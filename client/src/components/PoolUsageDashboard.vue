<!--
 * @Description: 号池服务调用记录与使用统计展示面板
 * @Date: 2026-07-30
 * @FilePath: client/src/components/PoolUsageDashboard.vue
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CSSProperties } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BarChartOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  DownloadOutlined,
  FileTextOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue';
import PaginationControl from './PaginationControl.vue';

export type PoolUsageRequestStatus = 'success' | 'failed' | 'fallback' | 'exhausted';
export type PoolUsageMetric = 'requests' | 'tokens';

export interface PoolUsageSummary {
  totalRequests: number;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  successCount?: number;
  failureCount?: number;
  averageLatencyMs?: number | null;
}

export interface PoolUsageRecord {
  id: string;
  createdAt: string;
  apiKeyLabel?: string;
  model: string;
  relayName?: string;
  relayId?: string;
  endpoint?: string;
  status: PoolUsageRequestStatus;
  statusCode?: number | null;
  attemptCount?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  totalTokens?: number | null;
  cost?: number | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  errorMessage?: string;
}

export interface PoolUsageDistribution {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  cost?: number | null;
}

export interface PoolUsageTrendPoint {
  bucket: string;
  label?: string;
  requests: number;
  tokens?: number | null;
}

export interface PoolUsageAnalytics {
  modelDistribution?: PoolUsageDistribution[];
  relayDistribution?: PoolUsageDistribution[];
  trend?: PoolUsageTrendPoint[];
}

export interface PoolUsageOption {
  label: string;
  value: string;
}

export interface PoolUsageFilters {
  timeRange?: string;
  granularity?: string;
  apiKey?: string;
  model?: string;
  relayId?: string;
  endpoint?: string;
  status?: PoolUsageRequestStatus | 'all';
}

export interface PoolUsagePagination {
  current: number;
  pageSize: number;
  total: number;
}

interface DistributionVisual extends PoolUsageDistribution {
  color: string;
  value: number;
  percentage: number;
}

interface TrendVisual extends PoolUsageTrendPoint {
  value: number;
  height: number;
  displayLabel: string;
}

const DISTRIBUTION_COLORS = ['#397c78', '#4f7fa8', '#b7792d', '#8560c5', '#c15e75', '#4b9b72'];
function createEmptySummary(): PoolUsageSummary {
  return {
    totalRequests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    successCount: 0,
    failureCount: 0,
    averageLatencyMs: null
  };
}

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    summary?: PoolUsageSummary;
    records?: PoolUsageRecord[];
    analytics?: PoolUsageAnalytics;
    filters?: PoolUsageFilters;
    pagination?: PoolUsagePagination;
    loading?: boolean;
    error?: string;
    apiKeyOptions?: PoolUsageOption[];
    modelOptions?: PoolUsageOption[];
    relayOptions?: PoolUsageOption[];
    endpointOptions?: PoolUsageOption[];
    timeRangeOptions?: PoolUsageOption[];
    granularityOptions?: PoolUsageOption[];
    statusOptions?: PoolUsageOption[];
    exportEnabled?: boolean;
  }>(),
  {
    title: '号池使用记录',
    description: '查看调用量、Token 消耗及中转切换情况。',
    summary: () => ({
      totalRequests: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      successCount: 0,
      failureCount: 0,
      averageLatencyMs: null
    }),
    records: () => [],
    filters: () => ({ timeRange: '24h', granularity: 'hour', status: 'all' }),
    pagination: () => ({ current: 1, pageSize: 20, total: 0 }),
    loading: false,
    error: '',
    apiKeyOptions: () => [],
    modelOptions: () => [],
    relayOptions: () => [],
    endpointOptions: () => [],
    timeRangeOptions: () => [
      { label: '近 24 小时', value: '24h' },
      { label: '近 7 天', value: '7d' },
      { label: '近 30 天', value: '30d' }
    ],
    granularityOptions: () => [
      { label: '按小时', value: 'hour' },
      { label: '按天', value: 'day' }
    ],
    statusOptions: () => [
      { label: '全部结果', value: 'all' },
      { label: '成功', value: 'success' },
      { label: '失败', value: 'failed' },
      { label: '切换成功', value: 'fallback' },
      { label: '余额耗尽', value: 'exhausted' }
    ],
    exportEnabled: true
  }
);

const emit = defineEmits<{
  'update:filters': [filters: PoolUsageFilters];
  'update:pagination': [pagination: PoolUsagePagination];
  refresh: [];
  retry: [];
  export: [];
}>();

const distributionMetric = ref<PoolUsageMetric>('tokens');
const trendMetric = ref<PoolUsageMetric>('tokens');

