import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { endpointUrl } from '../lib/relay-utils.js';
import type {
  BalanceSnapshot,
  PoolBalanceSummary,
  PoolEndpoint,
  PoolRelayBalanceUsage,
  PoolRoutingStrategy,
  PoolStartResult,
  PoolStatus,
  PoolUsageRecord,
  Relay,
  RelayPlatform
} from '../types.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_USAGE_CAPTURE_BYTES = 1_000_000;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_BALANCE_REFRESH_TIMEOUT_MS = 3_000;
const DEFAULT_POOL_FIRST_BYTE_TIMEOUT_MS = 180_000;
const DEFAULT_POOL_STREAM_IDLE_TIMEOUT_MS = 180_000;
const DEFAULT_POOL_RESPONSE_TIMEOUT_MS = 180_000;
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
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'x-api-key',
  'api-key',
  'openai-api-key'
]);

type PoolProxyPath = '/v1/models' | PoolEndpoint;

export type PoolProxyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PoolProxyDependencies {
  listRelays: () => Promise<Relay[]>;
  refreshBalance: (relay: Relay, signal?: AbortSignal) => Promise<Relay>;
  recordUsage?: (record: PoolUsageRecord) => void | Promise<void>;
  fetch?: PoolProxyFetch;
  now?: () => Date;
}

export interface PoolProxyOptions {
  cooldownMs?: number;
  maxRequestBodyBytes?: number;
  maxResponseBodyBytes?: number;
  balanceRefreshTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  responseTimeoutMs?: number;
  random?: () => number;
}

export interface PoolProxyStartOptions {
  port?: number;
  relayIds?: string[];
  routingStrategy?: PoolRoutingStrategy;
  modelMap?: Record<string, string[]>;
}

interface PoolState {
  eligible: Relay[];
  candidates: Relay[];
  cooldownRelayCount: number;
  exhausted: boolean;
}

interface SessionRelayBalance {
  relayId: string;
  relayName: string;
  unit: string;
  initialBalance: number | null;
  currentBalance: number | null;
}

interface RequestDetails {
  endpoint: PoolEndpoint;
  model: string;
  stream: boolean;
  body: Buffer;
}

interface UpstreamAttempt {
  response: Response;
  firstByteMs: number;
  clearStageTimeout: () => void;
  armFirstByteTimeout: () => void;
  armStreamIdleTimeout: () => void;
  failureFor: (error: unknown) => UpstreamFailure;
  dispose: () => void;
}

type UpstreamTimeoutKind = 'first_byte' | 'stream_idle' | 'response_total';

type StreamForwardOutcome = 'complete' | 'client_interrupted' | 'upstream_failed';

interface StreamForwardResult {
  outcome: StreamForwardOutcome;
  body: Buffer;
  firstByteMs: number;
  errorCode: string;
  errorMessage: string;
}

interface UsageTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
}

interface ModelListEntry extends Record<string, unknown> {
  id: string;
}

type ModelListAttempt =
  | { ok: true; relay: Relay; entries: ModelListEntry[] }
  | { ok: false; relay: Relay; failure: UpstreamFailure };

interface UpstreamFailureDetails {
  statusCode: number | null;
  code: string;
  message: string;
}

class RequestBodyTooLargeError extends Error {}

class PoolStartCancelledError extends Error {
  constructor() {
    super('号池服务启动已取消');
    this.name = 'PoolStartCancelledError';
  }
}

class UpstreamFailure extends Error implements UpstreamFailureDetails {
  constructor(
    readonly statusCode: number | null,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'UpstreamFailure';
  }
}

function nowMs(): number {
  return performance.now();
}

function hasRefreshableBalance(relay: Relay): boolean {
  return relay.enabled && relay.balanceConfig?.enabled === true;
}

function hasKnownExhaustedBalance(relay: Relay): boolean {
  return relay.balance?.success === true && typeof relay.balance.remaining === 'number' && relay.balance.remaining <= 0;
}

function isPoolEndpoint(pathname: string): pathname is PoolEndpoint {
  return pathname === '/v1/chat/completions' || pathname === '/v1/responses' || pathname === '/v1/messages';
}

function isStreamingRequest(body: Buffer): boolean {
  if (!body.length) return false;
  try {
    const payload: unknown = JSON.parse(body.toString('utf8'));
    return typeof payload === 'object' && payload !== null && (payload as { stream?: unknown }).stream === true;
  } catch {
    return false;
  }
}

function requestedModel(body: Buffer): string {
  if (!body.length) return '';
  try {
    const payload: unknown = JSON.parse(body.toString('utf8'));
    if (typeof payload === 'object' && payload !== null && typeof (payload as { model?: unknown }).model === 'string') {
      return (payload as { model: string }).model.trim();
    }
  } catch {
    // The upstream receives the original payload and returns its own validation error.
  }
  return '';
}

function safeHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(', ') : value ?? '';
}

function requestPoolKey(req: IncomingMessage): string {
  const authorization = safeHeaderValue(req.headers.authorization);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  if (bearer?.[1]) return bearer[1].trim();
  return safeHeaderValue(req.headers['x-api-key']).trim();
}

function requestIdempotencyKey(req: IncomingMessage, requestId: string, details: RequestDetails | undefined): string | undefined {
  if (!details) return undefined;
  return safeHeaderValue(req.headers['idempotency-key']).trim() || `rp_${requestId}`;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function safelyEqualKey(expectedDigest: Buffer | undefined, actual: string): boolean {
  if (!expectedDigest) return false;
  return timingSafeEqual(expectedDigest, digest(actual));
}

function compactUpstreamMessage(value: string, relay: Relay, poolKey: string | undefined): string {
  let message = value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
        message = (error as { message: string }).message;
      } else if (typeof (parsed as { message?: unknown }).message === 'string') {
        message = (parsed as { message: string }).message;
      }
    }
  } catch {
    // A non-JSON response is still useful as a compact diagnostic.
  }
  const withoutRelayKey = relay.apiKey ? message.replaceAll(relay.apiKey, '***') : message;
  const withoutPoolKey = poolKey ? withoutRelayKey.replaceAll(poolKey, '***') : withoutRelayKey;
  return withoutPoolKey
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function failureForResponse(response: Response, raw: string, relay: Relay, poolKey: string | undefined): UpstreamFailure {
  const message = compactUpstreamMessage(raw, relay, poolKey);
  if (response.status === 401 || response.status === 403) {
    return new UpstreamFailure(response.status, 'upstream_auth_error', '上游中转站拒绝了凭证');
  }
  if (response.status === 429) {
    return new UpstreamFailure(response.status, 'upstream_rate_limited', '上游中转站限流或额度不足');
  }
  if (response.status === 404) {
    return new UpstreamFailure(response.status, 'model_not_found', '请求的模型或接口不可用');
  }
  if (response.status >= 500) {
    return new UpstreamFailure(response.status, 'upstream_server_error', message || '上游中转站服务异常');
  }
  return new UpstreamFailure(response.status, 'upstream_request_error', message || `上游请求失败（HTTP ${response.status}）`);
}

