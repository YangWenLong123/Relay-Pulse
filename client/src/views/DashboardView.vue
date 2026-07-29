<!--
 * @Description: 中转站配置管理与连接测试主工作台
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/views/DashboardView.vue
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import { message, Modal } from 'ant-design-vue';
import {
  CheckCircleOutlined,
  BgColorsOutlined,
  BulbOutlined,
  CloudOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  DesktopOutlined,
  PlusOutlined,
  PoweroffOutlined,
  SearchOutlined,
  WalletOutlined
} from '@ant-design/icons-vue';
import BalanceConfigDrawer from '../components/BalanceConfigDrawer.vue';
import { errorMessage } from '../api/http';
import BatchTestModal from '../components/BatchTestModal.vue';
import HistoryDrawer from '../components/HistoryDrawer.vue';
import PaginationControl from '../components/PaginationControl.vue';
import RelayFormDrawer from '../components/RelayFormDrawer.vue';
import TestModal from '../components/TestModal.vue';
import { useRelayStore } from '../stores/relays';
import { useThemeStore } from '../stores/theme';
import type { Relay, TestStatus, ThemeMode } from '../types';

const store = useRelayStore();
const themeStore = useThemeStore();
const search = ref('');
const statusFilter = ref<TestStatus | 'all'>('all');
const selectedRowKeys = ref<string[]>([]);
const formOpen = ref(false);
const editingRelay = ref<Relay | null>(null);
const testOpen = ref(false);
const testingRelay = ref<Relay | null>(null);
const batchOpen = ref(false);
const balanceConfigOpen = ref(false);
const balanceRelay = ref<Relay | null>(null);
const historyOpen = ref(false);
const historyRelayId = ref<string>();
const loadError = ref<string>('');
const pendingIds = ref<Set<string>>(new Set());
const batchToggling = ref<boolean>(false);
const removingFailed = ref<boolean>(false);
const removingSelected = ref<boolean>(false);
const currentPage = ref(1);
const pageSize = ref(10);
const themeTrigger = ref<HTMLElement>();

function createThemeTransitionFallback(x: number, y: number): HTMLElement {
  document.querySelector('.theme-transition-fallback')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'theme-transition-fallback';
  overlay.style.setProperty('--theme-transition-x', `${x}px`);
  overlay.style.setProperty('--theme-transition-y', `${y}px`);
  overlay.style.setProperty('--theme-transition-from', getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim());
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  document.body.append(overlay);
  window.setTimeout(() => overlay.remove(), 600);
  return overlay;
}

const filteredRelays = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return store.relays.filter((relay) => {
    const matchesSearch = !keyword || relay.name.toLowerCase().includes(keyword) || relay.baseUrl.toLowerCase().includes(keyword);
    const matchesStatus = statusFilter.value === 'all' || relay.lastTestStatus === statusFilter.value;
    return matchesSearch && matchesStatus;
  });
});
const selectedRelays = computed(() => store.relays.filter((relay) => selectedRowKeys.value.includes(relay.id)));
const failedRelays = computed(() => store.relays.filter((relay) => relay.lastTestStatus === 'failed'));
const balanceSummary = computed(() => {
  const totals = new Map<string, number>();
  for (const relay of store.relays) {
    const balance = relay.balance;
    if (!balance?.success || balance.remaining === null || !Number.isFinite(balance.remaining)) continue;
    const unit = balance.unit.trim();
    totals.set(unit, (totals.get(unit) ?? 0) + balance.remaining);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, total]) => formatBalance(total, unit));
});
const todayConsumptionSummary = computed(() => {
  const today = new Date();
  const usageDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const totals = new Map<string, number>();
  for (const relay of store.relays) {
    const balance = relay.balance;
    if (!balance?.success || balance.dailyUsageDate !== usageDate || !Number.isFinite(balance.dailyConsumed)) continue;
    const unit = balance.unit.trim();
    totals.set(unit, (totals.get(unit) ?? 0) + (balance.dailyConsumed ?? 0));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, total]) => formatBalance(total, unit));
});
const tablePagination = computed<TablePaginationConfig>(() => ({
  current: currentPage.value,
  pageSize: pageSize.value,
  total: filteredRelays.value.length
}));

