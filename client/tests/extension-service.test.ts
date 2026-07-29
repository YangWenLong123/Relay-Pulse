import { describe, expect, it, vi } from 'vitest';
import { ExtensionRelayService } from '../src/extension/service';
import type { RelayTestClient } from '../src/extension/relay-tester';
import type { StoredRelay } from '../src/extension/relay-utils';
import type { ExtensionStorage } from '../src/extension/storage';
import type { RelayFormValue, TestResult } from '../src/types';

class MemoryStorage implements ExtensionStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    Object.entries(values).forEach(([key, value]) => this.values.set(key, structuredClone(value)));
  }
}

class FakeTester implements RelayTestClient {
  lastApiKey = '';
  counter = 0;

  async test(relay: StoredRelay): Promise<TestResult> {
    this.lastApiKey = relay.apiKey;
    this.counter += 1;
    return {
      id: `result-${this.counter}`,
      success: true,
      relayId: relay.id,
      relayName: relay.name,
      model: relay.model,
      protocol: 'chat',
      statusCode: 200,
      responseText: 'ok',
      totalDuration: this.counter,
      dnsDuration: null,
      tcpDuration: null,
      tlsDuration: null,
      firstByteDuration: 1,
      errorType: null,
      errorMessage: '',
      testedAt: new Date().toISOString()
    };
  }

  async discoverModels(relay: Pick<StoredRelay, 'apiKey'>): Promise<string[]> {
    this.lastApiKey = relay.apiKey;
    return ['gpt-test'];
  }
}

const relayInput: RelayFormValue = {
  name: '线路一',
  baseUrl: 'https://api.example.com/v1/',
  apiKey: 'sk-secret-value',
  model: 'gpt-test',
  platform: 'openai',
  protocol: 'auto',
  enabled: true,
  timeout: 30000,
  remark: ''
};

describe('ExtensionRelayService', () => {
  it('persists CRUD, masks keys, and preserves an empty key during edit', async () => {
    const storage = new MemoryStorage();
    const tester = new FakeTester();
    const service = new ExtensionRelayService(storage, tester);
    const created = await service.createRelay(relayInput);
    expect(created.baseUrl).toBe('https://api.example.com/v1');
    expect(created.apiKeyMasked).not.toContain(relayInput.apiKey!);
    expect('apiKey' in created).toBe(false);
    await expect(service.getRelayApiKey(created.id)).resolves.toBe(relayInput.apiKey);

    const updated = await service.updateRelay(created.id, { name: '新名称', apiKey: '' });
    expect(updated.name).toBe('新名称');
    await service.testRelay(created.id, { message: 'hi' });
    expect(tester.lastApiKey).toBe(relayInput.apiKey);
    expect(JSON.stringify(await service.listHistory())).not.toContain(relayInput.apiKey);

    const duplicate = await service.duplicateRelay(created.id);
    expect(duplicate.name).toBe('新名称 副本');
    await service.deleteRelay(created.id);
    expect(await service.listRelays()).toHaveLength(1);
    expect(await service.listHistory()).toHaveLength(1);
  });

  it('serializes concurrent writes without losing relays', async () => {
    const service = new ExtensionRelayService(new MemoryStorage(), new FakeTester());
    await Promise.all(Array.from({ length: 20 }, (_, index) => service.createRelay({ ...relayInput, name: `线路 ${index}` })));
    expect(await service.listRelays()).toHaveLength(20);
  });

  it('limits history and supports filters and clearing', async () => {
    const service = new ExtensionRelayService(new MemoryStorage(), new FakeTester(), 2);
    const relay = await service.createRelay(relayInput);
    await service.testRelay(relay.id, { message: 'hi' });
    await service.testRelay(relay.id, { message: 'hi' });
    await service.testRelay(relay.id, { message: 'hi' });
    expect(await service.listHistory()).toHaveLength(2);
    expect(await service.listHistory({ relayId: relay.id, success: true })).toHaveLength(2);
    await service.clearHistory();
    expect(await service.listHistory()).toEqual([]);
  });

  it('does not overwrite malformed extension storage', async () => {
    const storage = new MemoryStorage();
    storage.values.set('relay-pulse-state-v1', { version: 1, relays: 'broken', history: [] });
    const service = new ExtensionRelayService(storage, new FakeTester());
    await expect(service.listRelays()).rejects.toThrow('原数据未被覆盖');
    expect(storage.values.get('relay-pulse-state-v1')).toEqual({ version: 1, relays: 'broken', history: [] });
  });

  it('queries and persists a generic balance snapshot without exposing the configured key', async () => {
    const service = new ExtensionRelayService(new MemoryStorage(), new FakeTester());
    const relay = await service.createRelay({
      ...relayInput,
      balanceConfig: { template: 'generic', requestUrl: '', apiKey: 'balance-secret', accessToken: '', userId: '', timeout: 10000, intervalMinutes: 30, enabled: true }
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ balance: 8.25, unit: 'USD' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ balance: 7, unit: 'USD' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const updated = await service.queryBalance(relay.id);
    expect(updated.balance).toMatchObject({ success: true, remaining: 8.25, unit: 'USD' });
    expect(updated.balanceConfig).toMatchObject({ apiKeyConfigured: true });
    await expect(service.getRelayBalanceCredentials(relay.id)).resolves.toEqual({ apiKey: 'balance-secret', accessToken: '' });
    expect(JSON.stringify(updated)).not.toContain('balance-secret');
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/usage', expect.objectContaining({ headers: { Accept: 'application/json', Authorization: 'Bearer balance-secret' } }));

    const updatedAgain = await service.queryBalance(relay.id);
    expect(updatedAgain.balance).toMatchObject({ remaining: 7, dailyConsumed: 1.25 });
  });

  it('retrieves a saved New API access token without exposing it in public relay data', async () => {
    const service = new ExtensionRelayService(new MemoryStorage(), new FakeTester());
    const relay = await service.createRelay({
      ...relayInput,
      balanceConfig: { template: 'newapi', requestUrl: '', apiKey: '', accessToken: 'newapi-access-token', userId: '42', timeout: 10000, intervalMinutes: 1, enabled: true }
    });
    await expect(service.getRelayBalanceCredentials(relay.id)).resolves.toEqual({ apiKey: '', accessToken: 'newapi-access-token' });
    expect(JSON.stringify(relay)).not.toContain('newapi-access-token');
  });
});