const tableColumns: TableColumnsType<PoolUsageRecord> = [
  { title: 'API 密钥', key: 'apiKey', width: 150, fixed: 'left' },
  { title: '模型', dataIndex: 'model', key: 'model', width: 170 },
  { title: '中转站', key: 'relay', width: 160 },
  { title: '端点', key: 'endpoint', width: 146 },
  { title: '结果', key: 'status', width: 110 },
  { title: '尝试', key: 'attempts', width: 92, align: 'center' },
  { title: 'Token', key: 'tokens', width: 196 },
  { title: '延迟', key: 'latency', width: 148 },
  { title: '时间', key: 'createdAt', width: 172 }
];

const totalRecords = computed(() => props.pagination.total || props.records.length);
const summary = computed<PoolUsageSummary>(() => ({ ...createEmptySummary(), ...props.summary }));
const modelDistribution = computed(() => normalizedDistribution(props.analytics?.modelDistribution, (record) => record.model || '未标记模型'));
const relayDistribution = computed(() => normalizedDistribution(props.analytics?.relayDistribution, (record) => record.relayName || '未记录中转站'));
const modelVisuals = computed(() => createDistributionVisuals(modelDistribution.value, distributionMetric.value));
const relayVisuals = computed(() => createDistributionVisuals(relayDistribution.value, distributionMetric.value));
const trendPoints = computed(() => resolveTrendPoints());
const trendVisuals = computed(() => createTrendVisuals(trendPoints.value, trendMetric.value));
const trendTotal = computed(() => trendVisuals.value.reduce((total, point) => total + point.value, 0));

