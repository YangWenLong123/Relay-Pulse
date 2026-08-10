import { createHash, randomUUID } from 'node:crypto';
import { endpointUrl } from '../lib/relay-utils.js';
import { runGpt56Detection } from './gpt56-detector.js';
import type {
  Gpt56TestConfig,
  PurityCheckResult,
  PurityCheckStatus,
  PurityConfidence,
  PurityProgressStage,
  PurityTestMode,
  PurityTestProgress,
  PurityTestResult,
  PurityUsageSummary,
  PurityVerdict,
  Relay,
  TestProtocol
} from '../types.js';

type JsonRecord = Record<string, unknown>;
type ProbeKind = 'integrity' | 'token_delta' | 'repeat' | 'tool' | 'thinking';
type ModelProvider = 'openai' | 'anthropic' | 'google';
type FailureCategory =
  | 'auth'
  | 'quota'
  | 'model_unavailable'
  | 'incompatible'
  | 'upstream'
  | 'timeout'
  | 'cancelled'
  | 'transport'
  | 'invalid_response'
  | 'insufficient_output'
  | 'http';

interface TokenUsage {
  input: number | null;
  output: number | null;
  total: number | null;
}

interface ToolCall {
  name: string;
  arguments: unknown;
}

interface ProbeSpec {
  kind: ProbeKind;
  prompt: string;
  expected?: string;
  nonce: string;
}

interface ProbeObservation {
  kind: ProbeKind;
  expected?: string;
  text: string;
  model: string | null;
  responseId: string | null;
  object: string | null;
  type: string | null;
  finishReason: string | null;
  usage: TokenUsage;
  toolCall: ToolCall | null;
  thinkingPresent: boolean;
  signatureShapeValid: boolean;
  foreignFingerprints: ProviderFingerprint[];
  protocolIssues: string[];
  protocolScore: number;
  durationMs: number;
}

interface ProviderFingerprint {
  provider: ModelProvider;
  category: 'field_name' | 'metadata' | 'usage_source';
  digest: string;
}

interface ProbeFailure {
  kind: ProbeKind;
  category: FailureCategory;
  message: string;
  durationMs: number;
}

interface RunMetrics {
  requestCount: number;
  successfulRequests: number;
}

class PurityRequestError extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly status: number | null = null,
    readonly durationMs = 0
  ) {
    super(message);
    this.name = 'PurityRequestError';
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const DISCLAIMER =
  '本结果来自有限次数的黑盒行为与协议结构检测，只能识别异常信号，不能证明真实上游或提供密码学身份保证。';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMetadata(value: unknown, secret = '', limit = 120): string {
  if (typeof value !== 'string') return '';
  const withoutSecret = secret ? value.replaceAll(secret, '***') : value;
  return withoutSecret
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function numberValue(record: JsonRecord | undefined, ...keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function parseUsage(payload: JsonRecord, protocol: TestProtocol): TokenUsage {
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  if (protocol === 'anthropic') {
    return {
      input: numberValue(usage, 'input_tokens'),
      output: numberValue(usage, 'output_tokens'),
      total: numberValue(usage, 'total_tokens')
    };
  }
  return {
    input: numberValue(usage, 'input_tokens', 'prompt_tokens'),
    output: numberValue(usage, 'output_tokens', 'completion_tokens'),
    total: numberValue(usage, 'total_tokens')
  };
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'text' || part.type === 'output_text') return typeof part.text === 'string' ? part.text : '';
      return '';
    })
    .join('');
}

function firstRecord(value: unknown): JsonRecord | undefined {
  return Array.isArray(value) ? value.find(isRecord) : undefined;
}

function parseText(payload: JsonRecord, protocol: TestProtocol): string {
  if (protocol === 'chat') {
    const choice = firstRecord(payload.choices);
    const message = choice && isRecord(choice.message) ? choice.message : undefined;
    return textFromContent(message?.content).trim();
  }
  if (protocol === 'responses') {
    if (typeof payload.output_text === 'string') return payload.output_text.trim();
    return (Array.isArray(payload.output) ? payload.output : [])
      .map((item) => (isRecord(item) ? textFromContent(item.content) : ''))
      .join('')
      .trim();
  }
  return textFromContent(payload.content).trim();
}

function parseFinishReason(payload: JsonRecord, protocol: TestProtocol, secret = ''): string | null {
  if (protocol === 'chat') {
    const value = firstRecord(payload.choices)?.finish_reason;
    return typeof value === 'string' ? safeMetadata(value, secret) : null;
  }
  const value = protocol === 'anthropic' ? payload.stop_reason : payload.status;
  return typeof value === 'string' ? safeMetadata(value, secret) : null;
}

function outputBudgetExhausted(payload: JsonRecord, protocol: TestProtocol): boolean {
  if (protocol === 'chat') return firstRecord(payload.choices)?.finish_reason === 'length';
  if (protocol === 'anthropic') return payload.stop_reason === 'max_tokens';
  if (payload.status === 'incomplete') return true;
  const details = isRecord(payload.incomplete_details) ? payload.incomplete_details : undefined;
  return typeof details?.reason === 'string' && /max_output_tokens|length|budget/i.test(details.reason);
}

function parseJsonArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseToolCall(payload: JsonRecord, protocol: TestProtocol, secret = ''): ToolCall | null {
  if (protocol === 'chat') {
    const message = firstRecord(payload.choices)?.message;
    const call = isRecord(message) ? firstRecord(message.tool_calls) : undefined;
    const fn = call && isRecord(call.function) ? call.function : undefined;
    return fn && typeof fn.name === 'string'
      ? { name: safeMetadata(fn.name, secret), arguments: parseJsonArguments(fn.arguments) }
      : null;
  }
  if (protocol === 'responses') {
    const call = (Array.isArray(payload.output) ? payload.output : []).find(
      (item) => isRecord(item) && item.type === 'function_call'
    );
    return isRecord(call) && typeof call.name === 'string'
      ? { name: safeMetadata(call.name, secret), arguments: parseJsonArguments(call.arguments) }
      : null;
  }
  const call = (Array.isArray(payload.content) ? payload.content : []).find(
    (item) => isRecord(item) && item.type === 'tool_use'
  );
  return isRecord(call) && typeof call.name === 'string'
    ? { name: safeMetadata(call.name, secret), arguments: call.input }
    : null;
}

