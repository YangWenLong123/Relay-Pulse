<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  BgColorsOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  PictureOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined
} from '@ant-design/icons-vue';
import { generateImage } from '../api/images';
import { errorMessage } from '../api/http';
import { discoverDraftModels, discoverRelayModels } from '../api/relays';
import { useRelayStore } from '../stores/relays';
import { DEFAULT_DRAWING_MODEL, preferredDrawingModel } from '../utils/drawing';
import type {
  ImageAspectRatio,
  ImageGenerationResult,
  ImageGenerationResultImage,
  ImageGenerationSource,
  ImageOutputFormat,
  ImageReferenceInput,
  ImageSize,
  Relay
} from '../types';

interface AspectOption {
  value: ImageAspectRatio;
  label: string;
  hint: string;
  defaultSize: ImageSize;
}

interface ReferencePreview {
  dataUrl: string;
  name: string;
  mimeType: string;
  size: number;
}

const relayStore = useRelayStore();
const source = ref<ImageGenerationSource>('saved');
const selectedRelayId = ref('');
const customBaseUrl = ref('');
const customApiKey = ref('');
const model = ref(DEFAULT_DRAWING_MODEL);
const modelOptions = ref<string[]>([]);
const modelsLoading = ref(false);
const modelLoadError = ref('');
const aspectRatio = ref<ImageAspectRatio>('1:1');
const size = ref<ImageSize>('1024x1024');
const count = ref(1);
const outputFormat = ref<ImageOutputFormat>('jpg');
const prompt = ref('');
const reference = ref<ReferencePreview>();
const result = ref<ImageGenerationResult>();
const runError = ref('');
const generating = ref(false);
const referenceInput = ref<HTMLInputElement>();
let modelController: AbortController | undefined;
let generateController: AbortController | undefined;

const aspectOptions: AspectOption[] = [
  { value: '1:1', label: '正方形', hint: '头像 / 商品 / 通用', defaultSize: '1024x1024' },
  { value: '16:9', label: '横向宽屏', hint: '封面 / Banner', defaultSize: '1792x1024' },
  { value: '9:16', label: '竖向海报', hint: '手机壁纸 / 海报', defaultSize: '1024x1792' },
  { value: '4:3', label: '横向标准', hint: '插画 / 场景图', defaultSize: '1536x1024' },
  { value: '3:4', label: '竖向标准', hint: '角色 / 产品图', defaultSize: '1024x1536' }
];

const sizeOptions: Array<{ label: string; value: ImageSize; ratio: ImageAspectRatio }> = [
  { label: '1024 x 1024', value: '1024x1024', ratio: '1:1' },
  { label: '1792 x 1024', value: '1792x1024', ratio: '16:9' },
  { label: '1024 x 1792', value: '1024x1792', ratio: '9:16' },
  { label: '1536 x 1024', value: '1536x1024', ratio: '4:3' },
  { label: '1024 x 1536', value: '1024x1536', ratio: '3:4' }
];

const sourceOptions: Array<{ label: string; value: ImageGenerationSource }> = [
  { label: '已保存中转站', value: 'saved' },
  { label: '自定义端点', value: 'custom' }
];

const formatOptions: Array<{ label: string; value: ImageOutputFormat }> = [
  { label: 'JPG', value: 'jpg' },
  { label: 'PNG', value: 'png' },
  { label: 'WebP', value: 'webp' }
];