function failureForError(error: unknown): UpstreamFailure {
  if (error instanceof UpstreamFailure) return error;
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError') {
    return new UpstreamFailure(null, 'upstream_timeout', '上游中转站请求超时或已取消');
  }
  return new UpstreamFailure(null, 'upstream_connection_error', '无法连接到上游中转站');
}

function timeoutFailure(kind: UpstreamTimeoutKind): UpstreamFailure {
  if (kind === 'first_byte') return new UpstreamFailure(null, 'upstream_first_byte_timeout', '上游中转站首字响应超时');
  if (kind === 'stream_idle') return new UpstreamFailure(null, 'upstream_stream_idle_timeout', '上游流式响应空闲超时');
  return new UpstreamFailure(null, 'upstream_response_timeout', '上游中转站完整响应超时');
}

function responseError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string | null
): void {
  if (res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify({ error: { message, type, param: null, code } });
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function normalizedPathname(req: IncomingMessage): string {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalized === '/responses' || normalized === '/chat/completions' || normalized === '/messages' ||
      normalized === '/models' || normalized === '/usage') {
    return `/v1${normalized}`;
  }
  return normalized;
}

function forwardHeaders(req: IncomingMessage, relay: Relay, idempotencyKey?: string): Headers {
  const headers = new Headers();
  Object.entries(req.headers).forEach(([name, rawValue]) => {
    const lower = name.toLowerCase();
    if (REQUEST_HEADERS_TO_REMOVE.has(lower) || lower.includes('api-key')) return;
    const value = safeHeaderValue(rawValue);
    if (value) headers.set(name, value);
  });
  if (relay.platform === 'anthropic') {
    headers.set('X-API-Key', relay.apiKey);
    if (!headers.has('Anthropic-Version')) headers.set('Anthropic-Version', '2023-06-01');
  } else {
    headers.set('Authorization', `Bearer ${relay.apiKey}`);
  }
  headers.set('Accept-Encoding', 'identity');
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
  return headers;
}

function copyResponseHeaders(res: ServerResponse, response: Response): void {
  response.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length' || lower === 'content-encoding') return;
    res.setHeader(name, value);
  });
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

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.length;
      if (size > maxBytes) {
        throw new UpstreamFailure(null, 'upstream_response_too_large', '上游响应超过号池服务限制');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

function numberFrom(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nestedUsageRecord(value: unknown): Record<string, unknown> | null {
  const record = objectRecord(value);
  if (!record) return null;
  const direct = objectRecord(record.usage) ?? record;
  if (
    direct.input_tokens !== undefined ||
    direct.prompt_tokens !== undefined ||
    direct.output_tokens !== undefined ||
    direct.completion_tokens !== undefined ||
    direct.total_tokens !== undefined
  ) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    const found = nestedUsageRecord(nested);
    if (found) return found;
  }
  return null;
}

function usageFromObject(value: unknown): UsageTokens {
  const empty: UsageTokens = { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null, cost: null };
  const record = nestedUsageRecord(value);
  if (!record) return empty;
  const inputTokens = numberFrom(record.input_tokens) ?? numberFrom(record.prompt_tokens);
  const outputTokens = numberFrom(record.output_tokens) ?? numberFrom(record.completion_tokens);
  const totalTokens = numberFrom(record.total_tokens) ??
    (inputTokens !== null || outputTokens !== null ? (inputTokens ?? 0) + (outputTokens ?? 0) : null);
  const inputDetails = record.input_tokens_details;
  const promptDetails = record.prompt_tokens_details;
  const cachedTokens =
    (typeof inputDetails === 'object' && inputDetails !== null
      ? numberFrom((inputDetails as Record<string, unknown>).cached_tokens)
      : null) ??
    (typeof promptDetails === 'object' && promptDetails !== null
      ? numberFrom((promptDetails as Record<string, unknown>).cached_tokens)
      : null) ??
    numberFrom(record.cache_read_input_tokens);
  const cost = numberFrom(record.cost) ??
    numberFrom(record.cost_usd) ??
    numberFrom(record.total_cost) ??
    numberFrom(record.total_cost_usd);
  return { inputTokens, outputTokens, cachedTokens, totalTokens, cost };
}

function usageFromResponseBody(body: Buffer, stream: boolean): UsageTokens {
  const raw = body.toString('utf8');
  try {
    return usageFromObject(JSON.parse(raw));
  } catch {
    if (!stream) return usageFromObject(null);
  }
  let latest: UsageTokens = { inputTokens: null, outputTokens: null, cachedTokens: null, totalTokens: null, cost: null };
  raw.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    try {
      const parsed = usageFromObject(JSON.parse(value));
      if (parsed.totalTokens !== null || parsed.inputTokens !== null || parsed.outputTokens !== null || parsed.cost !== null) latest = parsed;
    } catch {
      // Individual non-JSON SSE lines do not contain usage data.
    }
  });
  return latest;
}

function modelEntriesFromResponseBody(body: Buffer): ModelListEntry[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new UpstreamFailure(null, 'upstream_invalid_response', '上游模型列表返回了无法解析的内容');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new UpstreamFailure(null, 'upstream_invalid_response', '上游模型列表返回格式无效');
  }

  const response = payload as Record<string, unknown>;
  const items = Array.isArray(response.data) ? response.data : Array.isArray(response.models) ? response.models : null;
  if (!items) {
    throw new UpstreamFailure(null, 'upstream_invalid_response', '上游模型列表缺少 data 字段');
  }

  const entries: ModelListEntry[] = [];
  for (const item of items) {
    if (typeof item === 'string' && item.trim()) {
      entries.push({ id: item.trim(), object: 'model' });
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item) || typeof item.id !== 'string' || !item.id.trim()) {
      continue;
    }
    entries.push({ ...(item as Record<string, unknown>), id: item.id.trim() });
  }
  if (items.length > 0 && !entries.length) {
    throw new UpstreamFailure(null, 'upstream_invalid_response', '上游模型列表中没有有效模型');
  }
  return entries;
}

function upstreamUrl(relay: Relay, path: PoolProxyPath, originalUrl: string | undefined): string {
  const target = new URL(endpointUrl(relay.baseUrl, path));
  target.search = new URL(originalUrl ?? '/', 'http://localhost').search;
  return target.toString();
}

