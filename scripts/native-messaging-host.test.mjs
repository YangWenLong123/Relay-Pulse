import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  checkBackendHealth,
  createNativeMessageDecoder,
  encodeNativeMessage,
  ensureBackend,
  ensureExtensionAccessToken,
  handleNativeRequest,
  nativeHostDirectory,
  resolveBackendSettings,
  runNativeMessagingHost
} from './native-messaging-host.mjs';

const execFileAsync = promisify(execFile);
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

test('uses a little-endian length prefix and accepts fragmented Native Messaging frames', () => {
  const frame = encodeNativeMessage({ type: 'ensureBackend' });
  const payloadLength = Buffer.byteLength(JSON.stringify({ type: 'ensureBackend' }));
  assert.equal(frame.readUInt32LE(0), payloadLength);

  const messages = [];
  const decoder = createNativeMessageDecoder((message) => messages.push(message));
  decoder.push(frame.subarray(0, 2));
  decoder.push(frame.subarray(2, 7));
  decoder.push(frame.subarray(7));
  decoder.finish();
  assert.deepEqual(messages, [{ type: 'ensureBackend' }]);
});

test('uses the packaged executable directory when the browser appends its launch arguments', async () => {
  assert.equal(
    nativeHostDirectory({
      executablePath: '/Applications/Relay Pulse/relay-pulse-native-host',
      argv: ['/Applications/Relay Pulse/relay-pulse-native-host', 'chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi/']
    }),
    '/Applications/Relay Pulse'
  );
  const settings = await resolveBackendSettings({
    hostDirectory: '/Applications/Relay Pulse',
    environment: {},
    readFileImpl: async () => 'SERVER_PORT=4123 # native host test'
  });
  assert.equal(settings.apiUrl, 'http://127.0.0.1:4123/api');
  assert.equal(settings.executablePath, '/Applications/Relay Pulse/relay-pulse-start');
});

test('creates and persists an extension-only token before launching a backend', async () => {
  let writtenPath;
  let writtenContent;
  const result = await ensureExtensionAccessToken(
    { environmentPath: '/tmp/relay-pulse/.env', extensionToken: undefined },
    {
      appendFileImpl: async (filePath, content) => {
        writtenPath = filePath;
        writtenContent = content;
      },
      randomBytesImpl: () => Buffer.alloc(32, 7)
    }
  );

  const expectedToken = Buffer.alloc(32, 7).toString('base64url');
  assert.equal(result.extensionToken, expectedToken);
  assert.equal(writtenPath, '/tmp/relay-pulse/.env');
  assert.equal(writtenContent, `\nEXTENSION_ACCESS_TOKEN=${expectedToken}\n`);

  const configured = await ensureExtensionAccessToken(
    { environmentPath: '/tmp/relay-pulse/.env', extensionToken: expectedToken },
    { appendFileImpl: async () => assert.fail('existing token must not be replaced') }
  );
  assert.equal(configured.extensionToken, expectedToken);
});

test('authenticates health checks when the local backend requires an extension token', async () => {
  const extensionToken = 'a'.repeat(43);
  let request;
  const healthy = await checkBackendHealth('http://127.0.0.1:4100/api/health', {
    extensionToken,
    fetchImpl: async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({
        success: true,
        data: { status: 'ok', service: 'relay-pulse' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  assert.equal(healthy, true);
  assert.equal(request.input, 'http://127.0.0.1:4100/api/health');
  assert.deepEqual(request.init.headers, { 'X-Relay-Pulse-Extension-Token': extensionToken });
});

test('reuses a healthy local backend without launching another process', async () => {
  let launched = false;
  const result = await ensureBackend({
    resolveSettings: async () => ({
      apiUrl: 'http://127.0.0.1:4100/api',
      healthUrl: 'http://127.0.0.1:4100/api/health',
      executablePath: '/tmp/relay-pulse-start',
      hostDirectory: '/tmp'
    }),
    checkHealth: async () => true,
    launch: async () => {
      launched = true;
    }
  });

  assert.deepEqual(result, { apiUrl: 'http://127.0.0.1:4100/api', extensionToken: null, reused: true });
  assert.equal(launched, false);
});

test('launches the sibling backend and waits for its health endpoint', async () => {
  let launchedWith;
  let healthChecks = 0;
  const result = await ensureBackend({
    resolveSettings: async () => ({
      apiUrl: 'http://127.0.0.1:4100/api',
      healthUrl: 'http://127.0.0.1:4100/api/health',
      executablePath: '/tmp/relay-pulse-start',
      hostDirectory: '/tmp'
    }),
    checkHealth: async () => {
      healthChecks += 1;
      return healthChecks > 1;
    },
    ensureExtensionToken: async (settings) => ({ ...settings, extensionToken: 'a'.repeat(43) }),
    launch: async (options) => {
      launchedWith = options;
    }
  });

  assert.deepEqual(launchedWith, {
    executablePath: '/tmp/relay-pulse-start',
    hostDirectory: '/tmp',
    accessImpl: undefined,
    spawnImpl: undefined
  });
  assert.deepEqual(result, { apiUrl: 'http://127.0.0.1:4100/api', extensionToken: 'a'.repeat(43), reused: false });
});

test('only accepts the fixed request shape and returns the extension response schema', async () => {
  const invalid = await handleNativeRequest({ type: 'ensureBackend', executablePath: '/tmp/other' });
  assert.deepEqual(invalid, {
    ok: false,
    error: {
      code: 'invalid_request',
      message: 'Native Messaging 请求包含不支持的字段'
    }
  });

  const response = await handleNativeRequest(
    { type: 'ensureBackend' },
    { ensureBackendImpl: async () => ({ apiUrl: 'http://127.0.0.1:3100/api', reused: false }) }
  );
  assert.deepEqual(response, {
    ok: true,
    apiUrl: 'http://127.0.0.1:3100/api',
    extensionToken: null,
    reused: false
  });
});

test('writes only framed JSON responses to stdout', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const outputChunks = [];
  output.on('data', (chunk) => outputChunks.push(chunk));

  const run = runNativeMessagingHost({
    input,
    output,
    ensureBackendImpl: async () => ({ apiUrl: 'http://127.0.0.1:3100/api', reused: true })
  });
  const request = encodeNativeMessage({ type: 'ensureBackend' });
  input.write(request.subarray(0, 3));
  input.end(request.subarray(3));
  await run;

  const responses = [];
  const decoder = createNativeMessageDecoder((message) => responses.push(message));
  decoder.push(Buffer.concat(outputChunks));
  decoder.finish();
  assert.deepEqual(responses, [{ ok: true, apiUrl: 'http://127.0.0.1:3100/api', extensionToken: null, reused: true }]);
});

test('CJS bundle can run the packaged host installer help without import.meta failures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-native-host-bundle-'));
  const bundlePath = path.join(directory, 'native-host.cjs');
  try {
    await build({
      entryPoints: [path.join(scriptsDirectory, 'native-messaging-host-entry.mjs')],
      outfile: bundlePath,
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      legalComments: 'none',
      define: {
        'import.meta.url': JSON.stringify('file:///__relay_pulse_packaged__/scripts/native-messaging-host-entry.mjs')
      }
    });
    const result = await execFileAsync(process.execPath, [bundlePath, '--install', '--help']);
    assert.match(result.stdout, /npm run install:native-host/);
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
