<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance } from 'ant-design-vue';
import { message } from 'ant-design-vue';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons-vue';
import { errorMessage } from '../api/http';
import { getRelayBalanceCredentials } from '../api/relays';
import { useRelayStore } from '../stores/relays';
import type { BalanceConfigFormValue, Relay } from '../types';

const props = defineProps<{ open: boolean; relay?: Relay | null }>();
const emit = defineEmits<{ close: []; saved: [relay: Relay] }>();
const store = useRelayStore();
const formRef = ref<FormInstance>();
const saving = ref(false);
const querying = ref(false);
const apiKeyConfigured = ref(false);
const accessTokenConfigured = ref(false);
const credentialsLoading = ref(false);
const credentialsLoadError = ref('');
let credentialsController: AbortController | undefined;
const form = reactive<BalanceConfigFormValue>({
  template: 'generic', requestUrl: '', apiKey: '', accessToken: '', userId: '', timeout: 10000, intervalMinutes: 1, enabled: true
});

const templateDescription = computed(() => form.template === 'generic'
  ? '使用当前中转站的 API Key 请求 /v1/usage，可按需覆盖查询地址和凭证。'
  : '使用 New API 的访问令牌和用户 ID 请求 /api/user/self，额度将按 New API 的单位换算为 USD。'
);
const requestExample = computed(() => form.template === 'generic'
  ? 'GET {{请求地址或当前 Base URL}}/v1/usage\nAuthorization: Bearer {{余额 API Key 或当前 API Key}}'
  : 'GET {{请求地址或当前 Base URL}}/api/user/self\nAuthorization: Bearer {{访问令牌}}\nNew-Api-User: {{用户 ID}}'
);

function showBalanceSuccess(relay: Relay): void {
  const balance = relay.balance;
  if (!balance?.success) return;
  const value = balance.remaining === null
    ? '余额已更新'
    : `剩余 ${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(balance.remaining)}${balance.unit ? ` ${balance.unit}` : ''}`;
  message.success({ content: `${relay.name}：${value}`, duration: 4 });
}

watch(() => props.open, (open) => {
  if (!open || !props.relay) {
    cancelCredentialsLoad();
    return;
  }
  const config = props.relay.balanceConfig;
  Object.assign(form, {
    template: config?.template ?? 'generic', requestUrl: config?.requestUrl ?? '', apiKey: '', accessToken: '',
    userId: config?.userId ?? '', timeout: config?.timeout ?? 10000, intervalMinutes: config?.intervalMinutes ?? 1, enabled: config?.enabled ?? true
  });
  apiKeyConfigured.value = config?.apiKeyConfigured ?? false;
  accessTokenConfigured.value = config?.accessTokenConfigured ?? false;
  credentialsLoadError.value = '';
  if (config) void loadBalanceCredentials(props.relay);
  formRef.value?.clearValidate();
});

async function loadBalanceCredentials(relay: Relay): Promise<void> {
  cancelCredentialsLoad();
  const currentController = new AbortController();
  credentialsController = currentController;
  credentialsLoading.value = true;
  try {
    const credentials = await getRelayBalanceCredentials(relay.id, currentController.signal);
    if (credentialsController === currentController) {
      form.apiKey = credentials.apiKey;
      form.accessToken = credentials.accessToken;
    }
  } catch (error) {
    if (!currentController.signal.aborted && credentialsController === currentController) credentialsLoadError.value = errorMessage(error);
  } finally {
    if (credentialsController === currentController) {
      credentialsController = undefined;
      credentialsLoading.value = false;
    }
  }
}

function cancelCredentialsLoad(): void {
  credentialsController?.abort();
  credentialsController = undefined;
  credentialsLoading.value = false;
}

async function save(): Promise<Relay | undefined> {
  if (!props.relay) return undefined;
  try { await formRef.value?.validate(); } catch { return undefined; }
  saving.value = true;
  try {
    const balanceConfig = { ...form };
    if (!balanceConfig.apiKey?.trim()) delete balanceConfig.apiKey;
    if (!balanceConfig.accessToken?.trim()) delete balanceConfig.accessToken;
    const relay = await store.update(props.relay.id, { balanceConfig });
    apiKeyConfigured.value ||= Boolean(balanceConfig.apiKey);
    accessTokenConfigured.value ||= Boolean(balanceConfig.accessToken);
    emit('saved', relay);
    return relay;
  } catch (error) {
    message.error(errorMessage(error));
    return undefined;
  } finally { saving.value = false; }
}

async function saveAndClose(): Promise<void> {
  const relay = await save();
  if (!relay) return;
  if (relay.balanceConfig?.enabled) {
    querying.value = true;
    try {
      const updated = await store.queryBalance(relay.id);
      emit('saved', updated);
    } catch {
      // The saved configuration remains valid when its initial balance query fails.
    } finally {
      querying.value = false;
    }
  }
  message.success('余额查询配置已保存');
  emit('close');
}

