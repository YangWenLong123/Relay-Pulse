import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type {
  CodexAccount,
  CodexProxyEndpoint,
  CodexProxyStartResult,
  CodexProxyStatus,
  CodexRoutingStrategy,
  CodexUsageRecord,
  PublicCodexAccount
} from '../types.js';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_CAPTURE_BYTES = 1_000_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 180_000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);
const REQUEST_HEADERS_TO_REMOVE = new Set([
  'authorization',
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'x-api-key',
  'api-key',
  'openai-api-key'
]);

export type CodexProxyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CodexProxyDependencies {
  listAccounts: () => Promise<CodexAccount[]>;
  recordUsage?: (record: CodexUsageRecord) => void | Promise<void>;
  setAccountError?: (id: string, message: string) => void | Promise<void>;
  fetch?: CodexProxyFetch;
  upstreamBaseUrl: string;
  now?: () => Date;
}

export interface CodexProxyOptions {
  responseTimeoutMs?: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
}

export interface CodexProxyStartOptions {
  port?: number;
  accountIds?: string[];
  routingStrategy?: CodexRoutingStrategy;
}

interface RequestDetails {
  endpoint: CodexProxyEndpoint;
  model: string;
  body: Buffer;
}

interface Failure {
  statusCode: number | null;
  code: string;
  message: string;
}

interface ForwardedBody {
  body: Buffer;
  firstByteMs: number;
}

class RequestBodyTooLargeError extends Error {}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safeHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

function requestKey(req: IncomingMessage): string {
  const authorization = safeHeaderValue(req.headers.authorization);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  return bearer?.[1]?.trim() || safeHeaderValue(req.headers['x-api-key']).trim();
}

function pathName(req: IncomingMessage): string {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/';
  if (path === '/responses' || path === '/models' || path === '/usage') return `/v1${path}`;
  return path;
}

function requestedModel(body: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { model?: unknown }).model === 'string'
      ? (parsed as { model: string }).model.trim()
      : '';
  } catch {
    return '';
  }
}

function compactMessage(body: string): string {
  let message = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { error?: unknown; message?: unknown };
      const error = typeof record.error === 'object' && record.error !== null ? record.error as { message?: unknown } : undefined;
      if (typeof error?.message === 'string') message = error.message;
      else if (typeof record.message === 'string') message = record.message;
    }
  } catch {
    // Keep a compact plain-text error.
  }
  return message
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

function failureForResponse(response: Response, body: string): Failure {
  if (response.status === 401 || response.status === 403) return { statusCode: response.status, code: 'account_auth_error', message: 'GPT 账号凭证被上游拒绝' };
  if (response.status === 429) return { statusCode: response.status, code: 'account_rate_limited', message: 'GPT 账号触发限流或额度限制' };
  if (response.status === 404) return { statusCode: response.status, code: 'model_not_found', message: '请求的模型或接口不存在' };
  if (response.status >= 500) return { statusCode: response.status, code: 'upstream_server_error', message: compactMessage(body) || '上游服务异常' };
  return { statusCode: response.status, code: 'upstream_request_error', message: compactMessage(body) || `上游请求失败（HTTP ${response.status}）` };
}

function failureForError(error: unknown): Failure {
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') {
    return { statusCode: null, code: 'upstream_timeout', message: '上游请求超时或已取消' };
  }
  return { statusCode: null, code: 'upstream_connection_error', message: '无法连接 GPT 上游服务' };
}

function retryable(failure: Failure): boolean {
  return failure.statusCode === null || failure.statusCode === 401 || failure.statusCode === 403 ||
    failure.statusCode === 429 || (failure.statusCode >= 500);
}

function responseError(res: ServerResponse, status: number, message: string, type: string, code: string): void {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify({ error: { message, type, param: null, code } });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestBodyTooLargeError('请求体过大');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function copyResponseHeaders(res: ServerResponse, response: Response): void {
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length' || lower === 'content-encoding') return;
    res.setHeader(name, value);
  });
}

