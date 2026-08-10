<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DatabaseOutlined,
  ExportOutlined,
  HistoryOutlined,
  KeyOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined,
  UploadOutlined,
  WalletOutlined
} from '@ant-design/icons-vue';
import {
  clearCodexUsage,
  deleteCodexAccount,
  getCodexProxyStatus,
  importCodexSessions,
  listCodexAccounts,
  listCodexUsage,
  refreshCodexAccountUsage,
  rotateCodexProxyKey,
  startCodexProxy,
  stopCodexProxy,
  syncCodexAccountModels,
  syncCodexModels,
  updateCodexAccount
} from '../api/codex-accounts';
import { errorMessage } from '../api/http';
import type {
  CodexAccount,
  CodexAccountUsageSnapshot,
  CodexRoutingStrategy,
  CodexUsageReport,
  CodexUsageWindow
} from '../types';
import { buildCcSwitchPoolDeeplink } from '../utils/cc-switch';
import { codexProxyBaseUrl, parseCodexSessionFiles } from '../utils/codex-account';
import { useCodexProxyStatusStore } from '../stores/codex-proxy-status';
import { storeToRefs } from 'pinia';

const accounts = ref<CodexAccount[]>([]);
const codexProxyStatusStore = useCodexProxyStatusStore();
const { status: proxy } = storeToRefs(codexProxyStatusStore);
const loading = ref(false);
const loadError = ref('');
const search = ref('');
const planFilter = ref('all');
const statusFilter = ref<'all' | CodexAccount['status']>('all');
const selectedRowKeys = ref<string[]>([]);
const pendingIds = ref<Set<string>>(new Set());
const syncingIds = ref<Set<string>>(new Set());
const importing = ref(false);
const syncingAll = ref(false);
const fileInput = ref<HTMLInputElement>();
const serviceOpen = ref(false);
const servicePort = ref(0);
const serviceAccountIds = ref<string[]>([]);
const routingStrategy = ref<CodexRoutingStrategy>('round-robin');
const serviceAction = ref<'start' | 'stop' | 'rotate'>();
const serviceError = ref('');
const usageOpen = ref(false);
const usageLoading = ref(false);
const usageError = ref('');
const usage = ref<CodexUsageReport>();
const usageModel = ref<string>();
const usageAccountId = ref<string>();
const usageStatus = ref<'success' | 'failed'>();
const quotaOpen = ref(false);
const quotaAccount = ref<CodexAccount>();
const quotaSnapshot = ref<CodexAccountUsageSnapshot>();
const quotaLoading = ref(false);
const quotaError = ref('');
let pageController: AbortController | undefined;
let usageController: AbortController | undefined;
let quotaController: AbortController | undefined;

const columns = [
  { title: '账号信息', key: 'account', width: 260 },
  { title: '模型详情', key: 'models', width: 340 },
  { title: '额度', key: 'quota', width: 250 },
  { title: '到期时间', key: 'expiry', width: 156, responsive: ['lg'] },
  { title: '状态', key: 'status', width: 150 },
  { title: '操作', key: 'actions', width: 210, fixed: 'right' as const }
];

const planOptions = computed(() => [...new Set(accounts.value.map((account) => account.planType).filter(Boolean))].sort());
const filteredAccounts = computed(() => {
  const query = search.value.trim().toLowerCase();
  return accounts.value.filter((account) => {
    if (planFilter.value !== 'all' && account.planType !== planFilter.value) return false;
    if (statusFilter.value !== 'all' && account.status !== statusFilter.value) return false;
    return !query || [account.email, account.name, account.accountIdMasked, account.models.join(' ')].join(' ').toLowerCase().includes(query);
  });
});
const enabledAccounts = computed(() => accounts.value.filter((account) => account.enabled && account.status !== 'expired'));
const selectedAccounts = computed(() => accounts.value.filter((account) => selectedRowKeys.value.includes(account.id)));
const serviceAccounts = computed(() => accounts.value.filter((account) => serviceAccountIds.value.includes(account.id)));
const running = computed(() => proxy.value?.active === true);
const serviceBaseUrl = computed(() => codexProxyBaseUrl(proxy.value?.baseUrl ?? null));
const activeCount = computed(() => accounts.value.filter((account) => account.status === 'active' && account.enabled).length);
const expiredCount = computed(() => accounts.value.filter((account) => account.status === 'expired').length);
const modelCount = computed(() => new Set(accounts.value.flatMap((account) => account.models)).size);
const usageRecords = computed(() => usage.value?.records ?? []);
const usageSummary = computed(() => usage.value?.summary);

function setPending(id: string, pending: boolean): void {
  const next = new Set(pendingIds.value);
  if (pending) next.add(id);
  else next.delete(id);
  pendingIds.value = next;
}

function setSyncing(id: string, syncing: boolean): void {
  const next = new Set(syncingIds.value);
  if (syncing) next.add(id);
  else next.delete(id);
  syncingIds.value = next;
}

function replaceAccount(next: CodexAccount): void {
  accounts.value = accounts.value.map((account) => account.id === next.id ? next : account);
  if (quotaAccount.value?.id === next.id) {
    quotaAccount.value = next;
    if (!quotaLoading.value) quotaSnapshot.value = next.usageSnapshot ?? undefined;
  }
}

function statusLabel(status: CodexAccount['status']): string {
  return ({ active: '可用', expired: '已过期', error: '异常', untested: '待验证' })[status];
}

function statusColor(status: CodexAccount['status']): string {
  return ({ active: 'success', expired: 'default', error: 'error', untested: 'processing' })[status];
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '-';
}

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '-' : new Intl.NumberFormat('zh-CN').format(value);
}

