<!--
 * @Description: 批量中转站连接测试及任务进度管理
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/components/BatchTestModal.vue
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { CloseCircleOutlined, LoadingOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons-vue';
import { cancelRelayTest, testRelay } from '../api/relays';
import { errorMessage } from '../api/http';
import { useRelayStore } from '../stores/relays';
import type { BatchItem, Relay } from '../types';
import { countBatchItems } from '../utils/batch-state';
import { runConcurrent } from '../utils/concurrency';

const props = defineProps<{ open: boolean; relays: Relay[] }>();
const emit = defineEmits<{ close: [] }>();
const store = useRelayStore();
const items = ref<BatchItem[]>([]);
const running = ref(false);
const stopped = ref(false);
const controllers = new Map<BatchItem, AbortController>();
let generation = 0;

const counts = computed(() => countBatchItems(items.value));
const completed = computed(() => items.value.filter((item) => ['success', 'failed', 'cancelled'].includes(item.status)).length);
const progress = computed(() => (counts.value.total ? Math.round((completed.value / counts.value.total) * 100) : 0));
const averageLatency = computed(() => {
  const values = items.value.flatMap((item) => (item.result?.success ? [item.result.totalDuration] : []));
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
});
const successRate = computed(() => {
  const finished = counts.value.success + counts.value.failed;
  return finished ? Math.round((counts.value.success / finished) * 100) : null;
});

watch(
  () => props.open,
  (open) => {
    const currentGeneration = ++generation;
    if (!open) {
      stop();
      return;
    }
    if (running.value) stop();
    running.value = false;
    items.value = props.relays.filter((relay) => relay.enabled).map((relay) => ({ relay, status: 'queued' }));
    stopped.value = false;
    if (items.value.length) void start(items.value, currentGeneration);
  }
);

async function start(targets: BatchItem[], runGeneration = generation): Promise<void> {
  if (running.value || !targets.length) return;
  running.value = true;
  stopped.value = false;
  await runConcurrent(
    targets,
    4,
    async (item) => {
      if (stopped.value || runGeneration !== generation) return;
      item.status = 'running';
      const controller = new AbortController();
      controllers.set(item, controller);
      try {
        const result = await testRelay(item.relay.id, { message: 'hi' }, controller.signal);
        if (runGeneration !== generation) return;
        item.result = result;
        item.status = result.success ? 'success' : 'failed';
        store.applyResult(result);
      } catch (error) {
        item.status = controller.signal.aborted ? 'cancelled' : 'failed';
        if (!controller.signal.aborted) message.error(`${item.relay.name}：${errorMessage(error)}`);
      } finally {
        controllers.delete(item);
      }
    },
    () => stopped.value
  );
  if (runGeneration !== generation) return;
  if (stopped.value) markQueuedAsCancelled();
  running.value = false;
}

function stop(): void {
  if (!running.value) return;
  stopped.value = true;
  markQueuedAsCancelled();
  const cancellations: Promise<void>[] = [];
  controllers.forEach((controller, item) => {
    controller.abort();
    cancellations.push(cancelRelayTest(item.relay.id));
  });
  void Promise.allSettled(cancellations)
    .then(() => store.fetchRelays())
    .catch(() => undefined);
}

function markQueuedAsCancelled(): void {
  items.value.forEach((item) => {
    if (item.status === 'queued') item.status = 'cancelled';
  });
}

function retryFailed(): void {
  const failed = items.value.filter((item) => item.status === 'failed');
  failed.forEach((item) => {
    item.status = 'queued';
    item.result = undefined;
  });
  if (failed.length) void start(failed);
}

function continueCancelled(): void {
  const cancelled = items.value.filter((item) => item.status === 'cancelled');
  cancelled.forEach((item) => {
    item.status = 'queued';
    item.result = undefined;
  });
  if (cancelled.length) void start(cancelled);
}

function close(): void {
  if (running.value) stop();
  emit('close');
}

function statusLabel(item: BatchItem): string {
  return { queued: '等待', running: '测试中', success: '成功', failed: '失败', cancelled: '已取消' }[item.status];
}

onBeforeUnmount(() => stop());
</script>

<template>
  <a-modal :open="open" :width="760" title="批量连接测试" :mask-closable="!running" @cancel="close">
    <!-- 各状态相加始终等于总任务数 -->
    <div class="batch-grid">
      <div class="batch-stat"><span>总数</span><strong>{{ counts.total }}</strong></div>
      <div class="batch-stat"><span>等待</span><strong>{{ counts.queued }}</strong></div>
      <div class="batch-stat"><span>进行中</span><strong>{{ counts.running }}</strong></div>
      <div class="batch-stat"><span>成功</span><strong>{{ counts.success }}</strong></div>
      <div class="batch-stat"><span>失败</span><strong>{{ counts.failed }}</strong></div>
      <div class="batch-stat"><span>已取消</span><strong>{{ counts.cancelled }}</strong></div>
    </div>
    <a-progress :percent="progress" :status="counts.failed ? 'exception' : running ? 'active' : 'normal'" />
    <div class="muted" style="display: flex; justify-content: space-between; margin: 4px 0 12px; font-size: 12px">
      <span>固定并发：4</span>
      <span>成功率：{{ successRate === null ? '-' : `${successRate}%` }} · 平均延迟：{{ averageLatency === null ? '-' : `${averageLatency}ms` }}</span>
    </div>
    <div class="batch-list">
      <div v-for="item in items" :key="item.relay.id" class="batch-row">
        <LoadingOutlined v-if="item.status === 'running'" spin />
        <a-badge v-else :status="item.status === 'success' ? 'success' : item.status === 'failed' ? 'error' : 'default'" />
        <div class="batch-row-main">
          <strong class="truncate">{{ item.relay.name }}</strong>
          <span class="truncate">{{ item.result?.errorMessage || item.result?.responseText || item.relay.model }}</span>
        </div>
        <span class="muted">{{ item.result ? `${item.result.totalDuration}ms` : statusLabel(item) }}</span>
      </div>
      <a-empty v-if="!items.length" description="所选中转站均已停用" style="padding: 32px 0" />
    </div>
    <template #footer>
      <a-button @click="close">关闭</a-button>
      <a-button v-if="running" danger @click="stop"><template #icon><StopOutlined /></template>停止</a-button>
      <a-button v-else-if="counts.failed" type="primary" @click="retryFailed"><template #icon><ReloadOutlined /></template>重试失败项</a-button>
      <a-button v-else-if="counts.cancelled" type="primary" @click="continueCancelled"><template #icon><CloseCircleOutlined /></template>继续测试</a-button>
    </template>
  </a-modal>
</template>
