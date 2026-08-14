import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_MESSAGING_HOST_NAME = 'com.relaypulse.host';
export const CHROMIUM_EXTENSION_ID = 'nplnfohmiahjljnemfcjklclaoecogpi';
export const FIREFOX_EXTENSION_ID = 'relay-pulse@local';
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

const DEFAULT_SERVER_PORT = 3100;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const EXTENSION_ACCESS_TOKEN_KEY = 'EXTENSION_ACCESS_TOKEN';
const extensionAccessTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export class NativeHostError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeHostError';
    this.code = code;
  }
}

function asNativeHostError(error, fallbackCode, fallbackMessage) {
  if (error instanceof NativeHostError) return error;
  return new NativeHostError(fallbackCode, error instanceof Error && error.message ? error.message : fallbackMessage);
}

function nativeErrorResponse(error) {
  const nativeError = asNativeHostError(error, 'internal_error', '本机服务启动器发生未知错误');
  return {
    ok: false,
    error: {
      code: nativeError.code,
      message: nativeError.message
    }
  };
}

function parseNativeRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new NativeHostError('invalid_request', 'Native Messaging 请求必须是 JSON 对象');
  }

  const keys = Object.keys(message);
  if (keys.some((key) => key !== 'type')) {
    throw new NativeHostError('invalid_request', 'Native Messaging 请求包含不支持的字段');
  }
  if (message.type !== 'ensureBackend' && message.type !== 'health') {
    throw new NativeHostError('unsupported_request', '仅支持 ensureBackend 和 health 请求');
  }
  return {
    type: message.type
  };
}

export function encodeNativeMessage(message, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  let payload;
  try {
    payload = Buffer.from(JSON.stringify(message), 'utf8');
  } catch {
    throw new NativeHostError('invalid_response', 'Native Messaging 响应无法序列化');
  }

  if (payload.length > maxBytes) {
    throw new NativeHostError('message_too_large', `Native Messaging 消息不能超过 ${maxBytes} 字节`);
  }

  const frame = Buffer.allocUnsafe(4 + payload.length);
  // Chromium on the supported macOS target expects a little-endian uint32 length prefix.
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createNativeMessageDecoder(onMessage, maxBytes = MAX_NATIVE_MESSAGE_BYTES) {
  let buffered = Buffer.alloc(0);

  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        throw new NativeHostError('invalid_frame', 'Native Messaging 输入不是二进制帧');
      }
      buffered = buffered.length ? Buffer.concat([buffered, Buffer.from(chunk)]) : Buffer.from(chunk);

      while (buffered.length >= 4) {
        const messageLength = buffered.readUInt32LE(0);
        if (messageLength > maxBytes) {
          throw new NativeHostError('message_too_large', `Native Messaging 消息不能超过 ${maxBytes} 字节`);
        }
        if (buffered.length < 4 + messageLength) return;

        const payload = buffered.subarray(4, 4 + messageLength);
        buffered = buffered.subarray(4 + messageLength);
        let message;
        try {
          message = JSON.parse(payload.toString('utf8'));
        } catch {
          throw new NativeHostError('invalid_json', 'Native Messaging 消息不是有效 JSON');
        }
        onMessage(message);
      }
    },
    finish() {
      if (buffered.length) {
        throw new NativeHostError('incomplete_frame', 'Native Messaging 输入在完整帧结束前中断');
      }
    }
  };
}

export async function writeNativeMessage(output, message) {
  const frame = encodeNativeMessage(message);
  if (output.write(frame)) return;
  await once(output, 'drain');
}

function parseEnvValue(source, key) {
  const expression = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm');
  const match = expression.exec(source);
  if (!match) return undefined;

  const value = match[1].trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    const closingQuote = value.lastIndexOf('"');
    if (closingQuote > 0) {
      const quoted = value.slice(0, closingQuote + 1);
      try {
        return JSON.parse(quoted);
      } catch {
        return value.slice(1, closingQuote);
      }
    }
  }
  if (value.startsWith("'")) {
    const closingQuote = value.lastIndexOf("'");
    return closingQuote > 0 ? value.slice(1, closingQuote) : value.slice(1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function validPort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined;
}

function extensionAccessToken(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !extensionAccessTokenPattern.test(value)) {
    throw new NativeHostError('invalid_extension_token', 'EXTENSION_ACCESS_TOKEN 必须是有效的随机访问令牌');
  }
  return value;
}