function modelLabel(account: CodexAccount): string {
  if (!account.modelCount) return account.lastModelSyncAt ? '未发现模型' : '未同步';
  return `${account.modelCount} 个模型`;
}

function planLabel(planType: string | undefined): string {
  const normalized = planType?.trim().toLowerCase();
  return ({
    free: 'FREE',
    chatgptplusplan: 'ChatGPT Plus',
    chatgptproplan: 'ChatGPT Pro',
    chatgptteamplan: 'ChatGPT Team',
    chatgptenterpriseplan: 'Enterprise'
  } as Record<string, string>)[normalized ?? ''] || planType || '未知';
}

function subscriptionLabel(snapshot: CodexAccountUsageSnapshot): string {
  return snapshot.planType.toLowerCase() === 'free' ? '未订阅' : '订阅中';
}

function formatWindowDuration(minutes: number): string {
  if (minutes <= 360) return '5 小时额度';
  if (minutes >= 9_500 && minutes <= 10_500) return '7 天周期额度';
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天周期额度`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时额度`;
  return `${minutes} 分钟额度`;
}

function quotaWindows(snapshot: CodexAccountUsageSnapshot | undefined): Array<{ key: string; label: string; hint: string; window: CodexUsageWindow | null; tone: 'green' | 'blue' }> {
  if (!snapshot) return [];
  return [
    { key: 'primary', label: snapshot.primary ? formatWindowDuration(snapshot.primary.windowMinutes) : '5 小时额度', hint: '标准模型窗口', window: snapshot.primary, tone: 'green' },
    { key: 'secondary', label: snapshot.secondary ? formatWindowDuration(snapshot.secondary.windowMinutes) : '7 天周期额度', hint: '长期周期窗口', window: snapshot.secondary, tone: 'blue' }
  ];
}

function quotaRemaining(window: CodexUsageWindow | null): number {
  return window ? Math.max(0, 100 - window.usedPercent) : 0;
}

function quotaResetLabel(window: CodexUsageWindow | null): string {
  if (!window) return '重置时间：未提供';
  if (window.resetAt) return `重置时间：${dateTime(window.resetAt)}`;
  if (window.resetAfterSeconds > 0) return `约 ${formatDuration(window.resetAfterSeconds)} 后重置`;
  return '重置时间：未提供';
}

function formatDuration(seconds: number): string {
  if (seconds >= 86_400) return `${Math.ceil(seconds / 86_400)} 天`;
  if (seconds >= 3_600) return `${Math.ceil(seconds / 3_600)} 小时`;
  return `${Math.ceil(seconds / 60)} 分钟`;
}

function creditLabel(snapshot: CodexAccountUsageSnapshot): string {
  if (snapshot.creditsUnlimited) return '无限制';
  if (snapshot.creditsBalance) return snapshot.creditsBalance;
  return snapshot.creditsHasCredits ? '有可用额度' : '未提供';
}

function accountQuotaWindows(account: CodexAccount) {
  return quotaWindows(account.usageSnapshot ?? undefined).filter((item) => item.window);
}

async function loadPage(silent = false): Promise<void> {
  pageController?.abort();
  const controller = new AbortController();
  pageController = controller;
  if (!silent) loading.value = true;
  loadError.value = '';
  try {
    const [nextAccounts, nextProxy] = await Promise.all([
      listCodexAccounts(controller.signal),
      getCodexProxyStatus(controller.signal)
    ]);
    if (controller.signal.aborted) return;
    accounts.value = nextAccounts;
    proxy.value = nextProxy;
    selectedRowKeys.value = selectedRowKeys.value.filter((id) => nextAccounts.some((account) => account.id === id));
  } catch (error) {
    if (!controller.signal.aborted) loadError.value = errorMessage(error);
  } finally {
    if (pageController === controller) {
      pageController = undefined;
      loading.value = false;
    }
  }
}

function openFilePicker(): void {
  fileInput.value?.click();
}

async function importFiles(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || importing.value) return;
  importing.value = true;
  try {
    const sessions = await parseCodexSessionFiles(files);
    const result = await importCodexSessions(sessions);
    const created = result.createdCount ? `新增 ${result.createdCount} 个` : '';
    const updated = result.updatedCount ? `${created ? '，' : ''}更新 ${result.updatedCount} 个` : '';
    message.success(`${created}${updated} GPT 账号` || '账号导入完成');
    await loadPage(true);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    importing.value = false;
  }
}

async function toggleAccount(account: CodexAccount, enabled: boolean): Promise<void> {
  if (pendingIds.value.has(account.id)) return;
  setPending(account.id, true);
  try {
    replaceAccount(await updateCodexAccount(account.id, { enabled }));
    if (running.value) await loadPage(true);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    setPending(account.id, false);
  }
}

async function syncAccount(account: CodexAccount): Promise<void> {
  if (syncingIds.value.has(account.id)) return;
  setSyncing(account.id, true);
  try {
    const result = await syncCodexAccountModels(account.id);
    replaceAccount(result.account);
    message.success(`${account.email} 已同步 ${result.models.length} 个模型`);
    if (running.value) proxy.value = await getCodexProxyStatus();
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    setSyncing(account.id, false);
  }
}

async function syncSelected(): Promise<void> {
  if (syncingAll.value) return;
  const ids = selectedAccounts.value.length ? selectedAccounts.value.map((account) => account.id) : enabledAccounts.value.map((account) => account.id);
  if (!ids.length) {
    message.error('没有可同步的 GPT 账号');
    return;
  }
  syncingAll.value = true;
  try {
    const result = await syncCodexModels(ids);
    result.accounts.forEach(replaceAccount);
    if (running.value) proxy.value = await getCodexProxyStatus();
    if (result.failed.length) message.warning(`已同步 ${result.accounts.length} 个账号，${result.failed.length} 个失败`);
    else message.success(`已同步 ${result.accounts.length} 个账号的模型`);
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    syncingAll.value = false;
  }
}

