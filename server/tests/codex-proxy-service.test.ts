import { afterEach, describe, expect, it } from 'vitest';
import { CodexProxyService, type CodexProxyFetch } from '../src/services/codex-proxy-service.js';
import type { CodexAccount, CodexProxyStartResult, CodexUsageRecord } from '../src/types.js';

const services: CodexProxyService[] = [];

function account(id: string, overrides: Partial<CodexAccount> = {}): CodexAccount {
  const timestamp = new Date().toISOString();
  return {
    id,
    accountId: `chatgpt-${id}`,
    email: `${id}@example.test`,
    name: `账号 ${id}`,
    planType: 'plus',
    enabled: true,
    status: 'active',
    expiresAt: null,
    models: ['gpt-test'],
    usageSnapshot: null,
    lastModelSyncAt: timestamp,
    lastError: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    session: { access_token: `test-access-token-${id}` },
    ...overrides
  };
}

function createService(accounts: CodexAccount[], upstreamFetch: CodexProxyFetch, records: CodexUsageRecord[]): CodexProxyService {
  const service = new CodexProxyService({
    listAccounts: async () => accounts,
    recordUsage: async (record) => { records.push(record); },
    upstreamBaseUrl: 'https://gateway.example.test/codex',
    fetch: upstreamFetch,
    now: () => new Date('2026-08-07T09:00:00.000Z')
  });
  services.push(service);
  return service;
}

function apiUrl(started: CodexProxyStartResult, pathname: string): string {
  if (!started.baseUrl) throw new Error('expected local Codex proxy URL');
  return `${started.baseUrl}${pathname}`;
}

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe('CodexProxyService', () => {
  it('binds locally, replaces caller credentials, retries the next account, and records only call metadata', async () => {
    const accounts = [account('primary'), account('secondary')];
    const records: CodexUsageRecord[] = [];
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const service = createService(accounts, async (input, init) => {
      const requestHeaders = new Headers(init?.headers);
      calls.push({
        url: input.toString(),
        headers: requestHeaders,
        body: Buffer.from(init?.body as Uint8Array).toString('utf8')
      });
      if (requestHeaders.get('chatgpt-account-id') === 'chatgpt-primary') {
        return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 });
      }
      return new Response(JSON.stringify({
        id: 'resp_test',
        object: 'response',
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18, input_tokens_details: { cached_tokens: 3 } }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, records);
    const started = await service.start({ port: 0, accountIds: accounts.map((item) => item.id) });

    expect(started).toMatchObject({ active: true, host: '127.0.0.1', availableAccountCount: 2, models: ['gpt-test'] });
    expect(started.apiKey).toMatch(/^rp_codex_/);

    const rejected = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: headers('invalid-local-key', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'invalid_api_key' } });

    const models = await fetch(apiUrl(started, '/v1/models'), { headers: headers(started.apiKey) });
    await expect(models.json()).resolves.toEqual({
      object: 'list',
      data: [{ id: 'gpt-test', object: 'model', owned_by: 'chatgpt-account' }]
    });
    const usage = await fetch(apiUrl(started, '/v1/usage'), { headers: headers(started.apiKey) });
    await expect(usage.json()).resolves.toEqual({ is_active: true, remaining: 2, unit: 'accounts' });

    const proxied = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: headers(started.apiKey, {
        'Content-Type': 'application/json',
        'X-API-Key': 'caller-key-that-must-not-be-forwarded'
      }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });
    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toMatchObject({ id: 'resp_test' });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      'https://gateway.example.test/codex/responses',
      'https://gateway.example.test/codex/responses'
    ]);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer test-access-token-primary');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer test-access-token-secondary');
    expect(calls[0]?.headers.get('x-api-key')).toBeNull();
    expect(calls[0]?.headers.get('chatgpt-account-id')).toBe('chatgpt-primary');
    expect(calls[0]?.body).toContain('gpt-test');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      accountId: 'secondary',
      accountLabel: 'secondary@example.test',
      endpoint: '/v1/responses',
      model: 'gpt-test',
      status: 'success',
      attempts: 2,
      inputTokens: 11,
      outputTokens: 7,
      cachedTokens: 3,
      totalTokens: 18
    });
    expect(JSON.stringify(records)).not.toContain('test-access-token');
    expect(JSON.stringify(records)).not.toContain('caller-key-that-must-not-be-forwarded');
  });

  it('records a model-selection failure without contacting an upstream account', async () => {
    const records: CodexUsageRecord[] = [];
    const service = createService([account('only', { models: ['gpt-allowed'] })], async () => {
      throw new Error('the model filter should prevent this fetch');
    }, records);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/responses'), {
      method: 'POST',
      headers: headers(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-not-allowed', input: 'hello' })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'model_not_found' } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'failed', accountId: null, attempts: 0, errorCode: 'model_not_found' });
  });
});