function thinkingShape(payload: JsonRecord): { present: boolean; valid: boolean } {
  const block = (Array.isArray(payload.content) ? payload.content : []).find(
    (item) => isRecord(item) && (item.type === 'thinking' || item.type === 'redacted_thinking')
  );
  if (!isRecord(block)) return { present: false, valid: false };
  const signature = typeof block.signature === 'string' ? block.signature : '';
  return { present: true, valid: signature.length >= 50 && signature.length <= 100_000 };
}

function protocolShape(payload: JsonRecord, protocol: TestProtocol): boolean {
  if (protocol === 'chat') {
    const message = firstRecord(payload.choices)?.message;
    return isRecord(message);
  }
  if (protocol === 'responses') return Array.isArray(payload.output) || typeof payload.output_text === 'string';
  return Array.isArray(payload.content) && (payload.type === undefined || payload.type === 'message');
}

function protocolQuality(payload: JsonRecord, protocol: TestProtocol): { issues: string[]; score: number } {
  const issues: string[] = [];
  let penalty = 0;
  const expect = (condition: boolean, issue: string, cost: number): void => {
    if (!condition) {
      issues.push(issue);
      penalty += cost;
    }
  };
  const id = typeof payload.id === 'string' ? payload.id : '';
  const usage = isRecord(payload.usage) ? payload.usage : undefined;

  if (protocol === 'chat') {
    expect(id.startsWith('chatcmpl-'), '响应 ID 缺失或不是 chatcmpl- 形状', 12);
    expect(payload.object === 'chat.completion', 'object 不是 chat.completion', 15);
    expect(typeof payload.model === 'string', '缺少模型声明', 15);
    expect(Array.isArray(payload.choices) && isRecord(firstRecord(payload.choices)?.message), '缺少 choices.message', 25);
    expect(typeof firstRecord(payload.choices)?.finish_reason === 'string', '缺少 finish_reason', 10);
    expect(Boolean(usage) && numberValue(usage, 'prompt_tokens', 'input_tokens') !== null, '缺少输入 Token usage', 12);
    expect(Boolean(usage) && numberValue(usage, 'completion_tokens', 'output_tokens') !== null, '缺少输出 Token usage', 11);
  } else if (protocol === 'responses') {
    expect(id.startsWith('resp_'), '响应 ID 缺失或不是 resp_ 形状', 12);
    expect(payload.object === 'response', 'object 不是 response', 15);
    expect(typeof payload.model === 'string', '缺少模型声明', 15);
    expect(Array.isArray(payload.output) || typeof payload.output_text === 'string', '缺少 output 结构', 25);
    expect(typeof payload.status === 'string', '缺少 status', 10);
    expect(Boolean(usage) && numberValue(usage, 'input_tokens') !== null, '缺少输入 Token usage', 12);
    expect(Boolean(usage) && numberValue(usage, 'output_tokens') !== null, '缺少输出 Token usage', 11);
  } else {
    expect(id.startsWith('msg_'), '响应 ID 缺失或不是 msg_ 形状', 12);
    expect(payload.type === 'message', 'type 不是 message', 15);
    expect(typeof payload.model === 'string', '缺少模型声明', 15);
    expect(Array.isArray(payload.content), '缺少 content 数组', 25);
    expect(typeof payload.stop_reason === 'string', '缺少 stop_reason', 10);
    expect(Boolean(usage) && numberValue(usage, 'input_tokens') !== null, '缺少输入 Token usage', 12);
    expect(Boolean(usage) && numberValue(usage, 'output_tokens') !== null, '缺少输出 Token usage', 11);
  }
  return { issues, score: Math.max(0, 100 - penalty) };
}

function providerHint(value: string): ModelProvider | null {
  const normalized = value.trim().toLowerCase().replace(/^(?:models|model)[/:]/, '');
  if (/(?:^|[/_.:-])(?:claude|anthropic)(?:$|[/_.:-])/.test(normalized)) return 'anthropic';
  if (/(?:^|[/_.:-])(?:gemini|google)(?:$|[/_.:-])/.test(normalized)) return 'google';
  if (/(?:^|[/_.:-])(?:gpt(?:$|[-_.])|openai(?:$|[/_.:-])|o(?:1|3|4)(?:$|[-_.]))/.test(normalized)) return 'openai';
  return null;
}

