<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue';
import {
  Bot,
  Copy,
  MessageSquare,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Square,
  Trash2,
  UserRound
} from '@lucide/vue';
import { errorMessage } from '../api/http';
import { streamPlaygroundReply } from '../api/playground';
import { discoverRelayModels } from '../api/relays';
import PlaygroundSettingsPanel from '../components/PlaygroundSettingsPanel.vue';
import { useRelayStore } from '../stores/relays';
import type { PlaygroundCompletion, PlaygroundMessage } from '../types';
import { DEFAULT_PLAYGROUND_MODEL, isPlaygroundRelayAvailable, preferredDetectedModel } from '../utils/playground';

type ConversationStatus = 'complete' | 'streaming' | 'stopped' | 'error';

interface ConversationMessage extends PlaygroundMessage {
  id: string;
  status: ConversationStatus;
  completion?: PlaygroundCompletion;
  error?: string;
}

const relayStore = useRelayStore();
const selectedRelayId = ref('');
const model = ref(DEFAULT_PLAYGROUND_MODEL);
const modelOptions = ref<string[]>([]);
const modelsLoading = ref(false);
const modelError = ref('');
const systemPrompt = ref('');
const temperature = ref(1);
const topP = ref(1);
const maxTokens = ref(4096);
const prompt = ref('');
const composerVersion = ref(0);
const messages = ref<ConversationMessage[]>([]);
const generating = ref(false);
const settingsOpen = ref(false);
const loadError = ref('');
const conversationRef = ref<HTMLElement>();
let modelController: AbortController | undefined;
let generationController: AbortController | undefined;

const availableRelays = computed(() => relayStore.relays.filter(isPlaygroundRelayAvailable));
const selectedRelay = computed(() => availableRelays.value.find((relay) => relay.id === selectedRelayId.value));
const canSend = computed(() => Boolean(
  selectedRelay.value
  && model.value.trim()
  && prompt.value.trim()
  && !modelsLoading.value
  && !generating.value
));
const activeProtocol = computed(() => {
  const relay = selectedRelay.value;
  if (!relay) return '';
  if (relay.platform === 'anthropic') return 'Anthropic Messages';
  if (relay.protocol === 'responses') return 'Responses';
  if (relay.protocol === 'chat') return 'Chat Completions';
  return '自动协议';
});

function normalizeModels(values: string[], fallback = ''): string[] {
  return [...new Set([...values, fallback].map((value) => value.trim()).filter(Boolean))];
}

function createMessage(role: 'user' | 'assistant', content: string, status: ConversationStatus): ConversationMessage {
  return reactive({ id: crypto.randomUUID(), role, content, status });
}

function protocolLabel(completion: PlaygroundCompletion): string {
  if (completion.protocol === 'anthropic') return 'Anthropic';
  return completion.protocol === 'responses' ? 'Responses' : 'Chat';
}

function usageLabel(completion: PlaygroundCompletion): string {
  const total = completion.usage.totalTokens;
  return total === null ? 'Token 未返回' : `${total} Token`;
}

function scrollToBottom(): void {
  void nextTick(() => {
    const element = conversationRef.value;
    if (element) element.scrollTop = element.scrollHeight;
  });
}

async function loadModels(relayId = selectedRelayId.value): Promise<void> {
  modelController?.abort();
  const relay = availableRelays.value.find((item) => item.id === relayId);
  if (!relay) {
    modelOptions.value = [];
    model.value = '';
    return;
  }
  model.value = DEFAULT_PLAYGROUND_MODEL;
  modelOptions.value = normalizeModels([DEFAULT_PLAYGROUND_MODEL], relay.model);
  modelError.value = '';
  const controller = new AbortController();
  modelController = controller;
  modelsLoading.value = true;
  try {
    const detected = await discoverRelayModels(relay.id, controller.signal);
    if (modelController !== controller) return;
    modelOptions.value = normalizeModels(detected, relay.model);
    model.value = preferredDetectedModel(modelOptions.value, relay.model);
  } catch (error) {
    if (controller.signal.aborted) return;
    modelError.value = errorMessage(error);
    modelOptions.value = normalizeModels([], relay.model);
    model.value = preferredDetectedModel(modelOptions.value, relay.model);
  } finally {
    if (modelController === controller) {
      modelController = undefined;
      modelsLoading.value = false;
    }
  }
}

