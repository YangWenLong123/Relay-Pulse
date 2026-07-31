import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { PoolUsageRepository } from '../src/repositories/pool-usage-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { RelayTester } from '../src/services/relay-tester.js';
import type { PoolProxyService } from '../src/services/pool-proxy-service.js';
import type { PoolStartResult, PoolStatus, PoolUsageRecord, Relay, TestResult } from '../src/types.js';

class FakeTester extends RelayTester {
  override async test(relay: Relay): Promise<TestResult> {
    return {
      id: randomUUID(),
      success: true,
      relayId: relay.id,
      relayName: relay.name,
      model: relay.model,
      protocol: 'chat',
      statusCode: 200,
      responseText: 'hi back',
      totalDuration: 12,
      dnsDuration: null,
      tcpDuration: null,
      tlsDuration: null,
      firstByteDuration: 10,
      errorType: null,
      errorMessage: '',
      testedAt: new Date().toISOString()
    };
  }

  override async discoverModels(): Promise<string[]> {
    return ['gpt-test', 'gpt-test-mini'];
  }
}

let directory: string;
let app: Express;
let relays: RelayRepository;
let poolUsage: PoolUsageRepository;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-api-'));
  relays = new RelayRepository(path.join(directory, 'relays.json'));
  poolUsage = new PoolUsageRepository(path.join(directory, 'pool-usage.json'), 20);
  app = await createApp({
    relays,
    history: new HistoryRepository(path.join(directory, 'history.json')),
    tester: new FakeTester(),
    poolUsage,
    startBalanceScheduler: false
  });
});

afterEach(async () => {
  await (app.locals.pool as PoolProxyService).close();
  await rm(directory, { recursive: true, force: true });
});

const input = {
  name: '线路一',
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-1234567890abcdef',
  model: 'gpt-test',
  protocol: 'auto',
  enabled: true,
  timeout: 30000,
  remark: ''
};

const poolStatus = (active: boolean): PoolStatus => ({
  active,
  host: '127.0.0.1',
  port: active ? 58000 : null,
  baseUrl: active ? 'http://127.0.0.1:58000' : null,
  startedAt: active ? '2026-07-30T05:00:00.000Z' : null,
  eligibleRelayCount: active ? 1 : 0,
  cooldownRelayCount: 0,
  routingStrategy: 'round-robin',
  relayIds: active ? ['57cbca38-99f1-49f7-a47f-ffb795d8d5c1'] : [],
  platform: active ? 'openai' : null,
  apiKey: active ? 'rp_simulated' : '',
  balanceSummary: [],
  balanceDetails: []
});

const poolUsageRecord = (overrides: Partial<PoolUsageRecord> = {}): PoolUsageRecord => ({
  id: randomUUID(),
  createdAt: '2026-07-30T05:00:00.000Z',
  relayId: null,
  relayName: '主线路',
  endpoint: '/v1/chat/completions',
  model: '=SUM(A1:A2)',
  status: 'failed',
  statusCode: 429,
  attempts: 2,
  durationMs: 320,
  inputTokens: null,
  outputTokens: null,
  cachedTokens: null,
  totalTokens: null,
  errorCode: 'pool_exhausted',
  errorMessage: '余额已耗尽',
  ...overrides
});