const selectedRelay = computed(() => relayStore.relays.find((relay) => relay.id === selectedRelayId.value));
const drawingRelays = computed(() => relayStore.relays.filter((relay) => relay.enabled && relay.platform === 'openai'));
const selectedAspect = computed(() => aspectOptions.find((option) => option.value === aspectRatio.value) ?? aspectOptions[0]);
const customBaseUrlValid = computed(() => isHttpUrl(customBaseUrl.value));
const customBaseUrlSafe = computed(() => customBaseUrlValid.value && isCredentialSafeUrl(customBaseUrl.value));
const customEndpointReady = computed(() => Boolean(customBaseUrlSafe.value && customApiKey.value.trim()));
const modelSelectOptions = computed(() => {
  const fallback = source.value === 'saved' ? selectedRelay.value?.model : '';
  return normalizeModels(modelOptions.value, fallback).map((value) => ({ value }));
});
const sourceHint = computed(() => source.value === 'saved'
  ? (selectedRelay.value ? '已选择 ' + selectedRelay.value.name : '请选择中转站')
  : (customBaseUrl.value.trim() ? '使用自定义端点' : '请输入自定义端点')
);
const referenceInputValue = computed<ImageReferenceInput | null>(() => reference.value
  ? { dataUrl: reference.value.dataUrl, name: reference.value.name, mimeType: reference.value.mimeType }
  : null
);
const finalPromptPreview = computed(() => [
  '画幅比例：' + selectedAspect.value.label + ' ' + aspectRatio.value + '。',
  '输出尺寸：' + size.value + '。',
  reference.value ? '参考图要求：保留参考图的主体、构图、配色或风格特征，并以文字描述作为最终创作方向。' : '',
  '描述内容：' + (prompt.value.trim() || '（等待输入）')
].filter(Boolean).join('\n'));
const canGenerate = computed(() => {
  const hasEndpoint = source.value === 'saved'
    ? Boolean(selectedRelay.value)
    : customEndpointReady.value;
  const hasDetectedCustomModel = source.value !== 'custom' || modelSelectOptions.value.some((option) => option.value === model.value);
  return Boolean(hasEndpoint && hasDetectedCustomModel && model.value.trim() && prompt.value.trim()) && !modelsLoading.value && !generating.value;
});
const resultImages = computed(() => {
  if (!result.value) return [];
  return result.value.images?.length ? result.value.images : [result.value.image].filter(Boolean);
});
const primaryImageDescription = computed(() => imageDescription(resultImages.value[0]) || result.value?.revisedPrompt?.trim() || '');

function normalizeModels(models: string[], fallback = ''): string[] {
  return [...new Set([...models, fallback].map((item) => item.trim()).filter(Boolean))];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value);
}

function isCredentialSafeUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function relayLabel(relay: Relay): string {
  return relay.name + ' · ' + relay.model;
}

function filterRelayOption(input: string, option?: { label?: unknown }): boolean {
  return String(option?.label ?? '').toLowerCase().includes(input.toLowerCase());
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(value / 1024)) + ' KB';
}

function imageSrc(image: ImageGenerationResultImage): string {
  return image.dataUrl || image.url || '';
}

function imageDescription(image?: ImageGenerationResultImage): string {
  return image?.revisedPrompt?.trim() || '';
}

function extensionFromMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return outputFormat.value;
}

function normalizedCount(): number {
  return Math.min(4, Math.max(1, Math.trunc(Number(count.value) || 1)));
}

function setAspect(value: ImageAspectRatio): void {
  aspectRatio.value = value;
  const option = aspectOptions.find((item) => item.value === value);
  if (option) size.value = option.defaultSize;
}

async function loadModels(relay: Relay): Promise<void> {
  modelController?.abort();
  const controller = new AbortController();
  modelController = controller;
  modelsLoading.value = true;
  modelLoadError.value = '';
  try {
    const detected = await discoverRelayModels(relay.id, controller.signal);
    if (modelController !== controller || source.value !== 'saved' || selectedRelayId.value !== relay.id) return;
    modelOptions.value = normalizeModels(detected, relay.model);
    model.value = preferredDrawingModel(modelOptions.value, relay.model);
  } catch (error) {
    if (!controller.signal.aborted) modelLoadError.value = errorMessage(error);
  } finally {
    if (modelController === controller) {
      modelController = undefined;
      modelsLoading.value = false;
    }
  }
}

async function loadCustomModels(): Promise<void> {
  const baseUrl = customBaseUrl.value.trim();
  const apiKey = customApiKey.value.trim();

  modelController?.abort();
  modelController = undefined;
  modelsLoading.value = false;
  modelOptions.value = [];
  model.value = '';
  modelLoadError.value = '';

  if (!isHttpUrl(baseUrl)) {
    modelLoadError.value = '请输入有效的 http/https Base URL。';
    return;
  }
  if (!isCredentialSafeUrl(baseUrl)) {
    modelLoadError.value = '公网 HTTP 会明文传输 API Key，请使用 HTTPS；本机回环地址可使用 HTTP。';
    return;
  }
  if (!apiKey) {
    modelLoadError.value = '请先填写 API Key。';
    return;
  }

  const controller = new AbortController();
  modelController = controller;
  modelsLoading.value = true;
  try {
    const detected = await discoverDraftModels({ baseUrl, apiKey, platform: 'openai', timeout: 30_000 }, controller.signal);
    if (
      controller.signal.aborted ||
      source.value !== 'custom' ||
      customBaseUrl.value.trim() !== baseUrl ||
      customApiKey.value.trim() !== apiKey
    ) {
      return;
    }

    modelOptions.value = normalizeModels(detected);
    model.value = preferredDrawingModel(modelOptions.value);
    if (!modelOptions.value.length) modelLoadError.value = '未探测到可用模型，请检查端点和 API Key。';
  } catch (error) {
    if (!controller.signal.aborted) modelLoadError.value = errorMessage(error);
  } finally {
    if (modelController === controller) {
      modelController = undefined;
      modelsLoading.value = false;
    }
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('参考图读取失败'));
    reader.onerror = () => reject(new Error('参考图读取失败'));
    reader.readAsDataURL(file);
  });
}