function requestHistory(history: ConversationMessage[]): PlaygroundMessage[] {
  return history
    .filter((item) => item.content.trim() && item.status !== 'error')
    .map(({ role, content }) => ({ role, content }));
}

async function generateReply(content: string, history = messages.value): Promise<void> {
  const relay = selectedRelay.value;
  const selectedModel = model.value.trim();
  if (!relay || !selectedModel || generating.value) return;
  const userMessage = createMessage('user', content, 'complete');
  const assistantMessage = createMessage('assistant', '', 'streaming');
  const upstreamMessages = [...requestHistory(history), { role: 'user' as const, content }];
  messages.value = [...history, userMessage, assistantMessage];
  generating.value = true;
  settingsOpen.value = false;
  scrollToBottom();
  const controller = new AbortController();
  generationController = controller;
  try {
    assistantMessage.completion = await streamPlaygroundReply(relay.id, {
      model: selectedModel,
      messages: upstreamMessages,
      systemPrompt: systemPrompt.value.trim(),
      temperature: temperature.value,
      topP: topP.value,
      maxTokens: maxTokens.value
    }, (delta) => {
      assistantMessage.content += delta;
      scrollToBottom();
    }, controller.signal);
    assistantMessage.status = 'complete';
  } catch (error) {
    if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      assistantMessage.status = 'stopped';
      assistantMessage.error = assistantMessage.content ? undefined : '已停止生成';
    } else {
      assistantMessage.status = 'error';
      assistantMessage.error = errorMessage(error);
    }
  } finally {
    if (generationController === controller) generationController = undefined;
    generating.value = false;
    scrollToBottom();
  }
}

function sendPrompt(): void {
  const content = prompt.value.trim();
  if (!content || !canSend.value) return;
  prompt.value = '';
  composerVersion.value += 1;
  void generateReply(content);
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendPrompt();
}

function stopGeneration(): void {
  generationController?.abort();
}

function regenerate(messageId: string): void {
  if (generating.value) return;
  const assistantIndex = messages.value.findIndex((item) => item.id === messageId && item.role === 'assistant');
  if (assistantIndex < 1) return;
  let userIndex = assistantIndex - 1;
  while (userIndex >= 0 && messages.value[userIndex]?.role !== 'user') userIndex -= 1;
  const userMessage = messages.value[userIndex];
  if (!userMessage) return;
  const history = messages.value.slice(0, userIndex);
  void generateReply(userMessage.content, history);
}

async function copyContent(content: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(content);
    message.success('消息已复制');
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限');
  }
}

function clearConversation(): void {
  if (!messages.value.length || generating.value) return;
  Modal.confirm({
    title: '清空当前对话？',
    content: '当前页面中的消息将被移除。',
    okText: '清空',
    okType: 'danger',
    cancelText: '取消',
    onOk: () => {
      messages.value = [];
    }
  });
}

async function loadRelays(): Promise<void> {
  loadError.value = '';
  try {
    await relayStore.fetchRelays();
  } catch (error) {
    loadError.value = errorMessage(error);
  }
}

watch(
  availableRelays,
  (relays) => {
    if (!relays.some((relay) => relay.id === selectedRelayId.value)) selectedRelayId.value = relays[0]?.id ?? '';
  },
  { immediate: true }
);

watch(
  selectedRelayId,
  (relayId) => {
    if (relayId) void loadModels(relayId);
    else {
      model.value = '';
      modelOptions.value = [];
    }
  },
  { immediate: true }
);

onMounted(() => {
  if (!relayStore.loaded && !relayStore.loading) void loadRelays();
});

