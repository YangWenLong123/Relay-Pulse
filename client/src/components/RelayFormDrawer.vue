<!--
 * @Description: 中转站新增与编辑表单
 * @Date: 2026-07-28 16:17:28
 * @FilePath: client/src/components/RelayFormDrawer.vue
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { FormInstance } from 'ant-design-vue';
import { message } from 'ant-design-vue';
import { ApiOutlined, SaveOutlined } from '@ant-design/icons-vue';
import { discoverDraftModels, discoverRelayModels } from '../api/relays';
import { errorMessage } from '../api/http';
import type { Relay, RelayFormValue } from '../types';
import { useRelayStore } from '../stores/relays';
import { isStandaloneExtensionRuntime } from '../utils/runtime';

const props = defineProps<{ open: boolean; relay?: Relay | null }>();
const emit = defineEmits<{ close: []; saved: [relay: Relay] }>();
const store = useRelayStore();
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  typeof window === 'undefined' ? '' : window.location.protocol
);
const formRef = ref<FormInstance>();
const saving = ref(false);
const discovering = ref(false);
const modelOptions = ref<{ value: string }[]>([]);
const modelSearch = ref('');
let discoveryController: AbortController | undefined;
const form = reactive<RelayFormValue>({
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  protocol: 'auto',
  enabled: true,
  timeout: 30000,
  remark: ''
});

const filteredModelOptions = computed(() => {
  const query = modelSearch.value.trim();
  const normalizedQuery = query.toLowerCase();
  const matches = modelOptions.value.filter(({ value }) => value.toLowerCase().includes(normalizedQuery));
  const hasExactMatch = modelOptions.value.some(({ value }) => value.toLowerCase() === normalizedQuery);

  return query && !hasExactMatch ? [{ value: query }, ...matches] : matches;
});

function validateBaseUrl(_rule: unknown, value: string): Promise<void> {
  if (!value) return Promise.reject(new Error('请输入 Base URL'));
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    if (url.username || url.password) return Promise.reject(new Error('URL 不能包含用户名或密码'));
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error('请输入有效的 http/https URL'));
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      cancelDiscovery();
      return;
    }
    modelOptions.value = [];
    modelSearch.value = '';
    Object.assign(
      form,
      props.relay
        ? {
            name: props.relay.name,
            baseUrl: props.relay.baseUrl,
            apiKey: '',
            model: props.relay.model,
            protocol: props.relay.protocol,
            enabled: props.relay.enabled,
            timeout: props.relay.timeout,
            remark: props.relay.remark
          }
        : {
            name: '',
            baseUrl: '',
            apiKey: '',
            model: '',
            protocol: 'auto',
            enabled: true,
            timeout: 30000,
            remark: ''
          }
    );
    formRef.value?.clearValidate();
  }
);

async function discover(): Promise<void> {
  if (!form.baseUrl || (!form.apiKey && !props.relay)) {
    message.warning('请先填写 URL 和 API Key');
    return;
  }
  if (props.relay && !form.apiKey && form.baseUrl !== props.relay.baseUrl) {
    message.warning('URL 已修改，请填写新 API Key 或先保存配置后再探测');
    return;
  }
  cancelDiscovery();
  const currentController = new AbortController();
  discoveryController = currentController;
  discovering.value = true;
  try {
    const models =
      props.relay && !form.apiKey
        ? await discoverRelayModels(props.relay.id, currentController.signal)
        : await discoverDraftModels(
            { baseUrl: form.baseUrl, apiKey: form.apiKey!, timeout: form.timeout },
            currentController.signal
          );
    modelOptions.value = models.map((value) => ({ value }));
    modelSearch.value = '';
    message.success(models.length ? `发现 ${models.length} 个模型` : '接口可访问，但没有返回模型');
  } catch (error) {
    if (!currentController.signal.aborted) message.error(errorMessage(error));
  } finally {
    if (discoveryController === currentController) {
      discoveryController = undefined;
      discovering.value = false;
    }
  }
}