async function onReferenceChange(event: Event): Promise<void> {
  if (generating.value) return;
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message.warning('参考图仅支持 PNG、JPG 或 WebP');
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    message.warning('参考图不能超过 8MB');
    return;
  }
  try {
    reference.value = { dataUrl: await readFileAsDataUrl(file), name: file.name, mimeType: file.type, size: file.size };
  } catch (error) {
    message.error(errorMessage(error));
  }
}

function clearReference(): void {
  if (generating.value) return;
  reference.value = undefined;
}

function openReferencePicker(): void {
  if (!generating.value) referenceInput.value?.click();
}

function generationStateKey(): string {
  return [
    source.value,
    selectedRelayId.value,
    customBaseUrl.value.trim(),
    customApiKey.value.trim(),
    model.value.trim(),
    prompt.value.trim(),
    aspectRatio.value,
    size.value,
    String(normalizedCount()),
    outputFormat.value,
    reference.value?.dataUrl ?? ''
  ].join('\u0000');
}

async function runGenerate(): Promise<void> {
  if (!canGenerate.value) return;
  generateController?.abort();
  const controller = new AbortController();
  generateController = controller;
  generating.value = true;
  runError.value = '';
  result.value = undefined;
  const requestStateKey = generationStateKey();
  try {
    const commonInput = {
      source: source.value,
      model: model.value.trim(),
      prompt: prompt.value.trim(),
      aspectRatio: aspectRatio.value,
      size: size.value,
      count: normalizedCount(),
      format: outputFormat.value,
      referenceImage: referenceInputValue.value
    };
    const generated = await generateImage({
      ...commonInput,
      ...(source.value === 'saved'
        ? { relayId: selectedRelay.value?.id }
        : { baseUrl: customBaseUrl.value.trim(), apiKey: customApiKey.value.trim() })
    }, controller.signal);
    if (controller.signal.aborted || generateController !== controller || generationStateKey() !== requestStateKey) return;
    result.value = generated;
    message.success('已生成 ' + generated.images.length + ' 张图片');
  } catch (error) {
    if (!controller.signal.aborted) runError.value = errorMessage(error);
  } finally {
    if (generateController === controller) {
      generateController = undefined;
      generating.value = false;
    }
  }
}

function cancelGenerate(): void {
  generateController?.abort();
  generating.value = false;
  message.info('已取消绘图请求');
}

function resetForm(): void {
  prompt.value = '';
  reference.value = undefined;
  result.value = undefined;
  runError.value = '';
}

function downloadImage(image: ImageGenerationResultImage): void {
  const src = imageSrc(image);
  if (!src) return;
  const link = document.createElement('a');
  link.href = src;
  link.download = 'relay-pulse-image-' + new Date().toISOString().slice(0, 10) + '-' + image.index + '.' + extensionFromMimeType(image.mimeType);
  document.body.append(link);
  link.click();
  link.remove();
}

async function copyPrompt(description: string): Promise<void> {
  const text = description.trim();
  if (!text.trim()) {
    message.warning('该图片暂无可复制的描述');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    message.success('图片描述已复制');
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限');
  }
}

watch(
  drawingRelays,
  (relays) => {
    if (!relays.some((relay) => relay.id === selectedRelayId.value)) selectedRelayId.value = relays[0]?.id ?? '';
  },
  { immediate: true }
);