function finiteNumber(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recordTokens(record: PoolUsageRecord): number {
  if (hasNumber(record.totalTokens)) return record.totalTokens;
  return finiteNumber(record.inputTokens) + finiteNumber(record.outputTokens) + finiteNumber(record.cachedTokens);
}

function normalizedDistribution(
  source: PoolUsageDistribution[] | undefined,
  labelForRecord: (record: PoolUsageRecord) => string
): PoolUsageDistribution[] {
  const entries = source?.length ? source : createDistributionFromRecords(labelForRecord);
  const cleanEntries = entries
    .map((entry) => ({
      key: entry.key || entry.label,
      label: entry.label || '未标记',
      requests: finiteNumber(entry.requests),
      tokens: finiteNumber(entry.tokens),
      cost: entry.cost
    }))
    .filter((entry) => entry.requests > 0 || entry.tokens > 0);
  const sorted = cleanEntries.sort((left, right) => right.tokens - left.tokens || right.requests - left.requests);

  if (sorted.length <= DISTRIBUTION_COLORS.length) return sorted;
  const visible = sorted.slice(0, DISTRIBUTION_COLORS.length - 1);
  const remaining = sorted.slice(DISTRIBUTION_COLORS.length - 1).reduce<PoolUsageDistribution>(
    (total, entry) => ({
      key: 'other',
      label: '其他',
      requests: total.requests + entry.requests,
      tokens: total.tokens + entry.tokens,
      cost: finiteNumber(total.cost) + finiteNumber(entry.cost)
    }),
    { key: 'other', label: '其他', requests: 0, tokens: 0, cost: 0 }
  );
  return [...visible, remaining];
}

function createDistributionFromRecords(labelForRecord: (record: PoolUsageRecord) => string): PoolUsageDistribution[] {
  const entries = new Map<string, PoolUsageDistribution>();
  for (const record of props.records) {
    const label = labelForRecord(record);
    const existing = entries.get(label) ?? { key: label, label, requests: 0, tokens: 0, cost: 0 };
    existing.requests += 1;
    existing.tokens += recordTokens(record);
    existing.cost = finiteNumber(existing.cost) + finiteNumber(record.cost);
    entries.set(label, existing);
  }
  return [...entries.values()];
}

function createDistributionVisuals(entries: PoolUsageDistribution[], metric: PoolUsageMetric): DistributionVisual[] {
  const total = entries.reduce((sum, entry) => sum + (metric === 'tokens' ? entry.tokens : entry.requests), 0);
  return entries.map((entry, index) => {
    const value = metric === 'tokens' ? entry.tokens : entry.requests;
    return {
      ...entry,
      color: DISTRIBUTION_COLORS[index % DISTRIBUTION_COLORS.length],
      value,
      percentage: total > 0 ? (value / total) * 100 : 0
    };
  });
}

function resolveTrendPoints(): PoolUsageTrendPoint[] {
  if (props.analytics?.trend?.length) return props.analytics.trend;

  const buckets = new Map<string, PoolUsageTrendPoint>();
  for (const record of props.records) {
    const createdAt = new Date(record.createdAt);
    if (Number.isNaN(createdAt.valueOf())) continue;
    const bucket = trendBucket(createdAt);
    const existing = buckets.get(bucket.key) ?? { bucket: bucket.key, label: bucket.label, requests: 0, tokens: 0 };
    existing.requests += 1;
    existing.tokens = finiteNumber(existing.tokens) + recordTokens(record);
    buckets.set(bucket.key, existing);
  }
  return [...buckets.values()].sort((left, right) => left.bucket.localeCompare(right.bucket));
}

function trendBucket(date: Date): { key: string; label: string } {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  if (props.filters.granularity === 'day') {
    return { key: `${year}-${month}-${day}`, label: `${month}/${day}` };
  }
  const hour = String(date.getHours()).padStart(2, '0');
  return { key: `${year}-${month}-${day} ${hour}`, label: `${month}/${day} ${hour}:00` };
}

function createTrendVisuals(points: PoolUsageTrendPoint[], metric: PoolUsageMetric): TrendVisual[] {
  const values = points.map((point) => (metric === 'tokens' ? finiteNumber(point.tokens) : finiteNumber(point.requests)));
  const maximum = Math.max(...values, 1);
  return points.map((point, index) => {
    const value = values[index];
    return {
      ...point,
      value,
      height: value > 0 ? Math.max(8, Math.round((value / maximum) * 100)) : 0,
      displayLabel: point.label || formatTrendLabel(point.bucket)
    };
  });
}

function updateFilter(key: keyof PoolUsageFilters, value: string | undefined): void {
  emit('update:filters', { ...props.filters, [key]: value || undefined });
}

function resetFilters(): void {
  emit('update:filters', {
    timeRange: props.timeRangeOptions[0]?.value,
    granularity: props.granularityOptions[0]?.value,
    status: 'all'
  });
}

function updateCurrentPage(current: number): void {
  emit('update:pagination', { ...props.pagination, current });
}

function updatePageSize(pageSize: number): void {
  emit('update:pagination', { ...props.pagination, current: 1, pageSize });
}

function donutStyle(segments: DistributionVisual[]): CSSProperties {
  if (!segments.length) return { background: 'conic-gradient(var(--border) 0deg 360deg)' };
  let current = 0;
  const parts = segments.map((segment) => {
    const next = current + segment.percentage * 3.6;
    const result = `${segment.color} ${current.toFixed(2)}deg ${next.toFixed(2)}deg`;
    current = next;
    return result;
  });
  return { background: `conic-gradient(${parts.join(', ')})` };
}

function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`;
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function formatTokenCount(value: number | null | undefined): string {
  return hasNumber(value) ? new Intl.NumberFormat('zh-CN').format(value) : '-';
}

function formatSuccessRate(successCount: number | undefined, requestCount: number): string {
  if (!requestCount) return '-';
  return `${((finiteNumber(successCount) / requestCount) * 100).toFixed(1)}%`;
}

function formatLatency(value: number | null | undefined): string {
  if (!hasNumber(value)) return '-';
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value || '-';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function formatTrendLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return props.filters.granularity === 'day'
    ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
    : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).format(date);
}

function statusLabel(status: PoolUsageRequestStatus): string {
  return {
    success: '成功',
    failed: '失败',
    fallback: '切换成功',
    exhausted: '余额耗尽'
  }[status];
}

function statusColor(status: PoolUsageRequestStatus): string {
  return {
    success: 'success',
    failed: 'error',
    fallback: 'gold',
    exhausted: 'warning'
  }[status];
}

</script>

<template>
  <section class="pool-usage-dashboard" aria-label="号池使用记录">
    <header class="usage-heading">
      <div>
        <h2>{{ title }}</h2>
        <p>{{ description }}</p>
      </div>
      <a-space class="usage-heading-actions" :size="8">
        <a-tooltip title="刷新使用记录">
          <a-button :loading="loading" aria-label="刷新使用记录" @click="emit('refresh')">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
        </a-tooltip>
        <a-button v-if="exportEnabled" type="primary" :disabled="loading || !records.length" @click="emit('export')">
          <template #icon><DownloadOutlined /></template>
          导出 CSV
        </a-button>
      </a-space>
    </header>

    <section class="usage-metric-band" aria-label="使用概览">
      <div class="usage-metric">
        <span class="usage-metric-icon requests"><FileTextOutlined /></span>
        <div>
          <span class="usage-metric-label">总请求数</span>
          <strong class="usage-metric-value">{{ formatCompactNumber(summary.totalRequests) }}</strong>
          <span class="usage-metric-detail">当前筛选范围</span>
        </div>
      </div>
      <div class="usage-metric">
        <span class="usage-metric-icon tokens"><DatabaseOutlined /></span>
        <div>
          <span class="usage-metric-label">总 Token</span>
          <strong class="usage-metric-value">{{ formatCompactNumber(summary.totalTokens) }}</strong>
          <span class="usage-metric-detail">输入 {{ formatCompactNumber(summary.inputTokens || 0) }} / 输出 {{ formatCompactNumber(summary.outputTokens || 0) }}</span>
        </div>
      </div>
      <div class="usage-metric">
        <span class="usage-metric-icon success"><CheckCircleOutlined /></span>
        <div>
          <span class="usage-metric-label">成功率</span>
          <strong class="usage-metric-value">{{ formatSuccessRate(summary.successCount, summary.totalRequests) }}</strong>
          <span class="usage-metric-detail">成功 {{ formatCompactNumber(summary.successCount || 0) }} / 失败 {{ formatCompactNumber(summary.failureCount || 0) }}</span>
        </div>
      </div>
      <div class="usage-metric">
        <span class="usage-metric-icon latency"><ClockCircleOutlined /></span>
        <div>
          <span class="usage-metric-label">平均耗时</span>
          <strong class="usage-metric-value">{{ formatLatency(summary.averageLatencyMs) }}</strong>
          <span class="usage-metric-detail">请求完整响应耗时</span>
        </div>
      </div>
    </section>

    <section class="usage-filter-panel" aria-label="使用记录筛选">
      <div class="usage-filter-primary">
        <label class="usage-filter-field usage-filter-range">
          <span>时间范围</span>
          <a-select :value="filters.timeRange" @update:value="updateFilter('timeRange', $event)">
            <a-select-option v-for="option in timeRangeOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
        <label class="usage-filter-field usage-filter-granularity">
          <span>粒度</span>
          <a-select :value="filters.granularity" @update:value="updateFilter('granularity', $event)">
            <a-select-option v-for="option in granularityOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
      </div>
      <div class="usage-filter-secondary">
        <label v-if="apiKeyOptions.length" class="usage-filter-field">
          <span>API 密钥</span>
          <a-select allow-clear :value="filters.apiKey" placeholder="全部密钥" @update:value="updateFilter('apiKey', $event)">
            <a-select-option v-for="option in apiKeyOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
        <label class="usage-filter-field">
          <span>模型</span>
          <a-select allow-clear :value="filters.model" placeholder="全部模型" @update:value="updateFilter('model', $event)">
            <a-select-option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
        <label class="usage-filter-field">
          <span>中转站</span>
          <a-select allow-clear :value="filters.relayId" placeholder="全部中转站" @update:value="updateFilter('relayId', $event)">
            <a-select-option v-for="option in relayOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
        <label class="usage-filter-field">
          <span>端点</span>
          <a-select allow-clear :value="filters.endpoint" placeholder="全部端点" @update:value="updateFilter('endpoint', $event)">
            <a-select-option v-for="option in endpointOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
        <label class="usage-filter-field">
          <span>结果</span>
          <a-select :value="filters.status || 'all'" @update:value="updateFilter('status', $event === 'all' ? undefined : $event)">
            <a-select-option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</a-select-option>
          </a-select>
        </label>
      </div>
      <div class="usage-filter-actions">
        <a-button :disabled="loading" @click="resetFilters">重置</a-button>
      </div>
    </section>

    <div v-if="error" class="usage-error" role="alert">
      <span>{{ error }}</span>
      <a-button size="small" :loading="loading" @click="emit('retry')">重试</a-button>
    </div>

    <a-spin :spinning="loading">
      <section class="usage-analytics" aria-label="用量分布与趋势">
        <article class="usage-analytic-panel">
          <div class="usage-panel-heading">
            <h3>模型分布</h3>
            <a-segmented v-model:value="distributionMetric" size="small" :options="[{ label: '按 Token', value: 'tokens' }, { label: '按请求', value: 'requests' }]" />
          </div>
          <div v-if="modelVisuals.length" class="usage-distribution-content">
            <div class="usage-donut" :style="donutStyle(modelVisuals)" role="img" :aria-label="`模型分布，按${distributionMetric === 'tokens' ? ' Token' : '请求'}统计`">
              <div class="usage-donut-center"><strong>{{ formatCompactNumber(modelVisuals.reduce((total, entry) => total + entry.value, 0)) }}</strong><span>{{ distributionMetric === 'tokens' ? 'Token' : '请求' }}</span></div>
            </div>
            <div class="usage-distribution-list">
              <div v-for="entry in modelVisuals" :key="entry.key" class="usage-distribution-row">
                <span class="usage-distribution-name"><i :style="{ background: entry.color }"></i><span class="truncate">{{ entry.label }}</span></span>
                <strong>{{ formatCompactNumber(entry.value) }}</strong>
                <span class="usage-distribution-percent">{{ entry.percentage.toFixed(1) }}%</span>
              </div>
            </div>
          </div>
          <a-empty v-else :image="false" description="暂无模型使用数据" class="usage-chart-empty" />
        </article>

        <article class="usage-analytic-panel">
          <div class="usage-panel-heading">
            <h3>中转站分布</h3>
            <span class="usage-panel-note">按实际响应中转站</span>
          </div>
          <div v-if="relayVisuals.length" class="usage-distribution-content">
            <div class="usage-donut" :style="donutStyle(relayVisuals)" role="img" :aria-label="`中转站分布，按${distributionMetric === 'tokens' ? ' Token' : '请求'}统计`">
              <div class="usage-donut-center"><strong>{{ formatCompactNumber(relayVisuals.reduce((total, entry) => total + entry.value, 0)) }}</strong><span>{{ distributionMetric === 'tokens' ? 'Token' : '请求' }}</span></div>
            </div>
            <div class="usage-distribution-list">
              <div v-for="entry in relayVisuals" :key="entry.key" class="usage-distribution-row">
                <span class="usage-distribution-name"><i :style="{ background: entry.color }"></i><span class="truncate">{{ entry.label }}</span></span>
                <strong>{{ formatCompactNumber(entry.value) }}</strong>
                <span class="usage-distribution-percent">{{ entry.percentage.toFixed(1) }}%</span>
              </div>
            </div>
          </div>
          <a-empty v-else :image="false" description="暂无中转站使用数据" class="usage-chart-empty" />
        </article>

        <article class="usage-analytic-panel usage-trend-panel">
          <div class="usage-panel-heading">
            <h3>使用趋势</h3>
            <a-segmented v-model:value="trendMetric" size="small" :options="[{ label: 'Token', value: 'tokens' }, { label: '请求', value: 'requests' }]" />
          </div>
          <div v-if="trendVisuals.length" class="usage-trend" role="img" :aria-label="`${trendMetric === 'tokens' ? 'Token' : '请求'}使用趋势`">
            <div class="usage-trend-total"><BarChartOutlined /><strong>{{ formatCompactNumber(trendTotal) }}</strong><span>{{ trendMetric === 'tokens' ? 'Token' : '请求' }}</span></div>
            <div class="usage-trend-bars">
              <a-tooltip v-for="point in trendVisuals" :key="point.bucket" :title="`${point.displayLabel}：${formatCompactNumber(point.value)} ${trendMetric === 'tokens' ? 'Token' : '请求'}`">
                <div class="usage-trend-bar-wrap">
                  <div class="usage-trend-bar" :style="{ height: `${point.height}%` }"></div>
                  <span>{{ point.displayLabel }}</span>
                </div>
              </a-tooltip>
            </div>
          </div>
          <a-empty v-else :image="false" description="暂无趋势数据" class="usage-chart-empty" />
        </article>
      </section>

      <section class="usage-records-panel" aria-label="调用明细">
        <div class="usage-panel-heading usage-records-heading">
          <div><h3>调用明细</h3><span>{{ totalRecords ? `共 ${totalRecords} 条结果` : '尚无调用记录' }}</span></div>
          <span v-if="loading" class="usage-panel-note">正在加载最新数据</span>
        </div>

        <div class="usage-desktop-table">
          <a-table
            class="usage-table"
            row-key="id"
            :columns="tableColumns"
            :data-source="records"
            :loading="loading"
            :pagination="false"
            :scroll="{ x: 1328 }"
          >
            <template #emptyText><a-empty description="暂无符合条件的调用记录" /></template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'apiKey'"><span class="usage-api-key mono truncate">{{ record.apiKeyLabel || '-' }}</span></template>
              <template v-else-if="column.key === 'model'"><a-tooltip :title="record.model"><strong class="usage-model truncate">{{ record.model }}</strong></a-tooltip></template>
              <template v-else-if="column.key === 'relay'"><a-tooltip :title="record.relayName || '未记录'"><span class="usage-relay truncate">{{ record.relayName || '-' }}</span></a-tooltip></template>
              <template v-else-if="column.key === 'endpoint'"><span class="usage-endpoint mono">{{ record.endpoint || '-' }}</span></template>
              <template v-else-if="column.key === 'status'">
                <a-tooltip :title="record.errorMessage || (record.statusCode ? `HTTP ${record.statusCode}` : statusLabel(record.status))"><a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag></a-tooltip>
              </template>
              <template v-else-if="column.key === 'attempts'"><span>{{ record.attemptCount || 1 }} 次</span></template>
              <template v-else-if="column.key === 'tokens'">
                <a-popover placement="bottomLeft" overlay-class-name="usage-token-popover">
                  <template #content>
                    <div class="usage-token-detail">
                      <strong>Token 明细</strong>
                      <span><label>输入 Token</label><b>{{ formatTokenCount(record.inputTokens) }}</b></span>
                      <span><label>输出 Token</label><b>{{ formatTokenCount(record.outputTokens) }}</b></span>
                      <span><label>缓存读取 Token</label><b>{{ formatTokenCount(record.cachedTokens) }}</b></span>
                      <span class="usage-token-total"><label>总 Token</label><b>{{ formatTokenCount(recordTokens(record)) }}</b></span>
                    </div>
                  </template>
                  <div class="usage-token-cell" tabindex="0">
                    <div>
                      <span class="usage-token-input"><ArrowDownOutlined />{{ formatTokenCount(record.inputTokens) }}</span>
                      <span class="usage-token-output"><ArrowUpOutlined />{{ formatTokenCount(record.outputTokens) }}</span>
                    </div>
                    <span class="usage-token-cache"><DatabaseOutlined />{{ hasNumber(record.cachedTokens) ? formatCompactNumber(record.cachedTokens) : '-' }}</span>
                  </div>
                </a-popover>
              </template>
              <template v-else-if="column.key === 'latency'">
                <div class="usage-latency"><span><label>首字</label><b>{{ formatLatency(record.firstByteLatencyMs) }}</b></span><span><label>总耗时</label><b>{{ formatLatency(record.latencyMs) }}</b></span></div>
              </template>
              <template v-else-if="column.key === 'createdAt'"><span class="usage-time">{{ formatDateTime(record.createdAt) }}</span></template>
            </template>
          </a-table>
        </div>

        <div class="usage-mobile-records">
          <div v-for="record in records" :key="record.id" class="usage-mobile-record">
            <div class="usage-mobile-record-head">
              <strong class="truncate">{{ record.model }}</strong>
              <a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag>
            </div>
            <div class="usage-mobile-record-meta"><span class="mono truncate">{{ record.apiKeyLabel || '-' }}</span><span class="usage-time">{{ formatDateTime(record.createdAt) }}</span></div>
            <div class="usage-mobile-record-grid">
              <span><small>中转站</small>{{ record.relayName || '-' }}</span>
              <span><small>端点</small><b class="mono">{{ record.endpoint || '-' }}</b></span>
              <span><small>尝试</small>{{ record.attemptCount || 1 }} 次</span>
              <span><small>Token</small>{{ formatTokenCount(recordTokens(record)) }}</span>
              <span><small>首字延迟</small>{{ formatLatency(record.firstByteLatencyMs) }}</span>
              <span><small>总耗时</small>{{ formatLatency(record.latencyMs) }}</span>
              <span v-if="record.statusCode"><small>响应</small>HTTP {{ record.statusCode }}</span>
            </div>
            <div v-if="record.errorMessage" class="usage-mobile-error truncate">{{ record.errorMessage }}</div>
          </div>
          <a-empty v-if="!loading && !records.length" description="暂无符合条件的调用记录" style="padding: 44px 0" />
        </div>

        <PaginationControl
          :current="pagination.current"
          :page-size="pagination.pageSize"
          :total="totalRecords"
          @update:current="updateCurrentPage"
          @update:page-size="updatePageSize"
        />
      </section>
    </a-spin>
  </section>
</template>

<style scoped>
.pool-usage-dashboard { color: var(--text); }
.usage-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.usage-heading h2, .usage-panel-heading h3 { margin: 0; color: var(--text); font-weight: 650; }
.usage-heading h2 { font-size: 22px; line-height: 30px; }
.usage-heading p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.usage-heading-actions { flex: 0 0 auto; }

.usage-metric-band { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.usage-metric { display: flex; min-width: 0; gap: 12px; padding: 16px 18px; border-right: 1px solid var(--border); }
.usage-metric:last-child { border-right: 0; }
.usage-metric-icon { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 6px; font-size: 17px; }
.usage-metric-icon.requests { color: #4f7fa8; background: color-mix(in srgb, #4f7fa8 14%, var(--surface)); }
.usage-metric-icon.tokens { color: #b7792d; background: color-mix(in srgb, #b7792d 15%, var(--surface)); }
.usage-metric-icon.success { color: #3e9b72; background: color-mix(in srgb, #3e9b72 14%, var(--surface)); }
.usage-metric-icon.latency { color: #8560c5; background: color-mix(in srgb, #8560c5 14%, var(--surface)); }
.usage-metric > div { min-width: 0; }
.usage-metric-label, .usage-metric-detail { display: block; overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.usage-metric-label { font-size: 12px; line-height: 18px; }
.usage-metric-value { display: block; margin: 1px 0; overflow: hidden; font-size: 21px; line-height: 28px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.usage-metric-detail { font-size: 11px; line-height: 16px; }

.usage-filter-panel, .usage-analytic-panel, .usage-records-panel { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.usage-filter-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px 20px; align-items: end; padding: 14px 16px; margin-bottom: 16px; }
.usage-filter-primary, .usage-filter-secondary { display: flex; min-width: 0; flex-wrap: wrap; gap: 10px; }
.usage-filter-primary { grid-column: 1 / -1; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
.usage-filter-secondary { grid-column: 1 / 2; }
.usage-filter-actions { grid-column: 2 / 3; }
.usage-filter-field { display: grid; min-width: 140px; gap: 5px; color: var(--text); font-size: 12px; }
.usage-filter-field > span { color: var(--muted); }
.usage-filter-field :deep(.ant-select) { width: 164px; }
.usage-filter-range :deep(.ant-select) { width: 160px; }
.usage-filter-granularity :deep(.ant-select) { width: 118px; }
.usage-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #c95757 38%, var(--border)); border-radius: 6px; background: color-mix(in srgb, #c95757 8%, var(--surface)); color: var(--text); overflow-wrap: anywhere; }

.usage-analytics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.usage-analytic-panel { min-width: 0; padding: 16px; }
.usage-trend-panel { grid-column: 1 / -1; }
.usage-panel-heading { display: flex; align-items: center; justify-content: space-between; min-height: 30px; gap: 12px; }
.usage-panel-heading h3 { font-size: 14px; line-height: 20px; }
.usage-panel-note { color: var(--muted); font-size: 12px; }
.usage-distribution-content { display: grid; grid-template-columns: 156px minmax(0, 1fr); gap: 18px; align-items: center; min-height: 178px; padding-top: 12px; }
.usage-donut { position: relative; display: grid; width: 144px; aspect-ratio: 1; place-items: center; border-radius: 50%; }
.usage-donut::after { position: absolute; inset: 35px; border-radius: 50%; background: var(--surface); content: ''; }
.usage-donut-center { position: relative; z-index: 1; display: grid; max-width: 68px; text-align: center; }
.usage-donut-center strong { overflow: hidden; font-size: 15px; line-height: 20px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.usage-donut-center span { color: var(--muted); font-size: 11px; }
.usage-distribution-list { display: grid; gap: 1px; min-width: 0; }
.usage-distribution-row { display: grid; grid-template-columns: minmax(0, 1fr) 64px 48px; min-width: 0; gap: 8px; padding: 7px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent); font-size: 12px; }
.usage-distribution-row:last-child { border-bottom: 0; }
.usage-distribution-name { display: flex; min-width: 0; align-items: center; gap: 7px; }
.usage-distribution-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-distribution-name i { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; }
.usage-distribution-row strong { overflow: hidden; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.usage-distribution-percent { color: var(--muted); font-variant-numeric: tabular-nums; text-align: right; }
.usage-chart-empty { min-height: 178px; display: grid; place-content: center; }

.usage-trend { display: grid; grid-template-columns: auto minmax(0, 1fr); min-height: 192px; gap: 20px; padding-top: 12px; }
.usage-trend-total { display: grid; align-content: center; gap: 3px; min-width: 74px; color: var(--accent); text-align: center; }
.usage-trend-total strong { color: var(--text); font-size: 18px; line-height: 24px; font-variant-numeric: tabular-nums; }
.usage-trend-total span { color: var(--muted); font-size: 11px; }
.usage-trend-bars { display: grid; grid-template-columns: repeat(auto-fit, minmax(4px, 1fr)); align-items: end; min-width: 0; min-height: 164px; gap: 7px; padding: 4px 0 0; border-bottom: 1px solid var(--border); background-image: linear-gradient(to bottom, transparent calc(25% - 1px), color-mix(in srgb, var(--border) 65%, transparent) calc(25% - 1px), color-mix(in srgb, var(--border) 65%, transparent) 25%, transparent 25%), linear-gradient(to bottom, transparent calc(50% - 1px), color-mix(in srgb, var(--border) 65%, transparent) calc(50% - 1px), color-mix(in srgb, var(--border) 65%, transparent) 50%, transparent 50%), linear-gradient(to bottom, transparent calc(75% - 1px), color-mix(in srgb, var(--border) 65%, transparent) calc(75% - 1px), color-mix(in srgb, var(--border) 65%, transparent) 75%, transparent 75%); }
.usage-trend-bar-wrap { display: grid; grid-template-rows: minmax(0, 1fr) 31px; height: 164px; min-width: 0; align-items: end; cursor: default; }
.usage-trend-bar { width: min(100%, 28px); min-height: 0; justify-self: center; border-radius: 4px 4px 0 0; background: #397c78; transition: opacity .16s ease, transform .16s ease; }
.usage-trend-bar-wrap:hover .usage-trend-bar { opacity: .82; transform: translateY(-2px); }
.usage-trend-bar-wrap span { align-self: end; overflow: hidden; padding-top: 7px; color: var(--muted); font-size: 10px; line-height: 12px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }

.usage-records-panel { overflow: hidden; }
.usage-records-heading { padding: 14px 16px; border-bottom: 1px solid var(--border); }
.usage-records-heading > div { display: grid; gap: 2px; }
.usage-records-heading > div > span { color: var(--muted); font-size: 12px; }
.usage-desktop-table { display: block; }
.usage-mobile-records { display: none; }
.usage-table :deep(.ant-table) { background: transparent; }
.usage-table :deep(.ant-table-container) { border-inline: 0 !important; }
.usage-table :deep(.ant-table-thead > tr > th) { color: var(--muted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.usage-table :deep(.ant-table-tbody > tr > td) { vertical-align: middle; }
.usage-api-key, .usage-model, .usage-relay { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-api-key, .usage-endpoint, .usage-time { color: var(--muted); font-size: 12px; }
.usage-endpoint { display: inline-block; max-width: 132px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; white-space: nowrap; }
.usage-model { font-size: 13px; }
.usage-token-cell { display: grid; width: fit-content; min-width: 142px; gap: 4px; border-radius: 4px; outline: none; cursor: help; }
.usage-token-cell:focus-visible { box-shadow: 0 0 0 2px color-mix(in srgb, #397c78 45%, transparent); }
.usage-token-cell > div { display: flex; align-items: center; gap: 12px; }
.usage-token-cell span { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.usage-token-input { color: #20a883; }
.usage-token-output { color: #8560c5; }
.usage-token-cache { color: #3987c6; }
.usage-latency { display: grid; gap: 3px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.usage-latency span { display: grid; grid-template-columns: 44px auto; gap: 4px; align-items: baseline; }
.usage-latency label { color: var(--muted); font-size: 11px; }
.usage-latency b { color: #20a883; font-weight: 500; }
:global(.usage-token-popover .ant-popover-inner) { padding: 10px 12px; }
:global(.usage-token-detail) { display: grid; min-width: 150px; gap: 4px; font-size: 12px; }
:global(.usage-token-detail > strong) { margin-bottom: 2px; font-size: 12px; }
:global(.usage-token-detail > span) { display: flex; justify-content: space-between; gap: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
:global(.usage-token-detail label) { color: var(--muted); }
:global(.usage-token-detail b) { font-weight: 500; }
:global(.usage-token-detail .usage-token-total) { margin-top: 4px; padding-top: 6px; border-top: 1px solid var(--border); }
:global(.usage-token-detail .usage-token-total b) { color: #4f79c7; }

@media (max-width: 1080px) {
  .usage-metric-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-metric:nth-child(2) { border-right: 0; }
  .usage-metric:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .usage-analytics { grid-template-columns: 1fr; }
  .usage-trend-panel { grid-column: auto; }
}

@media (max-width: 1330px) {
  .usage-desktop-table { display: none; }
  .usage-mobile-records { display: block; }
  .usage-mobile-record { padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .usage-mobile-record-head, .usage-mobile-record-meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; }
  .usage-mobile-record-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .usage-mobile-record-head :deep(.ant-tag) { flex: 0 0 auto; margin-inline-end: 0; }
  .usage-mobile-record-meta { margin-top: 6px; color: var(--muted); font-size: 11px; }
  .usage-mobile-record-meta > span:first-child { min-width: 0; }
  .usage-mobile-record-meta > span:last-child { flex: 0 0 auto; }
  .usage-mobile-record-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin-top: 13px; }
  .usage-mobile-record-grid > span { display: grid; min-width: 0; gap: 2px; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .usage-mobile-record-grid small { color: var(--muted); font-size: 11px; }
  .usage-mobile-record-grid b { overflow: hidden; font-size: 12px; font-weight: 400; text-overflow: ellipsis; }
  .usage-mobile-error { margin-top: 10px; color: #c95757; font-size: 12px; }
}

@media (max-width: 780px) {
  .usage-heading { align-items: flex-start; flex-direction: column; }
  .usage-heading-actions { align-self: stretch; }
  .usage-heading-actions :deep(.ant-space-item) { flex: 1; }
  .usage-heading-actions :deep(.ant-btn) { width: 100%; }
  .usage-filter-panel { display: flex; flex-direction: column; align-items: stretch; }
  .usage-filter-primary, .usage-filter-secondary { width: 100%; }
  .usage-filter-primary { padding-bottom: 12px; }
  .usage-filter-field { flex: 1 1 150px; }
  .usage-filter-field :deep(.ant-select), .usage-filter-range :deep(.ant-select), .usage-filter-granularity :deep(.ant-select) { width: 100%; }
  .usage-filter-actions { display: flex; justify-content: flex-end; }
  .usage-distribution-content { grid-template-columns: 132px minmax(0, 1fr); gap: 12px; }
  .usage-donut { width: 124px; }
  .usage-donut::after { inset: 30px; }
  .usage-trend { grid-template-columns: 1fr; gap: 2px; }
  .usage-trend-total { display: flex; align-items: baseline; justify-content: flex-start; gap: 5px; text-align: left; }
}

@media (max-width: 520px) {
  .usage-heading h2 { font-size: 20px; }
  .usage-metric-band { grid-template-columns: 1fr; }
  .usage-metric, .usage-metric:nth-child(2) { border-right: 0; }
  .usage-metric:not(:last-child), .usage-metric:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .usage-distribution-content { grid-template-columns: 1fr; justify-items: center; }
  .usage-distribution-list { width: 100%; }
  .usage-trend-bars { gap: 4px; }
  .usage-trend-bar-wrap span { font-size: 9px; }
}
</style>
