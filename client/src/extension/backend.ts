import { isBackendExtensionRuntime } from '../utils/runtime';

const NATIVE_ENSURE_TYPE = 'ensureBackend';
const NATIVE_HOST_NAME = 'com.relaypulse.host';
const DEFAULT_API_URL = 'http://127.0.0.1:3100/api';

interface ExtensionRuntime {
  lastError?: { message?: string };
  sendNativeMessage(hostName: string, message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
}

interface ExtensionApi {
  runtime?: ExtensionRuntime;
}

interface NativeHostError {
  code?: string;
  message?: string;
}

interface NativeHostState {
  ok?: boolean;
  apiUrl?: string;
  extensionToken?: string | null;
  error?: NativeHostError;
}

export interface ExtensionBackendState {
  ok: boolean;
  apiUrl?: string;
  extensionToken?: string | null;
  error?: {
    code: string;
    message: string;
  };
}

function extensionApi(): ExtensionApi | undefined {
  const runtime = globalThis as typeof globalThis & { browser?: ExtensionApi; chrome?: ExtensionApi };
  return runtime.browser ?? runtime.chrome;
}

function usesPromiseApi(api: ExtensionApi): boolean {
  const runtime = globalThis as typeof globalThis & { browser?: ExtensionApi };
  return runtime.browser === api;
}

function messageFrom(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
}

function errorState(code: string, message: string): ExtensionBackendState {
  return { ok: false, error: { code, message } };
}

function normalizeApiUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 256) return undefined;

  try {
    const url = new URL(value);
    const port = Number(url.port);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.username ||
      url.password ||
      url.pathname !== '/api' ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function normalizeExtensionToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  const error = new Error('本机服务返回的访问令牌无效') as Error & { code?: string };
  error.code = 'invalid_extension_token';
  throw error;
}

const configuredFallbackApiUrl = normalizeApiUrl(import.meta.env.VITE_API_BASE_URL) ?? DEFAULT_API_URL;

function normalizeState(value: unknown): ExtensionBackendState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return errorState('invalid_native_response', '扩展后台返回了无效的本机服务状态');
  }

  const state = value as NativeHostState;
  if (state.ok === true) {
    const apiUrl = normalizeApiUrl(state.apiUrl);
    if (apiUrl) return { ok: true, apiUrl, extensionToken: normalizeExtensionToken(state.extensionToken) };
    return errorState('invalid_api_url', '本机服务返回的 API 地址无效');
  }

  return errorState(
    typeof state.error?.code === 'string' && /^[a-z0-9_]{1,64}$/i.test(state.error.code)
      ? state.error.code
      : 'native_host_failed',
    messageFrom(state.error?.message, '无法启动本机服务')
  );
}

async function sendEnsureMessage(api: ExtensionApi): Promise<unknown> {
  const runtime = api.runtime;
  if (!runtime?.sendNativeMessage) throw new Error('当前浏览器不支持本机服务通信');

  if (usesPromiseApi(api)) return runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: NATIVE_ENSURE_TYPE });

  return new Promise((resolve, reject) => {
    let settled = false;
    const resolveOnce = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const rejectOnce = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      reject(reason);
    };

    try {
      const result = runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: NATIVE_ENSURE_TYPE }, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          rejectOnce(new Error(messageFrom(lastError.message, '无法连接扩展后台服务')));
          return;
        }
        resolveOnce(response);
      });
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        void (result as Promise<unknown>).then(resolveOnce, rejectOnce);
      }
    } catch (error) {
      rejectOnce(error);
    }
  });
}

async function isHealthy(apiUrl: string, extensionToken?: string | null): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${apiUrl}/health`, {
      signal: controller.signal,
      headers: extensionToken ? { 'X-Relay-Pulse-Extension-Token': extensionToken } : undefined
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => undefined) as { success?: unknown; data?: { status?: unknown; service?: unknown } } | undefined;
    return payload?.success === true && payload.data?.status === 'ok' && payload.data.service === 'relay-pulse';
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function requiresExtensionBackend(): boolean {
  return isBackendExtensionRuntime(
    import.meta.env.VITE_BUILD_TARGET,
    typeof window === 'undefined' ? '' : window.location.protocol,
    import.meta.env.VITE_EXTENSION_DATA_MODE
  );
}

export async function ensureExtensionBackend(): Promise<ExtensionBackendState> {
  if (!requiresExtensionBackend()) return { ok: true };

  const api = extensionApi();
  if (!api) return errorState('native_messaging_unsupported', '当前浏览器不支持本机服务通信');

  try {
    return normalizeState(await sendEnsureMessage(api));
  } catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code === 'invalid_extension_token') {
      return errorState(code, messageFrom(error instanceof Error ? error.message : undefined, '本机服务返回的访问令牌无效'));
    }
    if (await isHealthy(configuredFallbackApiUrl)) {
      return { ok: true, apiUrl: configuredFallbackApiUrl, extensionToken: null };
    }
    return errorState('native_host_unavailable', messageFrom(error instanceof Error ? error.message : undefined, '无法连接本机服务组件'));
  }
}