watch(
  selectedRelayId,
  (relayId) => {
    if (source.value !== 'saved') return;
    const relay = drawingRelays.value.find((item) => item.id === relayId);
    modelOptions.value = relay ? [DEFAULT_DRAWING_MODEL] : [];
    modelLoadError.value = '';
    model.value = relay ? DEFAULT_DRAWING_MODEL : '';
    if (relay) void loadModels(relay);
  },
  { immediate: true }
);

watch(source, (value) => {
  modelController?.abort();
  modelController = undefined;
  modelsLoading.value = false;
  modelLoadError.value = '';
  if (value === 'saved') {
    const relay = selectedRelay.value;
    modelOptions.value = relay ? [DEFAULT_DRAWING_MODEL] : [];
    if (relay) {
      model.value = DEFAULT_DRAWING_MODEL;
      void loadModels(relay);
    } else {
      model.value = '';
    }
    return;
  }
  modelOptions.value = [];
  model.value = '';
});

watch([customBaseUrl, customApiKey], () => {
  if (source.value !== 'custom') return;
  modelController?.abort();
  modelController = undefined;
  modelsLoading.value = false;
  modelOptions.value = [];
  modelLoadError.value = '';
  model.value = '';
});

onMounted(() => {
  if (!relayStore.loaded) void relayStore.fetchRelays();
});

onBeforeUnmount(() => {
  modelController?.abort();
  generateController?.abort();
});
</script>

