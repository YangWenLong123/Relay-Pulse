import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAccountRepository } from '../src/repositories/codex-account-repository.js';
import { CodexAccountService } from '../src/services/codex-account-service.js';

const directories: string[] = [];

async function createRepository(): Promise<CodexAccountRepository> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-codex-models-'));
  directories.push(directory);
  const repository = new CodexAccountRepository(path.join(directory, 'codex-accounts.json'), 'test-model-sync-secret');
  await repository.initialize();
  await repository.importMany([{
    account_id: 'account-model-sync-12345',
    email: 'models@example.test',
    access_token: 'test-model-sync-access-token'
  }]);
  return repository;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CodexAccountService', () => {
  it('discovers and normalizes models with Codex account authentication headers', async () => {
    const repository = await createRepository();
    const account = (await repository.listPublic())[0]!;
    const requests: Array<{ url: string; headers: Headers }> = [];
    const service = new CodexAccountService(repository, {
      upstreamBaseUrl: 'https://gateway.example.test/codex/',
      clientVersion: 'test-client-version',
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({
          data: [{ id: 'gpt-z' }, { slug: 'gpt-a' }, { id: 'gpt-z' }],
          results: { items: [{ name: 'gpt-b' }] }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    });

    const result = await service.discoverModels(account.id);

    expect(result.models).toEqual(['gpt-a', 'gpt-b', 'gpt-z']);
    expect(result.account).toMatchObject({ id: account.id, status: 'active', modelCount: 3 });
    expect(JSON.stringify(result)).not.toContain('test-model-sync-access-token');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://gateway.example.test/codex/models?client_version=test-client-version');
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test-model-sync-access-token');
    expect(requests[0]?.headers.get('chatgpt-account-id')).toBe('account-model-sync-12345');
    expect(requests[0]?.headers.get('openai-account-id')).toBe('account-model-sync-12345');
  });

  it('marks a rejected account as errored without exposing upstream bearer material', async () => {
    const repository = await createRepository();
    const account = (await repository.listPublic())[0]!;
    const service = new CodexAccountService(repository, {
      upstreamBaseUrl: 'https://gateway.example.test/codex',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Bearer upstream-test-token was rejected' } }), { status: 401 })
    });

    await expect(service.discoverModels(account.id)).rejects.toMatchObject({ status: 401, message: '上游拒绝了账号凭证' });
    const updated = (await repository.listPublic())[0]!;
    expect(updated).toMatchObject({ status: 'error', lastError: '上游拒绝了账号凭证' });
    expect(JSON.stringify(updated)).not.toContain('upstream-test-token');
    expect(JSON.stringify(updated)).not.toContain('test-model-sync-access-token');
  });

  it('preserves a safe network error code when model discovery cannot reach the upstream', async () => {
    const repository = await createRepository();
    const account = (await repository.listPublic())[0]!;
    const service = new CodexAccountService(repository, {
      upstreamBaseUrl: 'https://gateway.example.test/codex',
      fetch: async () => {
        const error = new TypeError('fetch failed');
        Object.assign(error, { cause: { code: 'ECONNREFUSED' } });
        throw error;
      }
    });

    await expect(service.discoverModels(account.id)).rejects.toMatchObject({
      status: 502,
      message: '无法连接模型服务（网络错误：ECONNREFUSED）'
    });
    expect((await repository.listPublic())[0]).toMatchObject({
      status: 'error',
      lastError: '无法连接模型服务（网络错误：ECONNREFUSED）'
    });
  });

  it('preserves a safe network error code when refreshing quota cannot reach the upstream', async () => {
    const repository = await createRepository();
    const account = (await repository.listPublic())[0]!;
    const service = new CodexAccountService(repository, {
      upstreamBaseUrl: 'https://gateway.example.test/codex',
      fetch: async () => {
        const error = new TypeError('fetch failed');
        Object.assign(error, { cause: { code: 'ETIMEDOUT' } });
        throw error;
      }
    });

    await expect(service.refreshUsage(account.id)).rejects.toMatchObject({
      status: 502,
      message: '无法连接额度服务（网络错误：ETIMEDOUT）'
    });
  });

  it('reads Codex quota windows from response headers, including quota-exhausted responses', async () => {
    const repository = await createRepository();
    const account = (await repository.listPublic())[0]!;
    const service = new CodexAccountService(repository, {
      upstreamBaseUrl: 'https://gateway.example.test/codex',
      fetch: async (input) => {
        expect(input.toString()).toBe('https://gateway.example.test/codex/responses');
        return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), {
          status: 429,
          headers: {
            'x-codex-plan-type': 'free',
            'x-codex-active-limit': 'premium',
            'x-codex-credits-has-credits': 'False',
            'x-codex-credits-unlimited': 'False',
            'x-codex-primary-used-percent': '100',
            'x-codex-primary-reset-after-seconds': '300',
            'x-codex-primary-reset-at': '1786325400',
            'x-codex-primary-window-minutes': '300',
            'x-codex-secondary-used-percent': '20',
            'x-codex-secondary-reset-after-seconds': '600',
            'x-codex-secondary-window-minutes': '10080'
          }
        });
      }
    });

    const result = await service.refreshUsage(account.id);

    expect(result.usage).toMatchObject({
      planType: 'free',
      activeLimit: 'premium',
      primary: { usedPercent: 100, windowMinutes: 300, resetAfterSeconds: 300 },
      secondary: { usedPercent: 20, windowMinutes: 10080, resetAfterSeconds: 600 }
    });
    expect(result.account).toMatchObject({ status: 'active', planType: 'free' });
    expect((await repository.listPublic())[0]?.usageSnapshot).toMatchObject({ primary: { usedPercent: 100 } });
  });
});