async function refreshQuota(accountId: string): Promise<void> {
  quotaController?.abort();
  const controller = new AbortController();
  quotaController = controller;
  quotaLoading.value = true;
  quotaError.value = '';
  try {
    const result = await refreshCodexAccountUsage(accountId, controller.signal);
    if (controller.signal.aborted) return;
    replaceAccount(result.account);
    quotaAccount.value = result.account;
    quotaSnapshot.value = result.usage;
    message.success('账号额度已刷新');
  } catch (error) {
    if (!controller.signal.aborted) quotaError.value = errorMessage(error);
  } finally {
    if (quotaController === controller) {
      quotaController = undefined;
      quotaLoading.value = false;
    }
  }
}

function openQuota(account: CodexAccount): void {
  quotaAccount.value = account;
  quotaSnapshot.value = account.usageSnapshot ?? undefined;
  quotaError.value = '';
  quotaOpen.value = true;
  void refreshQuota(account.id);
}

function openService(): void {
  serviceError.value = '';
  routingStrategy.value = proxy.value?.routingStrategy ?? 'round-robin';
  serviceAccountIds.value = proxy.value?.active
    ? [...proxy.value.accountIds]
    : (selectedAccounts.value.length ? selectedAccounts.value.map((account) => account.id) : enabledAccounts.value.map((account) => account.id));
  serviceOpen.value = true;
}

async function startService(): Promise<void> {
  if (serviceAction.value) return;
  const selected = serviceAccounts.value;
  if (!selected.length) {
    serviceError.value = '请至少选择一个 GPT 账号';
    return;
  }
  if (selected.some((account) => !account.enabled || account.status === 'expired')) {
    serviceError.value = '服务只能使用已启用且未过期的账号';
    return;
  }
  serviceAction.value = 'start';
  serviceError.value = '';
  try {
    proxy.value = await startCodexProxy(servicePort.value || 0, serviceAccountIds.value, routingStrategy.value);
    message.success('GPT 账号服务已启动');
  } catch (error) {
    serviceError.value = errorMessage(error);
  } finally {
    serviceAction.value = undefined;
  }
}

async function stopService(): Promise<void> {
  if (serviceAction.value) return;
  serviceAction.value = 'stop';
  serviceError.value = '';
  try {
    proxy.value = await stopCodexProxy();
    message.success('GPT 账号服务已停止');
  } catch (error) {
    serviceError.value = errorMessage(error);
  } finally {
    serviceAction.value = undefined;
  }
}

async function rotateServiceKey(): Promise<void> {
  if (serviceAction.value) return;
  serviceAction.value = 'rotate';
  serviceError.value = '';
  try {
    proxy.value = await rotateCodexProxyKey();
    message.success('服务 API Key 已轮换');
  } catch (error) {
    serviceError.value = errorMessage(error);
  } finally {
    serviceAction.value = undefined;
  }
}

async function copy(value: string, label: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    message.success(`${label}已复制`);
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限');
  }
}

function exportToCcSwitch(): void {
  const status = proxy.value;
  if (!status?.active || !status.baseUrl || !status.apiKey) return;
  try {
    window.open(buildCcSwitchPoolDeeplink({
      baseUrl: status.baseUrl,
      platform: 'openai',
      providerName: 'Relay Pulse GPT 账号',
      apiKey: status.apiKey,
      model: status.models[0]
    }), '_self');
    window.setTimeout(() => {
      if (document.hasFocus()) message.error('未检测到 CC Switch，请确认已安装并允许打开链接');
    }, 100);
  } catch {
    message.error('无法打开 CC Switch，请确认应用已安装');
  }
}

function confirmDelete(account: CodexAccount): void {
  Modal.confirm({
    title: '删除 GPT 账号？',
    content: `将删除 ${account.email} 的本地 session 数据，且无法恢复。`,
    okText: '删除',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      setPending(account.id, true);
      try {
        await deleteCodexAccount(account.id);
        accounts.value = accounts.value.filter((item) => item.id !== account.id);
        selectedRowKeys.value = selectedRowKeys.value.filter((id) => id !== account.id);
        message.success('GPT 账号已删除');
      } catch (error) {
        message.error(errorMessage(error));
      } finally {
        setPending(account.id, false);
      }
    }
  });
}

function usageQuery(): { model?: string; accountId?: string; status?: 'success' | 'failed'; limit: number } {
  return { model: usageModel.value, accountId: usageAccountId.value, status: usageStatus.value, limit: 100 };
}

async function loadUsage(): Promise<void> {
  usageController?.abort();
  const controller = new AbortController();
  usageController = controller;
  usageLoading.value = true;
  usageError.value = '';
  try {
    usage.value = await listCodexUsage(usageQuery(), controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) usageError.value = errorMessage(error);
  } finally {
    if (usageController === controller) {
      usageController = undefined;
      usageLoading.value = false;
    }
  }
}

function openUsage(): void {
  usageOpen.value = true;
  void loadUsage();
}

function confirmClearUsage(): void {
  Modal.confirm({
    title: '清空调用明细？',
    content: '此操作只删除本机调用记录，无法恢复。',
    okText: '清空',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: async () => {
      try {
        await clearCodexUsage();
        await loadUsage();
        message.success('调用明细已清空');
      } catch (error) {
        message.error(errorMessage(error));
      }
    }
  });
}