onBeforeUnmount(() => {
  modelController?.abort();
  generationController?.abort();
});
</script>

<template>
  <main class="playground-page" aria-labelledby="playground-title">
    <header class="playground-header">
      <div class="playground-title">
        <span class="playground-title-icon"><MessageSquare :size="18" aria-hidden="true" /></span>
        <div>
          <h1 id="playground-title">游乐场</h1>
          <div class="playground-context">
            <span>{{ selectedRelay?.name || '未选择中转站' }}</span>
            <i />
            <span>{{ model || '未选择模型' }}</span>
            <a-tag v-if="activeProtocol" color="default">{{ activeProtocol }}</a-tag>
          </div>
        </div>
      </div>
      <div class="playground-header-actions">
        <a-tooltip title="运行设置">
          <a-button class="playground-mobile-settings" aria-label="运行设置" @click="settingsOpen = true">
            <template #icon><SlidersHorizontal :size="16" aria-hidden="true" /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="清空对话">
          <a-button :disabled="!messages.length || generating" aria-label="清空对话" @click="clearConversation">
            <template #icon><Trash2 :size="16" aria-hidden="true" /></template>
          </a-button>
        </a-tooltip>
      </div>
    </header>

    <a-alert v-if="loadError" type="error" show-icon :message="loadError">
      <template #action><a-button size="small" @click="loadRelays">重试</a-button></template>
    </a-alert>

    <div class="playground-workspace">
      <section class="playground-chat" aria-label="对话区">
        <div ref="conversationRef" class="playground-conversation" aria-live="polite">
          <div v-if="!messages.length" class="playground-empty">
            <span><Bot :size="27" aria-hidden="true" /></span>
            <strong>开始新对话</strong>
            <small>{{ availableRelays.length ? `${availableRelays.length} 个可用中转站` : '暂无可用中转站' }}</small>
          </div>

          <article
            v-for="item in messages"
            :key="item.id"
            class="playground-message"
            :class="[`is-${item.role}`, `is-${item.status}`]"
          >
            <span class="playground-avatar">
              <UserRound v-if="item.role === 'user'" :size="17" aria-hidden="true" />
              <Bot v-else :size="18" aria-hidden="true" />
            </span>
            <div class="playground-message-main">
              <div class="playground-message-heading">
                <strong>{{ item.role === 'user' ? '你' : '模型' }}</strong>
                <div v-if="item.content" class="playground-message-actions">
                  <a-tooltip title="复制消息">
                    <button type="button" aria-label="复制消息" @click="copyContent(item.content)">
                      <Copy :size="14" aria-hidden="true" />
                    </button>
                  </a-tooltip>
                  <a-tooltip v-if="item.role === 'assistant' && item.status !== 'streaming'" title="重新生成">
                    <button type="button" aria-label="重新生成" :disabled="generating" @click="regenerate(item.id)">
                      <RotateCcw :size="14" aria-hidden="true" />
                    </button>
                  </a-tooltip>
                </div>
              </div>
              <div v-if="item.content" class="playground-message-content">{{ item.content }}</div>
              <div v-if="item.status === 'streaming' && !item.content" class="playground-typing"><i /><i /><i /></div>
              <div v-if="item.error" class="playground-message-error">{{ item.error }}</div>
              <div v-if="item.completion" class="playground-message-meta">
                <span>{{ item.completion.relayName }}</span>
                <span>{{ item.completion.reportedModel || item.completion.requestedModel }}</span>
                <span>{{ protocolLabel(item.completion) }}</span>
                <span>{{ usageLabel(item.completion) }}</span>
                <span>{{ (item.completion.durationMs / 1000).toFixed(1) }}s</span>
              </div>
              <div v-else-if="item.status === 'stopped' && item.content" class="playground-message-meta"><span>已停止</span></div>
            </div>
          </article>
        </div>

        <div class="playground-composer">
          <a-textarea
            :key="composerVersion"
            v-model:value="prompt"
            :disabled="generating || !selectedRelay"
            :auto-size="{ minRows: 2, maxRows: 6 }"
            :maxlength="20000"
            placeholder="发送消息"
            @keydown="onComposerKeydown"
          />
          <div class="playground-composer-footer">
            <span>{{ prompt.length.toLocaleString() }} / 20,000</span>
            <a-button v-if="generating" danger aria-label="停止生成" @click="stopGeneration">
              <template #icon><Square :size="13" fill="currentColor" aria-hidden="true" /></template>
              停止
            </a-button>
            <a-button v-else class="playground-send-button" type="primary" :disabled="!canSend" aria-label="发送消息" @click="sendPrompt">
              <template #icon><Send :size="15" aria-hidden="true" /></template>
              发送
            </a-button>
          </div>
        </div>
      </section>

      <aside class="playground-settings-column">
        <PlaygroundSettingsPanel
          v-model:relay-id="selectedRelayId"
          v-model:model="model"
          v-model:system-prompt="systemPrompt"
          v-model:temperature="temperature"
          v-model:top-p="topP"
          v-model:max-tokens="maxTokens"
          :relays="availableRelays"
          :model-options="modelOptions"
          :models-loading="modelsLoading"
          :model-error="modelError"
          :disabled="generating"
          @refresh-models="loadModels()"
        />
      </aside>
    </div>

    <a-drawer v-model:open="settingsOpen" class="playground-settings-drawer" title="运行设置" placement="right" :width="360">
      <PlaygroundSettingsPanel
        v-model:relay-id="selectedRelayId"
        v-model:model="model"
        v-model:system-prompt="systemPrompt"
        v-model:temperature="temperature"
        v-model:top-p="topP"
        v-model:max-tokens="maxTokens"
        :relays="availableRelays"
        :model-options="modelOptions"
        :models-loading="modelsLoading"
        :model-error="modelError"
        :disabled="generating"
        @refresh-models="loadModels()"
      />
    </a-drawer>
  </main>
