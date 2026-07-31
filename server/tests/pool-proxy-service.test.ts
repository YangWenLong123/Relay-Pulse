import { afterEach, describe, expect, it } from 'vitest';
import { PoolProxyService, type PoolProxyFetch, type PoolProxyOptions } from '../src/services/pool-proxy-service.js';
import type { PoolStartResult, PoolUsageRecord, Relay } from '../src/types.js';

const services: PoolProxyService[] = [];

function relay(id: string, overrides: Partial<Relay> = {}): Relay {
  const timestamp = new Date().toISOString();
  return {
    id,
    name: `中转 ${id}`,
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `upstream-${id}-secret`,
    model: `model-${id}`,
    platform: 'openai',
    protocol: 'auto',
    enabled: true,
    timeout: 10_000,
    remark: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    lastTestAt: null,
    lastTestStatus: 'untested',
    lastLatency: null,
    balance: {
      success: true,
      remaining: 10,
      total: 10,
      used: 0,
      unit: 'USD',
      planName: '',
      errorMessage: '',
      queriedAt: timestamp
    },
    balanceConfig: {
      template: 'generic',
      requestUrl: '',
      userId: '',
      timeout: 10_000,
      intervalMinutes: 30,
      enabled: true
    },
    ...overrides
  };
}

function createService(
  relays: Relay[],
  upstreamFetch: PoolProxyFetch,
  records: PoolUsageRecord[] = [],
  refreshBalance: (source: Relay, signal?: AbortSignal) => Promise<Relay> = async (source) => source,
  options: PoolProxyOptions = {}
): PoolProxyService {
  const service = new PoolProxyService({
    listRelays: async () => relays,
    refreshBalance,
    recordUsage: async (record) => {
      records.push(record);
    },
    fetch: upstreamFetch
  }, options);
  services.push(service);
  return service;
}

function apiUrl(started: PoolStartResult, pathname: string): string {
  if (!started.baseUrl) throw new Error('expected running pool base URL');
  return `${started.baseUrl}${pathname}`;
}

function poolHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