function onPageSizeChange(nextPageSize: number): void {
  pageSize.value = nextPageSize;
  currentPage.value = 1;
}

watch([search, statusFilter], () => {
  currentPage.value = 1;
});
watch(
  () => filteredRelays.value.length,
  (total) => {
    const lastPage = Math.max(1, Math.ceil(total / pageSize.value));
    if (currentPage.value > lastPage) currentPage.value = lastPage;
  }
);

const columns: TableColumnsType<Relay> = [
  {
    title: '中转站',
    dataIndex: 'name',
    key: 'name',
    width: 180,
    sorter: (a, b) => a.name.localeCompare(b.name),
    fixed: 'left'
  },
  { title: 'Base URL', dataIndex: 'baseUrl', key: 'baseUrl', width: 230 },
  { title: '模型', dataIndex: 'model', key: 'model', width: 150 },
  { title: '余额', dataIndex: 'balance', key: 'balance', width: 145 },
  { title: '启用', dataIndex: 'enabled', key: 'enabled', width: 76, align: 'center' },
  {
    title: '最近状态',
    dataIndex: 'lastTestStatus',
    key: 'lastTestStatus',
    width: 110,
    sorter: (a, b) => a.lastTestStatus.localeCompare(b.lastTestStatus)
  },
  {
    title: '延迟',
    dataIndex: 'lastLatency',
    key: 'lastLatency',
    width: 110,
    sorter: (a, b) => (a.lastLatency ?? Number.MAX_SAFE_INTEGER) - (b.lastLatency ?? Number.MAX_SAFE_INTEGER)
  },
  {
    title: '最后测试',
    dataIndex: 'lastTestAt',
    key: 'lastTestAt',
    width: 165,
    sorter: (a, b) => (a.lastTestAt ?? '').localeCompare(b.lastTestAt ?? '')
  },
  { title: '操作', key: 'actions', width: 190, fixed: 'right' }
];

onMounted(() => {
  store.startBalanceAutoRefresh();
  void loadRelays();
});
onBeforeUnmount(() => store.stopBalanceAutoRefresh());

async function loadRelays(): Promise<void> {
  loadError.value = '';
  try {
    await store.fetchRelays();
  } catch (error) {
    loadError.value = errorMessage(error);
    message.error(loadError.value);
  }
}

function markPending(id: string, pending: boolean): void {
  const next = new Set(pendingIds.value);
  if (pending) next.add(id);
  else next.delete(id);
  pendingIds.value = next;
}

function openCreate(): void {
  editingRelay.value = null;
  formOpen.value = true;
}

function openEdit(relay: Relay): void {
  editingRelay.value = relay;
  formOpen.value = true;
}

function openTest(relay: Relay): void {
  testingRelay.value = relay;
  testOpen.value = true;
}

function openBalanceConfig(relay: Relay): void {
  balanceRelay.value = relay;
  balanceConfigOpen.value = true;
}

function formatBalance(value: number, unit: string): string {
  const display = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
  return unit ? `${display} ${unit}` : display;
}

function openHistory(relay?: Relay): void {
  historyRelayId.value = relay?.id;
  historyOpen.value = true;
}

function confirmDelete(relay: Relay): void {
  Modal.confirm({
    title: `删除“${relay.name}”？`,
    content: '配置删除后无法恢复，已有测试历史会保留。',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      markPending(relay.id, true);
      try {
        await store.remove(relay.id);
        selectedRowKeys.value = selectedRowKeys.value.filter((id) => id !== relay.id);
        message.success('中转站已删除');
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      } finally {
        markPending(relay.id, false);
      }
    }
  });
}

