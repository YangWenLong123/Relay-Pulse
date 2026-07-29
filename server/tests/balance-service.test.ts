import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { BalanceService } from '../src/services/balance-service.js';

const directories: string[] = [];

async function createRepository(): Promise<RelayRepository> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-balance-'));
  directories.push(directory);
  const repository = new RelayRepository(path.join(directory, 'relays.json'));
  await repository.initialize();
  return repository;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('BalanceService', () => {
  it('queries the generic template with the relay key and stores a public snapshot', async () => {
    const repository = await createRepository();
    const relay = await repository.create({
      name: '通用线路', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'gpt-test', protocol: 'auto', enabled: true, timeout: 30000, remark: '',
      balanceConfig: { template: 'generic', requestUrl: '', userId: '', timeout: 10000, intervalMinutes: 30, enabled: true }
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ quota: { remaining: 12.5, total: 20, used: 7.5, unit: 'USD' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const updated = await new BalanceService(repository).query(relay.id);
    expect(updated.balance).toMatchObject({ success: true, remaining: 12.5, total: 20, used: 7.5, unit: 'USD' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/usage', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer sk-secret' } }));
    const listed = await repository.findPublic(relay.id);
    expect(listed.balance?.remaining).toBe(12.5);
    expect(JSON.stringify(listed)).not.toContain('sk-secret');
  });

  it('queries the New API template and converts quota units to USD', async () => {
    const repository = await createRepository();
    const relay = await repository.create({
      name: 'New API 线路', baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-relay', model: 'gpt-test', protocol: 'auto', enabled: true, timeout: 30000, remark: '',
      balanceConfig: { template: 'newapi', requestUrl: 'https://newapi.example.com', accessToken: 'newapi-token', userId: '42', timeout: 10000, intervalMinutes: 30, enabled: true }
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { group: 'pro', quota: 1250000, used_quota: 250000 } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const updated = await new BalanceService(repository).query(relay.id);
    expect(updated.balance).toMatchObject({ success: true, remaining: 2.5, total: 3, used: 0.5, planName: 'pro', unit: 'USD' });
    expect(fetchMock).toHaveBeenCalledWith('https://newapi.example.com/api/user/self', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer newapi-token', 'New-Api-User': '42' } }));
    const listed = await repository.findPublic(relay.id);
    expect(listed.balanceConfig).toMatchObject({ template: 'newapi', accessTokenConfigured: true, apiKeyConfigured: false });
    expect(JSON.stringify(listed)).not.toContain('newapi-token');
  });
});