async function resolveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`request exceeded ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe('PoolProxyService', () => {
  it('rejects an empty pool and mixed relay platforms', async () => {
    const relays = [relay('openai'), relay('anthropic', { platform: 'anthropic' })];
    const service = createService(relays, async () => new Response('{}', { status: 200 }));

    await expect(service.start({ relayIds: [] })).rejects.toThrow('至少一个中转站');
    await expect(service.start({ relayIds: relays.map((item) => item.id) })).rejects.toThrow('类型必须一致');
    expect(service.status()).toMatchObject({ active: false, apiKey: '' });
  });

  it('proxies an Anthropic pool with x-api-key authentication and only exposes /v1/messages', async () => {
    const relays = [relay('claude', {
      platform: 'anthropic',
      baseUrl: 'https://claude.example.com',
      model: 'claude-test'
    })];
    const requests: Array<{ url: string; headers: Headers }> = [];
    const service = createService(relays, async (input, init) => {
      requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ id: 'msg_1', usage: { input_tokens: 4, output_tokens: 2 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const started = await service.start({ relayIds: ['claude'] });

    expect(started).toMatchObject({ platform: 'anthropic', relayIds: ['claude'] });
    const response = await fetch(apiUrl(started, '/v1/messages'), {
      method: 'POST',
      headers: { 'X-API-Key': started.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-test', messages: [] })
    });

    expect(response.status).toBe(200);
    expect(requests[0]?.url).toBe('https://claude.example.com/v1/messages');
    expect(requests[0]?.headers.get('x-api-key')).toBe('upstream-claude-secret');
    expect(requests[0]?.headers.get('authorization')).toBeNull();
    expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01');
    const wrongEndpoint = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: '{}'
    });
    expect(wrongEndpoint.status).toBe(404);
  });

  it('binds to loopback, authenticates with a per-start key, replaces upstream auth, and records usage', async () => {
    const relays = [relay('primary')];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async (input, init) => {
      requests.push({ url: input.toString(), init });
      if (input.toString().endsWith('/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const service = createService(relays, upstreamFetch, records);
    const started = await service.start();

    expect(started).toMatchObject({ active: true, host: '127.0.0.1', eligibleRelayCount: 1 });
    expect(started.port).toBeTypeOf('number');
    expect(started.apiKey).toMatch(/^rp_/);
    const usage = await fetch(apiUrl(started, '/v1/usage'), { headers: poolHeaders(started.apiKey) });
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toEqual({ is_active: true, remaining: 10, unit: 'USD' });
    const compatibleUsage = await fetch(apiUrl(started, '/usage'), { headers: poolHeaders(started.apiKey) });
    expect(compatibleUsage.status).toBe(200);
    await expect(compatibleUsage.json()).resolves.toEqual({ is_active: true, remaining: 10, unit: 'USD' });
    const denied = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders('not-the-pool-key', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'invalid_api_key' } });

    const proxied = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json', 'X-API-Key': 'must-not-leak' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] })
    });
    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toMatchObject({ choices: [{ message: { content: 'ok' } }] });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://primary.example.com/v1/chat/completions');
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer upstream-primary-secret');
    expect(headers.get('x-api-key')).toBeNull();
    expect(Buffer.from(requests[0]?.init?.body as Uint8Array).toString('utf8')).toContain('gpt-test');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      endpoint: '/v1/chat/completions',
      model: 'gpt-test',
      relayId: 'primary',
      status: 'success',
      attempts: 1,
      inputTokens: 11,
      outputTokens: 7,
      cachedTokens: 3,
      totalTokens: 18
    });

    const rotated = await service.rotateKey();
    expect(rotated.apiKey).not.toBe(started.apiKey);
    const oldKey = await fetch(apiUrl(rotated, '/v1/models'), { headers: poolHeaders(started.apiKey) });
    expect(oldKey.status).toBe(401);
    const newKey = await fetch(apiUrl(rotated, '/v1/models'), { headers: poolHeaders(rotated.apiKey) });
    expect(newKey.status).toBe(200);
  });

  it('accepts unversioned Codex paths from existing CC Switch imports', async () => {
    const calls: string[] = [];
    const service = createService([relay('legacy')], async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({ id: 'resp_1', usage: { total_tokens: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hi' })
    });
    const usage = await fetch(apiUrl(started, '/usage'), { headers: poolHeaders(started.apiKey) });

    expect(response.status).toBe(200);
    expect(usage.status).toBe(200);
    expect(calls).toEqual(['https://legacy.example.com/v1/responses']);
  });

  it('tracks balance consumption for one service session and clears it on stop', async () => {
    const relays = [relay('primary'), relay('secondary', {
      balance: { ...relay('secondary-seed').balance!, remaining: 5, total: 5 }
    })];
    let primaryRefreshes = 0;
    const service = createService(
      relays,
      async () => new Response(JSON.stringify({ usage: { total_tokens: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }),
      [],
      async (source) => {
        if (source.id !== 'primary') return source;
        primaryRefreshes += 1;
        return {
          ...source,
          balance: {
            ...source.balance!,
            remaining: primaryRefreshes === 1 ? 10 : 8.5,
            queriedAt: new Date(Date.now() + primaryRefreshes).toISOString()
          }
        };
      }
    );

    const started = await service.start({ relayIds: relays.map((item) => item.id) });
    expect(started.balanceSummary).toEqual([{ unit: 'USD', currentBalance: 15, consumedBalance: 0 }]);
    expect(started.balanceDetails).toEqual([
      expect.objectContaining({ relayId: 'primary', initialBalance: 10, currentBalance: 10, consumedBalance: 0 }),
      expect.objectContaining({ relayId: 'secondary', initialBalance: 5, currentBalance: 5, consumedBalance: 0 })
    ]);

    const response = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    expect(response.status).toBe(200);
    await waitForCondition(() => service.status().balanceSummary[0]?.consumedBalance === 1.5);
    expect(service.status().balanceSummary).toEqual([{ unit: 'USD', currentBalance: 13.5, consumedBalance: 1.5 }]);
    expect(service.status().balanceDetails[0]).toEqual(expect.objectContaining({
      relayId: 'primary',
      initialBalance: 10,
      currentBalance: 8.5,
      consumedBalance: 1.5
    }));

    const stopped = await service.stop();
    expect(stopped.balanceSummary).toEqual([]);
    expect(stopped.balanceDetails).toEqual([]);

    const restarted = await service.start({ relayIds: relays.map((item) => item.id) });
    expect(restarted.balanceSummary).toEqual([{ unit: 'USD', currentBalance: 13.5, consumedBalance: 0 }]);
  });

  it('round-robins candidates and falls back before returning an upstream failure', async () => {
    const relays = [relay('first'), relay('second')];
    const calls: string[] = [];
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('first.example.com')) return new Response('maintenance', { status: 503 });
      if (url.endsWith('/v1/models')) {
        return new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ output_text: 'served by second' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, records);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ output_text: 'served by second' });
    expect(calls).toEqual([
      'https://first.example.com/v1/responses',
      'https://second.example.com/v1/responses'
    ]);
    expect(records[0]).toMatchObject({ relayId: 'second', status: 'success', attempts: 2 });

    const models = await fetch(apiUrl(started, '/v1/models'), { headers: poolHeaders(started.apiKey) });
    expect(models.status).toBe(200);
    expect(calls[2]).toBe('https://second.example.com/v1/models');
  });

  it('applies a random routing strategy immediately while the pool is running', async () => {
    const relays = [relay('first'), relay('second'), relay('third')];
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, [], async (source) => source, { random: () => 0 });
    const started = await service.start({ routingStrategy: 'round-robin' });
    const request = () => fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });

    expect((await request()).status).toBe(200);
    expect(service.setRoutingStrategy('random')).toMatchObject({ active: true, routingStrategy: 'random' });
    expect((await request()).status).toBe(200);

    expect(calls).toEqual([
      'https://first.example.com/v1/responses',
      'https://second.example.com/v1/responses'
    ]);
  });

  it('merges model lists from every non-cooling relay and keeps the first entry for duplicate ids', async () => {
    const relays = [relay('alpha'), relay('unavailable'), relay('beta')];
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('unavailable.example.com')) return new Response('maintenance', { status: 503 });
      if (url.includes('alpha.example.com')) {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'shared-model', object: 'model', owned_by: 'alpha' },
              { id: 'alpha-only', object: 'model', owned_by: 'alpha' }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [
            { id: 'shared-model', object: 'model', owned_by: 'beta' },
            { id: 'beta-only', object: 'model', owned_by: 'beta' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const service = createService(relays, upstreamFetch);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/models'), { headers: poolHeaders(started.apiKey) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [
        { id: 'shared-model', object: 'model', owned_by: 'alpha' },
        { id: 'alpha-only', object: 'model', owned_by: 'alpha' },
        { id: 'beta-only', object: 'model', owned_by: 'beta' }
      ]
    });
    expect(calls).toEqual([
      'https://alpha.example.com/v1/models',
      'https://unavailable.example.com/v1/models',
      'https://beta.example.com/v1/models'
    ]);
  });

  it('uses the existing mapped failure when every model-list upstream fails', async () => {
    const relays = [relay('server-error'), relay('not-found')];
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('server-error.example.com')) return new Response('maintenance', { status: 503 });
      return new Response(JSON.stringify({ error: { message: 'unknown model endpoint' } }), { status: 404 });
    };
    const service = createService(relays, upstreamFetch);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/models'), { headers: poolHeaders(started.apiKey) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: 'invalid_request_error', code: 'model_not_found' }
    });
    expect(calls).toEqual([
      'https://server-error.example.com/v1/models',
      'https://not-found.example.com/v1/models'
    ]);
  });

  it('returns pool_exhausted after a quota failure refresh confirms every balance is zero', async () => {
    const relays = [relay('depleted')];
    let refreshCount = 0;
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async () => new Response(JSON.stringify({ error: { message: 'insufficient quota' } }), { status: 429 });
    const service = createService(relays, upstreamFetch, records, async (source) => {
      refreshCount += 1;
      if (refreshCount > 1 && source.balance) source.balance.remaining = 0;
      return source;
    });
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'pool_exhausted' } });
    expect(records[0]).toMatchObject({
      relayId: 'depleted',
      status: 'failed',
      statusCode: 429,
      attempts: 1,
      errorCode: 'pool_exhausted'
    });
  });

  it('retries another relay after quota exhaustion and excludes the zero-balance relay afterwards', async () => {
    const relays = [relay('depleted'), relay('available')];
    let depletedRefreshes = 0;
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('depleted.example.com')) return new Response('quota exhausted', { status: 429 });
      return new Response(JSON.stringify({ output_text: 'available' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, [], async (source) => {
      if (source.id === 'depleted' && ++depletedRefreshes > 1 && source.balance) source.balance.remaining = 0;
      return source;
    });
    const started = await service.start();
    const request = () => fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });

    expect((await request()).status).toBe(200);
    await waitForCondition(() => relays[0]?.balance?.remaining === 0);
    expect((await request()).status).toBe(200);

    expect(calls).toEqual([
      'https://depleted.example.com/v1/responses',
      'https://available.example.com/v1/responses',
      'https://available.example.com/v1/responses'
    ]);
  });

  it('does not retry another relay after a streaming response has started and later becomes idle', async () => {
    const relays = [relay('streaming', { timeout: 20 }), relay('fallback')];
    const calls: string[] = [];
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async (input, init) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('fallback.example.com')) return new Response('should not be requested', { status: 200 });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":"one"}\n\n'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('upstream stream interrupted'), { name: 'AbortError' })),
            { once: true }
          );
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const service = createService(relays, upstreamFetch, records);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [], stream: true })
    });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('data:');

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls).toEqual(['https://streaming.example.com/v1/chat/completions']);
    expect(records[0]).toMatchObject({ relayId: 'streaming', status: 'failed', attempts: 1, errorCode: 'stream_interrupted' });
  });

  it('keeps the relay timeout active while buffering a non-stream response before falling back', async () => {
    const relays = [relay('slow', { timeout: 20 }), relay('fast')];
    const calls: string[] = [];
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async (input, init) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('fast.example.com')) {
        return new Response(JSON.stringify({ output_text: 'fallback worked' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('timed out'), { name: 'AbortError' })),
            { once: true }
          );
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, records);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ output_text: 'fallback worked' });
    expect(calls).toEqual(['https://slow.example.com/v1/responses', 'https://fast.example.com/v1/responses']);
    expect(records[0]).toMatchObject({ relayId: 'fast', status: 'success', attempts: 2 });
  });

  it('cancels an in-flight start before it can leave a listener running', async () => {
    const relays = [relay('starting')];
    let refreshStarted: (() => void) | undefined;
    const waitingForRefresh = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const upstreamFetch: PoolProxyFetch = async () => new Response('{}', { status: 200 });
    const service = createService(relays, upstreamFetch, [], async (source, signal) => {
      refreshStarted?.();
      return new Promise<Relay>((resolve) => {
        signal?.addEventListener('abort', () => resolve(source), { once: true });
      });
    });
    const starting = service.start().then(
      () => null,
      (error: unknown) => error
    );
    await waitingForRefresh;

    const stopped = await service.stop();
    const failure = await starting;
    expect(stopped.active).toBe(false);
    expect(service.status()).toMatchObject({ active: false, port: null, baseUrl: null });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('启动已取消');
  });

  it('does not cool a healthy relay when the local client cancels its request', async () => {
    const relays = [relay('cancel')];
    let calls = 0;
    let upstreamStarted: (() => void) | undefined;
    const waitingForUpstream = new Promise<void>((resolve) => {
      upstreamStarted = resolve;
    });
    const upstreamFetch: PoolProxyFetch = async (_input, init) => {
      calls += 1;
      if (calls > 1) return new Response(JSON.stringify({ output_text: 'still healthy' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      upstreamStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('client cancelled'), { name: 'AbortError' })),
          { once: true }
        );
      });
    };
    const service = createService(relays, upstreamFetch);
    const started = await service.start();
    const client = new AbortController();
    const cancelled = fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] }),
      signal: client.signal
    });
    await waitingForUpstream;
    client.abort();
    await expect(cancelled).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const followUp = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    expect(followUp.status).toBe(200);
    expect(service.status().cooldownRelayCount).toBe(0);
    expect(calls).toBe(2);
  });

  it('uses the relay returned by balance refresh even when the listing has not been persisted yet', async () => {
    const listed = relay('freshness', { balance: { ...relay('seed').balance!, remaining: 0 } });
    const untracked = relay('untracked', { balanceConfig: undefined });
    const refreshed: Relay = {
      ...listed,
      balance: {
        ...listed.balance!,
        remaining: 5,
        queriedAt: new Date(Date.now() + 1_000).toISOString()
      }
    };
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      calls.push(input.toString());
      return new Response(JSON.stringify({ output_text: 'fresh balance used' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const refreshedIds: string[] = [];
    const service = createService([listed, untracked], upstreamFetch, [], async (source) => {
      refreshedIds.push(source.id);
      return refreshed;
    });
    const started = await service.start({ relayIds: ['freshness'] });

    expect(started.eligibleRelayCount).toBe(1);
    expect(refreshedIds).toEqual(['freshness']);
    const response = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(['https://freshness.example.com/v1/responses']);
  });

  it('does not wait for a slow 429 balance refresh before trying the next relay', async () => {
    const relays = [relay('quota'), relay('available')];
    let quotaRefreshes = 0;
    let slowRefreshStarted: (() => void) | undefined;
    const waitingForSlowRefresh = new Promise<void>((resolve) => {
      slowRefreshStarted = resolve;
    });
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('quota.example.com')) return new Response('quota exhausted', { status: 429 });
      return new Response(JSON.stringify({ output_text: 'fallback without waiting' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, [], async (source, signal) => {
      if (source.id !== 'quota' || ++quotaRefreshes === 1) return source;
      slowRefreshStarted?.();
      return new Promise<Relay>((resolve) => {
        signal?.addEventListener('abort', () => resolve(source), { once: true });
      });
    });
    const started = await service.start();

    const request = fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });
    await waitingForSlowRefresh;
    const response = await resolveWithin(request, 200);

    expect(response.status).toBe(200);
    expect(calls).toEqual(['https://quota.example.com/v1/responses', 'https://available.example.com/v1/responses']);
  });

  it('reuses one generated Idempotency-Key across retries and preserves a caller key', async () => {
    const relays = [relay('idem-first'), relay('idem-second')];
    const idempotencyKeys: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input, init) => {
      const url = input.toString();
      idempotencyKeys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      if (url.includes('idem-first.example.com')) return new Response('maintenance', { status: 503 });
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch);
    const started = await service.start();

    const retried = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    expect(retried.status).toBe(200);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toMatch(/^rp_/);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);

    const callerKey = 'caller-controlled-idempotency-key';
    const callerControlled = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json', 'Idempotency-Key': callerKey }),
      body: JSON.stringify({ model: 'gpt-test', messages: [] })
    });
    expect(callerControlled.status).toBe(200);
    expect(idempotencyKeys[2]).toBe(callerKey);
  });

  it('falls back when a stream returns headers but no first chunk before the relay timeout', async () => {
    const relays = [relay('header-only', { timeout: 25 }), relay('stream-fallback')];
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input, init) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('stream-fallback.example.com')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"delta":"fallback"}\n\n'));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('first chunk timed out'), { name: 'AbortError' })),
            { once: true }
          );
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const service = createService(relays, upstreamFetch);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [], stream: true })
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('fallback');
    expect(calls).toEqual([
      'https://header-only.example.com/v1/chat/completions',
      'https://stream-fallback.example.com/v1/chat/completions'
    ]);
  });

  it('retains final stream usage after earlier chunks exceed the capture window', async () => {
    const relays = [relay('usage-tail')];
    const records: PoolUsageRecord[] = [];
    const upstreamFetch: PoolProxyFetch = async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"delta":"${'x'.repeat(1_050_000)}"}\n\n`));
          controller.enqueue(encoder.encode('data: {"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}\n\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const service = createService(relays, upstreamFetch, records);
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/chat/completions'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', messages: [], stream: true })
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(records[0]).toMatchObject({ status: 'success', inputTokens: 9, outputTokens: 4, totalTokens: 13 });
  });

  it('falls back when a buffered upstream response exceeds the configured limit', async () => {
    const relays = [relay('too-large'), relay('small')];
    const calls: string[] = [];
    const upstreamFetch: PoolProxyFetch = async (input) => {
      const url = input.toString();
      calls.push(url);
      if (url.includes('too-large.example.com')) return new Response(JSON.stringify({ output_text: 'x'.repeat(300) }), { status: 200 });
      return new Response(JSON.stringify({ output_text: 'fallback worked' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const service = createService(relays, upstreamFetch, [], async (source) => source, { maxResponseBodyBytes: 100 });
    const started = await service.start();

    const response = await fetch(apiUrl(started, '/v1/responses'), {
      method: 'POST',
      headers: poolHeaders(started.apiKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model: 'gpt-test', input: 'hello' })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ output_text: 'fallback worked' });
    expect(calls).toEqual(['https://too-large.example.com/v1/responses', 'https://small.example.com/v1/responses']);
  });
});