</template>

<style scoped>
.playground-page { display: flex; width: min(1480px, calc(100% - 40px)); height: 100%; min-height: 0; margin: 0 auto; padding: 18px 0 20px; flex-direction: column; gap: 12px; }
.playground-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 18px; }
.playground-title { display: flex; min-width: 0; align-items: center; gap: 11px; }
.playground-title-icon { display: grid; width: 34px; height: 34px; flex: 0 0 34px; place-items: center; border-radius: 7px; background: var(--accent-soft); color: var(--accent); }
.playground-title > div { min-width: 0; }
.playground-title h1 { margin: 0; font-size: 20px; line-height: 26px; }
.playground-context { display: flex; min-width: 0; align-items: center; gap: 7px; color: var(--muted); font-size: 11px; }
.playground-context > span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.playground-context i { width: 3px; height: 3px; flex: 0 0 3px; border-radius: 50%; background: var(--muted); }
.playground-context :deep(.ant-tag) { margin-inline: 2px 0; font-size: 10px; line-height: 18px; }
.playground-header-actions { display: flex; align-items: center; gap: 8px; }
.playground-header-actions :deep(.ant-btn-icon) { display: inline-flex; }
.playground-mobile-settings { display: none; }
.playground-workspace { display: grid; min-height: 0; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) 290px; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
.playground-chat { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
.playground-conversation { min-height: 0; flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.playground-empty { display: flex; min-height: 100%; align-items: center; justify-content: center; flex-direction: column; color: var(--muted); }
.playground-empty > span { display: grid; width: 54px; height: 54px; margin-bottom: 12px; place-items: center; border: 1px solid var(--border); border-radius: 50%; background: var(--surface-subtle); color: var(--accent); }
.playground-empty strong { color: var(--text); font-size: 15px; }
.playground-empty small { margin-top: 4px; font-size: 11px; }
.playground-message { display: flex; align-items: flex-start; gap: 12px; padding: 16px clamp(18px, 4vw, 54px); }
.playground-message.is-assistant { justify-content: flex-start; flex-direction: row-reverse; }
.playground-avatar { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); color: var(--muted); }
.playground-message.is-assistant .playground-avatar { border-color: color-mix(in srgb, var(--accent) 32%, var(--border)); background: var(--accent-soft); color: var(--accent); }
.playground-message-main { width: fit-content; min-width: 0; max-width: min(78%, 760px); padding: 9px 12px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--surface-subtle); }
.playground-message.is-assistant .playground-message-main { border-color: color-mix(in srgb, var(--accent) 28%, var(--border)); background: var(--accent-soft); }
.playground-message-heading { display: flex; min-height: 24px; align-items: flex-start; justify-content: space-between; gap: 12px; }
.playground-message-heading strong { font-size: 12px; line-height: 22px; }
.playground-message-actions { display: flex; flex: 0 0 auto; gap: 2px; opacity: 0; transition: opacity .15s ease; }
.playground-message:hover .playground-message-actions, .playground-message:focus-within .playground-message-actions { opacity: 1; }
.playground-message-actions button { display: grid; width: 26px; height: 26px; padding: 0; place-items: center; border: 0; border-radius: 4px; background: transparent; color: var(--muted); cursor: pointer; }
.playground-message-actions button:hover, .playground-message-actions button:focus-visible { background: var(--accent-soft); color: var(--accent); outline: none; }
.playground-message-actions button:disabled { opacity: .4; cursor: not-allowed; }
.playground-message-content { padding-top: 2px; color: var(--text); font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.playground-message-error { margin-top: 8px; color: #c95757; font-size: 12px; overflow-wrap: anywhere; }
.playground-message-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 10px; color: var(--muted); font-size: 10px; }
.playground-message.is-assistant .playground-message-meta { justify-content: flex-end; }
.playground-message-meta span { min-width: 0; overflow-wrap: anywhere; }
.playground-typing { display: flex; align-items: center; gap: 4px; height: 24px; }
.playground-typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); animation: playground-pulse 1.1s infinite ease-in-out; }
.playground-typing i:nth-child(2) { animation-delay: .15s; }
.playground-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes playground-pulse { 0%, 70%, 100% { opacity: .25; transform: translateY(0); } 35% { opacity: 1; transform: translateY(-2px); } }
.playground-composer { flex: 0 0 auto; padding: 12px 14px; border-top: 1px solid var(--border); background: var(--surface); }
.playground-composer :deep(textarea.ant-input) { min-height: 58px !important; resize: none; border: 0; box-shadow: none; background: transparent; }
.playground-composer-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 8px; }
.playground-composer-footer > span { color: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.playground-composer-footer :deep(.ant-btn-icon) { display: inline-flex; }
.playground-send-button :deep(svg) { transform: translateY(2px); }
.playground-settings-column { min-height: 0; padding: 18px; overflow-y: auto; border-left: 1px solid var(--border); background: var(--surface-subtle); }

@media (max-width: 900px) {
  .playground-page { width: min(100% - 28px, 1480px); padding-top: 14px; }
  .playground-workspace { grid-template-columns: minmax(0, 1fr); }
  .playground-settings-column { display: none; }
  .playground-mobile-settings { display: inline-flex; }
  .playground-message-actions { opacity: 1; }
}

@media (max-width: 560px) {
  .playground-page { width: 100%; padding: 10px 10px 12px; gap: 9px; }
  .playground-title-icon { width: 30px; height: 30px; flex-basis: 30px; }
  .playground-title h1 { font-size: 17px; line-height: 22px; }
  .playground-context > span { max-width: 105px; }
  .playground-context :deep(.ant-tag) { display: none; }
  .playground-workspace { border-radius: 6px; }
  .playground-message { gap: 9px; padding: 12px; }
  .playground-avatar { width: 28px; height: 28px; }
  .playground-message-main { max-width: calc(100% - 37px); padding: 8px 10px 9px; }
  .playground-message-content { font-size: 13px; line-height: 1.7; }
  .playground-composer { padding: 10px; }
}
</style>
