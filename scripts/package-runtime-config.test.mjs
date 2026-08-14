import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  renderBundledEnvironment,
  renderEnvironmentExample,
  selectBundledEnvironment,
  writePackagedRuntimeConfig
} from './package-runtime-config.mjs';

test('bundles non-secret runtime settings from the source environment', () => {
  const result = renderBundledEnvironment(`
    CODEX_UPSTREAM_PROXY_URL=http://127.0.0.1:7890
    SERVER_PORT=4100
    ACCOUNT_SESSION_ENCRYPTION_SECRET=do-not-copy
    EXTENSION_ACCESS_TOKEN=do-not-package-this-token
  `);

  assert.match(result.content, /CODEX_UPSTREAM_PROXY_URL="http:\/\/127\.0\.0\.1:7890"/);
  assert.match(result.content, /SERVER_PORT="4100"/);
  assert.doesNotMatch(result.content, /do-not-copy/);
  assert.doesNotMatch(result.content, /do-not-package-this-token/);
  assert.deepEqual(result.excludedKeys, ['ACCOUNT_SESSION_ENCRYPTION_SECRET', 'EXTENSION_ACCESS_TOKEN']);
});

test('does not package proxy credentials', () => {
  const result = selectBundledEnvironment(`
    CODEX_UPSTREAM_PROXY_URL=http://user:password@127.0.0.1:7890
    CODEX_UPSTREAM_BASE_URL=https://user:password@gateway.example.test/codex
  `);

  assert.deepEqual(result.values, []);
  assert.deepEqual(result.excludedKeys, ['CODEX_UPSTREAM_BASE_URL', 'CODEX_UPSTREAM_PROXY_URL']);
});

test('template includes the proxy and secret configuration guidance', () => {
  const template = renderEnvironmentExample();

  assert.match(template, /CODEX_UPSTREAM_PROXY_URL=/);
  assert.match(template, /ACCOUNT_SESSION_ENCRYPTION_SECRET/);
  assert.match(template, /EXTENSION_ACCESS_TOKEN/);
});

test('writes both packaged configuration files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-package-config-'));
  try {
    await writePackagedRuntimeConfig(directory, 'SERVER_PORT=4100');
    assert.match(await readFile(path.join(directory, '.env'), 'utf8'), /SERVER_PORT="4100"/);
    assert.match(await readFile(path.join(directory, '.env.example'), 'utf8'), /CODEX_UPSTREAM_PROXY_URL=/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
