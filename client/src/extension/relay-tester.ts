import type { RelayProtocol, TestErrorType, TestResult } from '../types';
import { endpointUrl, type StoredRelay } from './relay-utils';

interface AttemptFailure extends Error {
  statusCode: number | null;
  errorType: Exclude<TestErrorType, null>;
}

interface AttemptResult {
  responseText: string;
  statusCode: number;
  firstByteDuration: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeFailure(
  message: string,
  errorType: Exclude<TestErrorType, null>,
  statusCode: number | null = null
): AttemptFailure {
  return Object.assign(new Error(message), { statusCode, errorType });
}

function sanitizeSecret(value: string, secret: string): string {
  return (secret ? value.split(secret).join('***') : value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').slice(0, 500);
}

function compactErrorPayload(payload: string, apiKey: string): string {
  const sanitized = sanitizeSecret(payload, apiKey).replace(/\s+/g, ' ').trim();
  try {
    const parsed: unknown = JSON.parse(sanitized);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      if (typeof error.message === 'string') return error.message.slice(0, 500);
    }
  } catch {
    // Non-JSON upstream responses are returned as a compact sanitized excerpt.
  }
  return sanitized.slice(0, 500);
}

function statusError(status: number, payload: string, apiKey: string): AttemptFailure {
  const compact = compactErrorPayload(payload, apiKey);
  if (status === 401 || status === 403) return makeFailure('API Key 无效或没有访问权限', 'auth', status);
  if (status === 429) return makeFailure('请求频率受限或额度不足', 'rate_limit', status);
  if (/model.{0,80}(not found|does not exist|invalid|unsupported|not available|不存在|无效)/i.test(compact)) {
    return makeFailure('请求的模型不存在或不可用', 'model_not_found', status);
  }
  if (status === 404) return makeFailure('接口地址不存在，请检查 Base URL', 'not_found', status);
  if (status >= 500) return makeFailure(`中转站服务异常${compact ? `：${compact}` : ''}`, 'server', status);
  return makeFailure(`请求失败（HTTP ${status}）${compact ? `：${compact}` : ''}`, 'http_error', status);
}

function errorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth += 1) {
    if (typeof current.code === 'string') return current.code.toUpperCase();
    current = current.cause;
  }
  return '';
}

function classifyNetworkError(error: unknown): Exclude<TestErrorType, null> {
  const code = errorCode(error);
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA'].includes(code)) return 'dns';
  if (code.includes('CERT') || code.includes('TLS') || code.includes('SSL')) return 'tls';
  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code) ||
    code.startsWith('UND_ERR_CONNECT')
  ) {
    return 'connection';
  }
  return 'network';
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!isRecord(part)) return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.output_text === 'string') return part.output_text;
      return '';
    })
    .join('');
}

export function extractResponseText(payload: unknown): string {
  if (!isRecord(payload)) return '';
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  if (Array.isArray(payload.choices)) {
    const choice = payload.choices.find(isRecord);
    if (choice) {
      const message = isRecord(choice.message) ? choice.message : undefined;
      const text = contentText(message?.content) || contentText(choice.text);
      if (text.trim()) return text.trim();
    }
  }
  if (Array.isArray(payload.output)) {
    const text = payload.output
      .map((item) => {
        if (!isRecord(item)) return '';
        return contentText(item.content) || contentText(item.text) || contentText(item.output_text);
      })
      .join('');
    if (text.trim()) return text.trim();
  }
  return (contentText(payload.content) || contentText(payload.response)).trim();
}

export function extractModelIds(payload: unknown): string[] {
  const candidates = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : [];
  const ids = candidates.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!isRecord(item)) return [];
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
    return id ? [id] : [];
  });
  return [...new Set(ids)].sort();
}

function shouldAutoFallback(error: unknown): boolean {
  const type = (error as Partial<AttemptFailure>).errorType;
  return type === 'not_found' || type === 'http_error' || type === 'invalid_response';
}

function createId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface RelayTestClient {
  test(
    relay: StoredRelay,
    options?: { model?: string; message?: string; protocol?: RelayProtocol; signal?: AbortSignal }
  ): Promise<TestResult>;
  discoverModels(relay: Pick<StoredRelay, 'baseUrl' | 'apiKey' | 'timeout'>, signal?: AbortSignal): Promise<string[]>;
}