describe('relay API', () => {
  it('clears usage records around simulated pool service start and stop', async () => {
    const simulatedUsage = new PoolUsageRepository(20);
    let active = false;
    const simulatedPool = {
      status: () => poolStatus(active),
      start: async (): Promise<PoolStartResult> => {
        active = true;
        return { ...poolStatus(true), apiKey: 'rp_simulated' };
      },
      stop: async (): Promise<PoolStatus> => {
        active = false;
        return poolStatus(false);
      },
      refreshBalances: async (): Promise<PoolStatus> => poolStatus(active),
      setRoutingStrategy: (): PoolStatus => poolStatus(active),
      rotateKey: async (): Promise<PoolStartResult> => ({ ...poolStatus(true), apiKey: 'rp_rotated' }),
      close: async () => undefined
    } as unknown as PoolProxyService;
    const simulatedApp = await createApp({
      relays: new RelayRepository(path.join(directory, 'simulated-relays.json')),
      history: new HistoryRepository(path.join(directory, 'simulated-history.json')),
      tester: new FakeTester(),
      poolUsage: simulatedUsage,
      pool: simulatedPool,
      startBalanceScheduler: false
    });

    await simulatedUsage.add(poolUsageRecord());
    await request(simulatedApp).get('/api/pool/usage').expect(200).expect(({ body }) => {
      expect(body.data.total).toBe(1);
    });

    await request(simulatedApp).post('/api/pool/start').send({ port: 0, relayIds: ['57cbca38-99f1-49f7-a47f-ffb795d8d5c1'] }).expect(200);
    await request(simulatedApp).get('/api/pool/usage').expect(200).expect(({ body }) => {
      expect(body.data.total).toBe(0);
    });

    await simulatedUsage.add(poolUsageRecord({ id: randomUUID(), status: 'success', statusCode: 200 }));
    await request(simulatedApp).post('/api/pool/stop').expect(200);
    await request(simulatedApp).get('/api/pool/usage').expect(200).expect(({ body }) => {
      expect(body.data.total).toBe(0);
    });
  });

  it('manages the local pool service and exposes filtered usage exports', async () => {
    const openAiRelay = await relays.create({ ...input, platform: 'openai' });
    const anthropicRelay = await relays.create({
      ...input,
      name: 'Anthropic 线路',
      baseUrl: 'https://anthropic.example.com',
      model: 'claude-test',
      platform: 'anthropic'
    });

    await request(app).get('/api/pool').expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ active: false, host: '127.0.0.1', port: null });
    });

    await request(app).post('/api/pool/start').send({ port: 0, relayIds: [] }).expect(400);
    await request(app).post('/api/pool/start').send({ port: 0, relayIds: [openAiRelay.id, anthropicRelay.id] }).expect(400);
    const started = await request(app).post('/api/pool/start').send({ port: 0, relayIds: [openAiRelay.id], routingStrategy: 'random' }).expect(200);
    expect(started.body.data).toMatchObject({
      active: true,
      host: '127.0.0.1',
      eligibleRelayCount: 1,
      routingStrategy: 'random',
      relayIds: [openAiRelay.id],
      platform: 'openai'
    });
    expect(started.body.data.apiKey).toMatch(/^rp_/);

    await request(app).get('/api/pool').expect(200).expect(({ body }) => {
      expect(body.data.apiKey).toBe(started.body.data.apiKey);
    });

    await request(app).post('/api/pool/start').send({ port: 0, relayIds: [openAiRelay.id] }).expect(409);
    const rotated = await request(app).post('/api/pool/key/rotate').expect(200);
    expect(rotated.body.data.apiKey).not.toBe(started.body.data.apiKey);
    await request(app).post('/api/pool/refresh').expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ active: true, eligibleRelayCount: 1 });
    });
    await request(app).post('/api/pool/strategy').send({ routingStrategy: 'invalid' }).expect(400);
    await request(app).post('/api/pool/strategy').send({ routingStrategy: 'round-robin' }).expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ active: true, routingStrategy: 'round-robin' });
    });

    await poolUsage.add(poolUsageRecord());

    await request(app)
      .get('/api/pool/usage?limit=20&offset=0&granularity=hour&status=failed')
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.total).toBe(1);
        expect(body.data.summary).toMatchObject({ requestCount: 1, failureCount: 1 });
      });
    const exported = await request(app)
      .get('/api/pool/usage/export?limit=1&offset=0&granularity=hour')
      .expect('Content-Type', /text\/csv/)
      .expect('Content-Disposition', /relay-pulse-usage\.csv/)
      .expect(200);
    expect(exported.text).toContain("'=SUM(A1:A2)");

    await request(app).post('/api/pool/stop').expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ active: false, port: null });
    });
    await request(app).post('/api/pool/strategy').send({ routingStrategy: 'random' }).expect(409);
    await request(app).post('/api/pool/key/rotate').expect(409);
  });

  it('returns usage filter options before applying model and relay filters', async () => {
    const primaryRelayId = 'd8f3f5ce-9a76-4cf6-bc1e-773a86c1c0a5';
    const backupRelayId = 'd0fbe92a-3c0e-46ec-b5e3-3a9c4de7060b';
    const baseRecord: Omit<PoolUsageRecord, 'id' | 'relayId' | 'relayName' | 'model'> = {
      createdAt: '2026-07-30T05:00:00.000Z',
      endpoint: '/v1/chat/completions',
      status: 'success',
      statusCode: 200,
      attempts: 1,
      durationMs: 120,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      errorCode: '',
      errorMessage: ''
    };
    await poolUsage.add({ ...baseRecord, id: randomUUID(), relayId: primaryRelayId, relayName: '主线路', model: 'gpt-alpha' });
    await poolUsage.add({ ...baseRecord, id: randomUUID(), relayId: backupRelayId, relayName: '备用线路', model: 'gpt-beta' });
    await poolUsage.add({ ...baseRecord, id: randomUUID(), relayId: backupRelayId, relayName: '备用线路', model: 'gpt-failed', status: 'failed' });
    await poolUsage.add({ ...baseRecord, id: randomUUID(), relayId: backupRelayId, relayName: '备用线路', model: 'gpt-responses', endpoint: '/v1/responses' });
    await poolUsage.add({ ...baseRecord, id: randomUUID(), createdAt: '2026-07-29T05:00:00.000Z', relayId: backupRelayId, relayName: '备用线路', model: 'gpt-old' });

    await request(app)
      .get('/api/pool/usage')
      .query({
        limit: 20,
        offset: 0,
        granularity: 'hour',
        from: '2026-07-30T04:00:00.000Z',
        to: '2026-07-30T06:00:00.000Z',
        endpoint: '/v1/chat/completions',
        status: 'success',
        model: 'gpt-alpha',
        relayId: primaryRelayId
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.total).toBe(1);
        expect(body.data.filterOptions.models).toEqual([
          { value: 'gpt-alpha', label: 'gpt-alpha' },
          { value: 'gpt-beta', label: 'gpt-beta' }
        ]);
        expect(body.data.filterOptions.relays).toEqual(expect.arrayContaining([
          { value: backupRelayId, label: '备用线路' },
          { value: primaryRelayId, label: '主线路' }
        ]));
        expect(body.data.filterOptions.relays).toHaveLength(2);
      });
  });

  it('allows browser extension origins and rejects unconfigured web origins', async () => {
    const chromiumOrigin = 'chrome-extension://nplnfohmiahjljnemfcjklclaoecogpi';
    const firefoxOrigin = 'moz-extension://b2436814-3d3e-4d71-99db-386f6ad18ec3';

    await request(app)
      .options('/api/relays')
      .set('Origin', chromiumOrigin)
      .set('Access-Control-Request-Method', 'GET')
      .expect('Access-Control-Allow-Origin', chromiumOrigin)
      .expect(204);
    await request(app).get('/api/health').set('Origin', firefoxOrigin).expect('Access-Control-Allow-Origin', firefoxOrigin).expect(200);
    const rejected = await request(app).get('/api/health').set('Origin', 'https://example.com').expect(403);
    expect(rejected.body.message).toBe('请求来源不被允许');
  });

  it('creates, masks, retrieves, edits without replacing an empty key, and deletes a relay', async () => {
    const created = await request(app).post('/api/relays').send({
      ...input,
      balanceConfig: { template: 'newapi', requestUrl: '', accessToken: 'newapi-access-token', userId: '42', timeout: 10000, intervalMinutes: 1, enabled: true }
    }).expect(201);
    expect(created.body.data.apiKey).toBeUndefined();
    expect(created.body.data.apiKeyMasked).not.toContain(input.apiKey);
    const id = created.body.data.id as string;

    await request(app).put(`/api/relays/${id}`).send({ name: '新名称', apiKey: '' }).expect(200);
    expect((await relays.find(id)).apiKey).toBe(input.apiKey);

    const listed = await request(app).get('/api/relays').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].name).toBe('新名称');
    const apiKey = await request(app).get(`/api/relays/${id}/api-key`).expect(200);
    expect(apiKey.body.data).toEqual({ apiKey: input.apiKey });
    const accessToken = await request(app).get(`/api/relays/${id}/balance-access-token`).expect(200);
    expect(accessToken.body.data).toEqual({ apiKey: '', accessToken: 'newapi-access-token' });
    expect(JSON.stringify(listed.body)).not.toContain(input.apiKey);
    expect(JSON.stringify(listed.body)).not.toContain('newapi-access-token');
    const detailed = await request(app).get(`/api/relays/${id}`).expect(200);
    expect(detailed.body.data.apiKey).toBeUndefined();
    expect(JSON.stringify(detailed.body)).not.toContain(input.apiKey);

    await request(app).delete(`/api/relays/${id}`).expect(200);
    expect((await relays.list())).toHaveLength(0);
  });

  it('returns a saved generic balance API key without exposing it in relay lists', async () => {
    const created = await request(app).post('/api/relays').send({
      ...input,
      balanceConfig: { template: 'generic', requestUrl: '', apiKey: 'balance-api-key', userId: '', timeout: 10000, intervalMinutes: 1, enabled: true }
    }).expect(201);
    const credentials = await request(app).get(`/api/relays/${created.body.data.id}/balance-access-token`).expect(200);
    expect(credentials.body.data).toEqual({ apiKey: 'balance-api-key', accessToken: '' });
    const listed = await request(app).get('/api/relays').expect(200);
    expect(JSON.stringify(listed.body)).not.toContain('balance-api-key');
  });

  it('tests a relay and stores history', async () => {
    const created = await request(app).post('/api/relays').send(input).expect(201);
    const id = created.body.data.id as string;
    const tested = await request(app).post(`/api/relays/${id}/test`).send({ message: 'hi' }).expect(200);
    expect(tested.body.data.responseText).toBe('hi back');
    const history = await request(app).get(`/api/test-history?relayId=${id}`).expect(200);
    expect(history.body.data).toHaveLength(1);
    expect(await readFile(path.join(directory, 'history.json'), 'utf8')).not.toContain(input.apiKey);
  });

  it('updates relay status atomically and validates history filters', async () => {
    const first = await request(app).post('/api/relays').send(input).expect(201);
    const second = await request(app).post('/api/relays').send({ ...input, name: '线路二' }).expect(201);
    const firstId = first.body.data.id as string;
    const secondId = second.body.data.id as string;
    await request(app)
      .patch('/api/relays/batch')
      .send({ relayIds: [firstId, randomUUID()], enabled: false })
      .expect(404);
    expect((await relays.find(firstId)).enabled).toBe(true);

    await request(app)
      .patch('/api/relays/batch')
      .send({ relayIds: [firstId, secondId], enabled: false })
      .expect(200);
    expect((await relays.list()).every((relay) => !relay.enabled)).toBe(true);
    await request(app).get('/api/test-history?success=not-a-boolean').expect(400);
  });

  it('persists the requested relay order', async () => {
    const first = await request(app).post('/api/relays').send(input).expect(201);
    const second = await request(app).post('/api/relays').send({ ...input, name: '线路二' }).expect(201);
    const third = await request(app).post('/api/relays').send({ ...input, name: '线路三' }).expect(201);
    const ids = [third.body.data.id, first.body.data.id, second.body.data.id] as string[];

    const reordered = await request(app).patch('/api/relays/order').send({ relayIds: ids }).expect(200);
    expect(reordered.body.data.map((relay: Relay) => relay.id)).toEqual(ids);
    expect((await request(app).get('/api/relays').expect(200)).body.data.map((relay: Relay) => relay.id)).toEqual(ids);
  });

  it('returns one result per batch item when entries are disabled or missing', async () => {
    const enabled = await request(app).post('/api/relays').send(input).expect(201);
    const disabled = await request(app).post('/api/relays').send({ ...input, name: '停用', enabled: false }).expect(201);
    const missingId = randomUUID();
    const response = await request(app)
      .post('/api/relays/batch-test')
      .send({ relayIds: [enabled.body.data.id, disabled.body.data.id, missingId], message: 'hi' })
      .expect(200);
    expect(response.body.data).toHaveLength(3);
    expect(response.body.data.map((item: TestResult) => item.success)).toEqual([true, false, false]);
    expect(response.body.data.map((item: TestResult) => item.errorType)).toEqual([null, 'http_error', 'not_found']);
  });

  it('rejects oversized and malformed request bodies without echoing content', async () => {
    const oversized = await request(app).post('/api/relays').send({ ...input, remark: 'x'.repeat(70 * 1024) }).expect(413);
    expect(oversized.body.message).toBe('请求体过大');
    const malformed = await request(app)
      .post('/api/relays')
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(400);
    expect(malformed.body.message).toBe('请求体 JSON 格式错误');
  });
});
