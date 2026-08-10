<!--
 * @Description: 中转站配置管理与连接测试主工作台
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/views/DashboardView.vue
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TableColumnsType, TablePaginationConfig } from 'ant-design-vue';
import type { FilterValue, SorterResult, TableCurrentDataSource } from 'ant-design-vue/es/table/interface';
import { message, Modal } from 'ant-design-vue';
import {
  CheckCircleOutlined,
  CopyOutlined,
  DownloadOutlined,
  ExportOutlined,
  HolderOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  ImportOutlined,
  PlusOutlined,
  PoweroffOutlined,
  SearchOutlined,
  UploadOutlined,
  WalletOutlined
} from '@ant-design/icons-vue';
import BalanceConfigDrawer from '../components/BalanceConfigDrawer.vue';
import CcSwitchImportModal from '../components/CcSwitchImportModal.vue';
import { errorMessage } from '../api/http';
import {
  exportRelays,
  getRelayApiKey,
  getRelayBalanceCredentials,
  importRelays as importRelaySpreadsheet
} from '../api/relays';
import BatchTestModal from '../components/BatchTestModal.vue';
import HistoryDrawer from '../components/HistoryDrawer.vue';
import PaginationControl from '../components/PaginationControl.vue';
import RelayFormDrawer from '../components/RelayFormDrawer.vue';
import TestModal from '../components/TestModal.vue';
import { useRelayStore } from '../stores/relays';
import type { Relay, TestStatus } from '../types';
import {
  DASHBOARD_PAGE_SIZE_STORAGE_KEY,
  DEFAULT_DASHBOARD_PAGE_SIZE,
  PAGINATION_PAGE_SIZE_OPTIONS,
  isPaginationPageSize,
  readPageSize,
  writePageSize
} from '../utils/pagination';
import { displayRelayUrl } from '../utils/relay-display';
import { buildCcSwitchRelayDeeplink } from '../utils/cc-switch';

const store = useRelayStore();
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
const ccSwitchImportOpen = ref(false);
const todayConsumptionOpen = ref(false);
const importFileInput = ref<HTMLInputElement>();
const exporting = ref(false);
const importing = ref(false);
const historyRelayId = ref<string>();
const loadError = ref<string>('');
const pendingIds = ref<Set<string>>(new Set());
const ccSwitchExportingIds = ref<Set<string>>(new Set());
const batchToggling = ref<boolean>(false);
const removingFailed = ref<boolean>(false);
const removingSelected = ref<boolean>(false);
const reordering = ref(false);
const draggingRelayId = ref<string>();
const dragOverRelayId = ref<string>();
const tableSortActive = ref(false);
const currentPage = ref(1);
const pageSize = ref(readPageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, DEFAULT_DASHBOARD_PAGE_SIZE));
const desktopTableRef = ref<HTMLElement | null>(null);
const tableScrollY = ref(240);
const tableScroll = computed(() => ({ x: 1560, y: tableScrollY.value }));

