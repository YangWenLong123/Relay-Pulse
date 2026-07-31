import { config } from '../config.js';
import type {
  PoolUsageBreakdown,
  PoolUsageFilterOption,
  PoolUsageFilterOptions,
  PoolUsageGranularity,
  PoolUsageQuery,
  PoolUsageRecord,
  PoolUsageReport,
  PoolUsageSummary,
  PoolUsageTrendPoint
} from '../types.js';

const emptySummary = (): PoolUsageSummary => ({
  requestCount: 0,
  successCount: 0,
  failureCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  averageDurationMs: 0
});

function numberOrZero(value: number | null): number {
  return value !== null && Number.isFinite(value) ? value : 0;
}

function parseTime(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function bucketKey(value: string, granularity: PoolUsageGranularity): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (granularity === 'day') return date.toISOString().slice(0, 10);
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

function updateSummary(summary: PoolUsageSummary, record: PoolUsageRecord): void {
  summary.requestCount += 1;
  if (record.status === 'success') summary.successCount += 1;
  else summary.failureCount += 1;
  summary.inputTokens += numberOrZero(record.inputTokens);
  summary.outputTokens += numberOrZero(record.outputTokens);
  summary.cachedTokens += numberOrZero(record.cachedTokens);
  summary.totalTokens += numberOrZero(record.totalTokens);
  summary.averageDurationMs += record.durationMs;
}

function finalizeSummary(summary: PoolUsageSummary): PoolUsageSummary {
  return {
    ...summary,
    averageDurationMs: summary.requestCount ? Math.round(summary.averageDurationMs / summary.requestCount) : 0
  };
}

function breakdown(
  records: PoolUsageRecord[],
  keyOf: (record: PoolUsageRecord) => string,
  labelOf: (record: PoolUsageRecord) => string
): PoolUsageBreakdown[] {
  const groups = new Map<string, { label: string; summary: PoolUsageSummary }>();
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

function trend(records: PoolUsageRecord[], granularity: PoolUsageGranularity): PoolUsageTrendPoint[] {
  const buckets = new Map<string, PoolUsageTrendPoint>();
  records.forEach((record) => {
    const bucket = bucketKey(record.createdAt, granularity);
    if (!bucket) return;
    const point = buckets.get(bucket) ?? {
      bucket,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0
    };
    point.requestCount += 1;
    point.inputTokens += numberOrZero(record.inputTokens);
    point.outputTokens += numberOrZero(record.outputTokens);
    point.cachedTokens += numberOrZero(record.cachedTokens);
    point.totalTokens += numberOrZero(record.totalTokens);
    buckets.set(bucket, point);
  });
  return [...buckets.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function filterOptions(records: PoolUsageRecord[]): PoolUsageFilterOptions {
  const models = new Map<string, PoolUsageFilterOption>();
  const relays = new Map<string, PoolUsageFilterOption>();
  records.forEach((record) => {
    if (record.model) models.set(record.model, { value: record.model, label: record.model });
    if (record.relayId && !relays.has(record.relayId)) {
      relays.set(record.relayId, {
        value: record.relayId,
        label: record.relayName || '未记录中转站'
      });
    }
  });
  const sortOptions = (options: Iterable<PoolUsageFilterOption>): PoolUsageFilterOption[] =>
    [...options].sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return { models: sortOptions(models.values()), relays: sortOptions(relays.values()) };
}

export class PoolUsageRepository {
  private readonly limit: number;
  private records: PoolUsageRecord[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(filePathOrLimit: string | number = config.poolUsageLimit, limit = config.poolUsageLimit) {
    this.limit = typeof filePathOrLimit === 'number' ? filePathOrLimit : limit;
  }

  async initialize(): Promise<void> {
    await this.queue;
  }

  async add(record: PoolUsageRecord): Promise<void> {
    const operation = this.queue.then(() => {
      this.records = [...this.records, record].slice(-this.limit);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  async clear(): Promise<void> {
    const operation = this.queue.then(() => {
      this.records = [];
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  async report(query: PoolUsageQuery): Promise<PoolUsageReport> {
    const from = query.from ? parseTime(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? parseTime(query.to) : Number.POSITIVE_INFINITY;
    await this.queue;
    const contextualRecords = this.records
      .filter((record) => {
        const timestamp = parseTime(record.createdAt);
        return (
          timestamp >= from &&
          timestamp <= to &&
          (!query.endpoint || record.endpoint === query.endpoint) &&
          (!query.status || record.status === query.status)
        );
      })
      .sort((left, right) => parseTime(right.createdAt) - parseTime(left.createdAt));
    const records = contextualRecords.filter(
      (record) => (!query.model || record.model === query.model) && (!query.relayId || record.relayId === query.relayId)
    );
    const summary = records.reduce((result, record) => {
      updateSummary(result, record);
      return result;
    }, emptySummary());
    return {
      records: records.slice(query.offset, query.offset + query.limit),
      total: records.length,
      summary: finalizeSummary(summary),
      byModel: breakdown(records, (record) => record.model, (record) => record.model),
      byRelay: breakdown(records, (record) => record.relayId ?? 'unknown', (record) => record.relayName),
      byEndpoint: breakdown(records, (record) => record.endpoint, (record) => record.endpoint),
      trend: trend(records, query.granularity),
      filterOptions: filterOptions(contextualRecords)
    };
  }
}