export function generateExtensionAccessToken(randomBytesImpl = randomBytes) {
  return randomBytesImpl(32).toString('base64url');
}

export function nativeHostDirectory({ executablePath = process.execPath, argv = process.argv } = {}) {
  // A browser appends its origin (or Firefox manifest/add-on arguments) after
  // the executable. Only direct source execution has a JavaScript entry path.
  const directScriptPath = argv[1];
  if (typeof directScriptPath === 'string' && /\.(?:mjs|cjs|js)$/i.test(directScriptPath)) {
    return path.dirname(path.resolve(directScriptPath));
  }
  return path.dirname(path.resolve(executablePath));
}

export function nativeHostExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'relay-pulse-native-host.exe' : 'relay-pulse-native-host';
}

export function backendExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'relay-pulse-start.exe' : 'relay-pulse-start';
}

export async function resolveBackendSettings({
  hostDirectory = nativeHostDirectory(),
  environment = process.env,
  platform = process.platform,
  readFileImpl = readFile
} = {}) {
  const resolvedHostDirectory = path.resolve(hostDirectory);
  const environmentPath = path.join(resolvedHostDirectory, '.env');
  let sourceEnvironment = '';

  try {
    sourceEnvironment = await readFileImpl(environmentPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code !== 'ENOENT') {
      throw new NativeHostError('config_read_failed', '无法读取本机后端的 .env 配置');
    }
  }

  const port = validPort(environment.SERVER_PORT)
    ?? validPort(parseEnvValue(sourceEnvironment, 'SERVER_PORT'))
    ?? DEFAULT_SERVER_PORT;
  const tokenFromEnvironment = environment[EXTENSION_ACCESS_TOKEN_KEY];
  const tokenFromFile = parseEnvValue(sourceEnvironment, EXTENSION_ACCESS_TOKEN_KEY);
  const configuredExtensionToken = extensionAccessToken(tokenFromEnvironment ?? tokenFromFile);
  const executablePath = path.resolve(resolvedHostDirectory, backendExecutableName(platform));
  if (path.dirname(executablePath) !== resolvedHostDirectory) {
    throw new NativeHostError('invalid_backend_path', '本机后端路径无效');
  }

  const apiUrl = `http://127.0.0.1:${port}/api`;
  return {
    apiUrl,
    healthUrl: `${apiUrl}/health`,
    executablePath,
    environmentPath,
    extensionToken: configuredExtensionToken,
    hostDirectory: resolvedHostDirectory,
    port
  };
}

export async function ensureExtensionAccessToken(
  settings,
  { appendFileImpl = appendFile, randomBytesImpl = randomBytes } = {}
) {
  if (settings.extensionToken) return settings;

  const extensionToken = generateExtensionAccessToken(randomBytesImpl);
  await appendFileImpl(settings.environmentPath, `\n${EXTENSION_ACCESS_TOKEN_KEY}=${extensionToken}\n`, 'utf8');
  return { ...settings, extensionToken };
}

export async function checkBackendHealth(healthUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  extensionToken
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new NativeHostError('fetch_unavailable', '当前运行时不支持本机健康检查');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(healthUrl, {
      signal: controller.signal,
      ...(extensionToken ? { headers: { 'X-Relay-Pulse-Extension-Token': extensionToken } } : {})
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => undefined);
    return payload?.success === true && payload?.data?.status === 'ok' && payload.data.service === 'relay-pulse';
  } finally {
    clearTimeout(timeout);
  }
}

