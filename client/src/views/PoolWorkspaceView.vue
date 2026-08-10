<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { storeToRefs } from 'pinia';
import {
  CopyOutlined,
  ExportOutlined,
  KeyOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined
} from '@ant-design/icons-vue';
import PoolUsageDashboard, {
  type PoolUsageAnalytics,
  type PoolUsageFilters as DashboardFilters,
  type PoolUsageOption,
  type PoolUsagePagination as DashboardPagination,
  type PoolUsageRecord as DashboardRecord,
  type PoolUsageSummary as DashboardSummary
} from '../components/PoolUsageDashboard.vue';
import {
  addPoolRelays,
  getPoolStatus,
  listPoolUsage,
  poolUsageExportUrl,
  rotatePoolKey,
  startPool,
  stopPool,
  updatePoolRoutingStrategy
} from '../api/pool';
import { discoverRelayModels } from '../api/relays';
import { errorMessage } from '../api/http';
import { usePoolStatusStore } from '../stores/pool-status';
import { useRelayStore } from '../stores/relays';
import type { PoolEndpoint, PoolRoutingStrategy, PoolUsageQuery, PoolUsageReport, PoolUsageStatus, Relay } from '../types';
import { buildCcSwitchPoolDeeplink } from '../utils/cc-switch';
import {
  DEFAULT_POOL_USAGE_PAGE_SIZE,
  PAGINATION_PAGE_SIZE_OPTIONS,
  POOL_USAGE_PAGE_SIZE_STORAGE_KEY,
  isPaginationPageSize,
  readPageSize,
  writePageSize
} from '../utils/pagination';

const relayStore = useRelayStore();
const poolStatusStore = usePoolStatusStore();
const { status: poolStatus } = storeToRefs(poolStatusStore);

const selectedRelayIds = ref<string[]>([]);
const pendingRelayIds = ref<string[]>([]);
const requestedPort = ref(0);
const routingStrategy = ref<PoolRoutingStrategy>('round-robin');
const modelMap = ref<Record<string, string[]>>({});
const modelOptionsByRelay = ref<Record<string, string[]>>({});
const discoveringModelRelayIds = ref<Set<string>>(new Set());
const poolLoading = ref(false);
const poolError = ref('');
const poolAction = ref<'start' | 'stop' | 'rotate' | 'strategy' | 'members'>();
const balanceDetailsOpen = ref(false);
let poolController: AbortController | undefined;
let poolStatusTimer: ReturnType<typeof setInterval> | undefined;

const report = ref<PoolUsageReport>();
const usageLoading = ref(false);
const usageError = ref('');
const filters = ref<DashboardFilters>({ timeRange: '24h', granularity: 'hour', status: 'all' });
const pagination = ref<DashboardPagination>({
  current: 1,
  pageSize: readPageSize(POOL_USAGE_PAGE_SIZE_STORAGE_KEY, DEFAULT_POOL_USAGE_PAGE_SIZE),
  total: 0
});
let usageController: AbortController | undefined;
let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;

const running = computed(() => poolStatus.value?.active === true);
const enabledRelays = computed(() => relayStore.relays.filter((relay) => relay.enabled));
const availableRelays = computed(() => {
  const selectedIds = new Set(selectedRelayIds.value);
  return enabledRelays.value.filter((relay) => !selectedIds.has(relay.id));
});
const selectedRelays = computed(() => {
  const byId = new Map(relayStore.relays.map((relay) => [relay.id, relay]));
  return selectedRelayIds.value.map((id) => byId.get(id)).filter((relay): relay is Relay => Boolean(relay));
});
const selectedPlatform = computed(() => selectedRelays.value[0]?.platform ?? null);
const mixedPlatform = computed(() => new Set(selectedRelays.value.map((relay) => relay.platform)).size > 1);
const canStart = computed(() => selectedRelayIds.value.length > 0 && selectedRelays.value.length === selectedRelayIds.value.length && !mixedPlatform.value);
const canAddRelays = computed(() => {
  if (!running.value || !pendingRelayIds.value.length || selectedRelayIds.value.length + pendingRelayIds.value.length > 200) return false;
  const byId = new Map(availableRelays.value.map((relay) => [relay.id, relay]));
  return pendingRelayIds.value.every((id) => byId.get(id)?.platform === poolStatus.value?.platform);
});
const statusPlatform = computed(() => poolStatus.value?.platform ?? selectedPlatform.value);
const serviceBaseUrl = computed(() => {
  const baseUrl = poolStatus.value?.baseUrl ?? '';
  if (!baseUrl || statusPlatform.value !== 'openai') return baseUrl;
  return baseUrl.toLowerCase().endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
});
const runningSince = computed(() => poolStatus.value?.startedAt ? new Date(poolStatus.value.startedAt).toLocaleString() : '-');
const currentBalanceLabel = computed(() => formatBalanceSummary('currentBalance'));
const consumedBalanceLabel = computed(() => formatBalanceSummary('consumedBalance'));

