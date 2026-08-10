import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { PoolUsageRepository } from '../src/repositories/pool-usage-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { PlaygroundService, type PlaygroundGenerateOptions } from '../src/services/playground-service.js';
import type { PlaygroundCompletion, PlaygroundInput, PlaygroundStreamEvent, Relay } from '../src/types.js';
import type { PoolProxyService } from '../src/services/pool-proxy-service.js';

class FakePlaygroundService extends PlaygroundService {
  calls: Array<{ relay: Relay; input: PlaygroundInput }> = [];

  override async generate(relay: Relay, input: PlaygroundInput, options: PlaygroundGenerateOptions = {}): Promise<PlaygroundCompletion> {
    this.calls.push({ relay, input });
    options.onDelta?.('实时');
    options.onDelta?.('回复');
    return {
      relayId: relay.id,
      relayName: relay.name,
      requestedModel: input.model,
      reportedModel: 'gpt-playground-reported',
      protocol: 'chat',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      durationMs: 88
    };
  }
}

function events(response: request.Response): PlaygroundStreamEvent[] {
  return response.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as PlaygroundStreamEvent);
}

describe('playground API', () => {
  let directory: string;
  let app: Express;
  let relays: RelayRepository;
  let playground: FakePlaygroundService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-playground-'));
    relays = new RelayRepository(path.join(directory, 'relays.json'));
    playground = new FakePlaygroundService();
    app = await createApp({
      relays,
      history: new HistoryRepository(path.join(directory, 'history.json')),
      poolUsage: new PoolUsageRepository(path.join(directory, 'pool-usage.json'), 20),
      playground,
      startBalanceScheduler: false
    });
  });

  afterEach(async () => {
    await (app.locals.pool as PoolProxyService).close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uses a saved credential while only streaming normalized events', async () => {
    const apiKey = 'sk-playground-secret';
    const relay = await relays.create({
      name: '对话线路',
      baseUrl: 'https://relay.example.com/v1',
      apiKey,
      model: 'gpt-default',
      platform: 'openai',
      protocol: 'chat',
      enabled: true,
      timeout: 30_000,
      remark: ''
    });
    const body: PlaygroundInput = {
      model: 'gpt-selected',
      messages: [{ role: 'user', content: '你好' }],
      systemPrompt: '简洁回答',
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 2048
    };
    const response = await request(app)
      .post(`/api/relays/${relay.id}/playground/stream`)
      .send(body)
      .expect('Content-Type', /application\/x-ndjson/)
      .expect('Cache-Control', 'no-cache, no-transform')
      .expect('X-Accel-Buffering', 'no')
      .expect(200);

    expect(events(response)).toEqual([
      { type: 'delta', data: { text: '实时' } },
      { type: 'delta', data: { text: '回复' } },
      { type: 'done', data: expect.objectContaining({ requestedModel: 'gpt-selected', protocol: 'chat' }) }
    ]);
    expect(playground.calls).toHaveLength(1);
    expect(playground.calls[0]?.relay.apiKey).toBe(apiKey);
    expect(playground.calls[0]?.input).toEqual(body);
    expect(response.text).not.toContain(apiKey);
  });

  it('rejects disabled relays and invalid conversation payloads before streaming', async () => {
    const disabled = await relays.create({
      name: '停用线路',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-disabled',
      model: 'gpt-test',
      platform: 'openai',
      protocol: 'auto',
      enabled: false,
      timeout: 30_000,
      remark: ''
    });
    const valid = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: '',
      temperature: 1,
      topP: 1,
      maxTokens: 1024
    };

    await request(app).post(`/api/relays/${disabled.id}/playground/stream`).send(valid).expect(409);
    await request(app).post(`/api/relays/${disabled.id}/playground/stream`).send({ ...valid, messages: [] }).expect(400);
    expect(playground.calls).toHaveLength(0);
  });

  it('accepts validated multibyte context beyond the global JSON limit', async () => {
    const relay = await relays.create({
      name: '长上下文线路',
      baseUrl: 'https://relay.example.com',
      apiKey: 'sk-long-context',
      model: 'gpt-long',
      platform: 'openai',
      protocol: 'chat',
      enabled: true,
      timeout: 30_000,
      remark: ''
    });
    const content = '测'.repeat(20_000);

    await request(app)
      .post(`/api/relays/${relay.id}/playground/stream`)
      .send({
        model: 'gpt-long',
        messages: [
          { role: 'user', content },
          { role: 'assistant', content },
          { role: 'user', content }
        ],
        systemPrompt: '',
        temperature: 1,
        topP: 1,
        maxTokens: 1024
      })
      .expect(200);

    expect(playground.calls[0]?.input.messages).toHaveLength(3);
  });
});