<template>
  <div class="page-view drawing-page-view">
    <main class="page-content drawing-page-content">
      <div class="page-heading drawing-heading">
        <div>
          <h1>绘图</h1>
          <p>选择中转站与绘图模型，输入描述或上传参考图生成图片。</p>
        </div>
        <a-space>
          <a-button :loading="relayStore.loading" @click="relayStore.fetchRelays">
            <template #icon><ReloadOutlined /></template>
            刷新中转站
          </a-button>
        </a-space>
      </div>

      <div class="drawing-grid">
        <section class="drawing-panel drawing-config-panel">
          <div class="drawing-panel-head">
            <span><BgColorsOutlined /> 生成配置</span>
            <small>{{ sourceHint }}</small>
          </div>

          <div class="drawing-form">
            <div class="drawing-field drawing-source-field">
              <span>接入方式</span>
              <a-segmented v-model:value="source" block :disabled="generating" :options="sourceOptions" />
            </div>

            <label v-if="source === 'saved'" class="drawing-field">
              <span>中转站</span>
              <a-select
                v-model:value="selectedRelayId"
                show-search
                :disabled="generating"
                :loading="relayStore.loading"
                placeholder="选择已启用的 OpenAI 兼容中转站"
                :filter-option="filterRelayOption"
              >
                <a-select-option v-for="relay in drawingRelays" :key="relay.id" :value="relay.id" :label="relayLabel(relay)">
                  <div class="drawing-relay-option">
                    <strong>{{ relay.name }}</strong>
                    <span>{{ relay.model }}</span>
                  </div>
                </a-select-option>
              </a-select>
              <small v-if="!drawingRelays.length">请先在中转站管理中启用 OpenAI 兼容中转站。</small>
            </label>

            <div v-else class="drawing-custom-grid">
              <label class="drawing-field">
                <span>Base URL</span>
                <a-input v-model:value="customBaseUrl" :disabled="generating" placeholder="https://api.example.com/v1" allow-clear />
              </label>
              <label class="drawing-field">
                <span>API Key</span>
                <a-input-password v-model:value="customApiKey" :disabled="generating" placeholder="仅用于本次绘图请求" allow-clear />
              </label>
            </div>

            <label class="drawing-field">
              <span>绘图模型</span>
              <div class="drawing-model-row">
                <a-auto-complete
                  v-if="source === 'saved'"
                  v-model:value="model"
                  :options="modelSelectOptions"
                  :disabled="generating || !selectedRelay"
                  placeholder="例如 gpt-image-1 / dall-e-3 / flux-kontext"
                />
                <a-select
                  v-else
                  v-model:value="model"
                  :options="modelSelectOptions"
                  :loading="modelsLoading"
                  :disabled="generating || modelsLoading || !customEndpointReady || !modelSelectOptions.length"
                  placeholder="输入端点和 API Key 后探测模型"
                />
                <a-tooltip :title="source === 'custom' ? '使用当前 Base URL 和 API Key 探测模型' : '重新查询该中转站模型'">
                  <a-button
                    :disabled="generating || modelsLoading || (source === 'custom' ? !customEndpointReady : !selectedRelay)"
                    :loading="modelsLoading"
                    @click="source === 'custom' ? loadCustomModels() : selectedRelay && loadModels(selectedRelay)"
                  >
                    <template #icon><SearchOutlined v-if="source === 'custom'" /><ReloadOutlined v-else /></template>
                    <span v-if="source === 'custom'">探测模型</span>
                  </a-button>
                </a-tooltip>
              </div>
              <small v-if="modelLoadError" class="is-error">{{ modelLoadError }}</small>
              <small v-else-if="source === 'custom' && customBaseUrl.trim() && !customBaseUrlValid">请输入有效的 http/https Base URL。</small>
              <small v-else-if="source === 'custom' && customBaseUrlValid && !customBaseUrlSafe">公网 HTTP 会明文传输 API Key，请使用 HTTPS；本机回环地址可使用 HTTP。</small>
              <small v-else-if="source === 'custom' && !customEndpointReady">请输入 Base URL 和 API Key 后点击“探测模型”。</small>
              <small v-else-if="source === 'custom' && !modelSelectOptions.length">尚未探测模型。</small>
              <small v-else-if="source === 'custom'">模型列表来自端点探测，实际需由上游支持绘图。</small>
            </label>

            <div class="drawing-field">
              <span>画幅比例</span>
              <div class="drawing-aspect-grid">
                <button
                  v-for="option in aspectOptions"
                  :key="option.value"
                  type="button"
                  class="drawing-aspect"
                  :class="{ active: aspectRatio === option.value }"
                  :disabled="generating"
                  @click="setAspect(option.value)"
                >
                  <strong>{{ option.value }}</strong>
                  <span>{{ option.label }}</span>
                  <small>{{ option.hint }}</small>
                </button>
              </div>
            </div>

            <label class="drawing-field">
              <span>输出尺寸</span>
              <a-select v-model:value="size" :disabled="generating">
                <a-select-option v-for="option in sizeOptions" :key="option.value" :value="option.value">
                  {{ option.label }} · {{ option.ratio }}
                </a-select-option>
              </a-select>
            </label>

            <div class="drawing-inline-grid">
              <label class="drawing-field">
                <span>生成数量</span>
                <a-input-number v-model:value="count" :disabled="generating" :min="1" :max="4" :precision="0" />
                <small>单次最多 4 张，后端会按张请求并汇总结果。</small>
              </label>
              <label class="drawing-field">
                <span>图片格式</span>
                <a-select v-model:value="outputFormat" :disabled="generating" :options="formatOptions" />
                <small>默认 JPG；若上游不支持会自动降级重试。</small>
              </label>
            </div>

            <div class="drawing-field">
              <span>参考图</span>
              <div class="drawing-upload" :class="{ 'has-reference': reference, 'is-disabled': generating }" @click="openReferencePicker">
                <input ref="referenceInput" type="file" accept="image/png,image/jpeg,image/webp" :disabled="generating" hidden @change="onReferenceChange" />
                <img v-if="reference" :src="reference.dataUrl" alt="参考图预览" />
                <div v-else>
                  <CloudUploadOutlined />
                  <strong>上传参考图</strong>
                  <small>PNG / JPG / WebP，最大 8MB</small>
                </div>
              </div>
              <div v-if="reference" class="drawing-reference-meta">
                <span class="truncate">{{ reference.name }} · {{ formatBytes(reference.size) }}</span>
                <a-button type="text" danger size="small" :disabled="generating" @click.stop="clearReference">
                  <template #icon><DeleteOutlined /></template>
                  移除
                </a-button>
              </div>
            </div>

            <label class="drawing-field">
              <span>描述内容</span>
              <a-textarea
                v-model:value="prompt"
                :disabled="generating"
                :rows="6"
                :maxlength="8000"
                show-count
                placeholder="描述你想生成的画面、主体、风格、光线、颜色、构图和细节。"
              />
            </label>

            <div class="drawing-prompt-preview">
              <div><span>最终提示词预览</span><small>比例和尺寸会自动带入</small></div>
              <pre>{{ finalPromptPreview }}</pre>
            </div>

            <div class="drawing-actions">
              <a-button v-if="generating" danger @click="cancelGenerate">取消</a-button>
              <a-button :disabled="generating" @click="resetForm">重置</a-button>
              <a-button type="primary" :loading="generating" :disabled="!canGenerate" @click="runGenerate">
                <template #icon><ThunderboltOutlined /></template>
                生图
              </a-button>
            </div>
          </div>
        </section>

        <section class="drawing-panel drawing-result-panel">
          <div class="drawing-panel-head">
            <span><PictureOutlined /> 生成结果</span>
            <small v-if="result">{{ result.images.length }} 张 · {{ result.durationMs }}ms · {{ result.upstreamEndpoint }}</small>
            <small v-else>等待生成</small>
          </div>

          <a-alert v-if="runError" type="error" show-icon :message="runError" class="drawing-error" />

          <div class="drawing-result-stage" :class="{ empty: !resultImages.length }">
            <a-spin :spinning="generating">
              <div v-if="resultImages.length" class="drawing-result-grid" :class="{ single: resultImages.length === 1 }">
                <article v-for="image in resultImages" :key="image.index" class="drawing-result-card">
                  <div class="drawing-result-frame">
                    <img :src="imageSrc(image)" :alt="'生成结果 ' + image.index" />
                  </div>
                  <div class="drawing-result-card-foot">
                    <span>#{{ image.index }} · {{ image.mimeType }}</span>
                    <a-space :size="6">
                      <a-tooltip :title="imageDescription(image) ? '复制图片描述' : '该图片暂无描述'">
                        <a-button size="small" :disabled="!imageDescription(image)" @click="copyPrompt(imageDescription(image))">
                          <template #icon><CopyOutlined /></template>
                        </a-button>
                      </a-tooltip>
                      <a-tooltip title="下载图片">
                        <a-button size="small" @click="downloadImage(image)">
                          <template #icon><DownloadOutlined /></template>
                        </a-button>
                      </a-tooltip>
                    </a-space>
                  </div>
                  <p v-if="imageDescription(image)" class="drawing-card-prompt">{{ imageDescription(image) }}</p>
                </article>
              </div>
              <div v-else class="drawing-result-empty">
                <PictureOutlined />
                <strong>暂无生成结果</strong>
                <span>配置中转站、模型和提示词后点击生图。</span>
              </div>
            </a-spin>
          </div>

          <div v-if="result" class="drawing-result-meta">
            <div><span>中转站</span><strong>{{ result.relayName }}</strong></div>
            <div><span>模型</span><strong>{{ result.model }}</strong></div>
            <div><span>尺寸</span><strong>{{ result.size }} · {{ result.aspectRatio }}</strong></div>
            <div><span>批量</span><strong>{{ result.count }} 张 · {{ result.format.toUpperCase() }}</strong></div>
          </div>

          <div v-if="result?.revisedPrompt" class="drawing-revised">
            <span>图片描述</span>
            <p>{{ result.revisedPrompt }}</p>
          </div>

          <div class="drawing-result-actions">
            <a-button :disabled="!primaryImageDescription" @click="copyPrompt(primaryImageDescription)">
              <template #icon><CopyOutlined /></template>
              复制图片描述
            </a-button>
          </div>
        </section>
      </div>
    </main>
  </div>