const timeRangeOptions: PoolUsageOption[] = [
  { label: '近 24 小时', value: '24h' },
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' }
];
const granularityOptions: PoolUsageOption[] = [
  { label: '按小时', value: 'hour' },
  { label: '按天', value: 'day' }
];
const endpointOptions: PoolUsageOption[] = [
  { label: '/v1/chat/completions', value: '/v1/chat/completions' },
  { label: '/v1/responses', value: '/v1/responses' },
  { label: '/v1/messages', value: '/v1/messages' }
];
const statusOptions: PoolUsageOption[] = [
  { label: '全部结果', value: 'all' },
  { label: '成功', value: 'success' },
  { label: '失败', value: 'failed' }
];

const summary = computed<DashboardSummary>(() => ({
  totalRequests: report.value?.summary.requestCount ?? 0,
  totalTokens: report.value?.summary.totalTokens ?? 0,
  inputTokens: report.value?.summary.inputTokens ?? 0,
  outputTokens: report.value?.summary.outputTokens ?? 0,
  cachedTokens: report.value?.summary.cachedTokens ?? 0,
  successCount: report.value?.summary.successCount ?? 0,
  failureCount: report.value?.summary.failureCount ?? 0,
  averageLatencyMs: report.value?.summary.averageDurationMs ?? null
}));

const records = computed<DashboardRecord[]>(() =>
  (report.value?.records ?? []).map((record) => ({
    id: record.id,
    createdAt: record.createdAt,
    apiKeyLabel: '本机号池',
    model: record.model || '未指定模型',
    relayId: record.relayId ?? undefined,
    relayName: record.relayName || undefined,
    endpoint: record.endpoint,
    status: record.status,
    statusCode: record.statusCode,
    attemptCount: record.attempts,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    totalTokens: record.totalTokens,
    cost: record.cost,
    firstByteLatencyMs: record.firstByteMs,
    latencyMs: record.durationMs,
    errorMessage: record.errorMessage || undefined
  }))
);

const analytics = computed<PoolUsageAnalytics>(() => ({
  modelDistribution: (report.value?.byModel ?? []).map((item) => ({
    key: item.key,
    label: item.label,
    requests: item.requestCount,
    tokens: item.totalTokens
  })),
  relayDistribution: (report.value?.byRelay ?? []).map((item) => ({
    key: item.key,
    label: item.label,
    requests: item.requestCount,
    tokens: item.totalTokens
  })),
  trend: (report.value?.trend ?? []).map((point) => ({
    bucket: point.bucket,
    requests: point.requestCount,
    tokens: point.totalTokens
  }))
}));

const modelOptions = computed<PoolUsageOption[]>(() => report.value?.filterOptions?.models ?? []);
const relayOptions = computed<PoolUsageOption[]>(() => report.value?.filterOptions?.relays ?? []);

function relayOptionDisabled(relay: Relay): boolean {
  return running.value || Boolean(selectedPlatform.value && relay.platform !== selectedPlatform.value);
}

function addRelayOptionDisabled(relay: Relay): boolean {
  return relay.platform !== poolStatus.value?.platform;
}

function relayOptionLabel(relay: Relay): string {
  return `${relay.name} · ${relay.platform === 'anthropic' ? 'Anthropic' : 'OpenAI'}`;
}

function relayBalanceLabel(relay: Relay): string {
  const balance = relay.balance;
  if (balance?.success && balance.remaining !== null && Number.isFinite(balance.remaining)) {
    const remaining = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(balance.remaining);
    return balance.unit ? `${remaining} ${balance.unit}` : remaining;
  }
  if (balance && !balance.success) return '查询失败';
  return relay.balanceConfig?.enabled ? '尚未查询' : '未配置';
}

