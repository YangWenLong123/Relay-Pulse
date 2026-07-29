import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { JsonStore } from '../lib/json-store.js';
import { KeyCipher } from '../lib/key-cipher.js';
import { maskApiKey, normalizeBaseUrl } from '../lib/relay-utils.js';
import type { BalanceConfig, BalanceSnapshot, PublicBalanceConfig, PublicRelay, Relay, RelayInput, TestResult } from '../types.js';

type StoredBalanceConfig = Omit<BalanceConfig, 'apiKey' | 'accessToken'> & { apiKey?: string; accessToken?: string };
type StoredRelay = Omit<Relay, 'apiKey' | 'balanceConfig'> & {
  apiKey: string;
  apiKeyMasked?: string;
  balanceConfig?: StoredBalanceConfig;
};

export class RelayRepository {
  private readonly store: JsonStore<StoredRelay[]>;
  private readonly cipher: KeyCipher;

  constructor(
    filePath = path.join(config.dataDir, 'relays.json'),
    encryptionSecret = config.apiKeyEncryptionSecret
  ) {
    this.store = new JsonStore(filePath, []);
    this.cipher = new KeyCipher(encryptionSecret);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    const records = await this.store.read();
    records.forEach((relay) => this.toRelay(relay));
    if (this.cipher.enabled && records.some((relay) => this.hasUnencryptedSecret(relay))) {
      await this.store.update((items) => items.map((relay) => this.toStoredRelay(this.toRelay(relay))));
    }
  }

  async list(): Promise<Relay[]> {
    return (await this.store.read()).map((relay) => this.toRelay(relay));
  }

  async listPublic(): Promise<PublicRelay[]> {
    return (await this.store.read()).map((relay) => this.toPublicRelay(relay));
  }

  async find(id: string): Promise<Relay> {
    const relay = (await this.store.read()).find((item) => item.id === id);
    if (!relay) throw new HttpError(404, '中转站不存在');
    return this.toRelay(relay);
  }

  async findPublic(id: string): Promise<PublicRelay> {
    const relay = (await this.store.read()).find((item) => item.id === id);
    if (!relay) throw new HttpError(404, '中转站不存在');
    return this.toPublicRelay(relay);
  }