function foreignFingerprints(payload: JsonRecord, protocol: TestProtocol, requestedModel: string): ProviderFingerprint[] {
  if (protocol === 'anthropic') return [];
  const requestedProvider = providerHint(requestedModel);
  if (!requestedProvider) return [];
  const found = new Map<string, ProviderFingerprint>();
  const metadataValues = new Set(['id', 'model', 'object', 'type', 'provider', 'backend', 'source']);
  const add = (provider: ModelProvider | null, category: ProviderFingerprint['category'], raw: string): void => {
    if (!provider || provider === requestedProvider) return;
    const digest = fingerprint(raw);
    found.set(`${provider}:${category}:${digest}`, { provider, category, digest });
  };

  const visit = (value: unknown, depth: number): void => {
    if (depth > 7) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (/^claude_/.test(lowerKey)) add('anthropic', 'field_name', lowerKey);
      if (/^gemini_/.test(lowerKey)) add('google', 'field_name', lowerKey);
      if (lowerKey === 'usage_source' && typeof child === 'string') add(providerHint(child), 'usage_source', child);
      if (typeof child === 'string' && metadataValues.has(lowerKey)) add(providerHint(child), 'metadata', child);
      visit(child, depth + 1);
    }
  };
  visit(payload, 0);
  return [...found.values()];
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new PurityRequestError('上游响应体超过安全上限', 'invalid_response');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  let finished = false;
  while (!finished) {
    const chunk = await reader.read();
    if (chunk.done) {
      finished = true;
      continue;
    }
    bytes += chunk.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PurityRequestError('上游响应体超过安全上限', 'invalid_response');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function compactUpstreamError(raw: string, secret: string): string {
  const sanitized = safeMetadata(raw, secret, 240);
  try {
    const payload: unknown = JSON.parse(raw);
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      if (typeof error.message === 'string') return safeMetadata(error.message, secret, 240);
    }
  } catch {
    // A short sanitized excerpt is sufficient for non-JSON upstream errors.
  }
  return sanitized;
}

function httpError(status: number, raw: string, secret: string, durationMs: number): PurityRequestError {
  const detail = compactUpstreamError(raw, secret);
  if (status === 401 || status === 403) return new PurityRequestError('API Key 无效或无访问权限', 'auth', status, durationMs);
  if (status === 429 || /quota|credit|usage limit|额度|余额/i.test(detail)) {
    return new PurityRequestError('上游额度不足或请求频率受限', 'quota', status, durationMs);
  }
  if (/model.{0,100}(not found|does not exist|invalid|unsupported|unavailable|不存在|不可用|无效)/i.test(detail)) {
    return new PurityRequestError('请求模型不存在或不可用', 'model_unavailable', status, durationMs);
  }
  if (status === 404 || status === 405 || ((status === 400 || status === 422) && /endpoint|responses api|unknown field|unsupported/i.test(detail))) {
    return new PurityRequestError('接口端点或请求结构不兼容', 'incompatible', status, durationMs);
  }
  if (status >= 300 && status < 400) {
    return new PurityRequestError('上游返回重定向，已拒绝转发凭据', 'http', status, durationMs);
  }
  if (status >= 500) return new PurityRequestError('上游服务暂时不可用', 'upstream', status, durationMs);
  return new PurityRequestError(`上游请求失败（HTTP ${status}）`, 'http', status, durationMs);
}