watch([usageModel, usageAccountId, usageStatus], () => {
  if (usageOpen.value) void loadUsage();
});

onMounted(() => { void loadPage(); });
onBeforeUnmount(() => {
  pageController?.abort();
  usageController?.abort();
  quotaController?.abort();
});
</script>

<template>
  <div class="page-view codex-accounts-view">
    <main class="page-content">
      <div class="page-heading codex-heading">
        <div>
          <h1>GPT 账号</h1>
          <p>导入 CPA、sub2api 或 Codex-Manager 账号，在本机启动 Responses 服务并查看额度。</p>
        </div>
        <a-space wrap>
          <a-button @click="openUsage"><template #icon><HistoryOutlined /></template>调用明细</a-button>
          <a-button :type="running ? 'default' : 'primary'" @click="openService">
            <template #icon><ApiOutlined /></template>{{ running ? '服务设置' : '启动服务' }}
          </a-button>
        </a-space>
      </div>

      <section class="metric-band codex-metrics" aria-label="GPT 账号统计">
        <div class="metric"><span class="metric-label">全部账号</span><strong class="metric-value">{{ accounts.length }}</strong></div>
        <div class="metric"><span class="metric-label">当前可用</span><strong class="metric-value">{{ activeCount }}</strong></div>
        <div class="metric"><span class="metric-label">已过期</span><strong class="metric-value">{{ expiredCount }}</strong></div>
        <div class="metric"><span class="metric-label">已同步模型</span><strong class="metric-value">{{ modelCount }}</strong></div>
      </section>

      <section class="workspace-panel codex-table-panel">
        <div v-if="loadError" class="error-banner" role="alert">
          <span>{{ loadError }}</span>
          <a-button size="small" :loading="loading" @click="loadPage">重试</a-button>
        </div>
        <div class="toolbar codex-toolbar">
          <div class="toolbar-group codex-filters">
            <a-input v-model:value="search" allow-clear placeholder="搜索账号名 / 邮箱 / 编号" class="codex-search">
              <template #prefix><SearchOutlined class="muted" /></template>
            </a-input>
            <a-select v-model:value="planFilter" class="codex-filter" aria-label="订阅类型">
              <a-select-option value="all">全部类型</a-select-option>
              <a-select-option v-for="plan in planOptions" :key="plan" :value="plan">{{ plan }}</a-select-option>
            </a-select>
            <a-select v-model:value="statusFilter" class="codex-filter" aria-label="账号状态">
              <a-select-option value="all">全部状态</a-select-option>
              <a-select-option value="active">可用</a-select-option>
              <a-select-option value="untested">待验证</a-select-option>
              <a-select-option value="error">异常</a-select-option>
              <a-select-option value="expired">已过期</a-select-option>
            </a-select>
          </div>
          <div class="toolbar-group">
            <span v-if="selectedRowKeys.length" class="muted">已选择 {{ selectedRowKeys.length }} 项</span>
            <a-tooltip title="同步已选择账号；未选择时同步全部可用账号的模型">
              <a-button :loading="syncingAll" :disabled="importing || !enabledAccounts.length" @click="syncSelected">
                <template #icon><ReloadOutlined /></template>同步模型
              </a-button>
            </a-tooltip>
            <a-tooltip title="支持 CPA、sub2api、Codex-Manager JSON 和 Codex auth.json">
              <a-button type="primary" :loading="importing" @click="openFilePicker"><template #icon><UploadOutlined /></template>导入账号</a-button>
            </a-tooltip>
          </div>
        </div>

        <div class="desktop-table codex-desktop-table">
          <a-table
            row-key="id"
            :columns="columns"
            :data-source="filteredAccounts"
            :loading="loading"
            :pagination="{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['20', '50', '100'], showTotal: (total: number) => `共 ${total} 个账号` }"
            :scroll="{ x: 1366 }"
            :row-selection="{ selectedRowKeys, onChange: (keys: (string | number)[]) => selectedRowKeys = keys.map(String) }"
          >
            <template #emptyText>
              <a-empty :description="loading ? '正在读取 GPT 账号' : '暂无 GPT 账号'">
                <a-button type="primary" @click="openFilePicker">导入第一个账号</a-button>
              </a-empty>
            </template>
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'account'">
                <div class="codex-account-cell">
                  <div class="codex-account-top">
                    <span class="relay-dot" :class="record.status === 'active' ? 'success' : record.status === 'error' ? 'failed' : ''"></span>
                    <strong class="truncate">{{ record.name || record.email }}</strong>
                    <a-tag class="codex-plan-tag">{{ record.planType || '未知' }}</a-tag>
                  </div>
                  <span class="codex-account-email">{{ record.email }}</span>
                  <span class="codex-account-id mono">{{ record.accountIdMasked }}</span>
                </div>
              </template>
              <template v-else-if="column.key === 'models'">
                <div class="codex-model-cell">
                  <div class="codex-model-summary"><strong>{{ modelLabel(record) }}</strong><span v-if="record.lastModelSyncAt">{{ dateTime(record.lastModelSyncAt) }}</span></div>
                  <div v-if="record.models.length" class="codex-model-tags">
                    <a-tag v-for="model in record.models.slice(0, 4)" :key="model">{{ model }}</a-tag>
                    <a-tag v-if="record.models.length > 4">+{{ record.models.length - 4 }}</a-tag>
                  </div>
                  <span v-else class="muted">使用同步模型获取当前可用模型</span>
                </div>
              </template>
              <template v-else-if="column.key === 'quota'">
                <div v-if="record.usageSnapshot && accountQuotaWindows(record).length" class="codex-list-quota">
                  <div v-for="item in accountQuotaWindows(record)" :key="item.key" class="codex-list-quota-row">
                    <span>{{ item.label }}</span>
                    <div class="codex-list-quota-track"><i :class="item.tone" :style="{ width: `${quotaRemaining(item.window)}%` }"></i></div>
                    <strong>{{ quotaRemaining(item.window) }}%</strong>
                  </div>
                  <small>{{ dateTime(record.usageSnapshot.updatedAt) }}</small>
                </div>
                <a-button v-else type="link" size="small" class="codex-quota-empty" @click="openQuota(record)">未刷新额度</a-button>
              </template>
              <template v-else-if="column.key === 'expiry'">
                <a-tooltip :title="record.expiresAt ? dateTime(record.expiresAt) : '未提供到期时间'">
                  <span class="muted">{{ record.expiresAt ? dateTime(record.expiresAt) : '-' }}</span>
                </a-tooltip>
              </template>
              <template v-else-if="column.key === 'status'">
                <div class="codex-status-cell">
                  <a-tag :color="statusColor(record.status)">{{ statusLabel(record.status) }}</a-tag>
                  <a-tooltip v-if="record.lastError" :title="record.lastError"><span class="codex-error-text">{{ record.lastError }}</span></a-tooltip>
                  <a-switch :checked="record.enabled" size="small" :loading="pendingIds.has(record.id)" @change="toggleAccount(record, $event)" />
                </div>
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-space :size="2">
                  <a-tooltip title="同步模型"><a-button type="text" shape="circle" :loading="syncingIds.has(record.id)" :disabled="pendingIds.has(record.id)" @click="syncAccount(record)"><template #icon><ReloadOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="刷新额度"><a-button type="text" shape="circle" :disabled="pendingIds.has(record.id)" @click="openQuota(record)"><template #icon><WalletOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="查看调用明细"><a-button type="text" shape="circle" @click="usageAccountId = record.id; openUsage()"><template #icon><HistoryOutlined /></template></a-button></a-tooltip>
                  <a-tooltip title="删除账号"><a-button type="text" danger shape="circle" :loading="pendingIds.has(record.id)" @click="confirmDelete(record)"><template #icon><DeleteOutlined /></template></a-button></a-tooltip>
                </a-space>
              </template>
            </template>
          </a-table>
        </div>

        <div class="mobile-relays codex-mobile-list">
          <a-spin :spinning="loading">
            <a-empty v-if="!filteredAccounts.length" description="暂无 GPT 账号"><a-button type="primary" @click="openFilePicker">导入账号</a-button></a-empty>
            <article v-for="account in filteredAccounts" :key="account.id" class="mobile-relay codex-mobile-account">
              <div class="mobile-relay-head">
                <div class="codex-account-top"><span class="relay-dot" :class="account.status === 'active' ? 'success' : account.status === 'error' ? 'failed' : ''"></span><strong class="truncate">{{ account.name || account.email }}</strong></div>
                <a-switch :checked="account.enabled" size="small" :loading="pendingIds.has(account.id)" @change="toggleAccount(account, $event)" />
              </div>
              <p class="mobile-relay-url">{{ account.email }} · {{ account.accountIdMasked }}</p>
              <div class="codex-mobile-meta"><a-tag>{{ account.planType || '未知' }}</a-tag><a-tag :color="statusColor(account.status)">{{ statusLabel(account.status) }}</a-tag><span>{{ modelLabel(account) }}</span></div>
              <div v-if="account.usageSnapshot && accountQuotaWindows(account).length" class="codex-mobile-quota">
                <span v-for="item in accountQuotaWindows(account)" :key="item.key">{{ item.label }}剩余 <strong>{{ quotaRemaining(item.window) }}%</strong></span>
              </div>
              <div v-else class="codex-mobile-quota muted">额度尚未刷新</div>
              <div class="codex-mobile-actions">
                <a-button size="small" :loading="syncingIds.has(account.id)" @click="syncAccount(account)"><template #icon><ReloadOutlined /></template>同步模型</a-button>
                <a-button size="small" :loading="quotaLoading && quotaAccount?.id === account.id" @click="openQuota(account)"><template #icon><WalletOutlined /></template>刷新额度</a-button>
                <a-tooltip title="调用明细"><a-button size="small" aria-label="调用明细" @click="usageAccountId = account.id; openUsage()"><template #icon><HistoryOutlined /></template></a-button></a-tooltip>
                <a-tooltip title="删除账号"><a-button size="small" danger aria-label="删除账号" @click="confirmDelete(account)"><template #icon><DeleteOutlined /></template></a-button></a-tooltip>
              </div>
            </article>
          </a-spin>
        </div>
      </section>
    </main>

    <input ref="fileInput" class="visually-hidden" type="file" accept="application/json,.json" multiple @change="importFiles" />

    <a-modal v-model:open="quotaOpen" :width="680" :footer="null" centered class="codex-quota-modal" @cancel="quotaController?.abort()">
      <template #title>
        <div class="codex-quota-title">
          <span class="codex-quota-title-icon"><DatabaseOutlined /></span>
          <div><strong>用量详情</strong><span>{{ quotaAccount?.email || 'GPT 账号' }}（{{ quotaAccount?.accountIdMasked || '-' }}）</span></div>
        </div>
      </template>
      <div class="codex-quota-content">
        <div v-if="quotaError" class="error-banner codex-drawer-error" role="alert"><span>{{ quotaError }}</span><a-button size="small" :loading="quotaLoading" @click="quotaAccount && refreshQuota(quotaAccount.id)">重试</a-button></div>
        <div class="codex-quota-section">
          <div class="codex-quota-section-heading"><div><h3>套餐信息</h3><p>账号上游返回的套餐状态与时间信息。</p></div><a-tag v-if="quotaLoading" color="processing">刷新中</a-tag></div>
          <div class="codex-quota-info-grid">
            <div><span>订阅状态</span><strong>{{ quotaSnapshot ? subscriptionLabel(quotaSnapshot) : '未提供' }}</strong></div>
            <div><span>订阅方案</span><strong>{{ quotaSnapshot ? planLabel(quotaSnapshot.planType) : '未提供' }}</strong></div>
            <div><span>到期时间</span><strong>未提供</strong></div>
            <div><span>续费时间</span><strong>未提供</strong></div>
          </div>
          <p v-if="quotaSnapshot" class="codex-quota-subline">额度类型：{{ quotaSnapshot.activeLimit || '标准' }} · 积分额度：{{ creditLabel(quotaSnapshot) }}</p>
        </div>

        <div class="codex-quota-section">
          <div class="codex-quota-section-heading"><div><h3>额度窗口</h3><p>不同模型和功能使用的周期额度会在这里分别显示。</p></div></div>
          <div v-if="quotaLoading && !quotaSnapshot" class="codex-quota-loading"><a-spin /><span>正在获取账号额度...</span></div>
          <div v-else class="codex-quota-window-grid">
            <div v-for="item in quotaWindows(quotaSnapshot)" :key="item.key" class="codex-quota-window">
              <div class="codex-quota-window-heading"><span class="codex-quota-window-icon" :class="item.tone"><ReloadOutlined /></span><div><strong>{{ item.label }}</strong><small>{{ item.hint }}</small></div><strong v-if="item.window">{{ quotaRemaining(item.window) }}% <span class="codex-quota-remaining">剩余</span></strong><strong v-else>未提供</strong></div>
              <div class="codex-quota-progress"><span :class="item.tone" :style="{ width: `${quotaRemaining(item.window)}%` }"></span></div>
              <div class="codex-quota-window-footer"><span>已使用 {{ item.window ? `${item.window.usedPercent}%` : '-' }}</span><span>{{ quotaResetLabel(item.window) }}</span></div>
            </div>
          </div>
        </div>
        <div v-if="quotaSnapshot" class="codex-quota-updated">数据获取于：{{ dateTime(quotaSnapshot.updatedAt) }}</div>
        <div class="codex-quota-footer"><a-button @click="quotaOpen = false">关闭</a-button><a-button type="primary" :loading="quotaLoading" :disabled="!quotaAccount" @click="quotaAccount && refreshQuota(quotaAccount.id)"><template #icon><ReloadOutlined /></template>立即刷新</a-button></div>
      </div>
    </a-modal>

    <a-drawer :open="serviceOpen" title="GPT 账号服务" width="min(580px, 100vw)" class="responsive-drawer" @close="serviceOpen = false">
      <div class="codex-service-drawer">
        <div v-if="serviceError" class="error-banner codex-drawer-error" role="alert">{{ serviceError }}</div>
        <template v-if="!running">
          <label class="codex-form-label"><span>服务端口</span><a-input-number v-model:value="servicePort" :min="0" :max="65535" style="width: 100%" placeholder="0 表示自动分配" /></label>
          <label class="codex-form-label"><span>路由规则</span><a-segmented v-model:value="routingStrategy" :options="[{ label: '顺序轮询', value: 'round-robin' }, { label: '随机', value: 'random' }]" block /></label>
          <label class="codex-form-label"><span>服务账号</span>
            <a-select v-model:value="serviceAccountIds" mode="multiple" :max-tag-count="3" :options="enabledAccounts.map((account) => ({ value: account.id, label: `${account.email} · ${modelLabel(account)}` }))" placeholder="选择账号" style="width: 100%" />
          </label>
          <p class="codex-service-note">服务仅监听本机回环地址，启动后会生成临时 API Key；停止服务后该 Key 立即失效。</p>
          <a-button type="primary" block :loading="serviceAction === 'start'" :disabled="!!serviceAction || !serviceAccountIds.length" @click="startService"><template #icon><PlayCircleOutlined /></template>启动本机服务</a-button>
        </template>
        <template v-else>
          <div class="codex-service-state"><span class="relay-dot success"></span><strong>服务运行中</strong><span class="muted">{{ proxy?.availableAccountCount ?? 0 }} 个账号 · {{ proxy?.models.length ?? 0 }} 个模型</span></div>
          <label class="codex-form-label"><span>Base URL</span><a-space-compact block><a-input :value="serviceBaseUrl" readonly class="mono" /><a-tooltip title="复制 Base URL"><a-button aria-label="复制 Base URL" @click="copy(serviceBaseUrl, 'Base URL')"><template #icon><CopyOutlined /></template></a-button></a-tooltip></a-space-compact></label>
          <label class="codex-form-label"><span>API Key</span><a-space-compact block><a-input :value="proxy?.apiKey" readonly class="mono" /><a-tooltip title="复制 API Key"><a-button aria-label="复制 API Key" @click="copy(proxy?.apiKey ?? '', 'API Key')"><template #icon><CopyOutlined /></template></a-button></a-tooltip></a-space-compact></label>
          <p class="codex-service-note">CC Switch 使用 Responses 协议。模型同步后可立即刷新服务模型列表。</p>
          <div class="codex-service-actions">
            <a-button :loading="serviceAction === 'rotate'" :disabled="!!serviceAction" @click="rotateServiceKey"><template #icon><KeyOutlined /></template>轮换 Key</a-button>
            <a-button :disabled="!!serviceAction || !proxy?.apiKey" @click="exportToCcSwitch"><template #icon><ExportOutlined /></template>导入 CC Switch</a-button>
            <a-button danger :loading="serviceAction === 'stop'" :disabled="!!serviceAction" @click="stopService"><template #icon><StopOutlined /></template>停止服务</a-button>
          </div>
        </template>
      </div>
    </a-drawer>

    <a-drawer :open="usageOpen" title="GPT 账号调用明细" width="min(1050px, 100vw)" class="responsive-drawer" @close="usageOpen = false">
      <div class="codex-usage-drawer">
        <div class="codex-usage-summary">
          <div><span>请求</span><strong>{{ formatNumber(usageSummary?.requestCount) }}</strong></div>
          <div><span>成功</span><strong>{{ formatNumber(usageSummary?.successCount) }}</strong></div>
          <div><span>失败</span><strong>{{ formatNumber(usageSummary?.failureCount) }}</strong></div>
          <div><span>Token</span><strong>{{ formatNumber(usageSummary?.totalTokens) }}</strong></div>
          <div><span>平均耗时</span><strong>{{ usageSummary ? `${formatNumber(usageSummary.averageDurationMs)}ms` : '-' }}</strong></div>
        </div>
        <div class="toolbar codex-usage-toolbar">
          <div class="toolbar-group">
            <a-select v-model:value="usageModel" allow-clear placeholder="全部模型" style="min-width: 170px"><a-select-option v-for="option in usage?.filterOptions.models ?? []" :key="option.value" :value="option.value">{{ option.label }}</a-select-option></a-select>
            <a-select v-model:value="usageAccountId" allow-clear placeholder="全部账号" style="min-width: 190px"><a-select-option v-for="option in usage?.filterOptions.accounts ?? []" :key="option.value" :value="option.value">{{ option.label }}</a-select-option></a-select>
            <a-select v-model:value="usageStatus" allow-clear placeholder="全部结果" style="width: 125px"><a-select-option value="success">成功</a-select-option><a-select-option value="failed">失败</a-select-option></a-select>
          </div>
          <div class="toolbar-group"><a-tooltip title="刷新调用明细"><a-button :loading="usageLoading" aria-label="刷新调用明细" @click="loadUsage"><template #icon><ReloadOutlined /></template></a-button></a-tooltip><a-button danger :disabled="!usage?.total" @click="confirmClearUsage">清空记录</a-button></div>
        </div>
        <div v-if="usageError" class="error-banner codex-drawer-error" role="alert"><span>{{ usageError }}</span><a-button size="small" @click="loadUsage">重试</a-button></div>
        <a-table :data-source="usageRecords" row-key="id" :loading="usageLoading" :pagination="{ pageSize: 15, showSizeChanger: false }" :scroll="{ x: 930 }">
          <a-table-column title="时间" data-index="createdAt" :width="176"><template #default="{ text }"><span class="muted">{{ dateTime(text) }}</span></template></a-table-column>
          <a-table-column title="账号" data-index="accountLabel" :width="205"><template #default="{ record }"><span>{{ record.accountLabel }}</span></template></a-table-column>
          <a-table-column title="模型" data-index="model" :width="180"><template #default="{ text }"><span class="mono">{{ text || '-' }}</span></template></a-table-column>
          <a-table-column title="结果" key="status" :width="100"><template #default="{ record }"><a-tag :color="record.status === 'success' ? 'success' : 'error'">{{ record.status === 'success' ? '成功' : '失败' }}</a-tag></template></a-table-column>
          <a-table-column title="Token" data-index="totalTokens" :width="100"><template #default="{ text }">{{ formatNumber(text) }}</template></a-table-column>
          <a-table-column title="耗时" data-index="durationMs" :width="95"><template #default="{ text }">{{ text }}ms</template></a-table-column>
          <a-table-column title="详情" key="detail" :width="220"><template #default="{ record }"><a-tooltip :title="record.errorMessage || `HTTP ${record.statusCode ?? '-'}`"><span class="codex-usage-detail">{{ record.errorMessage || `HTTP ${record.statusCode ?? '-'}` }}</span></a-tooltip></template></a-table-column>
          <template #emptyText><a-empty :description="usageLoading ? '正在读取调用明细' : '暂无调用记录'" /></template>
        </a-table>
      </div>
    </a-drawer>
  </div>