async function saveAndQuery(): Promise<void> {
  const relay = await save();
  if (!relay) return;
  if (!relay.balanceConfig?.enabled) { message.warning('请启用余额查询后再执行查询'); return; }
  querying.value = true;
  try {
    const updated = await store.queryBalance(relay.id);
    emit('saved', updated);
    if (updated.balance?.success) showBalanceSuccess(updated);
    else message.warning(updated.balance?.errorMessage || '余额查询失败');
  } catch (error) { message.error(errorMessage(error)); }
  finally { querying.value = false; }
}

function close(): void {
  if (saving.value || querying.value) return;
  cancelCredentialsLoad();
  emit('close');
}
</script>

<template>
  <a-drawer :open="open" :title="relay ? `余额查询 - ${relay.name}` : '余额查询配置'" :width="580" root-class-name="responsive-drawer" placement="right" :closable="!saving && !querying" :mask-closable="!saving && !querying" @close="close">
    <a-form ref="formRef" :model="form" :disabled="saving || querying" layout="vertical" required-mark="optional">
      <section class="balance-config-section">
        <div class="balance-section-heading"><div><h3>查询模板</h3><p>{{ templateDescription }}</p></div></div>
        <a-segmented v-model:value="form.template" block :options="[{ label: '通用模板', value: 'generic' }, { label: 'New API', value: 'newapi' }]" />
      </section>
      <section class="balance-config-section">
        <div class="balance-section-heading"><h3>凭证配置</h3><span>留空则使用当前中转站配置</span></div>
        <a-form-item label="请求地址" name="requestUrl" :rules="[{ type: 'url', message: '请输入有效的 http/https URL' }]">
          <a-input v-model:value="form.requestUrl" :maxlength="500" :placeholder="form.template === 'generic' ? '留空使用当前 Base URL' : '例如：https://api.newapi.com'" />
        </a-form-item>
        <template v-if="form.template === 'generic'">
          <a-form-item label="余额 API Key" name="apiKey" :extra="credentialsLoadError || (apiKeyConfigured ? (credentialsLoading ? '正在读取已保存的余额 API Key...' : '已回显保存的余额 API Key，可直接修改。') : '留空使用当前中转站 API Key。')">
            <a-input v-model:value="form.apiKey" :disabled="credentialsLoading" :maxlength="500" autocomplete="off" placeholder="可选：用于余额查询的独立 API Key" />
          </a-form-item>
        </template>
        <template v-else>
          <a-form-item label="访问令牌" name="accessToken" :rules="[{ required: !accessTokenConfigured, message: '请输入 New API 访问令牌' }]" :extra="credentialsLoadError || (accessTokenConfigured ? (credentialsLoading ? '正在读取已保存的访问令牌...' : '已回显保存的访问令牌，可直接修改。') : '在 New API 的个人安全设置中生成。')">
            <a-input v-model:value="form.accessToken" :disabled="credentialsLoading" :maxlength="500" autocomplete="off" placeholder="Bearer Token" />
          </a-form-item>
          <a-form-item label="用户 ID" name="userId" :rules="[{ required: true, message: '请输入 New API 用户 ID' }]"><a-input v-model:value="form.userId" :maxlength="160" placeholder="例如：114514" /></a-form-item>
        </template>
      </section>
      <section class="balance-config-section">
        <div class="balance-section-heading"><h3>自动查询</h3><span>保存后会立即查询一次</span></div>
        <a-row :gutter="16">
          <a-col :span="12"><a-form-item label="超时时间"><a-input-number v-model:value="form.timeout" :min="1000" :max="120000" :step="1000" style="width: 100%" addon-after="ms" /></a-form-item></a-col>
          <a-col :span="12"><a-form-item label="查询间隔"><a-input-number v-model:value="form.intervalMinutes" :min="0" :max="1440" style="width: 100%" addon-after="分钟" /></a-form-item></a-col>
        </a-row>
        <a-form-item label="余额查询"><a-switch v-model:checked="form.enabled" checked-children="启用" un-checked-children="停用" /><span class="balance-switch-note">0 分钟表示仅保存后和手动查询</span></a-form-item>
      </section>
      <section class="balance-config-section balance-request-preview">
        <div class="balance-section-heading"><h3>模板请求规则</h3><span>自动提取余额、已用额度和单位</span></div><pre>{{ requestExample }}</pre>
      </section>
    </a-form>
    <template #footer><div class="balance-drawer-footer"><a-button :disabled="saving || querying" @click="close">取消</a-button><a-space><a-button :loading="querying" :disabled="saving" @click="saveAndQuery"><template #icon><ReloadOutlined /></template>立即查询</a-button><a-button type="primary" :loading="saving" :disabled="querying" @click="saveAndClose"><template #icon><SaveOutlined /></template>保存配置</a-button></a-space></div></template>
  </a-drawer>
</template>