function requestBody(model: string, protocol: TestProtocol, spec: ProbeSpec): JsonRecord {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { nonce: { type: 'string' }, value: { type: 'integer' } },
    required: ['nonce', 'value']
  };
  const normalizedModel = model.trim().toLowerCase().replace(/^(?:models|openai)[/:]/, '');
  const modernOpenAi = /^(?:gpt-5(?:[.-]|$)|o(?:1|3|4)(?:-|$))/.test(normalizedModel);
  if (protocol === 'responses') {
    const body: JsonRecord = {
      model,
      input: spec.prompt,
      max_output_tokens: modernOpenAi ? 512 : 192,
      stream: false
    };
    if (modernOpenAi) body.reasoning = { effort: 'low' };
    if (spec.kind === 'tool') {
      body.tools = [{ type: 'function', name: 'relay_probe', description: 'Return controlled probe data.', parameters: schema }];
      body.tool_choice = { type: 'function', name: 'relay_probe' };
    }
    return body;
  }
  if (protocol === 'chat') {
    const body: JsonRecord = {
      model,
      messages: [{ role: 'user', content: spec.prompt }],
      [modernOpenAi ? 'max_completion_tokens' : 'max_tokens']: modernOpenAi ? 512 : 96,
      stream: false
    };
    if (modernOpenAi) body.reasoning_effort = 'low';
    if (spec.kind === 'tool') {
      body.tools = [{ type: 'function', function: { name: 'relay_probe', description: 'Return controlled probe data.', parameters: schema } }];
      body.tool_choice = { type: 'function', function: { name: 'relay_probe' } };
    }
    return body;
  }
  const body: JsonRecord = {
    model,
    max_tokens: spec.kind === 'thinking' ? 1100 : 96,
    messages: [{ role: 'user', content: spec.prompt }],
    temperature: 0,
    stream: false
  };
  if (spec.kind === 'tool') {
    body.tools = [{ name: 'relay_probe', description: 'Return controlled probe data.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name: 'relay_probe' };
  }
  if (spec.kind === 'thinking') {
    delete body.temperature;
    body.thinking = { type: 'enabled', budget_tokens: 1024 };
  }
  return body;
}

function abortError(): Error {
  return Object.assign(new Error('纯度检测已取消'), { name: 'AbortError' });
}

async function requestProbe(
  relay: Relay,
  model: string,
  protocol: TestProtocol,
  spec: ProbeSpec,
  metrics: RunMetrics,
  signal?: AbortSignal
): Promise<ProbeObservation> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const started = performance.now();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, relay.timeout));
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  metrics.requestCount += 1;

  try {
    const path = protocol === 'responses' ? '/v1/responses' : protocol === 'chat' ? '/v1/chat/completions' : '/v1/messages';
    const headers: Record<string, string> =
      protocol === 'anthropic'
        ? {
            'x-api-key': relay.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        : {
            Authorization: `Bearer ${relay.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          };
    const response = await fetch(endpointUrl(relay.baseUrl, path), {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(model, protocol, spec)),
      signal: controller.signal,
      redirect: 'manual'
    });
    const raw = await readLimitedText(response);
    const durationMs = Math.round(performance.now() - started);
    if (!response.ok) throw httpError(response.status, raw, relay.apiKey, durationMs);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new PurityRequestError('上游返回了非 JSON 内容', 'invalid_response', response.status, durationMs);
    }
    if (!isRecord(payload) || !protocolShape(payload, protocol)) {
      throw new PurityRequestError('上游响应结构与所选协议不兼容', 'incompatible', response.status, durationMs);
    }
    if (outputBudgetExhausted(payload, protocol)) {
      throw new PurityRequestError('输出预算耗尽，本次探测证据不足', 'insufficient_output', response.status, durationMs);
    }
    metrics.successfulRequests += 1;
    const thinking = protocol === 'anthropic' ? thinkingShape(payload) : { present: false, valid: false };
    const quality = protocolQuality(payload, protocol);
    return {
      kind: spec.kind,
      expected: spec.expected,
      text: parseText(payload, protocol),
      model: typeof payload.model === 'string' ? safeMetadata(payload.model, relay.apiKey) : null,
      responseId: typeof payload.id === 'string' ? payload.id.slice(0, 500) : null,
      object: typeof payload.object === 'string' ? safeMetadata(payload.object, relay.apiKey) : null,
      type: typeof payload.type === 'string' ? safeMetadata(payload.type, relay.apiKey) : null,
      finishReason: parseFinishReason(payload, protocol, relay.apiKey),
      usage: parseUsage(payload, protocol),
      toolCall: parseToolCall(payload, protocol, relay.apiKey),
      thinkingPresent: thinking.present,
      signatureShapeValid: thinking.valid,
      foreignFingerprints: foreignFingerprints(payload, protocol, model),
      protocolIssues: quality.issues,
      protocolScore: quality.score,
      durationMs
    };
  } catch (error) {
    const durationMs = Math.round(performance.now() - started);
    if (error instanceof PurityRequestError) {
      if (error.durationMs === 0) {
        throw new PurityRequestError(error.message, error.category, error.status, durationMs);
      }
      throw error;
    }
    if (controller.signal.aborted) {
      if (signal?.aborted && !timedOut) throw abortError();
      throw new PurityRequestError('单次探测请求超时', 'timeout', null, durationMs);
    }
    throw new PurityRequestError('无法连接到中转站', 'transport', null, durationMs);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function probeFailure(error: unknown, kind: ProbeKind): ProbeFailure {
  if (error instanceof PurityRequestError) {
    return { kind, category: error.category, message: error.message, durationMs: error.durationMs };
  }
  throw error;
}

function makeCheck(
  id: string,
  name: string,
  status: PurityCheckStatus,
  score: number | null,
  weight: number,
  summary: string,
  evidence: string[],
  observations: Array<ProbeObservation | ProbeFailure>
): PurityCheckResult {
  return {
    id,
    name,
    status,
    score,
    weight,
    summary,
    evidence,
    requestCount: observations.length,
    durationMs: observations.reduce((total, item) => total + item.durationMs, 0)
  };
}

function skippedCheck(id: string, name: string, weight: number, summary: string): PurityCheckResult {
  return makeCheck(id, name, 'skipped', null, weight, summary, [], []);
}

function matchesRequestedModel(requested: string, reported: string): boolean {
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/^(?:models|openai|anthropic|google)[/:]/, '')
      .replace(/[._]+/g, '-')
      .replace(/-+/g, '-');
  const wanted = normalize(requested);
  const actual = normalize(reported);
  if (wanted === actual) return true;
  const withoutAlias = (value: string): string => value.replace(/-(?:latest|\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return withoutAlias(wanted) === withoutAlias(actual);
}

function integrityCheck(observation: ProbeObservation): PurityCheckResult {
  const expected = observation.expected ?? '';
  const exact = observation.text.trim() === expected;
  const contains = expected.length > 0 && observation.text.includes(expected);
  const evidence = [
    `输出指纹 ${fingerprint(observation.text)}`,
    observation.finishReason ? `结束原因 ${observation.finishReason}` : '未报告结束原因'
  ];
  if (exact) return makeCheck('basic_integrity', '基础响应完整性', 'pass', 100, 20, '受控随机标记被原样返回', evidence, [observation]);
  if (contains) {
    return makeCheck('basic_integrity', '基础响应完整性', 'warning', 65, 20, '随机标记存在，但响应包含额外内容', evidence, [observation]);
  }
  return makeCheck('basic_integrity', '基础响应完整性', 'fail', 0, 20, '受控随机标记未按要求返回', evidence, [observation]);
}

function buildModelCheck(requestedModel: string, observations: ProbeObservation[]): { check: PurityCheckResult; mismatch: boolean } {
  const models = [...new Set(observations.flatMap((item) => (item.model ? [item.model] : [])))];
  const evidence = models.length ? models.map((model) => `上游声明模型 ${model}`) : ['成功响应均未声明模型'];
  if (!models.length) {
    return {
      check: makeCheck('model_consistency', '模型声明一致性', 'warning', 55, 22, '无法从响应中核对模型声明', evidence, observations),
      mismatch: false
    };
  }
  const mismatched = models.filter((model) => !matchesRequestedModel(requestedModel, model));
  if (mismatched.length) {
    return {
      check: makeCheck('model_consistency', '模型声明一致性', 'fail', 0, 22, '响应声明与请求模型不一致', evidence, observations),
      mismatch: true
    };
  }
  return {
    check: makeCheck('model_consistency', '模型声明一致性', 'pass', 100, 22, '各次响应的模型声明一致', evidence, observations),
    mismatch: false
  };
}

function buildProtocolCheck(observations: ProbeObservation[], failures: ProbeFailure[]): { check: PurityCheckResult; foreign: boolean } {
  const foreign = [
    ...new Map(
      observations
        .flatMap((item) => item.foreignFingerprints)
        .map((item) => [`${item.provider}:${item.category}:${item.digest}`, item] as const)
    ).values()
  ];
  const structural = observations.flatMap((item) => {
    const values = [
      item.responseId ? `id#${fingerprint(item.responseId)}` : '',
      item.object ? `object=${item.object}` : '',
      item.type ? `type=${item.type}` : '',
      item.finishReason ? `finish=${item.finishReason}` : ''
    ].filter(Boolean);
    return values.length ? [values.join(', ')] : [];
  });
  if (foreign.length) {
    return {
      check: makeCheck(
        'protocol_shape',
        '协议结构与提供商指纹',
        'fail',
        0,
        18,
        'OpenAI 协议响应出现明确的其他提供商字段',
        [
          ...foreign.map((item) => `异源指纹 ${item.provider}/${item.category} #${item.digest}`),
          ...structural.slice(0, 3)
        ],
        observations
      ),
      foreign: true
    };
  }
  if (failures.some((item) => item.category === 'incompatible' || item.category === 'invalid_response')) {
    return {
      check: makeCheck('protocol_shape', '协议结构与提供商指纹', 'warning', 65, 18, '部分探测返回了不兼容结构', structural, [...observations, ...failures]),
      foreign: false
    };
  }
  const qualityScore = observations.length
    ? Math.round(observations.reduce((total, item) => total + item.protocolScore, 0) / observations.length)
    : 0;
  const issues = [...new Set(observations.flatMap((item) => item.protocolIssues))];
  if (issues.length) {
    const status: PurityCheckStatus = qualityScore < 55 ? 'fail' : 'warning';
    return {
      check: makeCheck(
        'protocol_shape',
        '协议结构与提供商指纹',
        status,
        qualityScore,
        18,
        status === 'fail' ? '响应缺少多项协议核心元数据' : '响应协议可解析，但部分标准元数据缺失',
        [...issues, ...structural.slice(0, 3)],
        observations
      ),
      foreign: false
    };
  }
  return {
    check: makeCheck('protocol_shape', '协议结构与提供商指纹', 'pass', 100, 18, '响应符合所选协议的核心结构', structural.slice(0, 4), observations),
    foreign: false
  };
}