function confirmRemoveFailed(): void {
  const targets = failedRelays.value;
  if (!targets.length || removingFailed.value || removingSelected.value) return;
  Modal.confirm({
    title: `移除 ${targets.length} 个异常中转站？`,
    content: '只会移除最近测试状态为“异常”的配置，测试历史会保留。',
    okText: '移除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      removingFailed.value = true;
      try {
        await removeRelays(targets);
        message.success(`已移除 ${targets.length} 个异常中转站`);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      } finally {
        removingFailed.value = false;
      }
    }
  });
}

function confirmRemoveSelected(): void {
  const targets = selectedRelays.value;
  if (!targets.length || removingSelected.value || removingFailed.value) return;
  Modal.confirm({
    title: `移除已选择的 ${targets.length} 个中转站？`,
    content: '配置删除后无法恢复，已有测试历史会保留。',
    okText: '移除',
    okType: 'danger',
    cancelText: '取消',
    async onOk() {
      removingSelected.value = true;
      try {
        await removeRelays(targets);
        message.success(`已移除 ${targets.length} 个中转站`);
      } catch (error) {
        message.error(errorMessage(error));
        throw error;
      } finally {
        removingSelected.value = false;
      }
    }
  });
}

async function removeRelays(targets: Relay[]): Promise<void> {
  for (const relay of targets) {
    markPending(relay.id, true);
    try {
      await store.remove(relay.id);
      selectedRowKeys.value = selectedRowKeys.value.filter((id) => id !== relay.id);
    } finally {
      markPending(relay.id, false);
    }
  }
}

async function duplicate(relay: Relay): Promise<void> {
  if (pendingIds.value.has(relay.id)) return;
  markPending(relay.id, true);
  try {
    await store.duplicate(relay.id);
    message.success('配置副本已创建');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    markPending(relay.id, false);
  }
}

async function toggle(relay: Relay, enabled: boolean): Promise<void> {
  if (pendingIds.value.has(relay.id)) return;
  markPending(relay.id, true);
  try {
    await store.update(relay.id, { enabled });
    message.success(enabled ? '已启用' : '已停用');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    markPending(relay.id, false);
  }
}

async function batchToggle(enabled: boolean): Promise<void> {
  if (batchToggling.value) return;
  batchToggling.value = true;
  try {
    await store.batchToggle(selectedRowKeys.value, enabled);
    message.success(enabled ? '已批量启用' : '已批量停用');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    batchToggling.value = false;
  }
}

function onSelectionChange(keys: (string | number)[]): void {
  selectedRowKeys.value = keys.map(String);
}

function onRelayToggle(relay: Relay, checked: boolean): void {
  void toggle(relay, checked);
}

async function onThemeSelect(event: { key: string }): Promise<void> {
  const mode = event.key as ThemeMode;
  if (themeStore.mode === mode) return;

  const triggerBounds = themeTrigger.value?.getBoundingClientRect();
  const supportsReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!triggerBounds || supportsReducedMotion) {
    themeStore.setMode(mode);
    return;
  }

  const x = triggerBounds.left + triggerBounds.width / 2;
  const y = triggerBounds.top + triggerBounds.height / 2;
  document.documentElement.style.setProperty('--theme-transition-x', `${x}px`);
  document.documentElement.style.setProperty('--theme-transition-y', `${y}px`);

  if (typeof document.startViewTransition === 'function') {
    const transition = document.startViewTransition(async () => {
      themeStore.setMode(mode);
      await nextTick();
    });
    await transition.finished;
    return;
  }

  const fallback = createThemeTransitionFallback(x, y);
  themeStore.setMode(mode);
  await nextTick();
  requestAnimationFrame(() => fallback.classList.add('is-transitioning'));
}