function usageFromBody(body: Buffer): Pick<CodexUsageRecord, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'totalTokens'> {
  const empty = { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null };
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    // Streaming responses are often SSE; scan the captured tail below.
    const match = body.toString('utf8').match(/\"usage\"\s*:\s*(\{[^\n]*\})/);
    if (!match?.[1]) return empty;
    try { payload = { usage: JSON.parse(match[1]) }; } catch { return empty; }
  }
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.usage && typeof record.usage === 'object' && record.usage !== null) records.push(record.usage as Record<string, unknown>);
    if ('input_tokens' in record || 'prompt_tokens' in record || 'output_tokens' in record || 'completion_tokens' in record) records.push(record);
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };
  visit(payload, 0);
  const usage = records.at(-1);
  if (!usage) return empty;
  const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const inputTokens = number(usage.input_tokens) ?? number(usage.prompt_tokens);
  const outputTokens = number(usage.output_tokens) ?? number(usage.completion_tokens);
  const details = typeof usage.input_tokens_details === 'object' && usage.input_tokens_details !== null
    ? usage.input_tokens_details as Record<string, unknown>
    : undefined;
  const promptDetails = typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details as Record<string, unknown>
    : undefined;
  const cachedTokens = number(details?.cached_tokens) ?? number(promptDetails?.cached_tokens) ?? number(usage.cached_tokens);
  const totalTokens = number(usage.total_tokens) ?? (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);
  return { inputTokens, outputTokens, cachedTokens, totalTokens };
}

function accountAvailable(account: CodexAccount): boolean {
  return account.enabled && (!account.expiresAt || Date.parse(account.expiresAt) > Date.now());
}