  async create(input: RelayInput): Promise<Relay> {
    const now = new Date().toISOString();
    const relay: Relay = {
      ...input,
      id: randomUUID(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      createdAt: now,
      updatedAt: now,
      lastTestAt: null,
      lastTestStatus: 'untested',
      lastLatency: null
    };
    await this.store.update((items) => [...items, this.toStoredRelay(relay)]);
    return relay;
  }

  async update(id: string, input: Partial<RelayInput>): Promise<Relay> {
    let updated: Relay | undefined;
    await this.store.update((items) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) throw new HttpError(404, '中转站不存在');
      const current = this.toRelay(items[index]!);
      updated = {
        ...current,
        ...input,
        baseUrl: input.baseUrl ? normalizeBaseUrl(input.baseUrl) : current.baseUrl,
        apiKey: input.apiKey?.trim() ? input.apiKey.trim() : current.apiKey,
        balanceConfig: input.balanceConfig
          ? {
              ...input.balanceConfig,
              apiKey: input.balanceConfig.apiKey?.trim() ? input.balanceConfig.apiKey.trim() : current.balanceConfig?.apiKey,
              accessToken: input.balanceConfig.accessToken?.trim()
                ? input.balanceConfig.accessToken.trim()
                : current.balanceConfig?.accessToken
            }
          : current.balanceConfig,
        updatedAt: new Date().toISOString()
      };
      const stored = this.toStoredRelay(updated);
      return items.map((item) => (item.id === id ? stored : item));
    });
    return updated!;
  }

  async duplicate(id: string): Promise<Relay> {
    const source = await this.find(id);
    return this.create({
      name: `${source.name} 副本`,
      baseUrl: source.baseUrl,
      apiKey: source.apiKey,
      model: source.model,
      protocol: source.protocol,
      enabled: source.enabled,
      timeout: source.timeout,
      remark: source.remark,
      balanceConfig: source.balanceConfig
    });
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.store.update((items) => {
      found = items.some((item) => item.id === id);
      return items.filter((item) => item.id !== id);
    });
    if (!found) throw new HttpError(404, '中转站不存在');
  }

  async batchUpdateEnabled(ids: string[], enabled: boolean): Promise<PublicRelay[]> {
    const idSet = new Set(ids);
    let updated: StoredRelay[] = [];
    await this.store.update((items) => {
      const found = new Set(items.filter((item) => idSet.has(item.id)).map((item) => item.id));
      const missing = ids.find((id) => !found.has(id));
      if (missing) throw new HttpError(404, `中转站不存在：${missing}`);
      const updatedAt = new Date().toISOString();
      updated = items
        .filter((item) => idSet.has(item.id))
        .map((item) => ({ ...item, enabled, updatedAt }));
      const updatedMap = new Map(updated.map((item) => [item.id, item]));
      return items.map((item) => updatedMap.get(item.id) ?? item);
    });
    return updated.map((relay) => this.toPublicRelay(relay));
  }

  async applyTestResult(result: TestResult): Promise<void> {
    await this.store.update((items) =>
      items.map((relay) =>
        relay.id === result.relayId
          ? {
              ...relay,
              lastTestAt: result.testedAt,
              lastTestStatus: result.success ? 'success' : 'failed',
              lastLatency: result.totalDuration,
              updatedAt: new Date().toISOString()
            }
          : relay
      )
    );
  }

  async applyBalanceSnapshot(id: string, balance: BalanceSnapshot): Promise<Relay> {
    let updated: Relay | undefined;
    await this.store.update((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        updated = { ...this.toRelay(item), balance, updatedAt: new Date().toISOString() };
        return this.toStoredRelay(updated);
      })
    );
    if (!updated) throw new HttpError(404, '中转站不存在');
    return updated;
  }

  private toStoredRelay(relay: Relay): StoredRelay {
    return {
      ...relay,
      apiKey: this.cipher.encrypt(relay.apiKey),
      balanceConfig: relay.balanceConfig
        ? {
            ...relay.balanceConfig,
            apiKey: relay.balanceConfig.apiKey ? this.cipher.encrypt(relay.balanceConfig.apiKey) : undefined,
            accessToken: relay.balanceConfig.accessToken ? this.cipher.encrypt(relay.balanceConfig.accessToken) : undefined
          }
        : undefined,
      apiKeyMasked: maskApiKey(relay.apiKey)
    };
  }

  private toRelay(relay: StoredRelay): Relay {
    const { apiKeyMasked, balanceConfig, ...stored } = relay;
    void apiKeyMasked;
    return {
      ...stored,
      apiKey: this.cipher.decrypt(relay.apiKey),
      balanceConfig: balanceConfig
        ? {
            ...balanceConfig,
            apiKey: balanceConfig.apiKey ? this.cipher.decrypt(balanceConfig.apiKey) : undefined,
            accessToken: balanceConfig.accessToken ? this.cipher.decrypt(balanceConfig.accessToken) : undefined
          }
        : undefined
    };
  }

  private toPublicRelay(relay: StoredRelay): PublicRelay {
    const { apiKey, apiKeyMasked, balanceConfig, ...safe } = relay;
    return {
      ...safe,
      apiKeyMasked: apiKeyMasked ?? maskApiKey(this.cipher.decrypt(apiKey)),
      balanceConfig: balanceConfig ? this.toPublicBalanceConfig(balanceConfig) : undefined
    };
  }

  private toPublicBalanceConfig(config: StoredBalanceConfig): PublicBalanceConfig {
    const { apiKey, accessToken, ...safe } = config;
    return { ...safe, apiKeyConfigured: Boolean(apiKey), accessTokenConfigured: Boolean(accessToken) };
  }

  private hasUnencryptedSecret(relay: StoredRelay): boolean {
    return (
      !this.cipher.isEncrypted(relay.apiKey) ||
      Boolean(relay.balanceConfig?.apiKey && !this.cipher.isEncrypted(relay.balanceConfig.apiKey)) ||
      Boolean(relay.balanceConfig?.accessToken && !this.cipher.isEncrypted(relay.balanceConfig.accessToken))
    );
  }
}