function arithmeticAnomaly(usage: TokenUsage): { anomaly: boolean; severe: boolean } {
  const values = [usage.input, usage.output, usage.total].filter((value): value is number => value !== null);
  if (values.some((value) => value < 0 || !Number.isInteger(value))) return { anomaly: true, severe: true };
  if (usage.input === null || usage.output === null || usage.total === null) return { anomaly: false, severe: false };
  const expected = usage.input + usage.output;
  const difference = Math.abs(usage.total - expected);
  return {
    anomaly: difference !== 0,
    severe: usage.total < Math.max(usage.input, usage.output) || difference > Math.max(3, expected * 0.1)
  };
}

function absoluteUsageAnomaly(usage: TokenUsage): { warning: boolean; severe: boolean } {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const total = usage.total ?? input + output;
  return {
    warning: input > 4_000 || output > 1_000 || total > 6_000,
    severe: input > 16_000 || output > 4_000 || total > 20_000
  };
}

function buildTokenCheck(
  short: ProbeObservation,
  long: ProbeObservation | ProbeFailure
): { check: PurityCheckResult; severe: boolean } {
  const observations = [short, long];
  if ('category' in long) {
    return {
      check: makeCheck('token_accounting', 'Token 计量合理性', 'warning', 45, 20, '长输入探测失败，无法完成 Token 增量核对', [long.message], observations),
      severe: false
    };
  }
  const shortArithmetic = arithmeticAnomaly(short.usage);
  const longArithmetic = arithmeticAnomaly(long.usage);
  const shortAbsolute = absoluteUsageAnomaly(short.usage);
  const longAbsolute = absoluteUsageAnomaly(long.usage);
  const arithmeticBad = shortArithmetic.anomaly || longArithmetic.anomaly;
  const absoluteSevere = shortAbsolute.severe || longAbsolute.severe;
  const severe = shortArithmetic.severe || longArithmetic.severe || absoluteSevere;
  const evidence = [
    `短输入 usage: in=${short.usage.input ?? 'n/a'}, out=${short.usage.output ?? 'n/a'}, total=${short.usage.total ?? 'n/a'}`,
    `长输入 usage: in=${long.usage.input ?? 'n/a'}, out=${long.usage.output ?? 'n/a'}, total=${long.usage.total ?? 'n/a'}`
  ];
  if (arithmeticBad || absoluteSevere) {
    return {
      check: makeCheck(
        'token_accounting',
        'Token 计量合理性',
        'fail',
        0,
        20,
        absoluteSevere ? '小型探测的 usage Token 绝对量严重异常' : 'usage Token 算术关系异常',
        evidence,
        observations
      ),
      severe
    };
  }
  if (short.usage.input === null || long.usage.input === null) {
    return {
      check: makeCheck('token_accounting', 'Token 计量合理性', 'warning', 55, 20, '上游未提供足够的输入 Token 数据', evidence, observations),
      severe: false
    };
  }
  const delta = long.usage.input - short.usage.input;
  evidence.push(`80 个重复单词带来的输入 Token 增量 ${delta}`);
  if (delta >= 30 && delta <= 320) {
    if (shortAbsolute.warning || longAbsolute.warning) {
      return {
        check: makeCheck('token_accounting', 'Token 计量合理性', 'warning', 65, 20, 'Token 增量合理，但绝对计量明显偏高', evidence, observations),
        severe: false
      };
    }
    return {
      check: makeCheck('token_accounting', 'Token 计量合理性', 'pass', 100, 20, 'Token 算术与长输入增量均合理', evidence, observations),
      severe: false
    };
  }
  const status: PurityCheckStatus = delta < 15 ? 'fail' : 'warning';
  return {
    check: makeCheck('token_accounting', 'Token 计量合理性', status, status === 'fail' ? 15 : 60, 20, '长输入的 Token 增量偏离合理范围', evidence, observations),
    severe: false
  };
}

