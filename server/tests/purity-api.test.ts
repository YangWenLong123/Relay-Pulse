import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { PoolUsageRepository } from '../src/repositories/pool-usage-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import type { PoolProxyService } from '../src/services/pool-proxy-service.js';
import { PurityTester } from '../src/services/purity-tester.js';
import type {
  PurityStreamEvent,
  PurityTestMode,
  PurityTestProgress,
  PurityTestResult,
  Gpt56TestConfig,
  Relay
} from '../src/types.js';

class FakePurityTester extends PurityTester {
  calls: Array<{ apiKey: string; model: string; mode: PurityTestMode; gpt56?: Gpt56TestConfig }> = [];
  targets: Relay[] = [];
  block = false;
  failure: Error | null = null;
  abortedCount = 0;
  private startedCount = 0;
  private readonly startWaiters: Array<{ count: number; resolve: () => void }> = [];

  override async test(
    relay: Relay,
    options: {
      model?: string;
      mode?: PurityTestMode;
      gpt56?: Gpt56TestConfig;
      signal?: AbortSignal;
      onProgress?: (progress: PurityTestProgress) => void;
    } = {}
  ): Promise<PurityTestResult> {
    const model = options.model ?? relay.model;
    const mode = options.mode ?? 'quick';
    this.targets.push(relay);
    const call: { apiKey: string; model: string; mode: PurityTestMode; gpt56?: Gpt56TestConfig } = { apiKey: relay.apiKey, model, mode };
    if (options.gpt56) call.gpt56 = options.gpt56;
    this.calls.push(call);
    options.onProgress?.({
      stage: 'integrity',
      message: '基础完整性探针已完成',
      checks: [],
      requestCount: 1,
      successfulRequests: 1,
      usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 },
      reportedModels: [model],
      completedChecks: 1,
      totalChecks: mode === 'quick' ? 4 : 6,
      elapsedMs: 12
    });
    if (this.failure) throw this.failure;
    if (this.block) {
      this.startedCount += 1;
      this.startWaiters.forEach((waiter) => {
        if (this.startedCount >= waiter.count) waiter.resolve();
      });
      return new Promise<PurityTestResult>((_resolve, reject) => {
        const abort = () => {
          this.abortedCount += 1;
          reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return {
      id: 'purity-result-id',
      relayId: relay.id,
      relayName: relay.name,
      platform: relay.platform,
      protocol: relay.platform === 'anthropic' ? 'anthropic' : relay.protocol === 'responses' ? 'responses' : 'chat',
      mode,
      requestedModel: model,
      reportedModels: [model],
      score: 88,
      verdict: 'likely_normal',
      confidence: 'medium',
      summary: '现有黑盒信号整体正常',
      checks: [],
      anomalies: [],
      requestCount: 4,
      successfulRequests: 4,
      usage: { inputTokens: 120, outputTokens: 24, totalTokens: 144 },
      totalDuration: 42,
      testedAt: '2026-08-05T08:00:00.000Z',
      disclaimer: '黑盒检测不构成来源认证'
    };
  }

  waitForStarts(count: number): Promise<void> {
    if (this.startedCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => this.startWaiters.push({ count, resolve }));
  }
}

function streamEvents(response: request.Response): PurityStreamEvent[] {
  return response.text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PurityStreamEvent);
}

describe('purity test API', () => {
  let directory: string;
  let app: Express;
  let purityTester: FakePurityTester;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-purity-api-'));
    purityTester = new FakePurityTester();
    app = await createApp({
      relays: new RelayRepository(path.join(directory, 'relays.json')),
      history: new HistoryRepository(path.join(directory, 'history.json')),
      poolUsage: new PoolUsageRepository(path.join(directory, 'pool-usage.json'), 20),
      purityTester,
      startBalanceScheduler: false
    });
  });

  afterEach(async () => {
    await (app.locals.pool as PoolProxyService).close();
    await rm(directory, { recursive: true, force: true });
  });

  it('uses the saved key without exposing it and validates the requested mode', async () => {
    const apiKey = 'sk-private-purity-key';
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '纯度测试线路',
        baseUrl: 'https://relay.example.com',
        apiKey,
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;

    const tested = await request(app)
      .post(`/api/relays/${relayId}/purity-test`)
      .send({ model: 'gpt-test-2', mode: 'quick' })
      .expect(200);

    expect(tested.body.data).toMatchObject({
      relayId,
      requestedModel: 'gpt-test-2',
      mode: 'quick',
      verdict: 'likely_normal'
    });
    expect(purityTester.calls).toEqual([{ apiKey, model: 'gpt-test-2', mode: 'quick' }]);
    expect(JSON.stringify(tested.body)).not.toContain(apiKey);

    await request(app).post(`/api/relays/${relayId}/purity-test`).send({}).expect(200);
    expect(purityTester.calls[1]).toEqual({ apiKey, model: 'gpt-test', mode: 'standard' });

    await request(app).post(`/api/relays/${relayId}/purity-test`).send({ mode: 'full' }).expect(400);
    expect(purityTester.calls).toHaveLength(2);
  });

  it('runs a custom endpoint without persisting or returning its API key', async () => {
    const apiKey = 'sk-custom-purity-key';
    const response = await request(app)
      .post('/api/purity-test')
      .send({
        baseUrl: 'https://custom.example.com/v1/chat/completions',
        apiKey,
        model: 'gpt-custom',
        platform: 'openai',
        protocol: 'chat',
        timeout: 45000,
        mode: 'quick'
      })
      .expect(200);

    expect(response.body.data).toMatchObject({
      relayName: '自定义检测端点',
      platform: 'openai',
      protocol: 'chat',
      requestedModel: 'gpt-custom',
      mode: 'quick'
    });
    expect(purityTester.calls).toEqual([{ apiKey, model: 'gpt-custom', mode: 'quick' }]);
    expect(purityTester.targets[0]).toMatchObject({
      baseUrl: 'https://custom.example.com/v1',
      apiKey,
      model: 'gpt-custom',
      platform: 'openai',
      protocol: 'chat',
      timeout: 45000
    });
    expect(JSON.stringify(response.body)).not.toContain(apiKey);

    const relays = await request(app).get('/api/relays').expect(200);
    expect(relays.body.data).toHaveLength(0);
  });

  it('streams a custom Anthropic endpoint with safe defaults', async () => {
    const apiKey = 'sk-custom-anthropic-key';
    const response = await request(app)
      .post('/api/purity-test/stream')
      .send({
        baseUrl: 'https://custom.example.com/v1',
        apiKey,
        model: 'claude-sonnet-4',
        platform: 'anthropic',
        mode: 'quick'
      })
      .expect('Content-Type', /application\/x-ndjson/)
      .expect('Cache-Control', 'no-cache, no-transform')
      .expect('X-Accel-Buffering', 'no')
      .expect(200);
    const events = streamEvents(response);

    expect(events.map((event) => event.type)).toEqual(['progress', 'result']);
    expect(events[1]).toMatchObject({
      type: 'result',
      data: {
        relayName: '自定义检测端点',
        platform: 'anthropic',
        protocol: 'anthropic',
        requestedModel: 'claude-sonnet-4',
        mode: 'quick'
      }
    });
    expect(purityTester.targets[0]).toMatchObject({
      baseUrl: 'https://custom.example.com/v1',
      apiKey,
      platform: 'anthropic',
      protocol: 'auto',
      timeout: 30000
    });
    expect(response.text).not.toContain(apiKey);
  });

  it('passes an in-memory trusted reference to GPT-5.6 deep mode without exposing either key', async () => {
    const candidateKey = 'sk-candidate-deep-key';
    const trustedKey = 'sk-trusted-deep-key';
    const response = await request(app)
      .post('/api/purity-test/stream')
      .send({
        baseUrl: 'https://candidate.example.com/v1',
        apiKey: candidateKey,
        model: 'gpt-5.6',
        platform: 'openai',
        protocol: 'responses',
        mode: 'gpt56',
        gpt56: {
          trials: 3,
          trustedReference: {
            baseUrl: 'https://trusted.example.com/v1',
            apiKey: trustedKey,
            model: 'gpt-5.6'
          }
        }
      })
      .expect(200);

    expect(purityTester.calls[0]).toMatchObject({
      apiKey: candidateKey,
      model: 'gpt-5.6',
      mode: 'gpt56',
      gpt56: { trials: 3, trustedReference: { baseUrl: 'https://trusted.example.com/v1', model: 'gpt-5.6' } }
    });
    expect(purityTester.calls[0]?.gpt56?.trustedReference?.apiKey).toBe(trustedKey);
    expect(response.text).not.toContain(candidateKey);
    expect(response.text).not.toContain(trustedKey);
  });

  it('rejects Chat Completions before a GPT-5.6 deep request can send credentials', async () => {
    await request(app)
      .post('/api/purity-test/stream')
      .send({
        baseUrl: 'https://candidate.example.com/v1',
        apiKey: 'sk-chat-deep-key',
        model: 'gpt-5.6',
        platform: 'openai',
        protocol: 'chat',
        mode: 'gpt56'
      })
      .expect(400);
    expect(purityTester.calls).toHaveLength(0);
  });

  it('rejects malformed custom purity input before invoking the tester', async () => {
    await request(app)
      .post('/api/purity-test/stream')
      .send({ baseUrl: 'ftp://invalid.example.com', apiKey: '', model: '' })
      .expect(400);
    expect(purityTester.targets).toHaveLength(0);
  });

  it('rejects remote HTTP custom endpoints before credentials can be sent', async () => {
    const input = { baseUrl: 'http://relay.example.com/v1', apiKey: 'sk-plain-http', model: 'gpt-custom' };

    await request(app).post('/api/purity-test').send(input).expect(400);
    await request(app).post('/api/models/discover').send({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      platform: 'openai',
      timeout: 30000
    }).expect(400);
    expect(purityTester.targets).toHaveLength(0);
  });

  it('never exposes a custom API key through stream or JSON errors', async () => {
    const apiKey = 'sk-custom-failure-key';
    const input = {
      baseUrl: 'https://custom.example.com/v1',
      apiKey,
      model: 'gpt-custom',
      mode: 'quick'
    };
    purityTester.failure = new Error(`upstream rejected ${apiKey}`);

    const jsonResponse = await request(app).post('/api/purity-test').send(input).expect(500);
    expect(jsonResponse.body.message).toBe('服务器内部错误');
    expect(JSON.stringify(jsonResponse.body)).not.toContain(apiKey);

    const streamResponse = await request(app).post('/api/purity-test/stream').send(input).expect(200);
    expect(streamEvents(streamResponse).at(-1)).toEqual({
      type: 'error',
      data: { code: 'test_failed', message: '纯度检测失败，请稍后重试' }
    });
    expect(streamResponse.text).not.toContain(apiKey);
  });

  it('aborts a custom detector when its client stream disconnects', async () => {
    purityTester.block = true;
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用');

    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/purity-test/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: 'https://custom.example.com/v1',
          apiKey: 'sk-custom-disconnect',
          model: 'gpt-custom',
          mode: 'quick'
        }),
        signal: controller.signal
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('流式响应正文不可用');
      const firstChunk = await reader.read();

      expect(firstChunk.done).toBe(false);
      expect(new TextDecoder().decode(firstChunk.value)).toContain('"type":"progress"');
      controller.abort();
      await vi.waitFor(() => expect(purityTester.abortedCount).toBe(1));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it('rejects purity tests for disabled relays before making a paid request', async () => {
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '停用线路',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-disabled',
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: false,
        timeout: 30000,
        remark: ''
      })
      .expect(201);

    const response = await request(app)
      .post(`/api/relays/${created.body.data.id as string}/purity-test`)
      .send({ mode: 'quick' })
      .expect(409);

    expect(response.body.message).toContain('已停用');
    expect(purityTester.calls).toHaveLength(0);
  });

  it('streams progress followed by the authoritative result as NDJSON', async () => {
    const apiKey = 'sk-private-stream-key';
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '流式纯度线路',
        baseUrl: 'https://relay.example.com',
        apiKey,
        model: 'gpt-stream-default',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;

    const response = await request(app)
      .post(`/api/relays/${relayId}/purity-test/stream`)
      .send({ model: 'gpt-stream-selected', mode: 'quick' })
      .expect('Content-Type', /application\/x-ndjson/)
      .expect('Cache-Control', 'no-cache, no-transform')
      .expect('X-Accel-Buffering', 'no')
      .expect(200);
    const events = streamEvents(response);

    expect(events.map((event) => event.type)).toEqual(['progress', 'result']);
    expect(events[0]).toMatchObject({
      type: 'progress',
      data: { stage: 'integrity', requestCount: 1, completedChecks: 1, totalChecks: 4 }
    });
    expect(events[1]).toMatchObject({
      type: 'result',
      data: { relayId, requestedModel: 'gpt-stream-selected', verdict: 'likely_normal' }
    });
    expect(purityTester.calls).toEqual([{ apiKey, model: 'gpt-stream-selected', mode: 'quick' }]);
    expect(response.text).not.toContain(apiKey);
  });

  it('returns pre-stream validation errors as JSON without invoking the tester', async () => {
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '停用流式线路',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-disabled-stream',
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: false,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;

    const disabled = await request(app).post(`/api/relays/${relayId}/purity-test/stream`).send({}).expect(409);
    expect(disabled.headers['content-type']).toContain('application/json');
    expect(disabled.body.message).toContain('已停用');

    await request(app)
      .post(`/api/relays/${relayId}/purity-test/stream`)
      .send({ mode: 'full' })
      .expect(400);
    expect(purityTester.calls).toHaveLength(0);
  });

  it('streams a sanitized error event when the tester fails after headers are sent', async () => {
    const apiKey = 'sk-secret-upstream-failure';
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '失败流式线路',
        baseUrl: 'https://relay.example.com',
        apiKey,
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    purityTester.failure = new Error(`upstream rejected ${apiKey}`);

    const response = await request(app)
      .post(`/api/relays/${created.body.data.id as string}/purity-test/stream`)
      .send({})
      .expect(200);
    const events = streamEvents(response);

    expect(events.map((event) => event.type)).toEqual(['progress', 'error']);
    expect(events[1]).toEqual({
      type: 'error',
      data: { code: 'test_failed', message: '纯度检测失败，请稍后重试' }
    });
    expect(response.text).not.toContain(apiKey);
  });

  it('streams cancellation and aborts the detector through the existing cancel endpoint', async () => {
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '取消流式线路',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-cancel-stream',
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;
    purityTester.block = true;

    const pending = request(app)
      .post(`/api/relays/${relayId}/purity-test/stream`)
      .send({ mode: 'quick' })
      .then((response) => response);
    await purityTester.waitForStarts(1);
    await request(app).delete(`/api/relays/${relayId}/test`).expect(200);
    const response = await pending;
    const events = streamEvents(response);

    expect(purityTester.abortedCount).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['progress', 'error']);
    expect(events[1]).toEqual({
      type: 'error',
      data: { code: 'cancelled', message: '纯度检测已取消' }
    });
  });

  it('delivers progress before completion and aborts the detector when the stream disconnects', async () => {
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '断连流式线路',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-disconnect-stream',
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;
    purityTester.block = true;
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用');

    try {
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/relays/${relayId}/purity-test/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'quick' }),
        signal: controller.signal
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error('流式响应正文不可用');
      const firstChunk = await reader.read();

      expect(firstChunk.done).toBe(false);
      expect(new TextDecoder().decode(firstChunk.value)).toContain('"type":"progress"');
      expect(purityTester.abortedCount).toBe(0);

      controller.abort();
      await vi.waitFor(() => expect(purityTester.abortedCount).toBe(1));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  it.each([
    ['the existing cancel endpoint', (relayId: string) => `/api/relays/${relayId}/test`],
    ['relay deletion', (relayId: string) => `/api/relays/${relayId}`]
  ])('aborts all concurrent purity requests through %s', async (_label, endpoint) => {
    const created = await request(app)
      .post('/api/relays')
      .send({
        name: '并发纯度线路',
        baseUrl: 'https://relay.example.com',
        apiKey: 'sk-cancelled',
        model: 'gpt-test',
        platform: 'openai',
        protocol: 'chat',
        enabled: true,
        timeout: 30000,
        remark: ''
      })
      .expect(201);
    const relayId = created.body.data.id as string;
    purityTester.block = true;

    const first = request(app).post(`/api/relays/${relayId}/purity-test`).send({ mode: 'quick' }).then((response) => response);
    const second = request(app).post(`/api/relays/${relayId}/purity-test`).send({ mode: 'quick' }).then((response) => response);
    await purityTester.waitForStarts(2);

    await request(app).delete(endpoint(relayId)).expect(200);
    const responses = await Promise.all([first, second]);

    expect(purityTester.abortedCount).toBe(2);
    expect(responses.map((response) => response.status)).toEqual([499, 499]);
    expect(responses.every((response) => response.body.message === '纯度检测已取消')).toBe(true);
  });
});