export class ExtensionRelayTester implements RelayTestClient {
  // Chrome requires the native fetch method to retain its global receiver.
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async test(
    relay: StoredRelay,
    options: { model?: string; message?: string; protocol?: RelayProtocol; signal?: AbortSignal } = {}
  ): Promise<TestResult> {
    const model = options.model?.trim() || relay.model;
    const message = options.message?.trim() || 'hi';
    const requestedProtocol = options.protocol ?? relay.protocol;
    const startedAt = performance.now();
    let usedProtocol: Exclude<RelayProtocol, 'auto'> = requestedProtocol === 'chat' ? 'chat' : 'responses';
    try {
      let attempt: AttemptResult;
      if (requestedProtocol === 'auto') {
        try {
          attempt = await this.attempt(relay, model, message, 'responses', options.signal);
        } catch (error) {
          if (!shouldAutoFallback(error)) throw error;
          usedProtocol = 'chat';
          attempt = await this.attempt(relay, model, message, 'chat', options.signal);
        }
      } else {
        usedProtocol = requestedProtocol;
        attempt = await this.attempt(relay, model, message, requestedProtocol, options.signal);
      }
      return this.result(relay, model, usedProtocol, startedAt, {
        success: true,
        statusCode: attempt.statusCode,
        responseText: attempt.responseText.slice(0, 8000),
        firstByteDuration: attempt.firstByteDuration,
        errorType: null,
        errorMessage: ''
      });
    } catch (error) {
      const failure = error as Partial<AttemptFailure>;
      return this.result(relay, model, usedProtocol, startedAt, {
        success: false,
        statusCode: failure.statusCode ?? null,
        responseText: '',
        firstByteDuration: null,
        errorType: failure.errorType ?? classifyNetworkError(error),
        errorMessage: sanitizeSecret(failure.message || '无法连接到中转站', relay.apiKey)
      });
    }
  }

  async discoverModels(
    relay: Pick<StoredRelay, 'baseUrl' | 'apiKey' | 'timeout'>,
    signal?: AbortSignal
  ): Promise<string[]> {
    return this.withTimeout(relay.timeout, signal, '模型探测', async (requestSignal) => {
      const response = await this.fetcher(endpointUrl(relay.baseUrl, '/v1/models'), {
        headers: { Authorization: `Bearer ${relay.apiKey}`, Accept: 'application/json' },
        signal: requestSignal
      });
      const body = await response.text();
      if (!response.ok) throw statusError(response.status, body, relay.apiKey);
      try {
        return extractModelIds(JSON.parse(body));
      } catch {
        throw makeFailure('模型列表返回了无法解析的内容', 'invalid_response', response.status);
      }
    }, relay.apiKey);
  }

  private async attempt(
    relay: StoredRelay,
    model: string,
    message: string,
    protocol: Exclude<RelayProtocol, 'auto'>,
    signal?: AbortSignal
  ): Promise<AttemptResult> {
    const startedAt = performance.now();
    return this.withTimeout(relay.timeout, signal, '连接测试', async (requestSignal) => {
      const body = protocol === 'responses'
        ? { model, input: message, stream: false }
        : { model, messages: [{ role: 'user', content: message }], stream: false };
      const response = await this.fetcher(
        endpointUrl(relay.baseUrl, protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions'),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${relay.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(body),
          signal: requestSignal
        }
      );
      const firstByteDuration = Math.round(performance.now() - startedAt);
      const raw = await response.text();
      if (!response.ok) throw statusError(response.status, raw, relay.apiKey);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw makeFailure('接口返回了非 JSON 内容', 'invalid_response', response.status);
      }
      const responseText = extractResponseText(payload);
      if (!responseText) throw makeFailure('接口返回成功，但模型回复为空', 'invalid_response', response.status);
      return { responseText, statusCode: response.status, firstByteDuration };
    }, relay.apiKey);
  }

  private async withTimeout<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    label: string,
    worker: (signal: AbortSignal) => Promise<T>,
    apiKey: string
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await worker(controller.signal);
    } catch (error) {
      if ((error as Partial<AttemptFailure>).errorType) throw error;
      if (controller.signal.aborted) {
        throw makeFailure(`${label}${timedOut ? '超时' : '已取消'}`, timedOut ? 'timeout' : 'cancelled');
      }
      throw makeFailure(sanitizeSecret((error as Error).message || `${label}失败`, apiKey), classifyNetworkError(error));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private result(
    relay: StoredRelay,
    model: string,
    protocol: Exclude<RelayProtocol, 'auto'>,
    startedAt: number,
    result: Pick<TestResult, 'success' | 'statusCode' | 'responseText' | 'firstByteDuration' | 'errorType' | 'errorMessage'>
  ): TestResult {
    return {
      id: createId(),
      relayId: relay.id,
      relayName: relay.name,
      model,
      protocol,
      totalDuration: Math.round(performance.now() - startedAt),
      dnsDuration: null,
      tcpDuration: null,
      tlsDuration: null,
      testedAt: new Date().toISOString(),
      ...result
    };
  }
}
