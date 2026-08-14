(() => {
  const extensionApi = globalThis.browser ?? globalThis.chrome;

  const NATIVE_HOST_NAME = 'com.relaypulse.host';
  const DEFAULT_API_URL = 'http://127.0.0.1:3100/api';
  const BACKEND_STATE_KEY = 'relayPulseBackendState';
  const HEALTH_TIMEOUT_MS = 4_000;
  const EXTENSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  const dataMode = document.querySelector('meta[name="relay-pulse-data-mode"]')?.getAttribute('content') ?? 'backend';
  const configuredFallbackApiUrl = document.querySelector('meta[name="relay-pulse-api-url"]')?.getAttribute('content');

  function isBrowserPromiseApi() {
    return typeof globalThis.browser !== 'undefined' && extensionApi === globalThis.browser;
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function messageFrom(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback;
  }

  function errorWithCode(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function normalizeApiUrl(value) {
    if (typeof value !== 'string' || value.length > 256) {
      throw errorWithCode('本机服务返回的 API 地址无效', 'invalid_api_url');
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      throw errorWithCode('本机服务返回的 API 地址无效', 'invalid_api_url');
    }

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
      throw errorWithCode('本机服务返回的 API 地址不受支持', 'invalid_api_url');
    }

    return url.toString().replace(/\/$/, '');
  }

  function normalizeExtensionToken(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' && EXTENSION_TOKEN_PATTERN.test(value)) return value;
    throw errorWithCode('本机服务返回的访问令牌无效', 'invalid_extension_token');
  }

  function fallbackApiUrl() {
    try {
      return normalizeApiUrl(configuredFallbackApiUrl || DEFAULT_API_URL);
    } catch {
      return DEFAULT_API_URL;
    }
  }

  function hasOnlyKeys(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
  }

  function parseNativeResponse(response) {
    if (!isRecord(response)) throw errorWithCode('本机服务返回了无效响应', 'invalid_native_response');

    if (response.ok === true) {
      if (
        !hasOnlyKeys(response, ['ok', 'apiUrl', 'extensionToken', 'reused']) ||
        typeof response.apiUrl !== 'string' ||
        typeof response.reused !== 'boolean'
      ) {
        throw errorWithCode('本机服务返回了无效响应', 'invalid_native_response');
      }
      return {
        apiUrl: normalizeApiUrl(response.apiUrl),
        extensionToken: normalizeExtensionToken(response.extensionToken),
        reused: response.reused
      };
    }

    if (
      response.ok !== false ||
      !hasOnlyKeys(response, ['ok', 'error']) ||
      !isRecord(response.error) ||
      !hasOnlyKeys(response.error, ['code', 'message']) ||
      typeof response.error.code !== 'string' ||
      !/^[a-z0-9_]{1,64}$/i.test(response.error.code) ||
      typeof response.error.message !== 'string' ||
      response.error.message.length > 500
    ) {
      throw errorWithCode('本机服务返回了无效响应', 'invalid_native_response');
    }

    throw errorWithCode(messageFrom(response.error.message, '无法启动本机服务'), response.error.code);
  }

  function sendNativeMessage(message) {
    if (!extensionApi?.runtime?.sendNativeMessage) {
      return Promise.reject(errorWithCode('当前浏览器不支持本机服务通信', 'native_messaging_unsupported'));
    }

    if (isBrowserPromiseApi()) return extensionApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message);

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const rejectOnce = (reason) => {
        if (settled) return;
        settled = true;
        reject(reason);
      };

      try {
        const result = extensionApi.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, (response) => {
          const lastError = extensionApi.runtime.lastError;
          if (lastError) {
            rejectOnce(errorWithCode(messageFrom(lastError.message, '无法连接本机服务'), 'native_host_unavailable'));
            return;
          }
          resolveOnce(response);
        });
        if (result && typeof result.then === 'function') result.then(resolveOnce, rejectOnce);
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async function writeState(state) {
    if (!extensionApi?.storage?.local) return;
    if (isBrowserPromiseApi()) {
      await extensionApi.storage.local.set({ [BACKEND_STATE_KEY]: state });
      return;
    }

    await new Promise((resolve, reject) => {
      try {
        const result = extensionApi.storage.local.set({ [BACKEND_STATE_KEY]: state }, () => {
          const lastError = extensionApi.runtime.lastError;
          if (lastError) reject(errorWithCode(messageFrom(lastError.message, '无法保存本机服务状态'), 'storage_failed'));
          else resolve();
        });
        if (result && typeof result.then === 'function') result.then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function readState() {
    if (!extensionApi?.storage?.local) return null;
    if (isBrowserPromiseApi()) {
      const value = await extensionApi.storage.local.get(BACKEND_STATE_KEY);
      return value?.[BACKEND_STATE_KEY] ?? null;
    }

    return new Promise((resolve, reject) => {
      try {
        const result = extensionApi.storage.local.get(BACKEND_STATE_KEY, (value) => {
          const lastError = extensionApi.runtime.lastError;
          if (lastError) reject(errorWithCode(messageFrom(lastError.message, '无法读取本机服务状态'), 'storage_failed'));
          else resolve(value?.[BACKEND_STATE_KEY] ?? null);
        });
        if (result && typeof result.then === 'function') result.then((value) => resolve(value?.[BACKEND_STATE_KEY] ?? null), reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  async function backendHealthcheck(apiUrl, extensionToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiUrl.replace(/\/api$/, '')}/api/health`, {
        signal: controller.signal,
        headers: extensionToken ? { 'X-Relay-Pulse-Extension-Token': extensionToken } : undefined
      });
      if (!response.ok) return false;
      const payload = await response.json().catch(() => null);
      return payload?.success === true && payload?.data?.status === 'ok' && payload.data.service === 'relay-pulse';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function successState(apiUrl, source, reused, extensionToken) {
    return {
      ok: true,
      apiUrl,
      error: null,
      source,
      extensionToken: extensionToken ?? null,
      reused: Boolean(reused),
      updatedAt: new Date().toISOString()
    };
  }

  function failureState(error) {
    return {
      ok: false,
      apiUrl: fallbackApiUrl(),
      error: {
        code: typeof error?.code === 'string' ? error.code : 'native_host_failed',
        message: messageFrom(error?.message, '无法启动本机服务')
      },
      source: 'unavailable',
      reused: false,
      updatedAt: new Date().toISOString()
    };
  }

  async function ensureBackend() {
    const fallbackUrl = fallbackApiUrl();
    if (dataMode === 'standalone') {
      return successState(fallbackUrl, 'standalone', true, null);
    }

    try {
      const response = await sendNativeMessage({ type: 'ensureBackend' });
      const { apiUrl, extensionToken, reused } = parseNativeResponse(response);
      if (!await backendHealthcheck(apiUrl, extensionToken)) {
        throw errorWithCode('本机服务启动后未通过健康检查', 'backend_unavailable');
      }

      const state = successState(apiUrl, 'native_host', reused, extensionToken);
      await writeState(state).catch(() => undefined);
      return state;
    } catch (error) {
      // Before the native host is installed, a user can still run the legacy backend manually.
      if (error?.code !== 'invalid_extension_token' && await backendHealthcheck(fallbackUrl, null)) {
        const state = successState(fallbackUrl, 'existing_backend', true, null);
        await writeState(state).catch(() => undefined);
        return state;
      }

      const state = failureState(error);
      await writeState(state).catch(() => undefined);
      return state;
    }
  }

  globalThis.RelayPulseNativeBackend = Object.freeze({
    nativeHostName: NATIVE_HOST_NAME,
    defaultApiUrl: fallbackApiUrl(),
    ensureBackend,
    getLastState: readState
  });
})();