export async function waitForBackendHealth({
  healthUrl,
  checkHealth = checkBackendHealth,
  extensionToken,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  now = () => Date.now()
}) {
  const deadline = now() + timeoutMs;
  let lastError;

  while (now() <= deadline) {
    try {
      if (await checkHealth(healthUrl, { extensionToken })) return;
    } catch (error) {
      lastError = error;
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  const detail = lastError instanceof Error && lastError.message ? `：${lastError.message}` : '';
  throw new NativeHostError('backend_start_timeout', `Relay Pulse 后端在 ${timeoutMs}ms 内未通过健康检查${detail}`);
}

export async function launchBackend({
  executablePath,
  hostDirectory,
  accessImpl = access,
  spawnImpl = spawnChild
}) {
  try {
    await accessImpl(executablePath);
  } catch {
    throw new NativeHostError('backend_not_found', '找不到与 Native Messaging host 同目录的 relay-pulse-start');
  }

  let child;
  try {
    child = spawnImpl(executablePath, [], {
      cwd: hostDirectory,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
  } catch (error) {
    throw asNativeHostError(error, 'backend_launch_failed', '无法启动 Relay Pulse 后端');
  }

  if (!child || typeof child.once !== 'function') {
    child?.unref?.();
    return;
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      child.removeListener?.('spawn', onSpawn);
      reject(asNativeHostError(error, 'backend_launch_failed', '无法启动 Relay Pulse 后端'));
    };
    const onSpawn = () => {
      child.removeListener?.('error', onError);
      resolve();
    };
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
  child.unref?.();
}

export async function ensureBackend({
  resolveSettings = resolveBackendSettings,
  ensureExtensionToken = ensureExtensionAccessToken,
  checkHealth = checkBackendHealth,
  waitForHealth = waitForBackendHealth,
  launch = launchBackend,
  ...settingsOptions
} = {}) {
  const settings = await resolveSettings(settingsOptions);
  try {
    if (await checkHealth(settings.healthUrl, { extensionToken: settings.extensionToken })) {
      return { apiUrl: settings.apiUrl, extensionToken: settings.extensionToken ?? null, reused: true };
    }
  } catch {
    // A failed first probe is expected when the service is not running yet.
  }

  const launchSettings = await ensureExtensionToken(settings, {
    appendFileImpl: settingsOptions.appendFileImpl,
    randomBytesImpl: settingsOptions.randomBytesImpl
  });
  await launch({
    executablePath: launchSettings.executablePath,
    hostDirectory: launchSettings.hostDirectory,
    accessImpl: settingsOptions.accessImpl,
    spawnImpl: settingsOptions.spawnImpl
  });
  await waitForHealth({
    healthUrl: launchSettings.healthUrl,
    checkHealth,
    extensionToken: launchSettings.extensionToken,
    timeoutMs: settingsOptions.startupTimeoutMs,
    pollIntervalMs: settingsOptions.pollIntervalMs,
    sleep: settingsOptions.sleep,
    now: settingsOptions.now
  });
  return { apiUrl: launchSettings.apiUrl, extensionToken: launchSettings.extensionToken, reused: false };
}

export async function handleNativeRequest(message, {
  ensureBackendImpl = ensureBackend,
  resolveSettings = resolveBackendSettings,
  checkHealth = checkBackendHealth
} = {}) {
  let request;
  try {
    request = parseNativeRequest(message);
  } catch (error) {
    return nativeErrorResponse(error);
  }

  try {
    if (request.type === 'ensureBackend') {
      const result = await ensureBackendImpl();
      return {
        ok: true,
        apiUrl: result.apiUrl,
        extensionToken: result.extensionToken ?? null,
        reused: result.reused
      };
    }

    const settings = await resolveSettings();
    const running = await checkHealth(settings.healthUrl, { extensionToken: settings.extensionToken });
    if (!running) {
      return nativeErrorResponse(
        new NativeHostError('backend_unavailable', 'Relay Pulse 后端尚未启动')
      );
    }
    return {
      ok: true,
      apiUrl: settings.apiUrl,
      extensionToken: settings.extensionToken ?? null,
      reused: true
    };
  } catch (error) {
    return nativeErrorResponse(error);
  }
}

export async function runNativeMessagingHost({
  input = process.stdin,
  output = process.stdout,
  ensureBackendImpl = ensureBackend,
  resolveSettings = resolveBackendSettings,
  checkHealth = checkBackendHealth
} = {}) {
  let responseChain = Promise.resolve();
  const decoder = createNativeMessageDecoder((message) => {
    responseChain = responseChain.then(async () => {
      const response = await handleNativeRequest(message, { ensureBackendImpl, resolveSettings, checkHealth });
      await writeNativeMessage(output, response);
    });
  });

  await new Promise((resolve, reject) => {
    input.on('data', (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        input.pause?.();
        reject(error);
      }
    });
    input.once('end', resolve);
    input.once('error', reject);
  });
  decoder.finish();
  await responseChain;
}
