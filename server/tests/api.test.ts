import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { RelayTester } from '../src/services/relay-tester.js';
import type { Relay, TestResult } from '../src/types.js';

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

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-api-'));
  relays = new RelayRepository(path.join(directory, 'relays.json'));
  app = await createApp({
    relays,
    history: new HistoryRepository(path.join(directory, 'history.json')),
    tester: new FakeTester()
  });
});

afterEach(async () => rm(directory, { recursive: true, force: true }));

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

describe('relay API', () => {
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

  it('creates, masks, edits without replacing an empty key, and deletes a relay', async () => {
    const created = await request(app).post('/api/relays').send(input).expect(201);
    expect(created.body.data.apiKey).toBeUndefined();
    expect(created.body.data.apiKeyMasked).not.toContain(input.apiKey);
    const id = created.body.data.id as string;

    await request(app).put(`/api/relays/${id}`).send({ name: '新名称', apiKey: '' }).expect(200);
    expect((await relays.find(id)).apiKey).toBe(input.apiKey);

    const listed = await request(app).get('/api/relays').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].name).toBe('新名称');
    const detailed = await request(app).get(`/api/relays/${id}`).expect(200);
    expect(detailed.body.data.apiKey).toBeUndefined();
    expect(JSON.stringify(detailed.body)).not.toContain(input.apiKey);

    await request(app).delete(`/api/relays/${id}`).expect(200);
    expect((await relays.list())).toHaveLength(0);
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