async function submit(): Promise<void> {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  saving.value = true;
  try {
    const payload = { ...form };
    if (props.relay && !payload.apiKey?.trim()) delete payload.apiKey;
    const relay = props.relay ? await store.update(props.relay.id, payload) : await store.create(payload);
    message.success(props.relay ? '中转站已更新' : '中转站已添加');
    emit('saved', relay);
    emit('close');
  } catch (error) {
    message.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

function cancelDiscovery(): void {
  discoveryController?.abort();
  discoveryController = undefined;
  discovering.value = false;
}

function close(): void {
  if (saving.value) return;
  cancelDiscovery();
  emit('close');
}

onBeforeUnmount(cancelDiscovery);
</script>

<template>
  <a-drawer
    :open="open"
    :title="relay ? '编辑中转站' : '添加中转站'"
    :width="520"
    root-class-name="responsive-drawer"
    placement="right"
    :closable="!saving"
    :mask-closable="!saving"
    @close="close"
  >
    <a-form ref="formRef" :model="form" :disabled="saving" layout="vertical" required-mark="optional">
      <a-form-item label="名称" name="name" :rules="[{ required: true, message: '请输入中转站名称' }]">
        <a-input v-model:value="form.name" :maxlength="80" placeholder="例如：主力线路" />
      </a-form-item>
      <a-form-item
        label="Base URL"
        name="baseUrl"
        :rules="[
          { required: true, message: '请输入 Base URL' },
          { validator: validateBaseUrl, trigger: 'blur' }
        ]"
      >
        <a-input v-model:value="form.baseUrl" :maxlength="500" placeholder="https://api.example.com/v1" />
      </a-form-item>
      <a-form-item
        label="API Key"
        name="apiKey"
        :rules="[{ required: !relay, message: '请输入 API Key' }]"
        :extra="relay ? `留空表示不修改，当前：${relay.apiKeyMasked}` : standaloneExtension ? '密钥仅保存在当前浏览器扩展的本地存储中' : '密钥只会发送到本项目后端'"
      >
        <a-input-password v-model:value="form.apiKey" :maxlength="500" autocomplete="new-password" placeholder="sk-..." />
      </a-form-item>
      <a-form-item label="默认模型" name="model" :rules="[{ required: true, message: '请输入模型名称' }]">
        <a-space-compact block>
          <a-auto-complete
            v-model:value="form.model"
            :options="filteredModelOptions"
            :filter-option="false"
            style="width: 100%"
            placeholder="例如：gpt-4.1-mini"
            @search="modelSearch = $event"
            @select="modelSearch = ''"
          />
          <a-button :loading="discovering" @click="discover">
            <template #icon><ApiOutlined /></template>
            探测模型
          </a-button>
        </a-space-compact>
      </a-form-item>
      <a-form-item label="请求协议" name="protocol">
        <a-segmented
          v-model:value="form.protocol"
          block
          :options="[
            { label: '自动', value: 'auto' },
            { label: 'Responses', value: 'responses' },
            { label: 'Chat Completions', value: 'chat' }
          ]"
        />
      </a-form-item>
      <a-row :gutter="16">
        <a-col :span="16">
          <a-form-item label="超时时间" name="timeout">
            <a-input-number v-model:value="form.timeout" :min="1000" :max="120000" :step="1000" style="width: 100%" addon-after="ms" />
          </a-form-item>
        </a-col>
        <a-col :span="8">
          <a-form-item label="启用状态" name="enabled">
            <a-switch v-model:checked="form.enabled" checked-children="启用" un-checked-children="停用" />
          </a-form-item>
        </a-col>
      </a-row>
      <a-form-item label="备注" name="remark">
        <a-textarea v-model:value="form.remark" :maxlength="500" :rows="3" show-count placeholder="可选" />
      </a-form-item>
    </a-form>
    <template #footer>
      <div style="display: flex; justify-content: flex-end; gap: 8px">
        <a-button :disabled="saving" @click="close">取消</a-button>
        <a-button type="primary" :loading="saving" :disabled="discovering" @click="submit">
          <template #icon><SaveOutlined /></template>
          保存
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>
