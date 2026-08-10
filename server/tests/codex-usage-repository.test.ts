import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexUsageRepository } from '../src/repositories/codex-usage-repository.js';
import type { CodexUsageRecord } from '../src/types.js';

const directories: string[] = [];

function record(overrides: Partial<CodexUsageRecord> = {}): CodexUsageRecord {
  return {
    id: randomUUID(),
    createdAt: '2026-08-07T09:00:00.000Z',
    accountId: 'account-primary',
    accountLabel: 'primary@example.test',
    endpoint: '/v1/responses',
    model: 'gpt-codex-test',
    status: 'success',
    statusCode: 200,
    attempts: 1,
    firstByteMs: 120,
    durationMs: 300,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 2,
    totalTokens: 15,
    errorCode: '',
    errorMessage: '',
    ...overrides
  };
}

async function createRepository(limit = 3): Promise<CodexUsageRepository> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-codex-usage-'));
  directories.push(directory);
  const repository = new CodexUsageRepository(path.join(directory, 'codex-usage.json'), limit);
  await repository.initialize();
  return repository;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CodexUsageRepository', () => {
  it('limits retained call metadata and keeps account/model filter options contextual', async () => {
    const repository = await createRepository();
    await repository.add(record({ model: 'gpt-old', createdAt: '2026-08-07T08:00:00.000Z' }));
    await repository.add(record({ accountId: 'account-secondary', accountLabel: 'secondary@example.test', model: 'gpt-second' }));
    await repository.add(record({ status: 'failed', statusCode: 429, model: 'gpt-failed', errorCode: 'account_rate_limited' }));
    await repository.add(record({ createdAt: '2026-08-07T10:00:00.000Z', model: 'gpt-new', totalTokens: 20 }));

    const report = await repository.report({ limit: 2, offset: 0, status: 'success' });

    expect(report.total).toBe(2);
    expect(report.records.map((item) => item.model)).toEqual(['gpt-new', 'gpt-second']);
    expect(report.summary).toMatchObject({ requestCount: 2, successCount: 2, totalTokens: 35, averageDurationMs: 300 });
    expect(report.filterOptions.models.map((item) => item.value)).toEqual(['gpt-new', 'gpt-second']);
    expect(report.filterOptions.accounts).toEqual(expect.arrayContaining([
      { value: 'account-primary', label: 'primary@example.test' },
      { value: 'account-secondary', label: 'secondary@example.test' }
    ]));
  });

  it('clears persisted records', async () => {
    const repository = await createRepository();
    await repository.add(record());
    await repository.clear();

    await expect(repository.report({ limit: 50, offset: 0 })).resolves.toMatchObject({ total: 0, records: [] });
  });
});