function buildRepeatCheck(results: Array<ProbeObservation | ProbeFailure>): PurityCheckResult {
  const observations = results.filter((item): item is ProbeObservation => !('category' in item));
  if (observations.length < 2) {
    const failures = results.filter((item): item is ProbeFailure => 'category' in item);
    return makeCheck('repeat_stability', '重复请求稳定性', 'warning', 40, 10, '重复探测未全部完成', failures.map((item) => item.message), results);
  }
  const exact = observations.every((item) => item.text.trim() === item.expected);
  const ids = observations.flatMap((item) => (item.responseId ? [item.responseId] : []));
  const uniqueIds = new Set(ids).size === ids.length;
  const evidence = observations.map(
    (item) => `输出指纹 ${fingerprint(item.text)}，响应 ID 指纹 ${item.responseId ? fingerprint(item.responseId) : 'n/a'}`
  );
  if (!exact) return makeCheck('repeat_stability', '重复请求稳定性', 'fail', 20, 10, '确定性探测输出不稳定', evidence, results);
  if (ids.length === 2 && !uniqueIds) {
    return makeCheck('repeat_stability', '重复请求稳定性', 'fail', 20, 10, '重复请求返回了相同响应 ID', evidence, results);
  }
  if (ids.length < 2) return makeCheck('repeat_stability', '重复请求稳定性', 'warning', 75, 10, '输出稳定，但缺少可核对的响应 ID', evidence, results);
  return makeCheck('repeat_stability', '重复请求稳定性', 'pass', 100, 10, '输出稳定且响应 ID 各自唯一', evidence, results);
}

function buildToolCheck(result: ProbeObservation | ProbeFailure, nonce: string): PurityCheckResult {
  if ('category' in result) {
    return makeCheck('tool_passthrough', '工具调用参数透传', 'warning', 40, 10, '强制工具调用探测失败', [result.message], [result]);
  }
  const args = isRecord(result.toolCall?.arguments) ? result.toolCall.arguments : undefined;
  const valid = result.toolCall?.name === 'relay_probe' && args?.nonce === nonce && args.value === 7;
  const evidence = result.toolCall
    ? [`工具名 ${result.toolCall.name}`, `参数结构指纹 ${fingerprint(JSON.stringify(result.toolCall.arguments))}`]
    : ['响应中没有工具调用'];
  return valid
    ? makeCheck('tool_passthrough', '工具调用参数透传', 'pass', 100, 10, '工具名与受控参数均被原样透传', evidence, [result])
    : makeCheck('tool_passthrough', '工具调用参数透传', 'fail', 10, 10, '工具调用或受控参数未按要求返回', evidence, [result]);
}

function buildThinkingCheck(result: ProbeObservation | ProbeFailure): PurityCheckResult {
  if ('category' in result) {
    return makeCheck('anthropic_thinking_shape', 'Anthropic 思考签名结构', 'warning', 45, 5, '思考结构探测不可用', [result.message], [result]);
  }
  if (result.signatureShapeValid) {
    return makeCheck(
      'anthropic_thinking_shape',
      'Anthropic 思考签名结构',
      'pass',
      100,
      5,
      '检测到预期的思考块与签名字段形状',
      ['仅验证字段形状与长度，不验证签名真伪'],
      [result]
    );
  }
  return makeCheck(
    'anthropic_thinking_shape',
    'Anthropic 思考签名结构',
    result.thinkingPresent ? 'warning' : 'fail',
    result.thinkingPresent ? 55 : 20,
    5,
    result.thinkingPresent ? '检测到思考块，但签名字段形状异常' : '响应未包含预期的思考块',
    ['该信号不构成密码学身份认证'],
    [result]
  );
}

