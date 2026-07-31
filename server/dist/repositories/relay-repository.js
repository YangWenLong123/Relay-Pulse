import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { JsonStore } from '../lib/json-store.js';
import { KeyCipher } from '../lib/key-cipher.js';
import { maskApiKey, normalizeBaseUrl } from '../lib/relay-utils.js';
export class RelayRepository {
    store;
    cipher;
    constructor(filePath = path.join(config.dataDir, 'relays.json'), encryptionSecret = config.apiKeyEncryptionSecret) {
        this.store = new JsonStore(filePath, []);
        this.cipher = new KeyCipher(encryptionSecret);
    }
    async initialize() {
        await this.store.initialize();
        const records = await this.store.read();
        records.forEach((relay) => this.toRelay(relay));
        if (this.cipher.enabled && records.some((relay) => this.hasUnencryptedSecret(relay))) {
            await this.store.update((items) => items.map((relay) => this.toStoredRelay(this.toRelay(relay))));
        }
    }
    async list() {
        return (await this.store.read()).map((relay) => this.toRelay(relay));
    }
    async listPublic() {
        return (await this.store.read()).map((relay) => this.toPublicRelay(relay));
    }
    async find(id) {
        const relay = (await this.store.read()).find((item) => item.id === id);
        if (!relay)
            throw new HttpError(404, '中转站不存在');
        return this.toRelay(relay);
    }
    async findPublic(id) {
        const relay = (await this.store.read()).find((item) => item.id === id);
        if (!relay)
            throw new HttpError(404, '中转站不存在');
        return this.toPublicRelay(relay);
    }
    async create(input) {
        return (await this.createMany([input]))[0];
    }
    async createMany(inputs) {
        const now = new Date().toISOString();
        const relays = inputs.map((input) => ({
            ...input,
            id: randomUUID(),
            baseUrl: normalizeBaseUrl(input.baseUrl),
            createdAt: now,
            updatedAt: now,
            lastTestAt: null,
            lastTestStatus: 'untested',
            lastLatency: null
        }));
        await this.store.update((items) => [...items, ...relays.map((relay) => this.toStoredRelay(relay))]);
        return relays;
    }
    async update(id, input) {
        let updated;
        await this.store.update((items) => {
            const index = items.findIndex((item) => item.id === id);
            if (index < 0)
                throw new HttpError(404, '中转站不存在');
            const current = this.toRelay(items[index]);
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
        return updated;
    }
    async duplicate(id) {
        const source = await this.find(id);
        return this.create({
            name: `${source.name} 副本`,
            baseUrl: source.baseUrl,
            apiKey: source.apiKey,
            model: source.model,
            platform: source.platform,
            protocol: source.protocol,
            enabled: source.enabled,
            timeout: source.timeout,
            remark: source.remark,
            balanceConfig: source.balanceConfig
        });
    }
    async remove(id) {
        let found = false;
        await this.store.update((items) => {
            found = items.some((item) => item.id === id);
            return items.filter((item) => item.id !== id);
        });
        if (!found)
            throw new HttpError(404, '中转站不存在');
    }
    async batchUpdateEnabled(ids, enabled) {
        const idSet = new Set(ids);
        let updated = [];
        await this.store.update((items) => {
            const found = new Set(items.filter((item) => idSet.has(item.id)).map((item) => item.id));
            const missing = ids.find((id) => !found.has(id));
            if (missing)
                throw new HttpError(404, `中转站不存在：${missing}`);
            const updatedAt = new Date().toISOString();
            updated = items
                .filter((item) => idSet.has(item.id))
                .map((item) => ({ ...item, enabled, updatedAt }));
            const updatedMap = new Map(updated.map((item) => [item.id, item]));
            return items.map((item) => updatedMap.get(item.id) ?? item);
        });
        return updated.map((relay) => this.toPublicRelay(relay));
    }
    async reorder(ids) {
        let ordered = [];
        await this.store.update((items) => {
            if (ids.length !== items.length)
                throw new HttpError(400, '排序列表必须包含全部中转站');
            const byId = new Map(items.map((item) => [item.id, item]));
            const missing = ids.find((id) => !byId.has(id));
            if (missing)
                throw new HttpError(404, `中转站不存在：${missing}`);
            ordered = ids.map((id) => byId.get(id));
            return ordered;
        });
        return ordered.map((relay) => this.toPublicRelay(relay));
    }
    async applyTestResult(result) {
        await this.store.update((items) => items.map((relay) => relay.id === result.relayId
            ? {
                ...relay,
                lastTestAt: result.testedAt,
                lastTestStatus: result.success ? 'success' : 'failed',
                lastLatency: result.totalDuration,
                updatedAt: new Date().toISOString()
            }
            : relay));
    }
    async applyBalanceSnapshot(id, balance) {
        let updated;
        await this.store.update((items) => items.map((item) => {
            if (item.id !== id)
                return item;
            updated = { ...this.toRelay(item), balance, updatedAt: new Date().toISOString() };
            return this.toStoredRelay(updated);
        }));
        if (!updated)
            throw new HttpError(404, '中转站不存在');
        return updated;
    }
    toStoredRelay(relay) {
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
    toRelay(relay) {
        const { apiKeyMasked, balanceConfig, ...stored } = relay;
        void apiKeyMasked;
        return {
            ...stored,
            platform: relay.platform ?? 'openai',
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
    toPublicRelay(relay) {
        const { apiKey, apiKeyMasked, balanceConfig, ...safe } = relay;
        return {
            ...safe,
            platform: relay.platform ?? 'openai',
            apiKeyMasked: apiKeyMasked ?? maskApiKey(this.cipher.decrypt(apiKey)),
            balanceConfig: balanceConfig ? this.toPublicBalanceConfig(balanceConfig) : undefined
        };
    }
    toPublicBalanceConfig(config) {
        const { apiKey, accessToken, ...safe } = config;
        return { ...safe, apiKeyConfigured: Boolean(apiKey), accessTokenConfigured: Boolean(accessToken) };
    }
    hasUnencryptedSecret(relay) {
        return (!this.cipher.isEncrypted(relay.apiKey) ||
            Boolean(relay.balanceConfig?.apiKey && !this.cipher.isEncrypted(relay.balanceConfig.apiKey)) ||
            Boolean(relay.balanceConfig?.accessToken && !this.cipher.isEncrypted(relay.balanceConfig.accessToken)));
    }
}
