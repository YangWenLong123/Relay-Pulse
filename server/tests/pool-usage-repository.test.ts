import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PoolUsageRepository } from '../src/repositories/pool-usage-repository.js';
import type { PoolUsageRecord } from '../src/types.js';

const directories: string[] = [];

function record(overrides: Partial<PoolUsageRecord> = {}): PoolUsageRecord {
  return {
    id: randomUUID(),
    createdAt: '2026-07-30T05:00:00.000Z',
    relayId: '57cbca38-99f1-49f7-a47f-ffb795d8d5c1',
    relayName: '主线路',
    endpoint: '/v1/responses',
    model: 'gpt-5.6',
    status: 'success',
    statusCode: 200,
    attempts: 1,
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 20,
    totalTokens: 150,
    errorCode: '',
    errorMessage: '',
    ...overrides
  };
}

async function createRepositoryWithPath(limit = 3): Promise<{ repository: PoolUsageRepository; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-pool-usage-'));
  directories.push(directory);
  const filePath = path.join(directory, 'pool-usage.json');
  const repository = new PoolUsageRepository(filePath, limit);
  await repository.initialize();
  return { repository, filePath };
}

async function createRepository(limit = 3): Promise<PoolUsageRepository> {
  const { repository } = await createRepositoryWithPath(limit);
  return repository;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PoolUsageRepository', () => {
  it('keeps records in memory without creating a usage file', async () => {
    const { repository, filePath } = await createRepositoryWithPath();
    await repository.add(record());
    await repository.clear();

    await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('filters, aggregates and paginates pool calls without retaining more than its limit', async () => {
    const repository = await createRepository();
    await repository.add(record());
    await repository.add(record({ model: 'gpt-5.6-mini', durationMs: 800, inputTokens: 40, outputTokens: 10, totalTokens: 50 }));
    await repository.add(record({ status: 'failed', statusCode: 502, durationMs: 400, inputTokens: null, outputTokens: null, totalTokens: null, errorCode: 'upstream_error' }));
    await repository.add(record({ createdAt: '2026-07-30T06:00:00.000Z', model: 'newest' }));

    const report = await repository.report({ limit: 2, offset: 0, granularity: 'hour' });
    expect(report.total).toBe(3);
    expect(report.records).toHaveLength(2);
    expect(report.records[0]?.model).toBe('newest');
    expect(report.summary).toMatchObject({ requestCount: 3, successCount: 2, failureCount: 1, totalTokens: 200, averageDurationMs: 800 });
    expect(report.byModel.map((item) => item.key)).toEqual(['gpt-5.6', 'gpt-5.6-mini', 'newest']);
    expect(report.byEndpoint).toEqual([expect.objectContaining({ key: '/v1/responses', requestCount: 3 })]);
    expect(report.trend).toHaveLength(2);

    const failed = await repository.report({ limit: 50, offset: 0, granularity: 'day', status: 'failed' });
    expect(failed.total).toBe(1);
    expect(failed.summary.failureCount).toBe(1);
  });

  it('keeps model and relay filter options independent from selected model and relay values', async () => {
    const repository = await createRepository(5);
    const primaryRelayId = 'd8f3f5ce-9a76-4cf6-bc1e-773a86c1c0a5';
    const backupRelayId = 'd0fbe92a-3c0e-46ec-b5e3-3a9c4de7060b';
    await repository.add(record({ relayId: primaryRelayId, relayName: '主线路', model: 'gpt-alpha' }));
    await repository.add(record({ relayId: backupRelayId, relayName: '备用线路', model: 'gpt-beta' }));
    await repository.add(record({ relayId: backupRelayId, relayName: '备用线路', model: 'gpt-failed', status: 'failed' }));
    await repository.add(record({ createdAt: '2026-07-29T05:00:00.000Z', model: 'gpt-old' }));

    const report = await repository.report({
      limit: 50,
      offset: 0,
      granularity: 'hour',
      from: '2026-07-30T04:00:00.000Z',
      to: '2026-07-30T06:00:00.000Z',
      endpoint: '/v1/responses',
      status: 'success',
      model: 'gpt-alpha',
      relayId: primaryRelayId
    });

    expect(report.total).toBe(1);
    expect(report.filterOptions.models).toEqual([
      { value: 'gpt-alpha', label: 'gpt-alpha' },
      { value: 'gpt-beta', label: 'gpt-beta' }
    ]);
    expect(report.filterOptions.relays).toEqual(expect.arrayContaining([
      { value: backupRelayId, label: '备用线路' },
      { value: primaryRelayId, label: '主线路' }
    ]));
    expect(report.filterOptions.relays).toHaveLength(2);
  });
});