function aggregateUsage(observations: ProbeObservation[]): PurityUsageSummary {
  const sum = (field: keyof TokenUsage): number | null => {
    const values = observations.flatMap((item) => (item.usage[field] === null ? [] : [item.usage[field]]));
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const totals = observations.flatMap((item) => {
    if (item.usage.total !== null) return [item.usage.total];
    if (item.usage.input !== null && item.usage.output !== null) return [item.usage.input + item.usage.output];
    return [];
  });
  return {
    inputTokens: sum('input'),
    outputTokens: sum('output'),
    totalTokens: totals.length ? totals.reduce((total, value) => total + value, 0) : null
  };
}

function weightedScore(checks: PurityCheckResult[]): number | null {
  const scored = checks.filter((check) => check.status !== 'skipped' && check.score !== null);
  const weight = scored.reduce((total, check) => total + check.weight, 0);
  if (!weight) return null;
  return Math.round(scored.reduce((total, check) => total + (check.score ?? 0) * check.weight, 0) / weight);
}

function confidenceFor(
  platform: Relay['platform'],
  mode: PurityTestMode,
  checks: PurityCheckResult[],
  critical: boolean,
  hasRuntimeFailure: boolean
): PurityConfidence {
  if (critical) return 'low';
  const applicable = checks.filter((check) => check.status !== 'skipped');
  const passes = applicable.filter((check) => check.status === 'pass').length;
  if (
    platform === 'anthropic' &&
    mode === 'standard' &&
    !hasRuntimeFailure &&
    passes >= 5 &&
    applicable.every((check) => check.status === 'pass')
  ) {
    return 'high';
  }
  if (passes >= 3) return 'medium';
  return 'low';
}

function verdictFor(score: number, confidence: PurityConfidence, foreign: boolean, mismatch: boolean, severeTokens: boolean): PurityVerdict {
  if (foreign) return 'abnormal';
  if (mismatch || severeTokens) return score < 45 ? 'abnormal' : 'suspicious';
  if (score >= 92 && confidence === 'high') return 'high_confidence_normal';
  if (score >= 80) return 'likely_normal';
  if (score >= 50) return 'suspicious';
  return 'abnormal';
}

function summaryFor(verdict: PurityVerdict): string {
  if (verdict === 'high_confidence_normal') return '多项独立信号表现正常，未发现明显异常';
  if (verdict === 'likely_normal') return '现有黑盒信号整体正常，未发现明确异常';
  if (verdict === 'suspicious') return '检测到可疑信号，建议复测并核对上游说明';
  if (verdict === 'abnormal') return '检测到明确异常信号，不建议仅依据标称模型使用';
  return '探测信息不足，暂时无法判断中转站纯度';
}

function inconclusiveResult(
  relay: Relay,
  model: string,
  protocol: TestProtocol,
  mode: PurityTestMode,
  started: number,
  metrics: RunMetrics,
  failure: ProbeFailure,
  observations: ProbeObservation[] = [],
  checks: PurityCheckResult[] = []
): PurityTestResult {
  return {
    id: randomUUID(),
    relayId: relay.id,
    relayName: relay.name,
    platform: relay.platform,
    protocol,
    mode,
    requestedModel: model,
    reportedModels: [...new Set(observations.flatMap((item) => (item.model ? [item.model] : [])))],
    score: null,
    verdict: 'inconclusive',
    confidence: 'low',
    summary: `${summaryFor('inconclusive')}：${failure.message}`,
    checks,
    anomalies: [],
    requestCount: metrics.requestCount,
    successfulRequests: metrics.successfulRequests,
    usage: aggregateUsage(observations),
    totalDuration: Math.round(performance.now() - started),
    testedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER
  };
}

function modernClaude(model: string): boolean {
  const normalized = model.trim().replace(/^(?:models|anthropic)[/:]/i, '');
  return /^claude-(?:(?:3-[7-9])|[4-9]|(?:opus|sonnet|haiku)-[4-9])/i.test(normalized);
}

export class PurityTester {
  async test(
    relay: Relay,
    options: {
      model?: string;
      mode?: PurityTestMode;
      gpt56?: Gpt56TestConfig;
      signal?: AbortSignal;
      onProgress?: (progress: PurityTestProgress) => void;
    } = {}
  ): Promise<PurityTestResult> {
    const model = options.model?.trim() || relay.model;
    const mode = options.mode ?? 'quick';
    if (mode === 'gpt56') {
      return runGpt56Detection({
        relay,
        model,
        config: options.gpt56,
        signal: options.signal,
        onProgress: options.onProgress
      });
    }
    const started = performance.now();
    const metrics: RunMetrics = { requestCount: 0, successfulRequests: 0 };
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    const integrity: ProbeSpec = {
      kind: 'integrity',
      nonce,
      expected: `RP_OK_${nonce}`,
      prompt: `Relay integrity probe ${nonce}. Reply with exactly "RP_OK_${nonce}" and no other text.`
    };
    let protocol: TestProtocol = relay.platform === 'anthropic' ? 'anthropic' : relay.protocol === 'chat' ? 'chat' : 'responses';
    const observations: ProbeObservation[] = [];
    const failures: ProbeFailure[] = [];
    let first: ProbeObservation | null = null;
    let long: ProbeObservation | ProbeFailure | null = null;
    let repeats: Array<ProbeObservation | ProbeFailure> = [];
    let tool: ProbeObservation | ProbeFailure | null = null;
    let thinking: ProbeObservation | ProbeFailure | null = null;
    const thinkingApplicable = mode === 'standard' && relay.platform === 'anthropic' && modernClaude(model);
    const totalChecks = mode === 'quick' ? 4 : thinkingApplicable ? 7 : 6;
    const progressChecks = (): PurityCheckResult[] => {
      if (!first) return [];
      const checks: PurityCheckResult[] = [
        integrityCheck(first),
        buildModelCheck(model, observations).check,
        buildProtocolCheck(observations, failures).check
      ];
      if (long) checks.push(buildTokenCheck(first, long).check);
      if (mode === 'standard' && repeats.length === 2) checks.push(buildRepeatCheck(repeats));
      if (mode === 'standard' && tool) checks.push(buildToolCheck(tool, nonce));
      if (thinkingApplicable && thinking) checks.push(buildThinkingCheck(thinking));
      return checks;
    };
    const emitProgress = (stage: PurityProgressStage, message: string): void => {
      if (!options.onProgress) return;
      const checks = progressChecks();
      const progress: PurityTestProgress = {
        stage,
        message,
        checks,
        requestCount: metrics.requestCount,
        successfulRequests: metrics.successfulRequests,
        usage: aggregateUsage(observations),
        reportedModels: [...new Set(observations.flatMap((item) => (item.model ? [item.model] : [])))],
        completedChecks: checks.length,
        totalChecks,
        elapsedMs: Math.round(performance.now() - started)
      };
      options.onProgress(progress);
    };

    try {
      if (relay.platform === 'openai' && relay.protocol === 'auto') {
        try {
          first = await requestProbe(relay, model, 'responses', integrity, metrics, options.signal);
        } catch (error) {
          if (error instanceof PurityRequestError && ['incompatible', 'invalid_response'].includes(error.category)) {
            protocol = 'chat';
            first = await requestProbe(relay, model, protocol, integrity, metrics, options.signal);
          } else {
            throw error;
          }
        }
      } else {
        first = await requestProbe(relay, model, protocol, integrity, metrics, options.signal);
      }
      observations.push(first);
      emitProgress('integrity', '基础完整性探针已完成');
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      const failure = probeFailure(error, 'integrity');
      failures.push(failure);
      emitProgress('integrity', '基础完整性探针未完成');
      return inconclusiveResult(relay, model, protocol, mode, started, metrics, failure);
    }

    const run = async (spec: ProbeSpec): Promise<ProbeObservation | ProbeFailure> => {
      try {
        const observation = await requestProbe(relay, model, protocol, spec, metrics, options.signal);
        observations.push(observation);
        return observation;
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        const failure = probeFailure(error, spec.kind);
        failures.push(failure);
        return failure;
      }
    };

    const longExpected = `RP_LONG_${nonce}`;
    long = await run({
      kind: 'token_delta',
      nonce,
      expected: longExpected,
      prompt: `Token accounting probe ${nonce}. Ignore this padding: ${Array.from({ length: 80 }, () => 'pulse').join(' ')}. Reply exactly "${longExpected}".`
    });
    emitProgress('token_accounting', 'Token 计量探针已完成');
    const fatalCategories: FailureCategory[] = ['auth', 'quota', 'model_unavailable'];
    const fatalAfterLong = failures.find((failure) => fatalCategories.includes(failure.category));
    if (fatalAfterLong) {
      return inconclusiveResult(relay, model, protocol, mode, started, metrics, fatalAfterLong, observations);
    }

    if (mode === 'standard') {
      const repeatExpected = `RP_STABLE_${nonce}`;
      const repeatSpec: ProbeSpec = {
        kind: 'repeat',
        nonce,
        expected: repeatExpected,
        prompt: `Deterministic relay probe ${nonce}. Reply with exactly "${repeatExpected}" and no other text.`
      };
      repeats = await Promise.all([run(repeatSpec), run(repeatSpec)]);
      emitProgress('repeat_stability', '重复稳定性探针已完成');
      const fatalAfterRepeats = failures.find((failure) => fatalCategories.includes(failure.category));
      if (fatalAfterRepeats) {
        return inconclusiveResult(relay, model, protocol, mode, started, metrics, fatalAfterRepeats, observations);
      }
      const toolSpec: ProbeSpec = {
        kind: 'tool',
        nonce,
        prompt: `Call relay_probe exactly once with nonce "${nonce}" and integer value 7. Do not answer in text.`
      };
      if (relay.platform === 'anthropic' && modernClaude(model)) {
        const thinkingSpec: ProbeSpec = {
          kind: 'thinking',
          nonce,
          prompt: `Think briefly, then answer with exactly "RP_THINK_${nonce}".`
        };
        [tool, thinking] = await Promise.all([run(toolSpec), run(thinkingSpec)]);
      } else {
        tool = await run(toolSpec);
      }
      emitProgress('capability_checks', thinkingApplicable ? '工具与思考结构探针已完成' : '工具调用探针已完成');
      const fatalAfterOptional = failures.find((failure) => fatalCategories.includes(failure.category));
      if (fatalAfterOptional) {
        return inconclusiveResult(relay, model, protocol, mode, started, metrics, fatalAfterOptional, observations);
      }
    }

    const modelResult = buildModelCheck(model, observations);
    const protocolResult = buildProtocolCheck(observations, failures);
    const tokenResult = buildTokenCheck(first, long);
    const checks: PurityCheckResult[] = [
      integrityCheck(first),
      modelResult.check,
      protocolResult.check,
      tokenResult.check,
      mode === 'standard'
        ? buildRepeatCheck(repeats)
        : skippedCheck('repeat_stability', '重复请求稳定性', 10, '快速模式未执行重复请求探测'),
      mode === 'standard' && tool
        ? buildToolCheck(tool, nonce)
        : skippedCheck('tool_passthrough', '工具调用参数透传', 10, '快速模式未执行工具调用探测'),
      mode === 'standard' && relay.platform === 'anthropic' && modernClaude(model) && thinking
        ? buildThinkingCheck(thinking)
        : skippedCheck('anthropic_thinking_shape', 'Anthropic 思考签名结构', 5, '当前模式或模型不适用该结构探测')
    ];
    const expectedProbes = mode === 'quick' ? 2 : thinkingApplicable ? 6 : 5;
    const minimumSuccessful = mode === 'quick' ? 2 : Math.max(3, Math.ceil(expectedProbes * 0.6));
    if (observations.length < minimumSuccessful) {
      return inconclusiveResult(
        relay,
        model,
        protocol,
        mode,
        started,
        metrics,
        {
          kind: 'integrity',
          category: 'invalid_response',
          message: `有效探测仅完成 ${observations.length}/${expectedProbes}，不足以形成可靠评分`,
          durationMs: 0
        },
        observations,
        checks
      );
    }
    const score = weightedScore(checks) ?? 0;
    const critical = protocolResult.foreign || modelResult.mismatch || tokenResult.severe;
    const confidence = confidenceFor(relay.platform, mode, checks, critical, failures.length > 0);
    const verdict = verdictFor(score, confidence, protocolResult.foreign, modelResult.mismatch, tokenResult.severe);
    const anomalies = [
      ...(modelResult.mismatch ? ['响应声明的模型与请求模型不一致'] : []),
      ...(protocolResult.foreign ? ['OpenAI 响应中出现明确的跨提供商结构指纹'] : []),
      ...(tokenResult.severe ? ['usage Token 绝对量或算术关系严重异常'] : []),
      ...checks.filter((check) => check.status === 'fail').map((check) => check.summary)
    ];

    return {
      id: randomUUID(),
      relayId: relay.id,
      relayName: relay.name,
      platform: relay.platform,
      protocol,
      mode,
      requestedModel: model,
      reportedModels: [...new Set(observations.flatMap((item) => (item.model ? [item.model] : [])))],
      score,
      verdict,
      confidence,
      summary: summaryFor(verdict),
      checks,
      anomalies: [...new Set(anomalies)],
      requestCount: metrics.requestCount,
      successfulRequests: metrics.successfulRequests,
      usage: aggregateUsage(observations),
      totalDuration: Math.round(performance.now() - started),
      testedAt: new Date().toISOString(),
      disclaimer: DISCLAIMER
    };
  }
}
