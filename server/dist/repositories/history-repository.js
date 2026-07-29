import path from 'node:path';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { JsonStore } from '../lib/json-store.js';
export class HistoryRepository {
    store;
    constructor(filePath = path.join(config.dataDir, 'test-history.json')) {
        this.store = new JsonStore(filePath, []);
    }
    initialize() {
        return this.store.initialize();
    }
    async list(filter = {}) {
        const records = await this.store.read();
        return records
            .filter((record) => !filter.relayId || record.relayId === filter.relayId)
            .filter((record) => filter.success === undefined || record.success === filter.success)
            .filter((record) => !filter.from || record.testedAt >= filter.from)
            .filter((record) => !filter.to || record.testedAt <= filter.to)
            .sort((a, b) => b.testedAt.localeCompare(a.testedAt));
    }
    async add(result) {
        await this.store.update((records) => [...records, result].slice(-config.historyLimit));
    }
    async remove(id) {
        let found = false;
        await this.store.update((records) => {
            found = records.some((record) => record.id === id);
            return records.filter((record) => record.id !== id);
        });
        if (!found)
            throw new HttpError(404, '历史记录不存在');
    }
    async clear() {
        await this.store.update(() => []);
    }
}