function modelOptionsForRelay(relay: Relay): string[] {
  const discovered = modelOptionsByRelay.value[relay.id] ?? [];
  const selected = modelMap.value[relay.id] ?? [];
  const base = relay.model ? [relay.model] : [];
  return [...new Set([...selected, ...discovered, ...base])];
}

function updateRelayModelSubset(relayId: string, models: string[]): void {
  modelMap.value = { ...modelMap.value, [relayId]: models };
}

async function discoverModelsForRelay(relayId: string): Promise<void> {
  if (running.value || discoveringModelRelayIds.value.has(relayId)) return;
  discoveringModelRelayIds.value = new Set(discoveringModelRelayIds.value).add(relayId);
  try {
    const models = await discoverRelayModels(relayId);
    modelOptionsByRelay.value = { ...modelOptionsByRelay.value, [relayId]: models };
    if (!models.length) message.info('该中转站未返回可用模型');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    const next = new Set(discoveringModelRelayIds.value);
    next.delete(relayId);
    discoveringModelRelayIds.value = next;
  }
}

function formatBalanceValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '-';
  const display = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
  return unit ? `${display} ${unit}` : display;
}

function formatBalanceSummary(field: 'currentBalance' | 'consumedBalance'): string {
  if (!running.value) return '-';
  const values = poolStatus.value?.balanceSummary ?? [];
  return values.length ? values.map((item) => formatBalanceValue(item[field], item.unit)).join(' · ') : '-';
}

async function loadPoolStatus(syncSelection = true, silent = false): Promise<void> {
  poolController?.abort();
  const controller = new AbortController();
  poolController = controller;
  if (!silent) {
    poolLoading.value = true;
    poolError.value = '';
  }
  try {
    const status = await getPoolStatus(controller.signal);
    if (poolController !== controller) return;
    poolStatus.value = status;
    routingStrategy.value = status.routingStrategy ?? 'round-robin';
    if (syncSelection) {
      selectedRelayIds.value = [...status.relayIds];
      if (status.active) modelMap.value = { ...modelMap.value, ...status.modelMap };
    }
  } catch (error) {
    if (!silent && !controller.signal.aborted) poolError.value = errorMessage(error);
  } finally {
    if (poolController === controller) {
      poolController = undefined;
      if (!silent) poolLoading.value = false;
    }
  }
}

async function startService(): Promise<void> {
  if (poolAction.value || !canStart.value) return;
  poolAction.value = 'start';
  poolError.value = '';
  try {
    const payload: Record<string, string[]> = {};
    for (const relayId of selectedRelayIds.value) {
      const models = (modelMap.value[relayId] ?? []).map((model) => model.trim()).filter(Boolean);
      if (models.length) payload[relayId] = [...new Set(models)];
    }
    poolStatus.value = await startPool(requestedPort.value || 0, selectedRelayIds.value, routingStrategy.value, payload);
    modelMap.value = { ...modelMap.value, ...poolStatus.value.modelMap };
    void loadUsage(1);
    message.success('号池服务已启动');
  } catch (error) {
    poolError.value = errorMessage(error);
  } finally {
    poolAction.value = undefined;
  }
}

async function changeRoutingStrategy(value: string | number): Promise<void> {
  if (value !== 'round-robin' && value !== 'random') return;
  const nextStrategy = value as PoolRoutingStrategy;
  if (!running.value) {
    routingStrategy.value = nextStrategy;
    return;
  }
  if (poolAction.value || nextStrategy === routingStrategy.value) return;
  poolAction.value = 'strategy';
  poolError.value = '';
  try {
    poolStatus.value = await updatePoolRoutingStrategy(nextStrategy);
    routingStrategy.value = poolStatus.value.routingStrategy;
    message.success('轮询规则已更新');
  } catch (error) {
    poolError.value = errorMessage(error);
  } finally {
    poolAction.value = undefined;
  }
}

