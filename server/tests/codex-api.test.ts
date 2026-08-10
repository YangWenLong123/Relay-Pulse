import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CodexAccountRepository } from '../src/repositories/codex-account-repository.js';
import { CodexUsageRepository } from '../src/repositories/codex-usage-repository.js';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { PoolUsageRepository } from '../src/repositories/pool-usage-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { CodexAccountService } from '../src/services/codex-account-service.js';
import { CodexProxyService } from '../src/services/codex-proxy-service.js';
import type { PoolProxyService } from '../src/services/pool-proxy-service.js';

let directory: string;
let app: Express;
let accounts: CodexAccountRepository;
let proxy: CodexProxyService;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-codex-api-'));
  accounts = new CodexAccountRepository(path.join(directory, 'codex-accounts.json'), 'codex-api-test-secret');
  const usage = new CodexUsageRepository(path.join(directory, 'codex-usage.json'), 20);
  const accountService = new CodexAccountService(accounts, {
    upstreamBaseUrl: 'https://models.example.test/codex',
    fetch: async (input) => {
      if (input.toString().endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: {
            'x-codex-plan-type': 'chatgptplusplan',
            'x-codex-primary-used-percent': '25',
            'x-codex-primary-reset-after-seconds': '300',
            'x-codex-primary-window-minutes': '300'
          }
        });
      }
      return new Response(JSON.stringify({ data: [{ id: 'gpt-codex-test' }] }), { status: 200 });
    }
  });
  proxy = new CodexProxyService({
    listAccounts: () => accounts.list(),
    recordUsage: (record) => usage.add(record),
    setAccountError: (id, message) => accounts.setError(id, message),
    upstreamBaseUrl: 'https://responses.example.test/codex',
    fetch: async () => new Response(JSON.stringify({ id: 'resp_api_test' }), { status: 200 })
  });
  app = await createApp({
    relays: new RelayRepository(path.join(directory, 'relays.json')),
    history: new HistoryRepository(path.join(directory, 'history.json')),
    poolUsage: new PoolUsageRepository(path.join(directory, 'pool-usage.json'), 20),
    codexAccounts: accounts,
    codexUsage: usage,
    codexAccountService: accountService,
    codexProxy: proxy,
    startBalanceScheduler: false
  });
});

afterEach(async () => {
  await proxy.close();
  await (app.locals.pool as PoolProxyService).close();
  await rm(directory, { recursive: true, force: true });
});

describe('Codex account API', () => {
  it('imports a session privately, synchronizes models, and controls the local proxy', async () => {
    const imported = await request(app)
      .post('/api/codex-accounts/import')
      .send({
        sessions: [{
          account_id: 'account-api-1234567890',
          email: 'api@example.test',
          access_token: 'test-api-access-token-that-must-not-be-returned'
        }]
      })
      .expect(200);

    const account = imported.body.data.accounts[0];
    expect(imported.body.data).toMatchObject({ createdCount: 1, updatedCount: 0 });
    expect(account).toMatchObject({ email: 'api@example.test', accountIdMasked: 'accou...67890', modelCount: 0 });
    expect(JSON.stringify(imported.body)).not.toContain('test-api-access-token');
    expect(JSON.stringify(imported.body)).not.toContain('account-api-1234567890');

    await request(app)
      .post(`/api/codex-accounts/${account.id}/models`)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({ models: ['gpt-codex-test'], account: { status: 'active', modelCount: 1 } });
      });

    await request(app)
      .post(`/api/codex-accounts/${account.id}/usage`)
      .send({})
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toMatchObject({
          usage: { planType: 'chatgptplusplan', primary: { usedPercent: 25, windowMinutes: 300 } },
          account: { status: 'active', planType: 'chatgptplusplan' }
        });
      });

    const listed = await request(app).get('/api/codex-accounts').expect(200);
    expect(listed.body.data).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain('test-api-access-token');

    const started = await request(app)
      .post('/api/codex-proxy/start')
      .send({ port: 0, accountIds: [account.id], routingStrategy: 'round-robin' })
      .expect(200);
    expect(started.body.data).toMatchObject({ active: true, accountIds: [account.id], models: ['gpt-codex-test'] });
    expect(started.body.data.apiKey).toMatch(/^rp_codex_/);

    await request(app).delete(`/api/codex-accounts/${account.id}`).expect(409);
    const rotated = await request(app).post('/api/codex-proxy/key/rotate').expect(200);
    expect(rotated.body.data.apiKey).not.toBe(started.body.data.apiKey);
    await request(app).post('/api/codex-proxy/stop').expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ active: false, apiKey: '', accountIds: [] });
    });
    await request(app).delete(`/api/codex-accounts/${account.id}`).expect(200);
  });

  it('validates import and service-start requests before they alter account state', async () => {
    await request(app).post('/api/codex-accounts/import').send({ sessions: [{}] }).expect(400);
    await request(app).post('/api/codex-proxy/start').send({ port: 0 }).expect(400);
    await request(app).get('/api/codex-proxy/usage?limit=20&offset=0').expect(200).expect(({ body }) => {
      expect(body.data).toMatchObject({ total: 0, summary: { requestCount: 0 } });
    });
  });
});