function mappedFailure(failure: UpstreamFailure): { status: number; message: string; type: string; code: string } {
  if (failure.statusCode === 400) {
    return { status: 400, message: '所有可用中转站均拒绝了该请求', type: 'invalid_request_error', code: failure.code };
  }
  if (failure.statusCode === 404) {
    return { status: 404, message: '所有可用中转站均不支持该模型或接口', type: 'invalid_request_error', code: 'model_not_found' };
  }
  if (failure.statusCode === 429) {
    return { status: 429, message: '号池中的中转站当前均受到限流', type: 'rate_limit_error', code: 'pool_rate_limited' };
  }
  if (failure.code === 'upstream_timeout' || failure.code === 'upstream_first_byte_timeout') {
    return { status: 504, message: '所有可用中转站均未能及时响应', type: 'server_error', code: 'pool_upstream_timeout' };
  }
  if (failure.code === 'upstream_stream_idle_timeout') {
    return { status: 504, message: '所有可用中转站流式响应均已超时', type: 'server_error', code: 'pool_stream_idle_timeout' };
  }
  if (failure.code === 'upstream_response_timeout') {
    return { status: 504, message: '所有可用中转站均未能完整响应', type: 'server_error', code: 'pool_response_timeout' };
  }
  return { status: 502, message: '所有可用中转站均请求失败', type: 'server_error', code: 'pool_upstream_failure' };
}

/**
 * A small OpenAI-compatible reverse proxy intended for local, loopback-only use.
 * Application state is injected so this service remains independent from Express and repositories.
 */
export class PoolProxyService {
  private readonly fetcher: PoolProxyFetch;
  private readonly cooldownMs: number;
  private readonly maxRequestBodyBytes: number;
  private readonly maxResponseBodyBytes: number;
  private readonly balanceRefreshTimeoutMs: number;
  private readonly firstByteTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly coolingUntilByRelay = new Map<string, number>();
  private readonly refreshedBalancesByRelay = new Map<string, BalanceSnapshot>();
  private readonly sessionBalancesByRelay = new Map<string, SessionRelayBalance>();
  private readonly balanceRefreshesByRelay = new Map<string, Promise<void>>();
  private readonly balanceRefreshControllers = new Set<AbortController>();
  private readonly sockets = new Set<Socket>();
  private readonly activeControllers = new Set<AbortController>();
  private server: Server | undefined;
  private apiKey: string | undefined;
  private apiKeyDigest: Buffer | undefined;
  private startedAt: string | null = null;
  private port: number | null = null;
  private eligibleRelayCount = 0;
  private cooldownRelayCount = 0;
  private relayIds: string[] = [];
  private readonly modelSubsetByRelay = new Map<string, Set<string>>();
  private platform: RelayPlatform | null = null;
  private routingStrategy: PoolRoutingStrategy = 'round-robin';
  private roundRobinCursor = 0;
  private starting = false;
  private lifecycleVersion = 0;
  private startAbortController: AbortController | undefined;
  private startCompletion: Promise<void> | undefined;

