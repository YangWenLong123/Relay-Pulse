import type {
  ApiEnvelope,
  CustomPurityTestInput,
  PurityStreamEvent,
  PurityTestInput,
  PurityTestProgress,
  PurityTestResult
} from '../types';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { backendRequestHeaders, http } from './http';

const MAX_STREAM_LINE_LENGTH = 1_048_576;

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

export async function runPurityTest(
  relayId: string,
  value: PurityTestInput,
  signal?: AbortSignal
): Promise<PurityTestResult> {
  if (standaloneExtension) throw new Error('纯度检测需要在本地后端模式下运行');
  return (
    await http.post<ApiEnvelope<PurityTestResult>>(`/relays/${relayId}/purity-test`, value, {
      signal,
      timeout: 600_000
    })
  ).data.data;
}

function apiBaseUrl(): string {
  return typeof http.defaults.baseURL === 'string' && http.defaults.baseURL
    ? http.defaults.baseURL.replace(/\/+$/, '')
    : '/api';
}

function streamUrl(relayId: string): string {
  const baseUrl = apiBaseUrl();
  return `${baseUrl}/relays/${encodeURIComponent(relayId)}/purity-test/stream`;
}

function customStreamUrl(): string {
  return `${apiBaseUrl()}/purity-test/stream`;
}

function abortError(message: string): DOMException {
  return new DOMException(message || '请求已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError('请求已取消');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseStreamEvent(line: string, lineNumber: number): PurityStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`纯度检测流第 ${lineNumber} 行不是有效 JSON`);
  }

  if (!isRecord(value) || !isRecord(value.data)) {
    throw new Error(`纯度检测流第 ${lineNumber} 行缺少事件数据`);
  }
  if (value.type === 'progress' || value.type === 'result') return value as unknown as PurityStreamEvent;
  if (
    value.type === 'error'
    && (value.data.code === 'cancelled' || value.data.code === 'test_failed')
    && typeof value.data.message === 'string'
  ) {
    return value as unknown as PurityStreamEvent;
  }
  throw new Error(`纯度检测流第 ${lineNumber} 行包含未知事件`);
}

function responseErrorMessage(response: Response, body: string): string {
  const fallback = `纯度检测请求失败（HTTP ${response.status}）`;
  const trimmed = body.trim();
  if (!trimmed) return fallback;
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    return trimmed.slice(0, 500);
  }
  return fallback;
}

export async function runPurityTestStream(
  relayId: string,
  value: PurityTestInput,
  onProgress?: (progress: PurityTestProgress) => void,
  signal?: AbortSignal
): Promise<PurityTestResult> {
  if (standaloneExtension) throw new Error('纯度检测需要在本地后端模式下运行');
  throwIfAborted(signal);

  return consumePurityTestStream(streamUrl(relayId), value, onProgress, signal);
}

export async function runCustomPurityTest(
  value: CustomPurityTestInput,
  signal?: AbortSignal
): Promise<PurityTestResult> {
  if (standaloneExtension) throw new Error('纯度检测需要在本地后端模式下运行');
  return (
    await http.post<ApiEnvelope<PurityTestResult>>('/purity-test', value, {
      signal,
      timeout: 600_000
    })
  ).data.data;
}

export async function runCustomPurityTestStream(
  value: CustomPurityTestInput,
  onProgress?: (progress: PurityTestProgress) => void,
  signal?: AbortSignal
): Promise<PurityTestResult> {
  if (standaloneExtension) throw new Error('纯度检测需要在本地后端模式下运行');
  throwIfAborted(signal);
  return consumePurityTestStream(customStreamUrl(), value, onProgress, signal);
}

async function consumePurityTestStream(
  url: string,
  value: PurityTestInput | CustomPurityTestInput,
  onProgress?: (progress: PurityTestProgress) => void,
  signal?: AbortSignal
): Promise<PurityTestResult> {
  const response = await globalThis.fetch(url, {
    method: 'POST',
    headers: backendRequestHeaders({
      Accept: 'application/x-ndjson',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(value),
    signal
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(responseErrorMessage(response, body));
  }
  if (!response.body) throw new Error('纯度检测响应不包含可读取的数据流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let lineNumber = 0;
  let streamEnded = false;

  const handleLine = (rawLine: string): PurityTestResult | undefined => {
    if (rawLine.length > MAX_STREAM_LINE_LENGTH) throw new Error('纯度检测流单行数据过大');
    const line = rawLine.trim();
    if (!line) return undefined;
    lineNumber += 1;
    const event = parseStreamEvent(line, lineNumber);
    if (event.type === 'progress') {
      onProgress?.(event.data);
      return undefined;
    }
    if (event.type === 'error') {
      if (event.data.code === 'cancelled') throw abortError(event.data.message);
      throw new Error(event.data.message || '纯度检测失败');
    }
    return event.data;
  };

  try {
    while (!streamEnded) {
      throwIfAborted(signal);
      const { done, value: chunk } = await reader.read();
      if (done) {
        streamEnded = true;
        continue;
      }
      throwIfAborted(signal);
      pending += decoder.decode(chunk, { stream: true });

      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const result = handleLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        if (result) {
          await reader.cancel().catch(() => undefined);
          return result;
        }
        newlineIndex = pending.indexOf('\n');
      }
      if (pending.length > MAX_STREAM_LINE_LENGTH) throw new Error('纯度检测流单行数据过大');
    }

    pending += decoder.decode();
    const result = handleLine(pending);
    if (result) return result;
    throw new Error('纯度检测流在返回最终结果前已结束');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