</template>

<style scoped>
.drawing-page-content { padding-bottom: 34px; }
.drawing-page-view { background: radial-gradient(circle at 18% 8%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 30%); }
.drawing-heading { align-items: center; }
.drawing-grid { display: grid; grid-template-columns: minmax(360px, 0.9fr) minmax(0, 1.1fr); gap: 18px; }
.drawing-panel { min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: 0 18px 48px color-mix(in srgb, #000 8%, transparent); }
.drawing-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 15px 18px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, var(--surface)), var(--surface-subtle)); }
.drawing-panel-head span { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; }
.drawing-panel-head small { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.drawing-form { display: grid; gap: 16px; padding: 18px; }
.drawing-field { display: grid; min-width: 0; gap: 7px; color: var(--text); font-size: 13px; }
.drawing-field > span { color: var(--muted); font-size: 12px; }
.drawing-field small { color: var(--muted); }
.drawing-field small.is-error { color: #c24d4d; }
.drawing-source-field :deep(.ant-segmented) { padding: 3px; background: var(--surface-subtle); }
.drawing-custom-grid, .drawing-inline-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.drawing-inline-grid :deep(.ant-input-number) { width: 100%; }
.drawing-relay-option { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; }
.drawing-relay-option span { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.drawing-model-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.drawing-aspect-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
.drawing-aspect { display: grid; min-width: 0; gap: 3px; padding: 10px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-subtle); color: var(--text); cursor: pointer; text-align: left; }
.drawing-aspect:disabled { cursor: not-allowed; opacity: .62; }
.drawing-aspect strong { color: var(--accent); font-size: 14px; }
.drawing-aspect span, .drawing-aspect small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawing-aspect small { color: var(--muted); font-size: 11px; }
.drawing-aspect.active { border-color: color-mix(in srgb, var(--accent) 62%, var(--border)); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
.drawing-upload { display: grid; min-height: 154px; place-items: center; overflow: hidden; border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--accent) 7%, var(--surface)); cursor: pointer; }
.drawing-upload.is-disabled { cursor: not-allowed; opacity: .62; }
.drawing-upload > div { display: grid; place-items: center; gap: 6px; color: var(--muted); }
.drawing-upload :deep(.anticon) { color: var(--accent); font-size: 26px; }
.drawing-upload img { width: 100%; max-height: 220px; object-fit: contain; background: var(--surface-subtle); }
.drawing-reference-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; }
.drawing-prompt-preview { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-subtle); }
.drawing-prompt-preview > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
.drawing-prompt-preview pre { max-height: 150px; margin: 0; overflow: auto; color: var(--text); font-family: inherit; font-size: 12px; line-height: 1.7; white-space: pre-wrap; }
.drawing-actions, .drawing-result-actions { display: flex; justify-content: flex-end; gap: 8px; }
.drawing-result-panel { display: flex; min-height: 660px; flex-direction: column; }
.drawing-error { margin: 16px 18px 0; }
.drawing-result-stage { display: grid; min-height: 480px; flex: 1; place-items: center; padding: 18px; background: radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 36%), var(--surface-subtle); }
.drawing-result-stage :deep(.ant-spin-nested-loading), .drawing-result-stage :deep(.ant-spin-container) { width: 100%; height: 100%; }
.drawing-result-grid { display: grid; width: 100%; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.drawing-result-grid.single { max-width: 680px; margin: 0 auto; grid-template-columns: minmax(0, 1fr); }
.drawing-result-card { display: grid; min-width: 0; overflow: hidden; border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, var(--accent)); box-shadow: 0 16px 42px color-mix(in srgb, #000 12%, transparent); }
.drawing-result-frame { display: grid; aspect-ratio: 1 / 1; place-items: center; overflow: hidden; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 8%, var(--surface-subtle)), var(--surface)); }
.drawing-result-grid.single .drawing-result-frame { aspect-ratio: 16 / 10; }
.drawing-result-frame img { display: block; width: 100%; height: 100%; object-fit: contain; }
.drawing-result-card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px; border-top: 1px solid var(--border); }
.drawing-result-card-foot span { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.drawing-card-prompt { max-height: 70px; margin: 0; overflow: auto; padding: 0 10px 10px; color: var(--muted); font-size: 12px; line-height: 1.6; }
.drawing-result-empty { display: grid; min-height: 420px; place-items: center; align-content: center; gap: 8px; color: var(--muted); text-align: center; }
.drawing-result-empty :deep(.anticon) { color: var(--accent); font-size: 42px; }
.drawing-result-empty strong { color: var(--text); font-size: 16px; }
.drawing-result-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; border-top: 1px solid var(--border); background: var(--border); }
.drawing-result-meta > div { min-width: 0; padding: 12px 14px; background: var(--surface); }
.drawing-result-meta span { display: block; margin-bottom: 3px; color: var(--muted); font-size: 11px; }
.drawing-result-meta strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawing-revised { display: grid; gap: 6px; padding: 13px 16px; border-top: 1px solid var(--border); }
.drawing-revised span { color: var(--muted); font-size: 12px; }
.drawing-revised p { max-height: 90px; margin: 0; overflow: auto; color: var(--text); font-size: 12px; line-height: 1.7; }
.drawing-result-actions { padding: 14px 16px; border-top: 1px solid var(--border); }

@media (max-width: 1120px) {
  .drawing-grid { grid-template-columns: 1fr; }
  .drawing-result-panel { min-height: auto; }
}

@media (max-width: 720px) {
  .drawing-custom-grid, .drawing-inline-grid { grid-template-columns: 1fr; }
  .drawing-aspect-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .drawing-result-meta { grid-template-columns: 1fr; }
  .drawing-result-grid { grid-template-columns: 1fr; }
}
</style>