  constructor(
    private readonly dependencies: PoolProxyDependencies,
    options: PoolProxyOptions = {}
  ) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    this.maxResponseBodyBytes = options.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES;
    this.balanceRefreshTimeoutMs = options.balanceRefreshTimeoutMs ?? DEFAULT_BALANCE_REFRESH_TIMEOUT_MS;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? DEFAULT_POOL_FIRST_BYTE_TIMEOUT_MS;
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_POOL_STREAM_IDLE_TIMEOUT_MS;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_POOL_RESPONSE_TIMEOUT_MS;
    if (!Number.isFinite(this.cooldownMs) || this.cooldownMs < 0) throw new Error('cooldownMs 必须是非负有限数字');
    if (!Number.isSafeInteger(this.maxRequestBodyBytes) || this.maxRequestBodyBytes <= 0) {
      throw new Error('maxRequestBodyBytes 必须是正整数');
    }
    if (!Number.isSafeInteger(this.maxResponseBodyBytes) || this.maxResponseBodyBytes <= 0) {
      throw new Error('maxResponseBodyBytes 必须是正整数');
    }
    if (!Number.isSafeInteger(this.balanceRefreshTimeoutMs) || this.balanceRefreshTimeoutMs <= 0) {
      throw new Error('balanceRefreshTimeoutMs 必须是正整数');
    }
    if (!Number.isSafeInteger(this.firstByteTimeoutMs) || this.firstByteTimeoutMs <= 0) {
      throw new Error('firstByteTimeoutMs 必须是正整数');
    }
    if (!Number.isSafeInteger(this.streamIdleTimeoutMs) || this.streamIdleTimeoutMs <= 0) {
      throw new Error('streamIdleTimeoutMs 必须是正整数');
    }
    if (!Number.isSafeInteger(this.responseTimeoutMs) || this.responseTimeoutMs <= 0) {
      throw new Error('responseTimeoutMs 必须是正整数');
    }
  }

  status(): PoolStatus {
    const balanceDetails = this.sessionBalanceDetails();
    return {
      active: Boolean(this.server),
      host: LOOPBACK_HOST,
      port: this.port,
      baseUrl: this.port === null ? null : `http://${LOOPBACK_HOST}:${this.port}`,
      startedAt: this.startedAt,
      eligibleRelayCount: this.eligibleRelayCount,
      cooldownRelayCount: this.cooldownRelayCount,
      routingStrategy: this.routingStrategy,
      relayIds: [...this.relayIds],
      modelMap: this.modelMapRecord(),
      platform: this.platform,
      apiKey: this.apiKey ?? '',
      balanceSummary: this.sessionBalanceSummary(balanceDetails),
      balanceDetails
    };
  }

  async refreshBalances(signal?: AbortSignal): Promise<PoolStatus> {
    const relays = await this.dependencies.listRelays();
    const selectedIds = new Set(this.relayIds);
    const refreshable = relays.filter((relay) => selectedIds.has(relay.id) && hasRefreshableBalance(relay));
    const settled = await Promise.allSettled(refreshable.map((relay) => this.dependencies.refreshBalance(relay, signal)));
    settled.forEach((result) => {
      if (result.status === 'fulfilled') this.rememberRefreshedBalance(result.value);
    });
    const state = await this.poolState();
    this.updateStatusCounts(state);
    return this.status();
  }

  async addRelays(
    relayIds: string[],
    modelMap: Record<string, string[]> = {},
    signal?: AbortSignal
  ): Promise<PoolStatus> {
    if (!this.server) throw new Error('号池服务未启动');
    if (!relayIds.length) throw new Error('请至少选择一个要添加的中转站');
    if (new Set(relayIds).size !== relayIds.length) throw new Error('新增中转站不能重复');
    if (this.relayIds.length + relayIds.length > 200) throw new Error('号池成员不能超过 200 个');

    const existingIds = new Set(this.relayIds);
    if (relayIds.some((relayId) => existingIds.has(relayId))) throw new Error('新增中转站已在号池中');
    const modelEntries = this.normalizedModelEntries(modelMap, new Set(relayIds));
    const lifecycleVersion = this.lifecycleVersion;
    const relays = await this.dependencies.listRelays();
    const additions = this.validateSelection(relays, relayIds);
    if (additions.some((relay) => relay.platform !== this.platform)) {
      throw new Error('新增中转站类型必须与当前号池一致');
    }

    const refreshable = additions.filter(hasRefreshableBalance);
    const settled = await Promise.allSettled(
      refreshable.map((relay) => this.dependencies.refreshBalance(relay, signal))
    );
    settled.forEach((result) => {
      if (result.status === 'fulfilled') this.rememberRefreshedBalance(result.value);
    });
    if (signal?.aborted) throw new Error('添加中转站已取消');
    if (!this.server || lifecycleVersion !== this.lifecycleVersion) throw new Error('号池服务未启动');

    const currentIds = new Set(this.relayIds);
    if (relayIds.some((relayId) => currentIds.has(relayId))) throw new Error('新增中转站已在号池中');
    if (this.relayIds.length + relayIds.length > 200) throw new Error('号池成员不能超过 200 个');
    const latestRelays = await this.dependencies.listRelays();
    const latestAdditions = this.validateSelection(latestRelays, relayIds);
    if (latestAdditions.some((relay) => relay.platform !== this.platform)) {
      throw new Error('新增中转站类型必须与当前号池一致');
    }
    if (!this.server || lifecycleVersion !== this.lifecycleVersion) throw new Error('号池服务未启动');
    const latestMemberIds = new Set(this.relayIds);
    if (relayIds.some((relayId) => latestMemberIds.has(relayId))) throw new Error('新增中转站已在号池中');
    if (this.relayIds.length + relayIds.length > 200) throw new Error('号池成员不能超过 200 个');

    this.relayIds = [...this.relayIds, ...relayIds];
    modelEntries.forEach((models, relayId) => this.modelSubsetByRelay.set(relayId, models));
    latestAdditions.forEach((relay) => this.captureSessionBalance(this.withRefreshedBalance(relay)));
    this.roundRobinCursor = 0;
    const state = await this.poolState();
    this.updateStatusCounts(state);
    return this.status();
  }

  async start(options: PoolProxyStartOptions = {}): Promise<PoolStartResult> {
    const port = options.port ?? 0;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('端口必须在 0 到 65535 之间');
    if (this.server || this.starting) throw new Error('号池服务已启动或正在启动');

    this.starting = true;
    const lifecycleVersion = ++this.lifecycleVersion;
    const startController = new AbortController();
    this.startAbortController = startController;
    let resolveStart: () => void = () => undefined;
    const startCompletion = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    this.startCompletion = startCompletion;
    let server: Server | undefined;
    try {
      const relays = await this.dependencies.listRelays();
      const selected = this.validateSelection(relays, options.relayIds ?? relays.map((relay) => relay.id));
      this.relayIds = selected.map((relay) => relay.id);
      this.setModelMap(options.modelMap ?? {});
      this.platform = selected[0]!.platform;
      this.routingStrategy = options.routingStrategy ?? 'round-robin';
      this.roundRobinCursor = 0;
      await this.refreshBalances(startController.signal);
      this.assertStartCurrent(lifecycleVersion, startController.signal);
      server = createServer((req, res) => {
        void this.handle(req, res);
      });
      server.on('connection', (socket) => {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
      });
      await this.listen(server, port);
      this.assertStartCurrent(lifecycleVersion, startController.signal);
      const address = server.address();
      if (!address || typeof address === 'string') {
        await this.closeServer(server);
        throw new Error('无法获取号池服务监听端口');
      }
      this.server = server;
      this.port = address.port;
      this.startedAt = this.now().toISOString();
      this.captureSessionBalances(selected.map((relay) => this.withRefreshedBalance(relay)));
      return this.rotateKey();
    } catch (error) {
      if (server && this.server !== server) await this.closeServer(server);
      throw error;
    } finally {
      resolveStart();
      if (this.startCompletion === startCompletion) this.startCompletion = undefined;
      if (this.startAbortController === startController) this.startAbortController = undefined;
      this.starting = false;
    }
  }

  async stop(): Promise<PoolStatus> {
    const startCompletion = this.startCompletion;
    this.lifecycleVersion += 1;
    this.startAbortController?.abort();
    const server = this.server;
    this.server = undefined;
    this.apiKey = undefined;
    this.apiKeyDigest = undefined;
    this.startedAt = null;
    this.port = null;
    this.eligibleRelayCount = 0;
    this.cooldownRelayCount = 0;
    this.modelSubsetByRelay.clear();
    this.coolingUntilByRelay.clear();
    this.refreshedBalancesByRelay.clear();
    this.sessionBalancesByRelay.clear();
    this.balanceRefreshControllers.forEach((controller) => controller.abort());
    this.balanceRefreshControllers.clear();
    this.balanceRefreshesByRelay.clear();
    this.roundRobinCursor = 0;
    this.activeControllers.forEach((controller) => controller.abort());
    this.activeControllers.clear();
    this.sockets.forEach((socket) => socket.destroy());
    this.sockets.clear();
    if (server) await this.closeServer(server);
    if (startCompletion) await startCompletion;
    this.refreshedBalancesByRelay.clear();
    this.balanceRefreshesByRelay.clear();
    return this.status();
  }

  async rotateKey(): Promise<PoolStartResult> {
    if (!this.server) throw new Error('号池服务未启动');
    this.apiKey = `rp_${randomBytes(32).toString('base64url')}`;
    this.apiKeyDigest = digest(this.apiKey);
    return { ...this.status(), apiKey: this.apiKey };
  }

  setRoutingStrategy(strategy: PoolRoutingStrategy): PoolStatus {
    if (!this.server) throw new Error('号池服务未启动');
    if (strategy !== 'round-robin' && strategy !== 'random') throw new Error('不支持的号池轮询规则');
    this.routingStrategy = strategy;
    this.roundRobinCursor = 0;
    return this.status();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (!this.server || !this.apiKeyDigest) {
        responseError(res, 503, '号池服务未启动', 'server_error', 'pool_not_running');
        return;
      }
      if (!safelyEqualKey(this.apiKeyDigest, requestPoolKey(req))) {
        responseError(res, 401, '无效的号池 API Key', 'authentication_error', 'invalid_api_key');
        return;
      }

      const pathname = normalizedPathname(req);
      if (pathname === '/v1/usage') {
        if (req.method !== 'GET') {
          responseError(res, 405, '该接口仅支持 GET 请求', 'invalid_request_error', 'method_not_allowed');
          return;
        }
        this.sendUsage(res);
        return;
      }
      if (pathname === '/v1/models') {
        if (this.platform !== 'openai') {
          responseError(res, 404, 'Anthropic 号池不提供模型列表接口', 'invalid_request_error', 'not_found');
          return;
        }
        if (req.method !== 'GET') {
          responseError(res, 405, '该接口仅支持 GET 请求', 'invalid_request_error', 'method_not_allowed');
          return;
        }
        await this.proxy(req, res, '/v1/models');
        return;
      }
      if (isPoolEndpoint(pathname)) {
        const platformMatches = this.platform === 'anthropic' ? pathname === '/v1/messages' : pathname !== '/v1/messages';
        if (!platformMatches) {
          responseError(res, 404, '请求接口与当前号池类型不匹配', 'invalid_request_error', 'not_found');
          return;
        }
        if (req.method !== 'POST') {
          responseError(res, 405, '该接口仅支持 POST 请求', 'invalid_request_error', 'method_not_allowed');
          return;
        }
        let body: Buffer;
        try {
          body = await readRequestBody(req, this.maxRequestBodyBytes);
        } catch (error) {
          if (error instanceof RequestBodyTooLargeError) {
            responseError(res, 413, '请求体超过号池服务限制', 'invalid_request_error', 'request_too_large');
            return;
          }
          throw error;
        }
        await this.proxy(req, res, pathname, {
          endpoint: pathname,
          body,
          model: requestedModel(body),
          stream: isStreamingRequest(body)
        });
        return;
      }
      responseError(res, 404, '接口不存在', 'invalid_request_error', 'not_found');
    } catch {
      if (!res.headersSent) responseError(res, 500, '号池服务内部错误', 'server_error', 'pool_internal_error');
      else if (!res.writableEnded) res.destroy();
    }
  }

  private async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    path: PoolProxyPath,
    details?: RequestDetails
  ): Promise<void> {
    const startedAt = nowMs();
    const requestId = details ? randomUUID() : '';
    const idempotencyKey = requestIdempotencyKey(req, requestId, details);
    const controller = new AbortController();
    const abortOnRequest = (): void => controller.abort();
    const abortOnResponseClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abortOnRequest);
    res.once('close', abortOnResponseClose);
    this.activeControllers.add(controller);
    let attempts = 0;
    let lastRelay: Relay | undefined;
    let lastFailure: UpstreamFailure | undefined;
    const balanceRefreshes = new Set<Promise<void>>();

    try {
      const state = await this.poolState();
      this.updateStatusCounts(state);
      if (!state.candidates.length) {
        await this.recordPoolFailure(
          details,
          requestId,
          startedAt,
          0,
          undefined,
          state.exhausted ? 'pool_exhausted' : 'pool_unavailable',
          '',
          state.exhausted ? 429 : 503
        );
        if (state.exhausted) {
          responseError(res, 429, '号池中的所有中转站余额均已耗尽', 'rate_limit_error', 'pool_exhausted');
        } else {
          responseError(res, 503, '号池中没有可用中转站', 'server_error', 'pool_unavailable');
        }
        return;
      }

      if (path === '/v1/models') {
        await this.proxyModelList(req, res, state.candidates, startedAt, controller.signal);
        return;
      }

      const requestModel = details?.model ?? '';
      const modelCandidates = requestModel
        ? state.candidates.filter((relay) => this.relaySupportsModel(relay.id, requestModel))
        : state.candidates;
      if (requestModel && !modelCandidates.length) {
        await this.recordPoolFailure(details, requestId, startedAt, 0, undefined, 'model_not_found', '', 404);
        responseError(res, 404, '号池中没有支持该模型的中转站', 'invalid_request_error', 'model_not_found');
        return;
      }

      for (const relay of this.orderCandidates(modelCandidates)) {
        if (controller.signal.aborted) return;
        attempts += 1;
        lastRelay = relay;
        let upstream: UpstreamAttempt | undefined;
        try {
          upstream = await this.openUpstream(req, path, details?.body, relay, startedAt, controller.signal, idempotencyKey);
          if (!upstream.response.ok) {
            const raw = await upstream.response.text();
            throw failureForResponse(upstream.response, raw, relay, this.apiKey);
          }
          const contentType = upstream.response.headers.get('content-type') ?? '';
          const streaming = Boolean(details?.stream) || /text\/event-stream/i.test(contentType);
          if (streaming) {
            const result = await this.forwardStream(res, upstream, startedAt);
            await this.recordUsage({
              requestId,
              details,
              relay,
              // A broken downstream connection must not turn an accepted upstream call into a failed relay call.
              status: result.outcome === 'upstream_failed' ? 'failed' : 'success',
              statusCode: upstream.response.status,
              attempts,
              startedAt,
              firstByteMs: result.firstByteMs,
              body: result.body,
              errorCode: result.errorCode,
              errorMessage: result.errorMessage
            });
            if (hasRefreshableBalance(relay)) void this.scheduleBalanceRefresh(relay);
            return;
          }

          const body = await readResponseBody(upstream.response, this.maxResponseBodyBytes);
          upstream.clearStageTimeout();
          this.sendBufferedResponse(res, upstream.response, body);
          await this.recordUsage({
            requestId,
            details,
            relay,
            status: 'success',
            statusCode: upstream.response.status,
            attempts,
            startedAt,
            firstByteMs: upstream.firstByteMs,
            body,
            errorCode: '',
            errorMessage: ''
          });
          if (hasRefreshableBalance(relay)) void this.scheduleBalanceRefresh(relay);
          return;
        } catch (error) {
          const failure = upstream?.failureFor(error) ?? failureForError(error);
          lastFailure = failure;
          if (failure.code === 'request_cancelled') return;
          if (failure.statusCode === 429) {
            balanceRefreshes.add(this.scheduleBalanceRefresh(relay));
          }
          if (this.shouldCooldown(failure)) this.setCooldown(relay.id);
        } finally {
          upstream?.dispose();
        }
      }

      if (lastFailure?.statusCode === 429) await this.waitForBalanceRefreshes(balanceRefreshes, controller.signal);
      const finalState = await this.poolState();
      this.updateStatusCounts(finalState);
      if (finalState.exhausted) {
        await this.recordPoolFailure(details, requestId, startedAt, attempts, lastRelay, 'pool_exhausted', '', 429);
        responseError(res, 429, '号池中的所有中转站余额均已耗尽', 'rate_limit_error', 'pool_exhausted');
        return;
      }
      const failure = lastFailure ?? new UpstreamFailure(null, 'pool_upstream_failure', '所有可用中转站均请求失败');
      await this.recordPoolFailure(details, requestId, startedAt, attempts, lastRelay, failure.code, failure.message, failure.statusCode);
      const mapped = mappedFailure(failure);
      responseError(res, mapped.status, mapped.message, mapped.type, mapped.code);
    } finally {
      this.activeControllers.delete(controller);
      req.removeListener('aborted', abortOnRequest);
      res.removeListener('close', abortOnResponseClose);
    }
  }

  private async proxyModelList(
    req: IncomingMessage,
    res: ServerResponse,
    candidates: Relay[],
    startedAt: number,
    requestSignal: AbortSignal
  ): Promise<void> {
    const attempts = await Promise.all(
      this.orderCandidates(candidates).map((relay) => this.fetchModelListFromRelay(req, relay, startedAt, requestSignal))
    );
    if (requestSignal.aborted) return;

    const entriesById = new Map<string, ModelListEntry>();
    let succeeded = false;
    let lastFailure: UpstreamFailure | undefined;
    const balanceRefreshes = new Set<Promise<void>>();
    for (const attempt of attempts) {
      if (attempt.ok) {
        succeeded = true;
        attempt.entries.forEach((entry) => {
          if (!entriesById.has(entry.id)) entriesById.set(entry.id, entry);
        });
        continue;
      }

      lastFailure = attempt.failure;
      if (attempt.failure.statusCode === 429) {
        balanceRefreshes.add(this.scheduleBalanceRefresh(attempt.relay));
      }
      if (this.shouldCooldown(attempt.failure)) this.setCooldown(attempt.relay.id);
    }

    if (requestSignal.aborted) return;
    if (succeeded) {
      this.sendModelList(res, [...entriesById.values()]);
      return;
    }

    if (lastFailure?.statusCode === 429) await this.waitForBalanceRefreshes(balanceRefreshes, requestSignal);
    const finalState = await this.poolState();
    this.updateStatusCounts(finalState);
    if (finalState.exhausted) {
      responseError(res, 429, '号池中的所有中转站余额均已耗尽', 'rate_limit_error', 'pool_exhausted');
      return;
    }
    const failure = lastFailure ?? new UpstreamFailure(null, 'pool_upstream_failure', '所有可用中转站均请求失败');
    const mapped = mappedFailure(failure);
    responseError(res, mapped.status, mapped.message, mapped.type, mapped.code);
  }

  private async fetchModelListFromRelay(
    req: IncomingMessage,
    relay: Relay,
    startedAt: number,
    requestSignal: AbortSignal
  ): Promise<ModelListAttempt> {
    const subset = this.modelSubsetByRelay.get(relay.id);
    if (subset?.size) {
      return { ok: true, relay, entries: [...subset].map((id) => ({ id, object: 'model' })) };
    }
    let upstream: UpstreamAttempt | undefined;
    try {
      upstream = await this.openUpstream(req, '/v1/models', undefined, relay, startedAt, requestSignal);
      if (!upstream.response.ok) {
        const raw = await upstream.response.text();
        throw failureForResponse(upstream.response, raw, relay, this.apiKey);
      }
      const body = await readResponseBody(upstream.response, this.maxResponseBodyBytes);
      upstream.clearStageTimeout();
      return { ok: true, relay, entries: modelEntriesFromResponseBody(body) };
    } catch (error) {
      return { ok: false, relay, failure: upstream?.failureFor(error) ?? failureForError(error) };
    } finally {
      upstream?.dispose();
    }
  }

  private async openUpstream(
    req: IncomingMessage,
    path: PoolProxyPath,
    body: Buffer | undefined,
    relay: Relay,
    startedAt: number,
    requestSignal: AbortSignal,
    idempotencyKey?: string
  ): Promise<UpstreamAttempt> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    requestSignal.addEventListener('abort', abort, { once: true });
    let timeoutKind: UpstreamTimeoutKind | null = null;
    let stageTimeout: ReturnType<typeof setTimeout> | undefined;
    let responseTimeout: ReturnType<typeof setTimeout> | undefined;
    const abortForTimeout = (kind: UpstreamTimeoutKind): void => {
      timeoutKind ??= kind;
      controller.abort();
    };
    const clearStageTimeout = (): void => {
      if (stageTimeout) clearTimeout(stageTimeout);
      stageTimeout = undefined;
    };
    const armStageTimeout = (kind: UpstreamTimeoutKind, durationMs: number): void => {
      clearStageTimeout();
      stageTimeout = setTimeout(() => abortForTimeout(kind), durationMs);
      stageTimeout.unref();
    };
    const armFirstByteTimeout = (): void => armStageTimeout('first_byte', this.firstByteTimeoutMs);
    const armStreamIdleTimeout = (): void => armStageTimeout('stream_idle', this.streamIdleTimeoutMs);
    const clearResponseTimeout = (): void => {
      if (responseTimeout) clearTimeout(responseTimeout);
      responseTimeout = undefined;
    };
    const clearTimeouts = (): void => {
      clearStageTimeout();
      clearResponseTimeout();
    };
    armFirstByteTimeout();
    responseTimeout = setTimeout(() => abortForTimeout('response_total'), this.responseTimeoutMs);
    responseTimeout.unref();
    const classifyFailure = (error: unknown): UpstreamFailure => {
      if (timeoutKind) return timeoutFailure(timeoutKind);
      if (requestSignal.aborted) return new UpstreamFailure(null, 'request_cancelled', '请求已取消');
      return failureForError(error);
    };
    try {
      const response = await this.fetcher(upstreamUrl(relay, path, req.url), {
        method: req.method,
        headers: forwardHeaders(req, relay, idempotencyKey),
        body: body?.length ? new Uint8Array(body) : undefined,
        redirect: 'manual',
        signal: controller.signal
      });
      clearStageTimeout();
      return {
        response,
        firstByteMs: Math.round(nowMs() - startedAt),
        clearStageTimeout,
        armFirstByteTimeout,
        armStreamIdleTimeout,
        failureFor: classifyFailure,
        dispose: () => {
          requestSignal.removeEventListener('abort', abort);
          clearTimeouts();
        }
      };
    } catch (error) {
      clearTimeouts();
      requestSignal.removeEventListener('abort', abort);
      if (controller.signal.aborted) {
        throw classifyFailure(error);
      }
      throw error;
    }
  }

  private sendBufferedResponse(res: ServerResponse, response: Response, body: Buffer): void {
    if (res.writableEnded || res.destroyed) return;
    res.statusCode = response.status;
    copyResponseHeaders(res, response);
    res.end(body);
  }

  private sendModelList(res: ServerResponse, entries: ModelListEntry[]): void {
    if (res.writableEnded || res.destroyed) return;
    const body = JSON.stringify({ object: 'list', data: entries });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }

  private sendUsage(res: ServerResponse): void {
    if (res.writableEnded || res.destroyed) return;
    const balance = this.status().balanceSummary[0];
    const body = JSON.stringify({
      is_active: true,
      remaining: balance?.currentBalance ?? null,
      unit: balance?.unit || 'USD'
    });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  }

  private async forwardStream(res: ServerResponse, upstream: UpstreamAttempt, startedAt: number): Promise<StreamForwardResult> {
    if (res.writableEnded || res.destroyed) throw new UpstreamFailure(null, 'request_cancelled', '请求已取消');
    const reader = upstream.response.body?.getReader();
    if (!reader) throw new UpstreamFailure(null, 'upstream_empty_stream', '上游流式响应未返回内容');

    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let committed = false;
    let firstByteMs = upstream.firstByteMs;
    const capture = (chunk: Buffer): void => {
      if (chunk.length >= MAX_STREAM_USAGE_CAPTURE_BYTES) {
        chunks.splice(0, chunks.length, Buffer.from(chunk.subarray(chunk.length - MAX_STREAM_USAGE_CAPTURE_BYTES)));
        capturedBytes = MAX_STREAM_USAGE_CAPTURE_BYTES;
        return;
      }
      chunks.push(chunk);
      capturedBytes += chunk.length;
      while (capturedBytes > MAX_STREAM_USAGE_CAPTURE_BYTES) {
        const excess = capturedBytes - MAX_STREAM_USAGE_CAPTURE_BYTES;
        const oldest = chunks[0]!;
        if (oldest.length <= excess) {
          chunks.shift();
          capturedBytes -= oldest.length;
          continue;
        }
        chunks[0] = Buffer.from(oldest.subarray(excess));
        capturedBytes -= excess;
      }
    };

    try {
      let firstChunk: Buffer | undefined;
      while (!firstChunk) {
        upstream.armFirstByteTimeout();
        const next = await reader.read();
        upstream.clearStageTimeout();
        if (next.done) throw new UpstreamFailure(null, 'upstream_empty_stream', '上游流式响应未返回内容');
        const chunk = Buffer.from(next.value);
        if (chunk.length) firstChunk = chunk;
      }
      firstByteMs = Math.round(nowMs() - startedAt);
      capture(firstChunk);
      if (res.writableEnded || res.destroyed) {
        await reader.cancel();
        throw new UpstreamFailure(null, 'request_cancelled', '请求已取消');
      }

      res.statusCode = upstream.response.status;
      copyResponseHeaders(res, upstream.response);
      committed = true;
      if (!(await this.writeStreamChunk(res, firstChunk))) {
        await reader.cancel();
        return {
          outcome: 'client_interrupted',
          body: Buffer.concat(chunks),
          firstByteMs,
          errorCode: 'stream_interrupted',
          errorMessage: '客户端连接在流式响应开始后中断'
        };
      }

      for (;;) {
        upstream.armStreamIdleTimeout();
        const next = await reader.read();
        upstream.clearStageTimeout();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        if (!chunk.length) continue;
        capture(chunk);
        if (res.writableEnded || res.destroyed || !(await this.writeStreamChunk(res, chunk))) {
          await reader.cancel();
          return {
            outcome: 'client_interrupted',
            body: Buffer.concat(chunks),
            firstByteMs,
            errorCode: 'stream_interrupted',
            errorMessage: '客户端连接在流式响应开始后中断'
          };
        }
      }
      res.end();
      return { outcome: 'complete', body: Buffer.concat(chunks), firstByteMs, errorCode: '', errorMessage: '' };
    } catch (error) {
      upstream.clearStageTimeout();
      const failure = upstream.failureFor(error);
      if (!committed) throw failure;
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return {
        outcome: failure.code === 'request_cancelled' ? 'client_interrupted' : 'upstream_failed',
        body: Buffer.concat(chunks),
        firstByteMs,
        errorCode: failure.code,
        errorMessage: failure.message
      };
    }
  }

  private waitForDrain(res: ServerResponse): Promise<boolean> {
    return new Promise((resolve) => {
      const cleanup = (): void => {
        res.removeListener('drain', onDrain);
        res.removeListener('close', onClose);
        res.removeListener('error', onError);
      };
      const finish = (drained: boolean): void => {
        cleanup();
        resolve(drained);
      };
      const onDrain = (): void => finish(true);
      const onClose = (): void => finish(false);
      const onError = (): void => finish(false);
      res.once('drain', onDrain);
      res.once('close', onClose);
      res.once('error', onError);
    });
  }

  private async writeStreamChunk(res: ServerResponse, chunk: Buffer): Promise<boolean> {
    if (res.writableEnded || res.destroyed) return false;
    return res.write(chunk) || this.waitForDrain(res);
  }

  private async poolState(): Promise<PoolState> {
    const now = Date.now();
    const all = (await this.dependencies.listRelays()).map((relay) => this.withRefreshedBalance(relay));
    const selectedIds = new Set(this.relayIds);
    const selected = all.filter((relay) => selectedIds.has(relay.id) && relay.enabled && relay.platform === this.platform);
    const eligible = selected.filter((relay) => !hasKnownExhaustedBalance(relay));
    const candidates = eligible.filter((relay) => !this.isCooling(relay.id, now));
    const exhausted = selected.length > 0 && selected.every(hasKnownExhaustedBalance);
    return {
      eligible,
      candidates,
      cooldownRelayCount: eligible.length - candidates.length,
      exhausted
    };
  }

  private updateStatusCounts(state: PoolState): void {
    this.eligibleRelayCount = state.candidates.length;
    this.cooldownRelayCount = state.cooldownRelayCount;
  }

  private validateSelection(relays: Relay[], relayIds: string[]): Relay[] {
    if (!relayIds.length) throw new Error('请先向号池添加至少一个中转站');
    const byId = new Map(relays.map((relay) => [relay.id, relay]));
    const selected = relayIds.map((id) => byId.get(id));
    if (selected.some((relay) => !relay)) throw new Error('号池中包含不存在的中转站');
    const resolved = selected as Relay[];
    if (resolved.some((relay) => !relay.enabled)) throw new Error('号池中包含已停用的中转站');
    const platforms = new Set(resolved.map((relay) => relay.platform));
    if (platforms.size !== 1) throw new Error('号池中的中转站类型必须一致，不能混用 OpenAI 和 Anthropic');
    return resolved;
  }

  private setModelMap(modelMap: Record<string, string[]>): void {
    this.modelSubsetByRelay.clear();
    this.normalizedModelEntries(modelMap, new Set(this.relayIds))
      .forEach((models, relayId) => this.modelSubsetByRelay.set(relayId, models));
  }

  private normalizedModelEntries(
    modelMap: Record<string, string[]>,
    allowedRelayIds: Set<string>
  ): Map<string, Set<string>> {
    const entries = new Map<string, Set<string>>();
    for (const [relayId, models] of Object.entries(modelMap)) {
      if (!allowedRelayIds.has(relayId)) throw new Error('模型映射只能包含本次添加的中转站');
      const subset = new Set(models.map((model) => model.trim()).filter(Boolean));
      if (subset.size) entries.set(relayId, subset);
    }
    return entries;
  }

  private modelMapRecord(): Record<string, string[]> {
    const record: Record<string, string[]> = {};
    for (const [relayId, subset] of this.modelSubsetByRelay) record[relayId] = [...subset];
    return record;
  }

  private relaySupportsModel(relayId: string, model: string): boolean {
    const subset = this.modelSubsetByRelay.get(relayId);
    if (!subset || !subset.size) return true;
    return subset.has(model.trim());
  }

  private rotateCandidates(candidates: Relay[]): Relay[] {
    if (!candidates.length) return [];
    const offset = this.roundRobinCursor % candidates.length;
    this.roundRobinCursor = (offset + 1) % candidates.length;
    return [...candidates.slice(offset), ...candidates.slice(0, offset)];
  }

  private orderCandidates(candidates: Relay[]): Relay[] {
    if (this.routingStrategy === 'round-robin') return this.rotateCandidates(candidates);
    const shuffled = [...candidates];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(this.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
    }
    return shuffled;
  }

  private isCooling(relayId: string, now = Date.now()): boolean {
    const until = this.coolingUntilByRelay.get(relayId);
    if (!until) return false;
    if (until <= now) {
      this.coolingUntilByRelay.delete(relayId);
      return false;
    }
    return true;
  }

  private setCooldown(relayId: string): void {
    if (!this.cooldownMs) return;
    this.coolingUntilByRelay.set(relayId, Date.now() + this.cooldownMs);
  }

  private shouldCooldown(failure: UpstreamFailure): boolean {
    if (failure.code === 'request_cancelled') return false;
    return failure.statusCode === null || failure.statusCode === 429 || failure.statusCode >= 500;
  }

  private scheduleBalanceRefresh(relay: Relay): Promise<void> {
    const existing = this.balanceRefreshesByRelay.get(relay.id);
    if (existing) return existing;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.balanceRefreshTimeoutMs);
    timeout.unref();
    this.balanceRefreshControllers.add(controller);
    const refresh = this.dependencies
      .refreshBalance(relay, controller.signal)
      .then((refreshed) => {
        if (!controller.signal.aborted) this.rememberRefreshedBalance(refreshed);
      })
      .catch(() => {
        // Balance refreshes refine later routing only; they must not affect the in-flight request.
      })
      .finally(() => {
        clearTimeout(timeout);
        this.balanceRefreshControllers.delete(controller);
        if (this.balanceRefreshesByRelay.get(relay.id) === refresh) this.balanceRefreshesByRelay.delete(relay.id);
      });
    this.balanceRefreshesByRelay.set(relay.id, refresh);
    return refresh;
  }

  private async waitForBalanceRefreshes(refreshes: Set<Promise<void>>, signal?: AbortSignal): Promise<void> {
    if (!refreshes.size || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timeout = setTimeout(finish, this.balanceRefreshTimeoutMs);
      timeout.unref();
      signal?.addEventListener('abort', finish, { once: true });
      void Promise.allSettled([...refreshes]).then(finish);
    });
  }

  private rememberRefreshedBalance(relay: Relay): void {
    if (relay.balance) this.refreshedBalancesByRelay.set(relay.id, relay.balance);
    else this.refreshedBalancesByRelay.delete(relay.id);
    this.updateSessionBalance(relay);
  }

  private withRefreshedBalance(relay: Relay): Relay {
    const refreshed = this.refreshedBalancesByRelay.get(relay.id);
    if (!refreshed) {
      this.updateSessionBalance(relay);
      return relay;
    }
    const storedAt = Date.parse(relay.balance?.queriedAt ?? '');
    const refreshedAt = Date.parse(refreshed.queriedAt);
    if (Number.isFinite(storedAt) && (!Number.isFinite(refreshedAt) || storedAt > refreshedAt)) {
      this.refreshedBalancesByRelay.delete(relay.id);
      this.updateSessionBalance(relay);
      return relay;
    }
    const merged = { ...relay, balance: refreshed };
    this.updateSessionBalance(merged);
    return merged;
  }

  private captureSessionBalances(relays: Relay[]): void {
    this.sessionBalancesByRelay.clear();
    relays.forEach((relay) => this.captureSessionBalance(relay));
  }

  private captureSessionBalance(relay: Relay): void {
    const balance = relay.balance;
    const remaining = balance?.success && balance.remaining !== null && Number.isFinite(balance.remaining)
      ? balance.remaining
      : null;
    this.sessionBalancesByRelay.set(relay.id, {
      relayId: relay.id,
      relayName: relay.name,
      unit: balance?.unit.trim() ?? '',
      initialBalance: remaining,
      currentBalance: remaining
    });
  }

  private updateSessionBalance(relay: Relay): void {
    const session = this.sessionBalancesByRelay.get(relay.id);
    const balance = relay.balance;
    if (!session || !balance?.success || balance.remaining === null || !Number.isFinite(balance.remaining)) return;
    session.currentBalance = balance.remaining;
    session.unit = balance.unit.trim();
  }

  private sessionBalanceDetails(): PoolRelayBalanceUsage[] {
    return [...this.sessionBalancesByRelay.values()].map((balance) => ({
      ...balance,
      consumedBalance: balance.initialBalance === null || balance.currentBalance === null
        ? null
        : Math.max(0, balance.initialBalance - balance.currentBalance)
    }));
  }

  private sessionBalanceSummary(details: PoolRelayBalanceUsage[]): PoolBalanceSummary[] {
    const totals = new Map<string, PoolBalanceSummary>();
    details.forEach((detail) => {
      if (detail.currentBalance === null) return;
      const current = totals.get(detail.unit) ?? { unit: detail.unit, currentBalance: 0, consumedBalance: 0 };
      current.currentBalance += detail.currentBalance;
      current.consumedBalance += detail.consumedBalance ?? 0;
      totals.set(detail.unit, current);
    });
    return [...totals.values()].sort((left, right) => left.unit.localeCompare(right.unit));
  }

  private assertStartCurrent(lifecycleVersion: number, signal: AbortSignal): void {
    if (signal.aborted || lifecycleVersion !== this.lifecycleVersion) throw new PoolStartCancelledError();
  }

  private async recordUsage(input: {
    requestId: string;
    details: RequestDetails | undefined;
    relay: Relay;
    status: 'success' | 'failed';
    statusCode: number | null;
    attempts: number;
    startedAt: number;
    firstByteMs: number;
    body: Buffer;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    if (!input.details) return;
    const tokens = usageFromResponseBody(input.body, input.details.stream);
    await this.persistUsage({
      id: input.requestId,
      createdAt: this.now().toISOString(),
      relayId: input.relay.id,
      relayName: input.relay.name,
      endpoint: input.details.endpoint,
      model: input.details.model || input.relay.model,
      status: input.status,
      statusCode: input.statusCode,
      attempts: input.attempts,
      firstByteMs: input.firstByteMs,
      durationMs: Math.round(nowMs() - input.startedAt),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedTokens: tokens.cachedTokens,
      totalTokens: tokens.totalTokens,
      cost: tokens.cost,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage
    });
  }

  private async recordPoolFailure(
    details: RequestDetails | undefined,
    requestId: string,
    startedAt: number,
    attempts: number,
    relay: Relay | undefined,
    errorCode: string,
    errorMessage = '',
    statusCode: number | null = null
  ): Promise<void> {
    if (!details) return;
    await this.persistUsage({
      id: requestId,
      createdAt: this.now().toISOString(),
      relayId: relay?.id ?? null,
      relayName: relay?.name ?? '号池',
      endpoint: details.endpoint,
      model: details.model || relay?.model || '',
      status: 'failed',
      statusCode,
      attempts,
      firstByteMs: null,
      durationMs: Math.round(nowMs() - startedAt),
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      totalTokens: null,
      cost: null,
      errorCode,
      errorMessage: errorMessage.slice(0, 500)
    });
  }

  private async persistUsage(record: PoolUsageRecord): Promise<void> {
    try {
      await this.dependencies.recordUsage?.(record);
    } catch {
      // Usage persistence must never interfere with a client-facing proxy response.
    }
  }

  private listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: LOOPBACK_HOST, port });
    });
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
}
