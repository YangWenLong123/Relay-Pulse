import path from 'node:path';
import { config } from '../config.js';
import { JsonStore } from '../lib/json-store.js';
const emptySummary = () => ({
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    averageDurationMs: 0
});
function numberOrZero(value) {
    return value !== null && Number.isFinite(value) ? value : 0;
}
function timestamp(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
}
function updateSummary(summary, record) {
    summary.requestCount += 1;
    if (record.status === 'success')
        summary.successCount += 1;
    else
        summary.failureCount += 1;
    summary.inputTokens += numberOrZero(record.inputTokens);
    summary.outputTokens += numberOrZero(record.outputTokens);
    summary.cachedTokens += numberOrZero(record.cachedTokens);
    summary.totalTokens += numberOrZero(record.totalTokens);
    summary.averageDurationMs += record.durationMs;
}
function finalizeSummary(summary) {
    return {
        ...summary,
        averageDurationMs: summary.requestCount ? Math.round(summary.averageDurationMs / summary.requestCount) : 0
    };
}
function breakdown(records, keyOf, labelOf) {
    const groups = new Map();
    records.forEach((record) => {
        const key = keyOf(record) || 'unknown';
        const group = groups.get(key) ?? { label: labelOf(record) || '未知', summary: emptySummary() };
        updateSummary(group.summary, record);
        groups.set(key, group);
    });
    return [...groups.entries()]
        .map(([key, group]) => ({ key, label: group.label, ...finalizeSummary(group.summary) }))
        .sort((left, right) => right.requestCount - left.requestCount || left.label.localeCompare(right.label));
}
function filterOptions(records) {
    const models = new Map();
    const accounts = new Map();
    records.forEach((record) => {
        if (record.model)
            models.set(record.model, { value: record.model, label: record.model });
        if (record.accountId)
            accounts.set(record.accountId, { value: record.accountId, label: record.accountLabel || '未命名账号' });
    });
    const sort = (items) => [...items].sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
    return { models: sort(models.values()), accounts: sort(accounts.values()) };
}
export class CodexUsageRepository {
    store;
    limit;
    constructor(filePath = path.join(config.dataDir, 'codex-usage.json'), limit = config.codexUsageLimit) {
        this.store = new JsonStore(filePath, []);
        this.limit = limit;
    }
    initialize() {
        return this.store.initialize();
    }
    async add(record) {
        await this.store.update((records) => [...records, record].slice(-this.limit));
    }
    async clear() {
        await this.store.update(() => []);
    }
    async report(query) {
        const from = query.from ? timestamp(query.from) : Number.NEGATIVE_INFINITY;
        const to = query.to ? timestamp(query.to) : Number.POSITIVE_INFINITY;
        const all = await this.store.read();
        const contextual = all
            .filter((record) => {
            const created = timestamp(record.createdAt);
            return created >= from && created <= to && (!query.status || record.status === query.status);
        })
            .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
        const records = contextual.filter((record) => (!query.model || record.model === query.model) && (!query.accountId || record.accountId === query.accountId));
        const summary = records.reduce((result, record) => {
            updateSummary(result, record);
            return result;
        }, emptySummary());
        return {
            records: records.slice(query.offset, query.offset + query.limit),
            total: records.length,
            summary: finalizeSummary(summary),
            byModel: breakdown(records, (record) => record.model, (record) => record.model),
            byAccount: breakdown(records, (record) => record.accountId ?? 'unknown', (record) => record.accountLabel),
            filterOptions: filterOptions(contextual)
        };
    }
}