export class CodexProxyService {
  private readonly fetcher: CodexProxyFetch;
  private readonly upstreamBaseUrl: string;
  private readonly responseTimeoutMs: number;
  private readonly maxRequestBodyBytes: number;
  private readonly maxResponseBodyBytes: number;
  private server?: Server;
  private port: number | null = null;
  private startedAt: string | null = null;
  private apiKey = '';
  private apiKeyDigest?: Buffer;
  private starting = false;
  private selectedAccountIds: string[] = [];
  private routingStrategy: CodexRoutingStrategy = 'round-robin';
  private roundRobinCursor = 0;
  private availableAccountCount = 0;
  private models: string[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly dependencies: CodexProxyDependencies,
    options: CodexProxyOptions = {}
  ) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.upstreamBaseUrl = dependencies.upstreamBaseUrl.replace(/\/+$/, '');
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes ?? MAX_RESPONSE_BODY_BYTES;
  }

  status(): CodexProxyStatus {
    return {
      active: Boolean(this.server),
      host: LOOPBACK_HOST,
      port: this.port,
      baseUrl: this.port === null ? null : `http://${LOOPBACK_HOST}:${this.port}`,
      apiKey: this.apiKey,
      startedAt: this.startedAt,
      routingStrategy: this.routingStrategy,
      accountIds: [...this.selectedAccountIds],
      availableAccountCount: this.availableAccountCount,
      models: [...this.models]
    };
  }

  async start(options: CodexProxyStartOptions = {}): Promise<CodexProxyStartResult> {
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('端口必须在 0 到 65535 之间');
    if (this.server || this.starting) throw new Error('GPT 账号服务已启动或正在启动');
    this.starting = true;
    try {
      const accounts = await this.dependencies.listAccounts();
      const byId = new Map(accounts.map((account) => [account.id, account]));
      const ids = options.accountIds?.length ? [...new Set(options.accountIds)] : accounts.filter(accountAvailable).map((account) => account.id);
      if (!ids.length) throw new Error('请先导入至少一个可用 GPT 账号');
      const selected = ids.map((id) => byId.get(id));
      const missing = ids.find((_, index) => !selected[index]);
      if (missing) throw new Error('选择的 GPT 账号不存在或已被删除');
      const unavailable = selected.find((account) => !accountAvailable(account!));
      if (unavailable) throw new Error(`GPT 账号不可用：${unavailable.email}`);
      this.selectedAccountIds = ids;
      this.routingStrategy = options.routingStrategy ?? 'round-robin';
      this.roundRobinCursor = 0;
      this.updateAccountMetadata(selected.filter((account): account is CodexAccount => Boolean(account)));
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      await this.listen(server, port);
      const address = server.address();
      if (!address || typeof address === 'string') {
        await this.closeServer(server);
        throw new Error('无法获取 GPT 账号服务监听端口');
      }
      this.server = server;
      this.port = address.port;
      this.startedAt = new Date().toISOString();
      this.apiKey = `rp_codex_${randomBytes(30).toString('base64url')}`;
      this.apiKeyDigest = digest(this.apiKey);
      return { ...this.status(), apiKey: this.apiKey };
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<CodexProxyStatus> {
    const server = this.server;
    this.server = undefined;
    this.apiKey = '';
    this.apiKeyDigest = undefined;
    this.port = null;
    this.startedAt = null;
    this.selectedAccountIds = [];
    this.availableAccountCount = 0;
    this.models = [];
    this.roundRobinCursor = 0;
    this.activeControllers.forEach((controller) => controller.abort());
    this.activeControllers.clear();
    this.sockets.forEach((socket) => socket.destroy());
    this.sockets.clear();
    if (server) await this.closeServer(server);
    return this.status();
  }

  async rotateKey(): Promise<CodexProxyStartResult> {
    if (!this.server) throw new Error('GPT 账号服务未启动');
    this.apiKey = `rp_codex_${randomBytes(30).toString('base64url')}`;
    this.apiKeyDigest = digest(this.apiKey);
    return { ...this.status(), apiKey: this.apiKey };
  }

  async refreshAccountMetadata(): Promise<CodexProxyStatus> {
    const accounts = await this.dependencies.listAccounts();
    this.updateAccountMetadata(accounts.filter((account) => this.selectedAccountIds.includes(account.id)));
    return this.status();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private updateAccountMetadata(accounts: CodexAccount[]): void {
    this.availableAccountCount = accounts.filter(accountAvailable).length;
    this.models = [...new Set(accounts.flatMap((account) => account.models))].sort((left, right) => left.localeCompare(right));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
      if (!this.server || !this.apiKeyDigest) { responseError(res, 503, 'GPT 账号服务未启动', 'server_error', 'service_not_running'); return; }
      const supplied = requestKey(req);
      const actual = digest(supplied);
      if (!supplied || actual.length !== this.apiKeyDigest.length || !timingSafeEqual(actual, this.apiKeyDigest)) {
        responseError(res, 401, '无效的 GPT 账号服务 API Key', 'authentication_error', 'invalid_api_key');
        return;
      }
      const pathname = pathName(req);
      if (pathname === '/v1/models') {
        if (req.method !== 'GET') { responseError(res, 405, '该接口仅支持 GET 请求', 'invalid_request_error', 'method_not_allowed'); return; }
        this.sendModels(res);
        return;
      }
      if (pathname === '/v1/usage') {
        if (req.method !== 'GET') { responseError(res, 405, '该接口仅支持 GET 请求', 'invalid_request_error', 'method_not_allowed'); return; }
        this.sendUsage(res);
        return;
      }
      if (pathname !== '/v1/responses') {
        responseError(res, 404, 'GPT 账号服务只支持 Responses 接口', 'invalid_request_error', 'not_found');
        return;
      }
      if (req.method !== 'POST') { responseError(res, 405, '该接口仅支持 POST 请求', 'invalid_request_error', 'method_not_allowed'); return; }
      let body: Buffer;
      try { body = await readRequestBody(req, this.maxRequestBodyBytes); }
      catch (error) {
        if (error instanceof RequestBodyTooLargeError) { responseError(res, 413, '请求体超过服务限制', 'invalid_request_error', 'request_too_large'); return; }
        throw error;
      }
      await this.proxy(req, res, { endpoint: '/v1/responses', model: requestedModel(body), body });
    } catch {
      if (!res.headersSent) responseError(res, 500, 'GPT 账号服务内部错误', 'server_error', 'service_internal_error');
      else if (!res.writableEnded) res.destroy();
    }
  }

  private async proxy(req: IncomingMessage, res: ServerResponse, details: RequestDetails): Promise<void> {
    const startedAt = performance.now();
    const requestId = randomUUID();
    const requestController = new AbortController();
    const abort = (): void => requestController.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    this.activeControllers.add(requestController);
    let lastFailure: Failure | undefined;
    let lastAccount: CodexAccount | undefined;
    let attempts = 0;
    try {
      const accounts = await this.dependencies.listAccounts();
      this.updateAccountMetadata(accounts.filter((account) => this.selectedAccountIds.includes(account.id)));
      const selected = accounts.filter((account) => this.selectedAccountIds.includes(account.id) && accountAvailable(account));
      const candidates = details.model
        ? selected.filter((account) => !account.models.length || account.models.includes(details.model))
        : selected;
      if (!candidates.length) {
        await this.recordFailure(requestId, details, startedAt, 0, undefined, { statusCode: 404, code: 'model_not_found', message: '没有可用账号支持请求模型' });
        responseError(res, 404, '没有可用账号支持请求模型', 'invalid_request_error', 'model_not_found');
        return;
      }
      for (const account of this.ordered(candidates)) {
        if (requestController.signal.aborted) return;
        attempts += 1;
        lastAccount = account;
        try {
          const upstream = await this.openUpstream(req, account, details.body, requestController.signal);
          if (!upstream.ok) {
            const body = await upstream.text();
            const failure = failureForResponse(upstream, body);
            lastFailure = failure;
            if (failure.statusCode === 401 || failure.statusCode === 403) void this.dependencies.setAccountError?.(account.id, failure.message);
            if (!retryable(failure)) {
              await this.recordFailure(requestId, details, startedAt, attempts, account, failure);
              responseError(res, this.clientStatus(failure), failure.message, 'invalid_request_error', failure.code);
              return;
            }
            continue;
          }
          const contentType = upstream.headers.get('content-type') ?? '';
          const forwarded = /text\/event-stream/i.test(contentType) || this.isStreamingRequest(details.body)
            ? await this.forwardStream(res, upstream, startedAt, requestController.signal)
            : await this.forwardBuffered(res, upstream, startedAt);
          await this.recordSuccess(requestId, details, startedAt, attempts, account, upstream.status, forwarded);
          return;
        } catch (error) {
          const failure = failureForError(error);
          lastFailure = failure;
          if (requestController.signal.aborted) return;
        }
      }
      const failure = lastFailure ?? { statusCode: 503, code: 'no_account_available', message: '没有可用 GPT 账号' };
      await this.recordFailure(requestId, details, startedAt, attempts, lastAccount, failure);
      responseError(res, this.clientStatus(failure), failure.message, failure.statusCode === 429 ? 'rate_limit_error' : 'server_error', failure.code);
    } finally {
      this.activeControllers.delete(requestController);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  }

  private ordered(accounts: CodexAccount[]): CodexAccount[] {
    if (accounts.length <= 1) return accounts;
    if (this.routingStrategy === 'random') {
      const index = Math.floor(Math.random() * accounts.length);
      return [...accounts.slice(index), ...accounts.slice(0, index)];
    }
    const offset = this.roundRobinCursor % accounts.length;
    this.roundRobinCursor = (this.roundRobinCursor + 1) % accounts.length;
    return [...accounts.slice(offset), ...accounts.slice(0, offset)];
  }

  private isStreamingRequest(body: Buffer): boolean {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      return typeof parsed === 'object' && parsed !== null && (parsed as { stream?: unknown }).stream === true;
    } catch { return false; }
  }

  private async openUpstream(req: IncomingMessage, account: CodexAccount, body: Buffer, signal: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.responseTimeoutMs);
    timeout.unref();
    const headers = new Headers();
    Object.entries(req.headers).forEach(([name, raw]) => {
      const lower = name.toLowerCase();
      if (REQUEST_HEADERS_TO_REMOVE.has(lower) || lower.includes('api-key')) return;
      const value = safeHeaderValue(raw);
      if (value) headers.set(name, value);
    });
    headers.set('Authorization', `Bearer ${account.session.access_token}`);
    headers.set('ChatGPT-Account-ID', account.accountId);
    headers.set('OpenAI-Account-ID', account.accountId);
    headers.set('Accept-Encoding', 'identity');
    headers.set('User-Agent', 'relay-pulse-codex-gateway/1.0');
    const upstreamUrl = this.upstreamBaseUrl.toLowerCase().endsWith('/responses')
      ? this.upstreamBaseUrl
      : `${this.upstreamBaseUrl}/responses`;
    try {
      return await this.fetcher(upstreamUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  private async forwardBuffered(res: ServerResponse, response: Response, startedAt: number): Promise<ForwardedBody> {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > this.maxResponseBodyBytes) throw new Error('上游响应超过服务限制');
    if (!res.destroyed && !res.writableEnded) {
      res.statusCode = response.status;
      copyResponseHeaders(res, response);
      res.end(body);
    }
    return { body, firstByteMs: Math.round(performance.now() - startedAt) };
  }

  private async forwardStream(res: ServerResponse, response: Response, startedAt: number, signal: AbortSignal): Promise<ForwardedBody> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('上游未返回可读取的流');
    const chunks: Buffer[] = [];
    let captured = 0;
    const capture = (chunk: Buffer): void => {
      chunks.push(chunk);
      captured += chunk.length;
      while (captured > MAX_STREAM_CAPTURE_BYTES && chunks.length) {
        const excess = captured - MAX_STREAM_CAPTURE_BYTES;
        const first = chunks[0]!;
        if (first.length <= excess) { chunks.shift(); captured -= first.length; }
        else { chunks[0] = first.subarray(excess); captured -= excess; }
      }
    };
    let firstByteMs = Math.round(performance.now() - startedAt);
    let gotFirst = false;
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.statusCode = response.status;
        copyResponseHeaders(res, response);
        res.flushHeaders();
      }
      for (;;) {
        if (signal.aborted) return { body: Buffer.concat(chunks), firstByteMs };
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        if (!chunk.length) continue;
        if (!gotFirst) { gotFirst = true; firstByteMs = Math.round(performance.now() - startedAt); }
        capture(chunk);
        if (!res.destroyed && !res.writableEnded) res.write(chunk);
      }
      if (!res.destroyed && !res.writableEnded) res.end();
      return { body: Buffer.concat(chunks), firstByteMs };
    } finally {
      reader.releaseLock();
    }
  }

  private sendModels(res: ServerResponse): void {
    const body = JSON.stringify({
      object: 'list',
      data: this.models.map((id) => ({ id, object: 'model', owned_by: 'chatgpt-account' }))
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }

  private sendUsage(res: ServerResponse): void {
    const body = JSON.stringify({ is_active: true, remaining: this.availableAccountCount, unit: 'accounts' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }

  private async recordSuccess(
    id: string,
    details: RequestDetails,
    startedAt: number,
    attempts: number,
    account: CodexAccount,
    statusCode: number,
    forwarded: ForwardedBody
  ): Promise<void> {
    const tokens = usageFromBody(forwarded.body);
    await this.persist({
      id,
      createdAt: this.now().toISOString(),
      accountId: account.id,
      accountLabel: account.email || account.name,
      endpoint: details.endpoint,
      model: details.model,
      status: 'success',
      statusCode,
      attempts,
      firstByteMs: forwarded.firstByteMs,
      durationMs: Math.round(performance.now() - startedAt),
      ...tokens,
      errorCode: '',
      errorMessage: ''
    });
  }

  private async recordFailure(
    id: string,
    details: RequestDetails,
    startedAt: number,
    attempts: number,
    account: CodexAccount | undefined,
    failure: Failure
  ): Promise<void> {
    await this.persist({
      id,
      createdAt: this.now().toISOString(),
      accountId: account?.id ?? null,
      accountLabel: account?.email || account?.name || 'GPT 账号服务',
      endpoint: details.endpoint,
      model: details.model,
      status: 'failed',
      statusCode: failure.statusCode,
      attempts,
      firstByteMs: null,
      durationMs: Math.round(performance.now() - startedAt),
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 500)
    });
  }

  private async persist(record: CodexUsageRecord): Promise<void> {
    try { await this.dependencies.recordUsage?.(record); } catch { /* logging must not fail a client request */ }
  }

  private clientStatus(failure: Failure): number {
    if (failure.statusCode === 401 || failure.statusCode === 403) return 502;
    if (failure.statusCode === 404) return 404;
    if (failure.statusCode === 429) return 429;
    return 502;
  }

  private now(): Date { return this.dependencies.now?.() ?? new Date(); }

  private listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => { server.removeListener('listening', onListening); reject(error); };
      const onListening = (): void => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: LOOPBACK_HOST, port });
    });
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }
}

export function publicAccountForProxy(account: CodexAccount): PublicCodexAccount {
  const { session, accountId, ...safe } = account;
  void session;
  return {
    ...safe,
    accountIdMasked: accountId.length > 10 ? `${accountId.slice(0, 5)}...${accountId.slice(-5)}` : `${accountId.slice(0, 3)}***${accountId.slice(-3)}`,
    modelCount: account.models.length
  };
}