async function addServiceRelays(): Promise<void> {
  if (poolAction.value || !canAddRelays.value) return;
  poolAction.value = 'members';
  poolError.value = '';
  try {
    const status = await addPoolRelays(pendingRelayIds.value);
    poolStatus.value = status;
    selectedRelayIds.value = [...status.relayIds];
    modelMap.value = { ...status.modelMap };
    pendingRelayIds.value = [];
    void relayStore.fetchRelays();
    message.success('中转站已加入号池');
  } catch (error) {
    poolError.value = errorMessage(error);
    message.error(poolError.value);
  } finally {
    poolAction.value = undefined;
  }
}

async function stopService(): Promise<void> {
  if (poolAction.value) return;
  poolAction.value = 'stop';
  poolError.value = '';
  try {
    poolStatus.value = await stopPool();
    balanceDetailsOpen.value = false;
    void loadUsage(1);
    message.success('号池服务已停止');
  } catch (error) {
    poolError.value = errorMessage(error);
  } finally {
    poolAction.value = undefined;
  }
}

async function rotateKey(): Promise<void> {
  if (poolAction.value) return;
  poolAction.value = 'rotate';
  poolError.value = '';
  try {
    poolStatus.value = await rotatePoolKey();
    message.success('号池 API Key 已轮换');
  } catch (error) {
    poolError.value = errorMessage(error);
  } finally {
    poolAction.value = undefined;
  }
}

function importToCcSwitch(): void {
  const status = poolStatus.value;
  if (!status?.active || !status.baseUrl || !status.apiKey || !status.platform) return;
  poolError.value = '';
  try {
    const platformName = status.platform === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const deeplink = buildCcSwitchPoolDeeplink({
      baseUrl: status.baseUrl,
      platform: status.platform,
      providerName: `Relay Pulse ${platformName} 号池`,
      apiKey: status.apiKey,
      model: selectedRelays.value[0]?.model
    });
    window.open(deeplink, '_self');
    setTimeout(() => {
      if (document.hasFocus()) message.error('未检测到 CC Switch，请确认已安装并允许打开链接');
    }, 100);
  } catch {
    message.error('无法打开 CC Switch，请确认应用已安装');
  }
}

async function copy(value: string, name: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    message.success(`${name}已复制`);
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限');
  }
}

function queryForCurrentFilters(page = pagination.value.current, pageSize = pagination.value.pageSize): PoolUsageQuery {
  const now = new Date();
  const rangeHours = filters.value.timeRange === '7d' ? 24 * 7 : filters.value.timeRange === '30d' ? 24 * 30 : 24;
  const status = filters.value.status === 'success' || filters.value.status === 'failed'
    ? filters.value.status as PoolUsageStatus
    : undefined;
  const endpoint = endpointOptions.some((option) => option.value === filters.value.endpoint)
    ? filters.value.endpoint as PoolEndpoint
    : undefined;
  return {
    from: new Date(now.getTime() - rangeHours * 60 * 60 * 1000).toISOString(),
    to: now.toISOString(),
    model: filters.value.model,
    relayId: filters.value.relayId,
    endpoint,
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    granularity: filters.value.granularity === 'day' ? 'day' : 'hour'
  };
}

async function loadUsage(page = pagination.value.current): Promise<void> {
  usageController?.abort();
  const controller = new AbortController();
  usageController = controller;
  usageLoading.value = true;
  usageError.value = '';
  try {
    const next = await listPoolUsage(queryForCurrentFilters(page), controller.signal);
    if (usageController !== controller) return;
    const lastPage = Math.max(1, Math.ceil(next.total / pagination.value.pageSize));
    if (page > lastPage) {
      pagination.value = { ...pagination.value, current: lastPage, total: next.total };
      void loadUsage(lastPage);
      return;
    }
    report.value = next;
    pagination.value = { ...pagination.value, current: page, total: next.total };
  } catch (error) {
    if (!controller.signal.aborted) usageError.value = errorMessage(error);
  } finally {
    if (usageController === controller) {
      usageController = undefined;
      usageLoading.value = false;
    }
  }
}

function refreshUsage(page = pagination.value.current): void {
  if (usageLoading.value) return;
  void loadUsage(page);
}

function updateFilters(next: DashboardFilters): void {
  filters.value = next;
  pagination.value = { ...pagination.value, current: 1 };
  void loadUsage(1);
}