let tableResizeObserver: ResizeObserver | null = null;
let tableScrollFrame: number | null = null;
const TABLE_BODY_BOTTOM_GAP = 4;
const TABLE_BODY_MIN_HEIGHT = 80;

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
function todayUsageDate(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
}
const todayConsumptionSummary = computed(() => {
  const usageDate = todayUsageDate();
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

interface TodayConsumptionDetail {
  relayId: string;
  relayName: string;
  unit: string;
  consumed: number;
  currentBalance: number | null;
}
const todayConsumptionDetails = computed<TodayConsumptionDetail[]>(() => {
  const usageDate = todayUsageDate();
  return store.relays
    .filter((relay) => {
      const balance = relay.balance;
      return Boolean(balance?.success) && balance!.dailyUsageDate === usageDate &&
        Number.isFinite(balance!.dailyConsumed) && (balance!.dailyConsumed ?? 0) > 0;
    })
    .map((relay) => {
      const balance = relay.balance!;
      const remaining = balance.remaining !== null && Number.isFinite(balance.remaining) ? balance.remaining : null;
      return {
        relayId: relay.id,
        relayName: relay.name,
        unit: balance.unit.trim(),
        consumed: balance.dailyConsumed ?? 0,
        currentBalance: remaining
      };
    })
    .sort((left, right) => right.consumed - left.consumed);
});
const tablePagination = computed<TablePaginationConfig>(() => ({
  current: currentPage.value,
  pageSize: pageSize.value,
  total: filteredRelays.value.length
}));
const reorderEnabled = computed(() => !search.value.trim() && statusFilter.value === 'all' && !tableSortActive.value && !reordering.value);

function onPageSizeChange(nextPageSize: number): void {
  if (!isPaginationPageSize(nextPageSize)) return;
  pageSize.value = nextPageSize;
  writePageSize(DASHBOARD_PAGE_SIZE_STORAGE_KEY, nextPageSize);
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
watch(
  [currentPage, pageSize, () => filteredRelays.value.length, () => store.loading],
  () => {
    void queueTableScrollMeasure();
  },
  { flush: 'post' }
);

async function queueTableScrollMeasure(): Promise<void> {
  await nextTick();
  measureTableScrollY();
}

function measureTableScrollY(): void {
  if (typeof window === 'undefined') return;

  if (tableScrollFrame !== null) window.cancelAnimationFrame(tableScrollFrame);
  tableScrollFrame = window.requestAnimationFrame(() => {
    tableScrollFrame = null;
    const tableRoot = desktopTableRef.value;
    const tableBody = tableRoot?.querySelector<HTMLElement>('.ant-table-body');
    if (!tableRoot || !tableBody) return;

    const pagination = tableRoot.querySelector<HTMLElement>('.pagination-control');
    const bodyTop = tableBody.getBoundingClientRect().top;
    const bottomLimit = pagination?.getBoundingClientRect().top ?? tableRoot.getBoundingClientRect().bottom;
    const measuredHeight = Math.floor(bottomLimit - bodyTop - TABLE_BODY_BOTTOM_GAP);
    if (measuredHeight <= 0) return;

    const nextHeight = Math.max(TABLE_BODY_MIN_HEIGHT, measuredHeight);
    if (Math.abs(tableScrollY.value - nextHeight) > 1) tableScrollY.value = nextHeight;
  });
}

async function setupTableScrollMeasure(): Promise<void> {
  await nextTick();
  const tableRoot = desktopTableRef.value;
  if (tableRoot && typeof ResizeObserver !== 'undefined') {
    tableResizeObserver = new ResizeObserver(() => measureTableScrollY());
    tableResizeObserver.observe(tableRoot);
  }
  window.addEventListener('resize', measureTableScrollY);
  measureTableScrollY();
}

const columns: TableColumnsType<Relay> = [
  {
    title: '',
    key: 'drag',
    width: 42,
    fixed: 'left',
    className: 'relay-drag-column'
  },
  {
    title: '中转站',
    dataIndex: 'name',
    key: 'name',
    width: 180,
    sorter: (a, b) => a.name.localeCompare(b.name),
    fixed: 'left'
  },
  { title: '官网地址', dataIndex: 'baseUrl', key: 'baseUrl', width: 230 },
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
  void setupTableScrollMeasure();
});
onBeforeUnmount(() => {
  store.stopBalanceAutoRefresh();
  tableResizeObserver?.disconnect();
  if (tableScrollFrame !== null) window.cancelAnimationFrame(tableScrollFrame);
  window.removeEventListener('resize', measureTableScrollY);
});

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

async function exportAllRelays(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const blob = await exportRelays();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `relay-pulse-relays-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    message.success(`已导出 ${store.relays.length} 个中转站`);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    exporting.value = false;
  }
}

function openRelayImport(): void {
  if (!importing.value && !exporting.value) importFileInput.value?.click();
}

async function importRelayFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || importing.value) return;
  importing.value = true;
  try {
    const result = await importRelaySpreadsheet(file);
    await store.fetchRelays();
    selectedRowKeys.value = [];
    message.success(`已导入 ${result.imported.length} 个中转站，全部默认为停用`);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    importing.value = false;
  }
}

function openBalanceConfig(relay: Relay): void {
  balanceRelay.value = relay;
  balanceConfigOpen.value = true;
}

function formatBalance(value: number, unit: string): string {
  const display = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
  return unit ? `${display} ${unit}` : display;
}

function formatBalanceValue(value: number | null, unit: string): string {
  return value === null || !Number.isFinite(value) ? '-' : formatBalance(value, unit);
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

async function exportRelayToCcSwitch(relay: Relay): Promise<void> {
  if (pendingIds.value.has(relay.id) || ccSwitchExportingIds.value.has(relay.id)) return;
  ccSwitchExportingIds.value = new Set(ccSwitchExportingIds.value).add(relay.id);
  try {
    const apiKey = await getRelayApiKey(relay.id);
    if (!apiKey) throw new Error('中转站缺少可导出的 API Key');
    const balanceCredentials = relay.balanceConfig
      ? await getRelayBalanceCredentials(relay.id)
      : undefined;
    window.open(buildCcSwitchRelayDeeplink({
      baseUrl: relay.baseUrl,
      platform: relay.platform,
      providerName: relay.name,
      apiKey,
      model: relay.model,
      balance: relay.balanceConfig
        ? {
            config: relay.balanceConfig,
            apiKey: balanceCredentials?.apiKey,
            accessToken: balanceCredentials?.accessToken
          }
        : undefined
    }), '_self');
    window.setTimeout(() => {
      if (document.hasFocus()) message.error('未检测到 CC Switch，请确认已安装并允许打开链接');
    }, 100);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    const next = new Set(ccSwitchExportingIds.value);
    next.delete(relay.id);
    ccSwitchExportingIds.value = next;
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

function onTableChange(
  _pagination: TablePaginationConfig,
  _filters: Record<string, FilterValue | null>,
  sorter: SorterResult<Relay> | SorterResult<Relay>[],
  _extra: TableCurrentDataSource<Relay>
): void {
  tableSortActive.value = Array.isArray(sorter) ? sorter.some((item) => Boolean(item.order)) : Boolean(sorter.order);
}

function customRow(record: Relay): Record<string, unknown> {
  return {
    draggable: reorderEnabled.value,
    class: {
      'relay-row-dragging': draggingRelayId.value === record.id,
      'relay-row-drag-over': dragOverRelayId.value === record.id
    },
    onDragstart: (event: DragEvent) => startDrag(record, event),
    onDragover: (event: DragEvent) => dragOver(record, event),
    onDrop: (event: DragEvent) => dropOn(record, event),
    onDragend: clearDrag
  };
}

function startDrag(relay: Relay, event: DragEvent): void {
  if (!reorderEnabled.value) return;
  draggingRelayId.value = relay.id;
  event.dataTransfer?.setData('text/plain', relay.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function dragOver(relay: Relay, event: DragEvent): void {
  if (!draggingRelayId.value || draggingRelayId.value === relay.id || !reorderEnabled.value) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dragOverRelayId.value = relay.id;
}

async function dropOn(relay: Relay, event: DragEvent): Promise<void> {
  event.preventDefault();
  const sourceId = draggingRelayId.value || event.dataTransfer?.getData('text/plain');
  clearDrag();
  if (!sourceId || sourceId === relay.id || !reorderEnabled.value || reordering.value) return;
  const sourceIndex = store.relays.findIndex((item) => item.id === sourceId);
  const targetIndex = store.relays.findIndex((item) => item.id === relay.id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const ids = store.relays.map((item) => item.id);
  ids.splice(sourceIndex, 1);
  ids.splice(targetIndex, 0, sourceId);
  reordering.value = true;
  try {
    await store.reorder(ids);
    message.success('中转站顺序已更新');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    reordering.value = false;
  }
}

function clearDrag(): void {
  draggingRelayId.value = undefined;
  dragOverRelayId.value = undefined;
}

function onRelayToggle(relay: Relay, checked: boolean): void {
  void toggle(relay, checked);
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
  <div class="page-view dashboard-page-view">
    <main class="page-content">
      <div class="page-heading">
        <div>
          <h1>中转站管理</h1>
          <p>维护连接配置，快速确认密钥与模型可用性。</p>
        </div>
        <a-space wrap>
          <a-button :loading="importing" :disabled="exporting" @click="openRelayImport">
            <template #icon><UploadOutlined /></template>
            导入 Excel
          </a-button>
          <a-button :loading="exporting" :disabled="importing" @click="exportAllRelays">
            <template #icon><DownloadOutlined /></template>
            导出 Excel
          </a-button>
          <a-button @click="ccSwitchImportOpen = true"><template #icon><ImportOutlined /></template>从 CC Switch 导入</a-button>
          <a-button type="primary" @click="openCreate"><template #icon><PlusOutlined /></template>添加中转站</a-button>
        </a-space>
      </div>

      <section class="metric-band" aria-label="中转站统计">
        <div class="metric"><span class="metric-label">全部配置</span><strong class="metric-value">{{ store.stats.total }}</strong></div>
        <div class="metric"><span class="metric-label">已启用</span><strong class="metric-value">{{ store.stats.enabled }}</strong></div>
        <div class="metric"><span class="metric-label">连接正常</span><strong class="metric-value">{{ store.stats.success }}</strong></div>
        <div class="metric"><span class="metric-label">连接异常</span><strong class="metric-value">{{ store.stats.failed }}</strong></div>
        <div class="metric metric-balance"><span class="metric-label">全部余额汇总</span><strong class="metric-value metric-balance-value">{{ balanceSummary.length ? balanceSummary.join(' · ') : '-' }}</strong></div>
        <div class="metric metric-balance">
          <span class="metric-label metric-label-row">
            今日消耗
            <a-button v-if="todayConsumptionDetails.length" type="link" size="small" class="metric-detail-link" @click="todayConsumptionOpen = true">明细</a-button>
          </span>
          <strong class="metric-value metric-balance-value">{{ todayConsumptionSummary.length ? todayConsumptionSummary.join(' · ') : '-' }}</strong>
        </div>
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

        <div ref="desktopTableRef" class="desktop-table">
          <a-table
            row-key="id"
            :columns="columns"
            :data-source="filteredRelays"
            :loading="store.loading"
            @change="onTableChange"
            :custom-row="customRow"
            :row-selection="{
              selectedRowKeys,
              onChange: onSelectionChange
            }"
            :scroll="tableScroll"
            :pagination="tablePagination"
          >
            <template #emptyText><a-empty description="暂无中转站配置"><a-button type="primary" @click="openCreate">添加第一条配置</a-button></a-empty></template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'drag'"><HolderOutlined class="relay-drag-handle" :class="{ 'is-disabled': !reorderEnabled }" /></template>
              <template v-else-if="column.key === 'name'">
                <div class="relay-name"><span class="relay-dot" :class="record.lastTestStatus"></span><strong class="truncate">{{ record.name }}</strong></div>
              </template>
              <template v-else-if="column.key === 'baseUrl'">
                <a-tooltip :title="`打开 ${displayRelayUrl(record.baseUrl)}`">
                  <a :href="displayRelayUrl(record.baseUrl)" target="_blank" rel="noopener noreferrer" class="base-url-link mono truncate">{{ displayRelayUrl(record.baseUrl) }}</a>
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
                        <a-menu-item key="cc-switch" :disabled="pendingIds.has(record.id) || ccSwitchExportingIds.has(record.id)" @click="exportRelayToCcSwitch(record)"><ExportOutlined />导入 CC Switch</a-menu-item>
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
            :page-size-options="PAGINATION_PAGE_SIZE_OPTIONS"
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
              <div class="mobile-relay-url mono">{{ displayRelayUrl(relay.baseUrl) }}</div>
              <div class="mobile-relay-actions">
                <a-space><a-tag :bordered="false">{{ relay.model }}</a-tag><span class="muted">{{ relay.balance?.success && relay.balance.remaining !== null ? formatBalance(relay.balance.remaining, relay.balance.unit) : relay.lastLatency === null ? '-' : `${relay.lastLatency}ms` }}</span></a-space>
                <a-space :size="2">
                  <a-tooltip title="测试连接"><a-button type="text" shape="circle" :disabled="!relay.enabled || pendingIds.has(relay.id)" @click="openTest(relay)"><template #icon><ExperimentOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="余额查询配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="openBalanceConfig(relay)"><template #icon><WalletOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="编辑"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="openEdit(relay)"><template #icon><EditOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="复制配置"><a-button type="text" shape="circle" :disabled="pendingIds.has(relay.id)" @click="duplicate(relay)"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
                  <a-dropdown :trigger="['click']">
                    <a-tooltip title="更多操作"><a-button type="text" shape="circle" :loading="pendingIds.has(relay.id)" aria-label="更多操作"><template #icon><EllipsisOutlined /></template></a-button></a-tooltip>
                    <template #overlay><a-menu><a-menu-item @click="openHistory(relay)"><HistoryOutlined />历史</a-menu-item><a-menu-item :disabled="pendingIds.has(relay.id) || ccSwitchExportingIds.has(relay.id)" @click="exportRelayToCcSwitch(relay)"><ExportOutlined />导入 CC Switch</a-menu-item><a-menu-item danger @click="confirmDelete(relay)"><DeleteOutlined />删除</a-menu-item></a-menu></template>
                  </a-dropdown>
                </a-space>
              </div>
            </div>
            <a-empty v-if="store.loaded && !filteredRelays.length" description="没有符合条件的配置" style="padding: 48px 0" />
          </a-spin>
        </div>
      </section>
    </main>

    <input ref="importFileInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden @change="importRelayFile" />

    <RelayFormDrawer :open="formOpen" :relay="editingRelay" @close="formOpen = false" />
    <BalanceConfigDrawer :open="balanceConfigOpen" :relay="balanceRelay" @close="balanceConfigOpen = false" @saved="balanceRelay = $event" />
    <TestModal :open="testOpen" :relay="testingRelay" @close="testOpen = false" />
    <BatchTestModal :open="batchOpen" :relays="selectedRelays" @close="batchOpen = false" />
    <HistoryDrawer :open="historyOpen" :initial-relay-id="historyRelayId" @close="historyOpen = false" />
    <CcSwitchImportModal :open="ccSwitchImportOpen" @close="ccSwitchImportOpen = false" />

    <a-modal v-model:open="todayConsumptionOpen" title="今日消耗明细" :width="680" :footer="null">
      <p class="today-consumption-note">按各中转站余额查询记录统计当日消耗；余额刷新后数据会随之更新。</p>
      <div v-if="todayConsumptionDetails.length" class="today-consumption-table-wrap">
        <table class="today-consumption-table">
          <thead><tr><th>中转站</th><th>当前余额</th><th>今日消耗</th></tr></thead>
          <tbody>
            <tr v-for="detail in todayConsumptionDetails" :key="detail.relayId">
              <td>{{ detail.relayName }}</td>
              <td>{{ formatBalanceValue(detail.currentBalance, detail.unit) }}</td>
              <td><strong>{{ formatBalance(detail.consumed, detail.unit) }}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>
      <a-empty v-else description="今日暂无消耗记录" />
    </a-modal>
  </div>
</template>
