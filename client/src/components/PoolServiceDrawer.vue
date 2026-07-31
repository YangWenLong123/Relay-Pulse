<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { CopyOutlined, KeyOutlined, PlayCircleOutlined, PoweroffOutlined } from '@ant-design/icons-vue';
import { getPoolStatus, rotatePoolKey, startPool, stopPool } from '../api/pool';
import { errorMessage } from '../api/http';
import type { PoolStatus } from '../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const status = ref<PoolStatus>();
const poolKey = ref('');
const requestedPort = ref(0);
const loading = ref(false);
const loadError = ref('');
const busyAction = ref<'start' | 'stop' | 'rotate'>();
let controller: AbortController | undefined;

const running = computed(() => status.value?.active === true);
const baseUrl = computed(() => status.value?.baseUrl ?? '');
const runningSince = computed(() => status.value?.startedAt ? new Date(status.value.startedAt).toLocaleString() : '-');
const statusLabel = computed(() => running.value ? '运行中' : '未启动');
const statusColor = computed(() => running.value ? 'success' : 'default');

watch(
  () => props.open,
  (open) => {
    if (open) void load();
    else controller?.abort();
  }
);

async function load(): Promise<void> {
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  loading.value = true;
  loadError.value = '';
  try {
    status.value = await getPoolStatus(currentController.signal);
    if (!status.value.active) poolKey.value = '';
  } catch (error) {
    if (!currentController.signal.aborted) loadError.value = errorMessage(error);
  } finally {
    if (controller === currentController) {
      controller = undefined;
      loading.value = false;
    }
  }
}

async function start(): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = 'start';
  loadError.value = '';
  try {
    const result = await startPool(requestedPort.value || 0);
    status.value = result;
    poolKey.value = result.apiKey;
    message.success('号池服务已启动');
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    busyAction.value = undefined;
  }
}

async function stop(): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = 'stop';
  loadError.value = '';
  try {
    status.value = await stopPool();
    poolKey.value = '';
    message.success('号池服务已停止');
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    busyAction.value = undefined;
  }
}

async function rotateKey(): Promise<void> {
  if (busyAction.value) return;
  busyAction.value = 'rotate';
  loadError.value = '';
  try {
    const result = await rotatePoolKey();
    status.value = result;
    poolKey.value = result.apiKey;
    message.success('号池 API Key 已轮换');
  } catch (error) {
    loadError.value = errorMessage(error);
  } finally {
    busyAction.value = undefined;
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

function close(): void {
  if (busyAction.value) return;
  controller?.abort();
  emit('close');
}
</script>

<template>
  <a-drawer
    :open="open"
    title="号池服务"
    :width="620"
    root-class-name="responsive-drawer"
    :closable="!busyAction"
    :mask-closable="!busyAction"
    @close="close"
  >
    <div class="pool-status-grid">
      <div><span>服务状态</span><a-tag :color="statusColor">{{ statusLabel }}</a-tag></div>
      <div><span>可用中转</span><strong>{{ status?.eligibleRelayCount ?? 0 }}</strong></div>
      <div><span>冷却中</span><strong>{{ status?.cooldownRelayCount ?? 0 }}</strong></div>
      <div><span>启动时间</span><strong class="pool-started-at">{{ runningSince }}</strong></div>
    </div>

    <div v-if="loadError" class="error-banner pool-error" role="alert">{{ loadError }}</div>

    <a-spin :spinning="loading">
      <template v-if="running">
        <section class="pool-section">
          <a-form layout="vertical">
            <a-form-item label="Base URL">
              <a-space-compact block>
                <a-input :value="baseUrl" readonly class="mono" />
                <a-tooltip title="复制 Base URL">
                  <a-button aria-label="复制 Base URL" @click="copy(baseUrl, 'Base URL')"><template #icon><CopyOutlined /></template></a-button>
                </a-tooltip>
              </a-space-compact>
            </a-form-item>
            <a-form-item label="API Key" :extra="poolKey ? '' : '为保护密钥，请轮换后获取新的 API Key。'">
              <a-space-compact block>
                <a-input :value="poolKey || '已隐藏'" readonly :type="poolKey ? 'text' : 'password'" class="mono" />
                <a-tooltip title="复制 API Key">
                  <a-button :disabled="!poolKey" aria-label="复制 API Key" @click="copy(poolKey, 'API Key')"><template #icon><CopyOutlined /></template></a-button>
                </a-tooltip>
              </a-space-compact>
            </a-form-item>
          </a-form>
        </section>
        <div class="pool-actions">
          <a-button :loading="busyAction === 'rotate'" :disabled="!!busyAction" @click="rotateKey"><template #icon><KeyOutlined /></template>轮换 Key</a-button>
        </div>
      </template>

      <template v-else>
        <section class="pool-section">
          <a-form layout="vertical">
            <a-form-item label="本机端口" extra="填 0 将自动分配可用端口。">
              <a-input-number v-model:value="requestedPort" :min="0" :max="65535" :precision="0" style="width: 100%" />
            </a-form-item>
          </a-form>
        </section>
      </template>
    </a-spin>

    <template #footer>
      <div class="pool-drawer-footer">
        <a-button :disabled="!!busyAction" @click="close">关闭</a-button>
        <a-button v-if="running" danger :loading="busyAction === 'stop'" :disabled="!!busyAction" @click="stop"><template #icon><PoweroffOutlined /></template>停止服务</a-button>
        <a-button v-else type="primary" :loading="busyAction === 'start'" :disabled="loading || !!busyAction" @click="start"><template #icon><PlayCircleOutlined /></template>启动服务</a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped>
.pool-status-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 18px; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; }
.pool-status-grid > div { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--surface-subtle); }
.pool-status-grid > div:nth-child(even) { border-right: 0; }
.pool-status-grid > div:nth-last-child(-n + 2) { border-bottom: 0; }
.pool-status-grid span { display: block; margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.pool-status-grid strong { display: block; min-height: 22px; font-size: 15px; font-variant-numeric: tabular-nums; }
.pool-status-grid .pool-started-at { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 22px; }
.pool-section { padding: 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.pool-section :deep(.ant-form-item:last-child) { margin-bottom: 0; }
.pool-error { margin-bottom: 16px; }
.pool-actions, .pool-drawer-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 16px; }
.pool-drawer-footer { margin-top: 0; }

@media (max-width: 420px) {
  .pool-status-grid { grid-template-columns: 1fr; }
  .pool-status-grid > div { border-right: 0; }
  .pool-status-grid > div:nth-last-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .pool-status-grid > div:last-child { border-bottom: 0; }
}
</style>