function updatePagination(next: DashboardPagination): void {
  const nextPageSize = isPaginationPageSize(next.pageSize) ? next.pageSize : pagination.value.pageSize;
  pagination.value = { ...next, pageSize: nextPageSize, total: report.value?.total ?? next.total };
  writePageSize(POOL_USAGE_PAGE_SIZE_STORAGE_KEY, nextPageSize);
  void loadUsage(next.current);
}

function exportCsv(): void {
  const link = document.createElement('a');
  link.href = poolUsageExportUrl({ ...queryForCurrentFilters(1, 200) });
  link.download = `relay-pulse-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
}

onMounted(() => {
  void loadPoolStatus();
  if (!relayStore.loaded) void relayStore.fetchRelays().catch((error) => { poolError.value = errorMessage(error); });
  void loadUsage();
});

watch(running, (active, previous) => {
  if (poolStatusTimer) clearInterval(poolStatusTimer);
  if (usageRefreshTimer) clearInterval(usageRefreshTimer);
  poolStatusTimer = active
    ? setInterval(() => {
        if (!poolAction.value && !poolLoading.value) void loadPoolStatus(false, true);
      }, 3_000)
    : undefined;
  usageRefreshTimer = active
    ? setInterval(() => {
        if (!usageLoading.value) refreshUsage();
      }, 3_000)
    : undefined;
  if (active && !previous) refreshUsage(1);
  if (!active && previous) refreshUsage(1);
});

onBeforeUnmount(() => {
  if (poolStatusTimer) clearInterval(poolStatusTimer);
  if (usageRefreshTimer) clearInterval(usageRefreshTimer);
  poolController?.abort();
  usageController?.abort();
});
</script>

<template>
  <div class="page-view">
    <main class="page-content pool-page-content">
      <section class="pool-service-panel" aria-label="号池服务配置">
        <div class="pool-service-heading">
          <div>
            <div class="pool-title-row">
              <span class="pool-state-dot" :class="running ? 'running' : 'stopped'"></span>
              <h1>号池服务</h1>
              <a-tag :color="running ? 'success' : 'error'">{{ running ? '运行中' : '未启动' }}</a-tag>
            </div>
            <p>选择同一类型的中转站组成号池，再启动本机兼容服务。</p>
          </div>
          <a-tooltip title="刷新服务状态">
            <a-button shape="circle" :loading="poolLoading" aria-label="刷新服务状态" @click="loadPoolStatus(false)">
              <template #icon><ReloadOutlined /></template>
            </a-button>
          </a-tooltip>
        </div>

        <div class="pool-status-band">
          <div><span>号池类型</span><strong>{{ statusPlatform === 'anthropic' ? 'Anthropic' : statusPlatform === 'openai' ? 'OpenAI' : '未选择' }}</strong></div>
          <div><span>号池成员</span><strong>{{ selectedRelayIds.length }}</strong></div>
          <div><span>轮询规则</span><strong>{{ routingStrategy === 'random' ? '随机轮询' : '顺序轮询' }}</strong></div>
          <div><span>当前总余额</span><strong>{{ currentBalanceLabel }}</strong></div>
          <div class="pool-consumption-metric">
            <span>本次消耗</span>
            <div><strong>{{ consumedBalanceLabel }}</strong><a-button v-if="running" type="link" size="small" @click="balanceDetailsOpen = true">明细</a-button></div>
          </div>
          <div><span>启动时间</span><strong class="pool-time">{{ runningSince }}</strong></div>
        </div>

        <div v-if="poolError" class="error-banner pool-error" role="alert">{{ poolError }}</div>

        <a-spin :spinning="poolLoading || relayStore.loading">
          <div class="pool-config-grid">
            <div class="pool-members-field">
              <label for="pool-relays">号池成员</label>
              <a-select
                id="pool-relays"
                v-model:value="selectedRelayIds"
                mode="multiple"
                :disabled="running || !!poolAction"
                :max-tag-count="3"
                placeholder="选择至少一个中转站"
              >
                <a-select-option
                  v-for="relay in enabledRelays"
                  :key="relay.id"
                  :value="relay.id"
                  :label="relayOptionLabel(relay)"
                  :disabled="relayOptionDisabled(relay)"
                >
                  <div class="pool-relay-option">
                    <span class="pool-relay-option-name">{{ relayOptionLabel(relay) }}</span>
                    <span class="pool-relay-option-balance">余额 {{ relayBalanceLabel(relay) }}</span>
                  </div>
                </a-select-option>
              </a-select>
              <span v-if="!enabledRelays.length">请先返回中转站管理添加并启用至少一个中转站。</span>
              <span v-else-if="selectedPlatform">已锁定 {{ selectedPlatform === 'anthropic' ? 'Anthropic' : 'OpenAI' }} 类型；清空选择后可切换。</span>
              <span v-else>同一号池不能混用 OpenAI 与 Anthropic。</span>
            </div>
            <label class="pool-routing-field">
              <span>轮询规则</span>
              <a-segmented
                :value="routingStrategy"
                :disabled="poolAction === 'strategy'"
                :options="[
                  { label: '顺序轮询', value: 'round-robin' },
                  { label: '随机轮询', value: 'random' }
                ]"
                @update:value="changeRoutingStrategy"
              />
            </label>
            <label class="pool-port-field">
              <span>本机端口</span>
              <a-input-number v-model:value="requestedPort" :disabled="running || !!poolAction" :min="0" :max="65535" :precision="0" />
              <small>填 0 自动分配</small>
            </label>
          </div>

          <div v-if="running" class="pool-add-members">
            <label for="pool-add-relays">加入中转站</label>
            <a-select
              id="pool-add-relays"
              v-model:value="pendingRelayIds"
              mode="multiple"
              :disabled="!!poolAction || !availableRelays.length"
              :max-tag-count="3"
              placeholder="选择要加入的中转站"
            >
              <a-select-option
                v-for="relay in availableRelays"
                :key="relay.id"
                :value="relay.id"
                :label="relayOptionLabel(relay)"
                :disabled="addRelayOptionDisabled(relay)"
              >
                <div class="pool-relay-option">
                  <span class="pool-relay-option-name">{{ relayOptionLabel(relay) }}</span>
                  <span class="pool-relay-option-balance">余额 {{ relayBalanceLabel(relay) }}</span>
                </div>
              </a-select-option>
            </a-select>
            <a-button
              type="primary"
              :loading="poolAction === 'members'"
              :disabled="!!poolAction || !canAddRelays"
              @click="addServiceRelays"
            >
              <template #icon><PlusOutlined /></template>加入号池
            </a-button>
          </div>

          <div v-if="selectedRelays.length" class="pool-model-map">
            <div class="pool-model-map-head">
              <span>模型映射</span>
              <small>为每个中转指定可用模型子集；留空表示接受全部模型。客户端请求某模型时，只会命中包含该模型的中转。</small>
            </div>
            <div class="pool-model-map-list">
              <div v-for="relay in selectedRelays" :key="relay.id" class="pool-model-map-row">
                <div class="pool-model-map-relay">
                  <span class="pool-model-map-name">{{ relay.name }}</span>
                  <span class="pool-model-map-hint">{{ (modelMap[relay.id] ?? []).length ? `${(modelMap[relay.id] ?? []).length} 个模型` : '全部模型' }}</span>
                </div>
                <a-select
                  :value="modelMap[relay.id] ?? []"
                  mode="tags"
                  class="pool-model-map-select"
                  :disabled="running || !!poolAction"
                  :max-tag-count="4"
                  placeholder="留空接受全部模型"
                  @update:value="(value: string[]) => updateRelayModelSubset(relay.id, value)"
                >
                  <a-select-option v-for="model in modelOptionsForRelay(relay)" :key="model" :value="model">{{ model }}</a-select-option>
                </a-select>
                <a-button
                  :loading="discoveringModelRelayIds.has(relay.id)"
                  :disabled="running || !!poolAction"
                  @click="discoverModelsForRelay(relay.id)"
                >探测模型</a-button>
              </div>
            </div>
          </div>

          <div v-if="running" class="pool-credentials">
            <label>
              <span>Base URL</span>
              <a-space-compact block>
                <a-input :value="serviceBaseUrl" readonly class="mono" />
                <a-tooltip title="复制 Base URL"><a-button aria-label="复制 Base URL" @click="copy(serviceBaseUrl, 'Base URL')"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
              </a-space-compact>
            </label>
            <label>
              <span>API Key</span>
              <a-space-compact block>
                <a-input :value="poolStatus?.apiKey" readonly class="mono" />
                <a-tooltip title="复制 API Key"><a-button :disabled="!poolStatus?.apiKey" aria-label="复制 API Key" @click="copy(poolStatus?.apiKey ?? '', 'API Key')"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
              </a-space-compact>
            </label>
          </div>

          <div class="pool-service-actions">
            <template v-if="running">
              <a-button :loading="poolAction === 'rotate'" :disabled="!!poolAction" @click="rotateKey"><template #icon><KeyOutlined /></template>轮换 Key</a-button>
              <a-button :disabled="!!poolAction || !poolStatus?.apiKey" @click="importToCcSwitch"><template #icon><ExportOutlined /></template>导入 CC Switch</a-button>
              <a-button danger :loading="poolAction === 'stop'" :disabled="!!poolAction" @click="stopService"><template #icon><PoweroffOutlined /></template>停止服务</a-button>
            </template>
            <a-button v-else type="primary" :loading="poolAction === 'start'" :disabled="poolLoading || !!poolAction || !canStart" @click="startService">
              <template #icon><PlayCircleOutlined /></template>启动服务
            </a-button>
          </div>
        </a-spin>
      </section>

      <section class="pool-usage-section" aria-label="号池使用记录">
        <PoolUsageDashboard
          title="使用记录"
          description="查看号池请求量、Token 消耗和实际中转情况。"
          :summary="summary"
          :records="records"
          :analytics="analytics"
          :filters="filters"
          :pagination="pagination"
          :page-size-options="PAGINATION_PAGE_SIZE_OPTIONS"
          :loading="usageLoading"
          :error="usageError"
          :model-options="modelOptions"
          :relay-options="relayOptions"
          :endpoint-options="endpointOptions"
          :time-range-options="timeRangeOptions"
          :granularity-options="granularityOptions"
          :status-options="statusOptions"
          @update:filters="updateFilters"
          @update:pagination="updatePagination"
          @refresh="loadUsage"
          @retry="loadUsage"
          @export="exportCsv"
        />
      </section>
    </main>

    <a-modal v-model:open="balanceDetailsOpen" title="本次消耗明细" :width="680" :footer="null">
      <p class="pool-balance-detail-note">仅统计本次服务启动后的余额变化，停止服务后数据将被清空。</p>
      <div v-if="poolStatus?.balanceDetails.length" class="pool-balance-detail-table-wrap">
        <table class="pool-balance-detail-table">
          <thead><tr><th>中转站</th><th>启动余额</th><th>当前余额</th><th>本次消耗</th></tr></thead>
          <tbody>
            <tr v-for="detail in poolStatus.balanceDetails" :key="detail.relayId">
              <td>{{ detail.relayName }}</td>
              <td>{{ formatBalanceValue(detail.initialBalance, detail.unit) }}</td>
              <td>{{ formatBalanceValue(detail.currentBalance, detail.unit) }}</td>
              <td><strong>{{ formatBalanceValue(detail.consumedBalance, detail.unit) }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <a-empty v-else description="暂无可统计的余额数据" />
    </a-modal>
  </div>
</template>

<style scoped>
.pool-page-content { padding-bottom: 32px; }
.pool-service-panel { padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.pool-service-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.pool-title-row { display: flex; align-items: center; min-width: 0; gap: 9px; }
.pool-title-row h1 { margin: 0; font-size: 22px; line-height: 30px; font-weight: 650; }
.pool-title-row :deep(.ant-tag) { margin-inline-end: 0; }
.pool-service-heading p { margin: 4px 0 0 17px; color: var(--muted); font-size: 13px; }
.pool-state-dot { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; }
.pool-state-dot.running { background: #3e9b72; box-shadow: 0 0 0 4px rgba(62, 155, 114, .14); }
.pool-state-dot.stopped { background: #d16060; box-shadow: 0 0 0 4px rgba(209, 96, 96, .14); }
.pool-status-band { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)) minmax(170px, 1.3fr); margin-bottom: 16px; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.pool-status-band > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--border); }
.pool-status-band > div:last-child { border-right: 0; }
.pool-status-band span, .pool-members-field > label, .pool-routing-field > span, .pool-port-field > span, .pool-credentials label > span { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; }
.pool-status-band strong { display: block; overflow: hidden; font-size: 15px; line-height: 22px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.pool-status-band .pool-time { font-size: 12px; }
.pool-consumption-metric > div { display: flex; align-items: center; min-width: 0; gap: 8px; }
.pool-consumption-metric :deep(.ant-btn) { height: 22px; padding-inline: 2px; font-size: 12px; }
.pool-balance-detail-note { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.pool-balance-detail-table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 6px; }
.pool-balance-detail-table { width: 100%; min-width: 560px; border-collapse: collapse; }
.pool-balance-detail-table th, .pool-balance-detail-table td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; }
.pool-balance-detail-table th { background: var(--surface-subtle); color: var(--muted); font-size: 12px; font-weight: 500; }
.pool-balance-detail-table th:first-child, .pool-balance-detail-table td:first-child { width: 40%; text-align: left; }
.pool-balance-detail-table tbody tr:last-child td { border-bottom: 0; }
.pool-balance-detail-table td { font-size: 13px; font-variant-numeric: tabular-nums; }
.pool-error { margin-bottom: 14px; }
.pool-config-grid { display: grid; grid-template-columns: minmax(0, 1fr) 210px 150px; align-items: start; gap: 14px; }
.pool-members-field, .pool-routing-field, .pool-port-field, .pool-credentials label { min-width: 0; }
.pool-members-field :deep(.ant-select), .pool-routing-field :deep(.ant-segmented), .pool-port-field :deep(.ant-input-number) { width: 100%; }
.pool-routing-field :deep(.ant-segmented-item) { min-width: 0; flex: 1; text-align: center; }
.pool-relay-option { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: 16px; }
.pool-relay-option-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pool-relay-option-balance { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.pool-members-field > span, .pool-port-field small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 16px; }
.pool-port-field { display: block; }
.pool-add-members { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: 10px; margin-top: 16px; }
.pool-add-members > label { grid-column: 1 / -1; margin-bottom: -5px; color: var(--muted); font-size: 12px; }
.pool-add-members :deep(.ant-select) { min-width: 0; width: 100%; }
.pool-credentials { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.pool-model-map { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.pool-model-map-head { margin-bottom: 12px; }
.pool-model-map-head > span { display: block; margin-bottom: 4px; font-size: 13px; font-weight: 600; }
.pool-model-map-head > small { display: block; color: var(--muted); font-size: 11px; line-height: 16px; }
.pool-model-map-list { display: flex; flex-direction: column; gap: 10px; }
.pool-model-map-row { display: grid; grid-template-columns: minmax(120px, 200px) minmax(0, 1fr) auto; align-items: center; gap: 10px; }
.pool-model-map-relay { min-width: 0; }
.pool-model-map-name { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.pool-model-map-hint { display: block; color: var(--muted); font-size: 11px; }
.pool-model-map-select { width: 100%; }
.pool-service-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.pool-usage-section { padding-top: 24px; }

@media (max-width: 900px) {
  .pool-status-band { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pool-status-band > div { border-bottom: 1px solid var(--border); }
  .pool-status-band > div:nth-child(even) { border-right: 0; }
  .pool-status-band > div:nth-last-child(-n + 2) { border-bottom: 0; }
  .pool-config-grid { grid-template-columns: minmax(0, 1fr) 210px; }
  .pool-port-field { grid-column: 2; }
  .pool-credentials { grid-template-columns: 1fr; }
}

@media (max-width: 620px) {
  .pool-service-heading { align-items: flex-start; }
  .pool-title-row { flex-wrap: wrap; }
  .pool-service-heading p { margin-left: 0; }
  .pool-status-band, .pool-config-grid { grid-template-columns: 1fr; }
  .pool-status-band > div, .pool-status-band > div:nth-child(even) { grid-column: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .pool-service-actions :deep(.ant-btn) { flex: 1 1 145px; }
  .pool-port-field { grid-column: auto; }
  .pool-model-map-row { grid-template-columns: 1fr; }
  .pool-add-members { grid-template-columns: 1fr; }
  .pool-add-members > label { grid-column: auto; }
  .pool-add-members :deep(.ant-btn) { width: 100%; }
}
</style>
