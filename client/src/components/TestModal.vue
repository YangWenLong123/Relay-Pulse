<!--
 * @Description: 单个中转站连接测试与结果展示
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/components/TestModal.vue
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { ApiOutlined, CopyOutlined, PlayCircleOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons-vue';
import { cancelRelayTest, discoverRelayModels, testRelay } from '../api/relays';
import { errorMessage } from '../api/http';
import type { Relay, RelayProtocol, TestResult } from '../types';
import { useRelayStore } from '../stores/relays';

type ModalState = 'idle' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
const props = defineProps<{ open: boolean; relay?: Relay | null }>();
const emit = defineEmits<{ close: [] }>();
const relayStore = useRelayStore();
const model = ref('');
const protocol = ref<RelayProtocol>('auto');
const prompt = ref('hi');
const models = ref<string[]>([]);
const discovering = ref(false);
const state = ref<ModalState>('idle');
const result = ref<TestResult>();
let controller: AbortController | undefined;
let discoveryController: AbortController | undefined;

watch(
  () => [props.open, props.relay?.id] as const,
  ([open]) => {
    if (!open) {
      cleanupRequests();
      return;
    }
    if (!props.relay) return;
    model.value = props.relay.model;
    protocol.value = props.relay.protocol;
    prompt.value = 'hi';
    models.value = [props.relay.model];
    state.value = 'idle';
    result.value = undefined;
  }
);

const stateLabel = computed(() => ({
  idle: '等待测试',
  running: '测试中',
  success: '测试成功',
  failed: '测试失败',
  cancelled: '已取消',
  timeout: '已超时'
}[state.value]));
const stateColor = computed(() => ({
  idle: 'default', running: 'processing', success: 'success', failed: 'error', cancelled: 'default', timeout: 'warning'
}[state.value]));

async function discover(): Promise<void> {
  if (!props.relay) return;
  discoveryController?.abort();
  const currentController = new AbortController();
  discoveryController = currentController;
  discovering.value = true;
  try {
    models.value = await discoverRelayModels(props.relay.id, currentController.signal);
    if (!models.value.includes(model.value)) models.value.unshift(model.value);
    message.success(`发现 ${models.value.length} 个模型`);
  } catch (error) {
    if (!currentController.signal.aborted) message.error(errorMessage(error));
  } finally {
    if (discoveryController === currentController) {
      discoveryController = undefined;
      discovering.value = false;
    }
  }
}

async function run(): Promise<void> {
  if (!props.relay) return;
  if (!model.value.trim() || !prompt.value.trim()) {
    message.warning('请填写测试模型和测试消息');
    return;
  }
  controller?.abort();
  const currentController = new AbortController();
  controller = currentController;
  state.value = 'running';
  result.value = undefined;
  try {
    result.value = await testRelay(
      props.relay.id,
      { model: model.value, message: prompt.value, protocol: protocol.value },
      currentController.signal
    );
    state.value = result.value.success ? 'success' : result.value.errorType === 'timeout' ? 'timeout' : 'failed';
    relayStore.applyResult(result.value);
  } catch (error) {
    state.value = currentController.signal.aborted ? 'cancelled' : 'failed';
    if (!currentController.signal.aborted) message.error(errorMessage(error));
  } finally {
    if (controller === currentController) controller = undefined;
  }
}

function cancel(): void {
  controller?.abort();
  controller = undefined;
  if (props.relay) {
    void cancelRelayTest(props.relay.id)
      .then(() => relayStore.fetchRelays())
      .catch(() => undefined);
  }
  state.value = 'cancelled';
}

function cleanupRequests(): void {
  if (controller) cancel();
  discoveryController?.abort();
  discoveryController = undefined;
  discovering.value = false;
}

function close(): void {
  if (state.value === 'running') cancel();
  emit('close');
}

async function copyResult(): Promise<void> {
  if (!result.value) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(result.value, null, 2));
    message.success('测试结果已复制');
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限');
  }
}

onBeforeUnmount(cleanupRequests);
</script>

<template>
  <a-modal :open="open" :width="720" title="测试中转站连接" :mask-closable="state !== 'running'" @cancel="close">
    <template v-if="relay">
      <div class="test-meta" style="margin-bottom: 18px">
        <div class="test-meta-item"><span>中转站</span><strong class="truncate">{{ relay.name }}</strong></div>
        <div class="test-meta-item"><span>API Key</span><strong class="mono">{{ relay.apiKeyMasked }}</strong></div>
        <div class="test-meta-item"><span>状态</span><a-tag :color="relay.enabled ? 'success' : 'default'">{{ relay.enabled ? '已启用' : '已停用' }}</a-tag></div>
        <div class="test-meta-item"><span>超时</span><strong>{{ relay.timeout / 1000 }}s</strong></div>
      </div>

      <a-form layout="vertical">
        <a-form-item label="测试模型">
          <a-space-compact block>
            <a-auto-complete v-model:value="model" :options="models.map(value => ({ value }))" :disabled="state === 'running'" style="width: 100%" />
            <a-button :loading="discovering" :disabled="state === 'running'" @click="discover"><template #icon><ApiOutlined /></template>探测模型</a-button>
          </a-space-compact>
        </a-form-item>
        <a-form-item label="请求协议">
          <a-segmented
            v-model:value="protocol"
            block
            :disabled="state === 'running'"
            :options="[
              { label: '自动', value: 'auto' },
              { label: 'Responses', value: 'responses' },
              { label: 'Chat Completions', value: 'chat' }
            ]"
          />
        </a-form-item>
        <a-form-item label="测试消息">
          <a-textarea v-model:value="prompt" :rows="2" :maxlength="4000" :disabled="state === 'running'" />
        </a-form-item>
      </a-form>

      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px">
        <a-tag :color="stateColor">{{ stateLabel }}</a-tag>
        <a-tooltip title="复制测试结果"><a-button v-if="result" type="text" shape="circle" @click="copyResult"><template #icon><CopyOutlined /></template></a-button></a-tooltip>
      </div>
      <div class="result-console">
        <template v-if="state === 'idle'">准备就绪。将向模型发送 “{{ prompt }}”。</template>
        <template v-else-if="state === 'running'">正在连接 {{ relay.baseUrl }}
请求模型：{{ model }}
等待模型回复...</template>
        <template v-else-if="state === 'cancelled'">测试请求已取消。</template>
        <template v-else-if="result"><span :class="result.success ? 'success' : 'failure'">{{ result.success ? '✓ 连接测试成功' : '× 连接测试失败' }}</span>
HTTP 状态：{{ result.statusCode ?? '-' }}
使用协议：{{ result.protocol }}
首字节：{{ result.firstByteDuration === null ? '-' : `${result.firstByteDuration}ms` }}
总耗时：{{ result.totalDuration }}ms
模型回复：{{ result.responseText || '-' }}
<template v-if="result.errorType">错误类型：{{ result.errorType }}
</template><template v-if="result.errorMessage">错误信息：{{ result.errorMessage }}</template></template>
        <template v-else>请求失败，未获得测试结果。</template>
      </div>
    </template>
    <template #footer>
      <a-button @click="close">关闭</a-button>
      <a-button v-if="state === 'running'" danger @click="cancel"><template #icon><StopOutlined /></template>取消</a-button>
      <a-button v-else type="primary" :disabled="!relay?.enabled || discovering || !model.trim() || !prompt.trim()" @click="run">
        <template #icon><ReloadOutlined v-if="result" /><PlayCircleOutlined v-else /></template>
        {{ result ? '重新测试' : '开始测试' }}
      </a-button>
    </template>
  </a-modal>
</template>
