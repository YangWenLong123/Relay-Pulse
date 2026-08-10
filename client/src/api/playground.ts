import type { PlaygroundCompletion, PlaygroundInput, PlaygroundStreamEvent } from '../types';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { http } from './http';

const MAX_STREAM_LINE_LENGTH = 2 * 1024 * 1024;

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

function apiBaseUrl(): string {
  return typeof http.defaults.baseURL === 'string' && http.defaults.baseURL
    ? http.defaults.baseURL.replace(/\/+$/, '')
    : '/api';
}

function abortError(message: string): DOMException {
  return new DOMException(message || '模型回复已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw abortError('模型回复已取消');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(line: string, lineNumber: number): PlaygroundStreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`游乐场响应流第 ${lineNumber} 行不是有效 JSON`);
  }
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new Error(`游乐场响应流第 ${lineNumber} 行缺少事件数据`);
  }
  if (value.type === 'delta' && typeof value.data.text === 'string') return value as unknown as PlaygroundStreamEvent;
  if (value.type === 'done') return value as unknown as PlaygroundStreamEvent;
  if (
    value.type === 'error'
    && (value.data.code === 'cancelled' || value.data.code === 'generation_failed')
    && typeof value.data.message === 'string'
  ) {
    return value as unknown as PlaygroundStreamEvent;
  }
  throw new Error(`游乐场响应流第 ${lineNumber} 行包含未知事件`);
}

function responseErrorMessage(response: Response, body: string): string {
  const fallback = `游乐场请求失败（HTTP ${response.status}）`;
  const trimmed = body.trim();
  if (!trimmed) return fallback;
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (isRecord(payload) && typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  } catch {
    return trimmed.slice(0, 500);
  }
  return fallback;
}

export async function streamPlaygroundReply(
  relayId: string,
  input: PlaygroundInput,
  onDelta?: (text: string) => void,
  signal?: AbortSignal
): Promise<PlaygroundCompletion> {
  if (standaloneExtension) throw new Error('游乐场需要在本地后端模式下运行');
  throwIfAborted(signal);
  const response = await globalThis.fetch(`${apiBaseUrl()}/relays/${encodeURIComponent(relayId)}/playground/stream`, {
    method: 'POST',
    headers: {
      Accept: 'application/x-ndjson',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(input),
    signal
  });
  if (!response.ok) throw new Error(responseErrorMessage(response, await response.text()));
  if (!response.body) throw new Error('游乐场响应不包含可读取的数据流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let lineNumber = 0;
  const handleLine = (rawLine: string): PlaygroundCompletion | undefined => {
    if (rawLine.length > MAX_STREAM_LINE_LENGTH) throw new Error('游乐场响应流单行数据过大');
    const line = rawLine.trim();
    if (!line) return undefined;
    lineNumber += 1;
    const event = parseEvent(line, lineNumber);
    if (event.type === 'delta') {
      onDelta?.(event.data.text);
      return undefined;
    }
    if (event.type === 'error') {
      if (event.data.code === 'cancelled') throw abortError(event.data.message);
      throw new Error(event.data.message || '模型生成失败');
    }
    return event.data;
  };

  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const result = handleLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (result) {
          await reader.cancel().catch(() => undefined);
          return result;
        }
        newline = pending.indexOf('\n');
      }
      if (pending.length > MAX_STREAM_LINE_LENGTH) throw new Error('游乐场响应流单行数据过大');
    }
    pending += decoder.decode();
    const result = handleLine(pending);
    if (result) return result;
    throw new Error('游乐场响应流在完成前已结束');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