function statusLabel(status: TestStatus): string {
  return { success: '可用', failed: '异常', untested: '未测试' }[status];
}
function statusColor(status: TestStatus): string {
  return { success: 'success', failed: 'error', untested: 'default' }[status];
}
function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}
</script>

<template>
  <div class="page-shell">
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-mark">RP</div>
          <div class="brand-copy"><strong>Relay Pulse</strong><span>AI 中转站连接测试</span></div>
        </div>
        <span ref="themeTrigger">
          <a-dropdown :trigger="['click']">
            <a-button shape="circle" aria-label="切换主题">
              <template #icon><BgColorsOutlined /></template>
            </a-button>
            <template #overlay>
              <a-menu :selected-keys="[themeStore.mode]" @click="onThemeSelect">
                <a-menu-item key="light"><BulbOutlined /> 浅色</a-menu-item>
                <a-menu-item key="dark"><CloudOutlined /> 深色</a-menu-item>
                <a-menu-item key="system"><DesktopOutlined /> 跟随系统</a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </span>
      </div>
    </header>

    <main class="page-content">
      <div class="page-heading">
        <div>
          <h1>中转站管理</h1>
          <p>维护连接配置，快速确认密钥与模型可用性。</p>
        </div>
        <a-space>
          <a-button @click="openHistory()"><template #icon><HistoryOutlined /></template>测试历史</a-button>
          <a-button type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>添加中转站</a-button>
        </a-space>
      </div>

      <section class="metric-band" aria-label="中转站统计">
        <div class="metric"><span class="metric-label">全部配置</span><strong class="metric-value">{{ store.stats.total }}</strong></div>
        <div class="metric"><span class="metric-label">已启用</span><strong class="metric-value">{{ store.stats.enabled }}</strong></div>
        <div class="metric"><span class="metric-label">连接正常</span><strong class="metric-value">{{ store.stats.success }}</strong></div>
        <div class="metric"><span class="metric-label">连接异常</span><strong class="metric-value">{{ store.stats.failed }}</strong></div>
        <div class="metric metric-balance"><span class="metric-label">全部余额汇总</span><strong class="metric-value metric-balance-value">{{ balanceSummary.length ? balanceSummary.join(' · ') : '-' }}</strong></div>
        <div class="metric metric-balance"><span class="metric-label">今日消耗</span><strong class="metric-value metric-balance-value">{{ todayConsumptionSummary.length ? todayConsumptionSummary.join(' · ') : '-' }}</strong></div>
      </section>

      <section class="workspace-panel">
        <div v-if="loadError" class="error-banner" role="alert">
          <span>{{ loadError }}</span>
          <a-button size="small" :loading="store.loading" @click="loadRelays">重试</a-button>
        </div>
        <div class="toolbar">
          <div class="toolbar-group">
            <a-input v-model:value="search" allow-clear placeholder="搜索名称或 URL" style="width: 250px">
              <template #prefix><SearchOutlined class="muted" /></template>
            </a-input>
            <a-select v-model:value="statusFilter" style="width: 120px">
              <a-select-option value="all">全部状态</a-select-option>
              <a-select-option value="success">连接正常</a-select-option>
              <a-select-option value="failed">连接异常</a-select-option>
              <a-select-option value="untested">未测试</a-select-option>
            </a-select>
          </div>
          <div class="toolbar-group">
            <span v-if="selectedRowKeys.length" class="muted">已选择 {{ selectedRowKeys.length }} 项</span>
            <a-tooltip title="移除已选择的中转站">
              <a-button
                danger
                :loading="removingSelected"
                :disabled="!selectedRelays.length || batchToggling || removingFailed || removingSelected"
                @click="confirmRemoveSelected"
              >
                <template #icon><DeleteOutlined /></template>
                批量移除
              </a-button>
            </a-tooltip>
            <a-tooltip title="移除所有最近测试异常的中转站">
              <a-button
                danger
                :loading="removingFailed"
                :disabled="!failedRelays.length || batchToggling || removingSelected || removingFailed"
                @click="confirmRemoveFailed"
              >
                <template #icon><DeleteOutlined /></template>
                移除异常（{{ failedRelays.length }}）
              </a-button>
            </a-tooltip>
            <a-dropdown :disabled="!selectedRowKeys.length || batchToggling || removingSelected || removingFailed" :trigger="['click']">
              <a-button :loading="batchToggling"><template #icon><PoweroffOutlined /></template>批量状态</a-button>
              <template #overlay>
                <a-menu>
                  <a-menu-item key="enable" @click="batchToggle(true)"><CheckCircleOutlined />启用</a-menu-item>
                  <a-menu-item key="disable" @click="batchToggle(false)"><PoweroffOutlined />停用</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
            <a-button type="primary" :disabled="!selectedRowKeys.length || batchToggling || batchOpen || removingSelected || removingFailed" @click="batchOpen = true">
              <template #icon><ExperimentOutlined /></template>批量测试
            </a-button>
          </div>
        </div>

        <div class="desktop-table">
          <a-table
            row-key="id"
            :columns="columns"
            :data-source="filteredRelays"
            :loading="store.loading"
            :row-selection="{
              selectedRowKeys,
              onChange: onSelectionChange
            }"
            :scroll="{ x: 1560 }"
            :pagination="tablePagination"
          >
            <template #emptyText><a-empty description="暂无中转站配置"><a-button type="primary" @click="openCreate">添加第一条配置</a-button></a-empty></template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <div class="relay-name"><span class="relay-dot" :class="record.lastTestStatus"></span><strong class="truncate">{{ record.name }}</strong></div>
              </template>
              <template v-else-if="column.key === 'baseUrl'">
                <a-tooltip :title="`打开 ${record.baseUrl}`">
                  <a :href="record.baseUrl" target="_blank" rel="noopener noreferrer" class="base-url-link mono truncate">{{ record.baseUrl }}</a>
                </a-tooltip>
              </template>
              <template v-else-if="column.key === 'model'"><a-tooltip :title="record.model"><span class="truncate" style="display: block">{{ record.model }}</span></a-tooltip></template>
              <template v-else-if="column.key === 'enabled'"><a-switch :checked="record.enabled" :loading="pendingIds.has(record.id)" size="small" @change="onRelayToggle(record, $event)" /></template>
              <template v-else-if="column.key === 'lastTestStatus'"><a-tag :color="statusColor(record.lastTestStatus)">{{ statusLabel(record.lastTestStatus) }}</a-tag></template>
              <template v-else-if="column.key === 'lastLatency'"><span class="latency-value">{{ record.lastLatency === null ? '-' : `${record.lastLatency}ms` }}</span></template>
              <template v-else-if="column.key === 'lastTestAt'"><span class="muted" style="font-size: 12px">{{ dateTime(record.lastTestAt) }}</span></template>
              <template v-else-if="column.key === 'balance'">
                <a-tooltip v-if="record.balance && !record.balance.success" :title="record.balance.errorMessage">
                  <a-tag color="error">查询失败</a-tag>
                </a-tooltip>
                <div v-else-if="record.balance?.success" class="balance-cell">
                  <strong>{{ record.balance.remaining === null ? '-' : formatBalance(record.balance.remaining, record.balance.unit) }}</strong>
                  <span class="muted">{{ dateTime(record.balance.queriedAt) }}</span>
                </div>
                <a-tag v-else-if="record.balanceConfig?.enabled" color="default">待查询</a-tag>
                <span v-else class="muted">未配置</span>
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-space :size="2">
                  <a-tooltip title="测试连接"><a-button type="text" shape="circle" :disabled="!record.enabled || pendingIds.has(record.id)" @click="openTest(record)"><template #icon><ExperimentOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="余额查询配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(record.id)" @click="openBalanceConfig(record)"><template #icon><WalletOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="编辑"><a-button type="text" shape="circle" :disabled="pendingIds.has(record.id)" @click="openEdit(record)"><template #icon><EditOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="复制配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(record.id)" @click="duplicate(record)"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
                  <a-dropdown :trigger="['click']">
                    <a-tooltip title="更多操作"><a-button type="text" shape="circle" :loading="pendingIds.has(record.id)"><template #icon><EllipsisOutlined /></template></a-button></a-tooltip>
                    <template #overlay>
                      <a-menu>
                        <a-menu-item key="history" @click="openHistory(record)"><HistoryOutlined />测试历史</a-menu-item>
                        <a-menu-divider />
                        <a-menu-item key="delete" danger @click="confirmDelete(record)"><DeleteOutlined />删除</a-menu-item>
                      </a-menu>
                    </template>
                  </a-dropdown>
                </a-space>
              </template>
            </template>
          </a-table>
          <PaginationControl
            :current="currentPage"
            :page-size="pageSize"
            :total="filteredRelays.length"
            @update:current="currentPage = $event"
            @update:page-size="onPageSizeChange"
          />
        </div>

        <div class="mobile-relays">
          <a-spin :spinning="store.loading">
            <div v-for="relay in filteredRelays" :key="relay.id" class="mobile-relay">
              <div class="mobile-relay-head">
                <div class="relay-name"><span class="relay-dot" :class="relay.lastTestStatus"></span><strong>{{ relay.name }}</strong></div>
                <a-tag :color="statusColor(relay.lastTestStatus)">{{ statusLabel(relay.lastTestStatus) }}</a-tag>
              </div>
              <div class="mobile-relay-url mono">{{ relay.baseUrl }}</div>
              <div class="mobile-relay-actions">
                <a-space><a-tag :bordered="false">{{ relay.model }}</a-tag><span class="muted">{{ relay.balance?.success && relay.balance.remaining !== null ? formatBalance(relay.balance.remaining, relay.balance.unit) : relay.lastLatency === null ? '-' : `${relay.lastLatency}ms` }}</span></a-space>
                <a-space :size="2">
                  <a-tooltip title="测试连接"><a-button type="text" shape="circle" :disabled="!relay.enabled || pendingIds.has(relay.id)" @click="openTest(relay)"><template #icon><ExperimentOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="余额查询配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="openBalanceConfig(relay)"><template #icon><WalletOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="编辑"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="openEdit(relay)"><template #icon><EditOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="复制配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="duplicate(relay)"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
                  <a-dropdown :trigger="['click']">
                    <a-tooltip title="更多操作"><a-button type="text" shape="circle" :loading="pendingIds.has(relay.id)" aria-label="更多操作"><template #icon><EllipsisOutlined /></template></a-button></a-tooltip>
                    <template #overlay><a-menu><a-menu-item @click="openHistory(relay)"><HistoryOutlined />历史</a-menu-item><a-menu-item danger @click="confirmDelete(relay)"><DeleteOutlined />删除</a-menu-item></a-menu></template>
                  </a-dropdown>
                </a-space>
              </div>
            </div>
            <a-empty v-if="store.loaded && !filteredRelays.length" description="没有符合条件的配置" style="padding: 48px 0" />
          </a-spin>
        </div>
      </section>
    </main>

    <RelayFormDrawer :open="formOpen" :relay="editingRelay" @close="formOpen = false" />
    <BalanceConfigDrawer :open="balanceConfigOpen" :relay="balanceRelay" @close="balanceConfigOpen = false" @saved="balanceRelay = $event" />
    <TestModal :open="testOpen" :relay="testingRelay" @close="testOpen = false" />
    <BatchTestModal :open="batchOpen" :relays="selectedRelays" @close="batchOpen = false" />
    <HistoryDrawer :open="historyOpen" :initial-relay-id="historyRelayId" @close="historyOpen = false" />
  </div>
</template>
