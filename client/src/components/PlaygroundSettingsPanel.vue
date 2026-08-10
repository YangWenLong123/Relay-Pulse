<script setup lang="ts">
import { RefreshCw } from '@lucide/vue';
import type { Relay } from '../types';

const props = defineProps<{
  relays: Relay[];
  relayId: string;
  model: string;
  modelOptions: string[];
  modelsLoading: boolean;
  modelError: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  disabled: boolean;
}>();

const emit = defineEmits<{
  'update:relayId': [value: string];
  'update:model': [value: string];
  'update:systemPrompt': [value: string];
  'update:temperature': [value: number];
  'update:topP': [value: number];
  'update:maxTokens': [value: number];
  refreshModels: [];
}>();

function relayLabel(relay: Relay): string {
  return `${relay.name} · ${relay.platform === 'anthropic' ? 'Anthropic' : 'OpenAI'}`;
}

function updateNumber(event: 'update:temperature' | 'update:topP' | 'update:maxTokens', value: number | null): void {
  if (value === null) return;
  if (event === 'update:temperature') emit(event, value);
  else if (event === 'update:topP') emit(event, value);
  else emit(event, value);
}
</script>

<template>
  <section class="playground-settings" aria-labelledby="playground-settings-heading">
    <div class="playground-settings-heading">
      <div>
        <span>配置</span>
        <h2 id="playground-settings-heading">运行设置</h2>
      </div>
      <a-tag v-if="props.relayId" color="default">
        {{ props.relays.find((relay) => relay.id === props.relayId)?.protocol === 'auto' ? '自动协议' : props.relays.find((relay) => relay.id === props.relayId)?.protocol }}
      </a-tag>
    </div>

    <label class="playground-setting-field">
      <span>中转站</span>
      <a-select
        :value="props.relayId"
        :disabled="props.disabled"
        show-search
        option-filter-prop="label"
        placeholder="选择中转站"
        :options="props.relays.map((relay) => ({ value: relay.id, label: relayLabel(relay) }))"
        @update:value="emit('update:relayId', $event)"
      />
    </label>

    <label class="playground-setting-field">
      <span>模型</span>
      <a-space-compact block>
        <a-select
          :value="props.model"
          :disabled="props.disabled || !props.relayId"
          :loading="props.modelsLoading"
          show-search
          placeholder="选择模型"
          :options="props.modelOptions.map((value) => ({ value, label: value }))"
          @update:value="emit('update:model', $event)"
        />
        <a-tooltip title="重新探测模型">
          <a-button
            class="playground-model-refresh"
            :disabled="props.disabled || !props.relayId"
            :loading="props.modelsLoading"
            aria-label="重新探测模型"
            @click="emit('refreshModels')"
          >
            <template #icon><RefreshCw v-if="!props.modelsLoading" :size="15" aria-hidden="true" /></template>
          </a-button>
        </a-tooltip>
      </a-space-compact>
      <small v-if="props.modelError" class="playground-setting-error">{{ props.modelError }}</small>
    </label>

    <label class="playground-setting-field">
      <span>系统提示词</span>
      <a-textarea
        :value="props.systemPrompt"
        :disabled="props.disabled"
        :rows="5"
        :maxlength="20000"
        placeholder="可选"
        @update:value="emit('update:systemPrompt', $event)"
      />
    </label>

    <div class="playground-parameter-grid">
      <label class="playground-setting-field">
        <span>Temperature</span>
        <a-input-number
          :value="props.temperature"
          :disabled="props.disabled"
          :min="0"
          :max="2"
          :step="0.1"
          @update:value="updateNumber('update:temperature', $event)"
        />
      </label>
      <label class="playground-setting-field">
        <span>Top P</span>
        <a-input-number
          :value="props.topP"
          :disabled="props.disabled"
          :min="0"
          :max="1"
          :step="0.05"
          @update:value="updateNumber('update:topP', $event)"
        />
      </label>
      <label class="playground-setting-field playground-max-token-field">
        <span>最大输出 Token</span>
        <a-input-number
          :value="props.maxTokens"
          :disabled="props.disabled"
          :min="1"
          :max="32768"
          :step="256"
          @update:value="updateNumber('update:maxTokens', $event)"
        />
      </label>
    </div>
  </section>
</template>

<style scoped>
.playground-settings { display: flex; min-height: 0; flex-direction: column; gap: 18px; }
.playground-settings-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
.playground-settings-heading > div { min-width: 0; }
.playground-settings-heading span { display: block; margin-bottom: 2px; color: var(--muted); font-size: 10px; line-height: 16px; text-transform: uppercase; }
.playground-settings-heading h2 { margin: 0; font-size: 15px; line-height: 22px; }
.playground-settings-heading :deep(.ant-tag) { max-width: 110px; margin-inline-end: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.playground-setting-field { display: grid; min-width: 0; gap: 6px; }
.playground-setting-field > span { color: var(--muted); font-size: 12px; }
.playground-setting-field :deep(.ant-select),
.playground-setting-field :deep(.ant-input-number),
.playground-setting-field :deep(.ant-input) { width: 100%; }
.playground-model-refresh { width: 36px; }
.playground-model-refresh :deep(.ant-btn-icon) { display: inline-flex; }
.playground-setting-error { color: #c95757; font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.playground-parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 10px; }
.playground-max-token-field { grid-column: 1 / -1; }
</style>