</template>

<style scoped>
.codex-accounts-view { min-height: 100%; }
.codex-heading { margin-bottom: 18px; }
.codex-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.codex-table-panel { min-height: 540px; }
.codex-toolbar { min-height: 72px; }
.codex-filters { min-width: 0; }
.codex-search { width: 270px; }
.codex-filter { width: 132px; }
.codex-account-cell { display: grid; gap: 3px; min-width: 0; }
.codex-account-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.codex-account-top strong { min-width: 0; }
.codex-plan-tag { margin-inline-end: 0; color: var(--muted); background: var(--surface-subtle); border-color: var(--border); }
.codex-account-email, .codex-account-id { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; }
.codex-model-cell { display: grid; gap: 6px; min-width: 0; }
.codex-model-summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; min-width: 0; }
.codex-model-summary span { color: var(--muted); font-size: 11px; white-space: nowrap; }
.codex-model-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.codex-model-tags .ant-tag { max-width: 172px; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codex-list-quota { display: grid; gap: 7px; min-width: 0; }
.codex-list-quota-row { display: grid; grid-template-columns: 72px minmax(48px, 1fr) 34px; align-items: center; gap: 7px; min-width: 0; font-size: 11px; }
.codex-list-quota-row > span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.codex-list-quota-row > strong { font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.codex-list-quota-track { height: 5px; overflow: hidden; border-radius: 99px; background: var(--border); }
.codex-list-quota-track i { display: block; height: 100%; border-radius: inherit; }
.codex-list-quota-track i.green { background: #61d99b; }
.codex-list-quota-track i.blue { background: #8baafc; }
.codex-list-quota small { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.codex-quota-empty { height: auto; padding: 0; font-size: 12px; }
.codex-status-cell { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 8px; }
.codex-status-cell .ant-tag { width: fit-content; margin: 0; }
.codex-error-text { display: block; max-width: 100%; overflow: hidden; color: #c75757; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.codex-desktop-table { display: block; }
.codex-mobile-list { display: none; }
.visually-hidden { position: fixed; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.codex-service-drawer { display: grid; gap: 18px; }
.codex-drawer-error { margin: 0; }
.codex-form-label { display: grid; gap: 7px; color: var(--text); font-size: 13px; }
.codex-form-label > span { color: var(--muted); font-size: 12px; }
.codex-service-note { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
.codex-service-state { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.codex-service-state .muted { margin-left: auto; font-size: 12px; }
.codex-service-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.codex-quota-title { display: flex; align-items: center; gap: 12px; min-width: 0; }
.codex-quota-title-icon { display: grid; width: 34px; height: 34px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #2563eb; background: #eaf1ff; font-size: 18px; }
.codex-quota-title strong, .codex-quota-title span { display: block; }
.codex-quota-title strong { font-size: 16px; line-height: 22px; }
.codex-quota-title div > span { max-width: 440px; overflow: hidden; color: var(--muted); font-size: 12px; font-weight: 400; text-overflow: ellipsis; white-space: nowrap; }
.codex-quota-content { display: grid; gap: 14px; }
.codex-quota-section { padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.codex-quota-section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.codex-quota-section-heading h3 { margin: 0; font-size: 14px; }
.codex-quota-section-heading p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.codex-quota-info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.codex-quota-info-grid > div { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-subtle); }
.codex-quota-info-grid span, .codex-quota-info-grid strong { display: block; }
.codex-quota-info-grid span { margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.codex-quota-info-grid strong { overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.codex-quota-subline { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
.codex-quota-window-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.codex-quota-window { min-width: 0; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-subtle); }
.codex-quota-window-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.codex-quota-window-heading > div { min-width: 0; flex: 1; }
.codex-quota-window-heading strong, .codex-quota-window-heading small { display: block; }
.codex-quota-window-heading > strong { flex: 0 0 auto; font-size: 15px; white-space: nowrap; }
.codex-quota-window-heading small { margin-top: 2px; color: var(--muted); font-size: 11px; }
.codex-quota-window-icon { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 50%; font-size: 14px; }
.codex-quota-window-icon.green { color: #0d9f58; background: #e5faee; }
.codex-quota-window-icon.blue { color: #2563eb; background: #eaf1ff; }
.codex-quota-progress { height: 5px; margin: 12px 0 8px; overflow: hidden; border-radius: 99px; background: var(--border); }
.codex-quota-progress span { display: block; height: 100%; min-width: 0; border-radius: inherit; transition: width 180ms ease; }
.codex-quota-progress span.green { background: #61d99b; }
.codex-quota-progress span.blue { background: #8baafc; }
.codex-quota-window-footer { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; }
.codex-quota-window-footer span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.codex-quota-remaining { color: var(--muted); font-size: 12px; font-weight: 400; }
.codex-quota-loading { display: flex; min-height: 116px; align-items: center; justify-content: center; gap: 10px; color: var(--muted); font-size: 13px; }
.codex-quota-updated { color: var(--muted); font-size: 11px; font-style: italic; text-align: center; }
.codex-quota-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 2px; }
:deep(.codex-quota-modal .ant-modal-body) { max-height: calc(100vh - 132px); overflow-y: auto; }
.codex-usage-drawer { display: grid; gap: 16px; }
.codex-usage-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.codex-usage-summary > div { min-width: 0; padding: 11px 12px; border-right: 1px solid var(--border); background: var(--surface-subtle); }
.codex-usage-summary > div:last-child { border-right: 0; }
.codex-usage-summary span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.codex-usage-summary strong { display: block; overflow: hidden; font-size: 18px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.codex-usage-toolbar { padding: 0; border: 0; }
.codex-usage-detail { display: block; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.codex-mobile-meta { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.codex-mobile-meta .ant-tag { margin: 0; }
.codex-mobile-quota { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 9px; font-size: 11px; }
.codex-mobile-quota span { color: var(--muted); }
.codex-mobile-quota strong { color: var(--text); font-variant-numeric: tabular-nums; }
.codex-mobile-actions { display: flex; align-items: center; gap: 6px; margin-top: 12px; }

@media (max-width: 900px) {
  .codex-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .codex-metrics .metric:nth-child(even) { border-right: 0; }
  .codex-metrics .metric:nth-child(-n+2) { border-bottom: 1px solid var(--border); }
  .codex-desktop-table { display: none; }
  .codex-mobile-list { display: block; }
  .codex-search { flex: 1 1 230px; width: auto; }
  .codex-filter { flex: 1 1 126px; }
}

@media (max-width: 560px) {
  .codex-metrics .metric { padding: 12px 14px; }
  .codex-toolbar { padding: 12px; }
  .codex-usage-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .codex-usage-summary > div:nth-child(2n) { border-right: 0; }
  .codex-usage-summary > div:not(:nth-last-child(-n+1)) { border-bottom: 1px solid var(--border); }
  .codex-service-state { align-items: flex-start; flex-wrap: wrap; }
  .codex-service-state .muted { width: 100%; margin-left: 16px; }
  .codex-quota-info-grid, .codex-quota-window-grid { grid-template-columns: minmax(0, 1fr); }
  .codex-quota-title div > span { max-width: 220px; }
}
</style>
