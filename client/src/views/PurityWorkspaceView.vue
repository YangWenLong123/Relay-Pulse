<!--
 * @Description: 中转站通用与 GPT-5.6 深度纯度检测工作台
 * @Date: 2026-08-07 00:00:00
 * @FilePath: client/src/views/PurityWorkspaceView.vue
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  ApiOutlined,
  CameraOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  ExperimentOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons-vue';
import { errorMessage } from '../api/http';
import { runCustomPurityTestStream, runPurityTestStream } from '../api/purity';
import { discoverDraftModels, discoverRelayModels } from '../api/relays';
import { useRelayStore } from '../stores/relays';
import type {
  CustomPurityTestInput,
  Gpt56DetectionSummary,
  Gpt56TestConfig,
  PurityCheckStatus,
  PurityConfidence,
  PurityTestProgress,
  PurityTestMode,
  PurityTestResult,
  PurityVerdict,
  Relay,
  RelayPlatform,
  RelayProtocol
} from '../types';

const relayStore = useRelayStore();

type PuritySource = 'saved' | 'custom';

const source = ref<PuritySource>('saved');
const selectedRelayId = ref('');
const model = ref('');
const modelOptions = ref<string[]>([]);
const modelsLoading = ref(false);
const modelLoadError = ref('');
const customBaseUrl = ref('');
const customApiKey = ref('');
const customModel = ref('');
const customModelOptions = ref<string[]>([]);
const customModelsLoading = ref(false);
const customModelLoadError = ref('');
const customPlatform = ref<RelayPlatform>('openai');
const customProtocol = ref<RelayProtocol>('auto');
const customTimeout = 30_000;
const mode = ref<PurityTestMode>('standard');
// GPT-5.6 deep mode keeps trusted endpoint credentials only in this component's memory.
const gpt56Trials = ref<number>(5);
const trustedBaseUrl = ref('');
const trustedApiKey = ref('');
const trustedModel = ref('');
const result = ref<PurityTestResult>();
const liveProgress = ref<PurityTestProgress>();
const relayLoadError = ref('');
const runError = ref('');
const running = ref(false);
const cancelling = ref(false);
const screenshotting = ref(false);
const elapsedSeconds = ref(0);
const resultCaptureRef = ref<HTMLElement>();
let runController: AbortController | undefined;
let modelController: AbortController | undefined;
let customModelController: AbortController | undefined;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

const enabledRelays = computed(() => relayStore.relays.filter((relay) => relay.enabled));
const selectedRelay = computed(() => relayStore.relays.find((relay) => relay.id === selectedRelayId.value));
const activeModel = computed({
  get: () => (source.value === 'saved' ? model.value : customModel.value),
  set: (value: string) => {
    if (source.value === 'saved') model.value = value;
    else customModel.value = value;
  }
});
const activeModelsLoading = computed(() => (source.value === 'saved' ? modelsLoading.value : customModelsLoading.value));
const activeModelLoadError = computed(() => (source.value === 'saved' ? modelLoadError.value : customModelLoadError.value));
const activePlatform = computed<RelayPlatform>(() =>
  source.value === 'saved' ? (selectedRelay.value?.platform ?? 'openai') : customPlatform.value
);
const activeSourceLabel = computed(() => (source.value === 'saved' ? selectedRelay.value?.name ?? '已保存中转站' : '自定义连接'));
const customBaseUrlValid = computed(() => isHttpUrl(customBaseUrl.value));
const customBaseUrlSafe = computed(() => customBaseUrlValid.value && isCredentialSafeUrl(customBaseUrl.value));
const customApiKeyReady = computed(() => Boolean(customApiKey.value.trim()));
const activeModelTrimmed = computed(() => activeModel.value.trim());
const activeModelValid = computed(() => activeModelTrimmed.value.length > 0 && activeModelTrimmed.value.length <= 160);
const customModelSearched = ref(false);
const isGpt56Mode = computed(() => mode.value === 'gpt56');
const savedRelaySupportsGpt56 = computed(() => {
  const relay = selectedRelay.value;
  return Boolean(relay && relay.platform === 'openai' && relay.protocol !== 'chat' && isCredentialSafeUrl(relay.baseUrl));
});
const gpt56TargetCompatible = computed(() => {
  if (!isGpt56Mode.value) return true;
  return source.value === 'saved' ? savedRelaySupportsGpt56.value : customPlatform.value === 'openai' && customProtocol.value !== 'chat';
});
const trustedReferenceTouched = computed(() => Boolean(trustedBaseUrl.value.trim() || trustedApiKey.value.trim() || trustedModel.value.trim()));
const trustedReferenceComplete = computed(() => Boolean(trustedBaseUrl.value.trim() && trustedApiKey.value.trim() && trustedModel.value.trim()));
const trustedBaseUrlValid = computed(() => isHttpUrl(trustedBaseUrl.value));
const trustedBaseUrlSafe = computed(() => trustedBaseUrlValid.value && isCredentialSafeUrl(trustedBaseUrl.value));
const trustedModelValid = computed(() => trustedModel.value.trim().length > 0 && trustedModel.value.trim().length <= 160);
const gpt56ReferenceIssue = computed(() => {
  if (!isGpt56Mode.value || !trustedReferenceTouched.value) return '';
  if (!trustedReferenceComplete.value) return '请完整填写可信参考端，或清空后仅运行辅助指纹';
  if (!trustedBaseUrlValid.value) return '可信参考端 Base URL 格式无效';
  if (!trustedBaseUrlSafe.value) return '可信参考端需使用 HTTPS 或本机回环地址';
  if (!trustedModelValid.value) return '可信参考模型不能为空且不能超过 160 个字符';
  return '';
});
const liveGpt56 = computed<Gpt56DetectionSummary | undefined>(() => liveProgress.value?.gpt56);
const resultGpt56 = computed<Gpt56DetectionSummary | undefined>(() => result.value?.gpt56);
const activeStatusLabel = computed(() => {
  if (activeModelsLoading.value) return '模型查询中';
  if (activeModelLoadError.value) return '模型查询失败';
  if (source.value === 'saved') {
    if (!selectedRelay.value) return '待选择中转站';
    if (!activeModelTrimmed.value) return '待选择模型';
    if (!activeModelValid.value) return '模型名过长';
    if (!gpt56TargetCompatible.value) return '深度检测需要 OpenAI Responses';
    if (gpt56ReferenceIssue.value) return gpt56ReferenceIssue.value;
    return '配置就绪';
  }
  if (!customBaseUrl.value.trim()) return '待填写 Base URL';
  if (!customBaseUrlValid.value) return 'URL 格式无效';
  if (!customBaseUrlSafe.value) return '需使用 HTTPS';
  if (!customApiKeyReady.value) return '待填写 API Key';
  if (!activeModelTrimmed.value) return '待填写模型';
  if (!activeModelValid.value) return '模型名过长';
  if (!gpt56TargetCompatible.value) return '深度检测需要 OpenAI Responses';
  if (gpt56ReferenceIssue.value) return gpt56ReferenceIssue.value;
  return '配置就绪';
});
const activeStatusClass = computed(() => ({
  'is-loading': activeModelsLoading.value,
  'is-error': Boolean(activeModelLoadError.value) || activeStatusLabel.value === 'URL 格式无效' || activeStatusLabel.value === '需使用 HTTPS' || activeStatusLabel.value === '模型名过长' || Boolean(gpt56ReferenceIssue.value) || !gpt56TargetCompatible.value,
  'is-waiting': !activeModelsLoading.value && !activeModelLoadError.value && activeStatusLabel.value !== '配置就绪'
}));
const canRun = computed(() => {
  if (source.value === 'saved') {
    return Boolean(selectedRelay.value?.enabled && activeModelValid.value && gpt56TargetCompatible.value && !gpt56ReferenceIssue.value)
      && !relayStore.loading
      && !modelsLoading.value
      && !running.value;
  }
  return Boolean(customBaseUrlSafe.value && customApiKeyReady.value && activeModelValid.value && gpt56TargetCompatible.value && !gpt56ReferenceIssue.value)
    && !customModelsLoading.value
    && !running.value;
});
const scorePercent = computed(() => clampScore(result.value?.score));
const totalTokens = computed(() => result.value?.usage.totalTokens ?? null);
const liveChecks = computed(() => liveProgress.value?.checks ?? []);
const livePercent = computed(() => {
  const progress = liveProgress.value;
  if (!progress?.totalChecks) return 0;
  return Math.min(100, Math.round((progress.completedChecks / progress.totalChecks) * 100));
});

const modeOptions = [
  { label: '快速', value: 'quick' },
  { label: '标准', value: 'standard' },
  { label: 'GPT-5.6 深度', value: 'gpt56' }
];

const sourceOptions = [
  { label: '已保存中转站', value: 'saved' },
  { label: '自定义连接', value: 'custom' }
];

const platformOptions = [
  { label: 'OpenAI', value: 'openai' },
  { label: 'Anthropic', value: 'anthropic' }
];

const protocolOptions = [
  { label: '自动', value: 'auto' },
  { label: 'Responses', value: 'responses' },
  { label: 'Chat Completions', value: 'chat' }
];

const verdictMeta: Record<PurityVerdict, { label: string; color: string; tone: string }> = {
  high_confidence_normal: { label: '高可信正常', color: 'success', tone: 'normal' },
  likely_normal: { label: '大概率正常', color: 'processing', tone: 'likely' },
  suspicious: { label: '存在可疑信号', color: 'warning', tone: 'suspicious' },
  abnormal: { label: '检测到明显异常', color: 'error', tone: 'abnormal' },
  inconclusive: { label: '证据不足', color: 'default', tone: 'inconclusive' },
  gpt56_compatible: { label: '兼容证据通过', color: 'success', tone: 'normal' },
  gpt56_auxiliary: { label: '辅助证据', color: 'processing', tone: 'likely' },
  gpt56_inconsistent: { label: '检测信号冲突', color: 'error', tone: 'abnormal' }
};

const confidenceLabels: Record<PurityConfidence, string> = {
  low: '低置信度',
  medium: '中等置信度',
  high: '高置信度'
};

const checkMeta: Record<PurityCheckStatus, { label: string; color: string }> = {
  pass: { label: '通过', color: 'success' },
  warning: { label: '需关注', color: 'warning' },
  fail: { label: '异常', color: 'error' },
  skipped: { label: '未检测', color: 'default' }
};

function relayOptionLabel(relay: Relay): string {
  return `${relay.name} · ${relay.platform === 'anthropic' ? 'Anthropic' : 'OpenAI'}`;
}

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

function updateMode(value: string | number): void {
  if (value !== 'quick' && value !== 'standard' && value !== 'gpt56') return;
  mode.value = value;
  if (value === 'gpt56' && source.value === 'custom') {
    customPlatform.value = 'openai';
    customProtocol.value = 'responses';
  }
}

function updateSource(value: string | number): void {
  if (value === 'saved' || value === 'custom') source.value = value;
}

function updateCustomPlatform(value: string | number): void {
  if (value !== 'openai' && value !== 'anthropic') return;
  if (isGpt56Mode.value && value === 'anthropic') return;
  customPlatform.value = value;
  if (value === 'anthropic') customProtocol.value = 'auto';
}

function updateCustomProtocol(value: string | number): void {
  if (value !== 'auto' && value !== 'responses' && value !== 'chat') return;
  if (isGpt56Mode.value && value === 'chat') return;
  customProtocol.value = value;
}

function modeLabel(value: PurityTestMode): string {
  if (value === 'gpt56') return 'GPT-5.6 深度';
  return value === 'standard' ? '标准' : '快速';
}

function gpt56StatusLabel(status: string): string {
  const labels: Record<string, string> = {
    preflight: '预检',
    trusted_seed: '可信状态',
    encrypted_controls: '加密对照',
    juice_fingerprint: 'Juice 指纹',
    literal_control: '字面量对照',
    finalizing: '汇总完成',
    not_run: '未执行',
    running: '进行中',
    compatible: '兼容通过',
    preliminary_compatible: '初步兼容',
    not_compatible: '未观察到兼容',
    suspicious: '阴性对照异常',
    invalid: '结果无效',
    inconclusive: '证据不足',
    fingerprint: '指纹一致',
    preliminary: '初步指纹',
    mixed: '信号冲突',
    insufficient: '样本不足',
    passed: '精确通过',
    output_rewrite_suspected: '疑似改写',
    smooth: '流畅',
    intermittent: '有重试',
    unstable: '不稳定'
  };
  return labels[status] ?? status;
}

function gpt56StatusColor(status: string): string {
  if (['compatible', 'preliminary_compatible', 'fingerprint', 'passed', 'smooth'].includes(status)) return 'success';
  if (['suspicious', 'invalid', 'mixed', 'unstable'].includes(status)) return 'error';
  if (['preliminary', 'intermittent', 'not_compatible', 'output_rewrite_suspected'].includes(status)) return 'warning';
  return 'default';
}

function gpt56EffortLabel(effort: string): string {
  return { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' }[effort] ?? effort;
}

/**
 * @description Build the optional trusted endpoint payload only after local URL and credential validation.
 */
function buildGpt56Config(): Gpt56TestConfig | undefined {
  if (!isGpt56Mode.value) return undefined;
  const config: Gpt56TestConfig = { trials: gpt56Trials.value };
  if (trustedReferenceComplete.value) {
    config.trustedReference = {
      baseUrl: trustedBaseUrl.value.trim(),
      apiKey: trustedApiKey.value.trim(),
      model: trustedModel.value.trim()
    };
  }
  return config;
}

function clampScore(score: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}

function scoreText(score: number | null): string {
  return score === null || !Number.isFinite(score) ? '--' : `${Math.round(score)}`;
}

function scoreColor(testResult: PurityTestResult): string {
  if (testResult.score === null) return 'var(--muted)';
  if (testResult.verdict === 'abnormal') return '#c95757';
  if (testResult.verdict === 'suspicious') return '#b7792d';
  if (testResult.verdict === 'likely_normal') return '#4f7fa8';
  return '#3e9b72';
}

function formatProgress(): string {
  return result.value?.score === null ? '--' : `${scorePercent.value}`;
}

function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '-'
    : new Intl.NumberFormat('zh-CN').format(value);
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return '-';
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1_000);
  return `${minutes} min ${seconds} s`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatTestedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function protocolLabel(testResult: PurityTestResult): string {
  if (testResult.protocol === 'anthropic') return 'Anthropic Messages';
  return testResult.protocol === 'responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions';
}

function safeFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'relay';
}

function screenshotTimestamp(value: string): string {
  const parsed = new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const pad = (part: number): string => `${part}`.padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('浏览器未能生成 PNG 图片'));
    }, 'image/png');
  });
}

function addCanvasPadding(
  source: HTMLCanvasElement,
  padding: number,
  backgroundColor: string
): HTMLCanvasElement {
  const output = document.createElement('canvas');
  output.width = source.width + padding * 2;
  output.height = source.height + padding * 2;
  const context = output.getContext('2d');
  if (!context) throw new Error('浏览器无法创建截图画布');
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(source, padding, padding);
  return output;
}

async function captureResult(): Promise<void> {
  const testResult = result.value;
  if (!testResult || !resultCaptureRef.value || screenshotting.value) return;

  screenshotting.value = true;
  try {
    await nextTick();
    await document.fonts?.ready;
    const { default: html2canvas } = await import('html2canvas');
    const target = resultCaptureRef.value;
    const backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim() || '#ffffff';
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = await html2canvas(target, {
      backgroundColor,
      logging: false,
      scale,
      useCORS: true
    });
    const paddedCanvas = addCanvasPadding(canvas, Math.round(20 * scale), backgroundColor);
    const blob = await canvasBlob(paddedCanvas);
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${safeFilenamePart(testResult.relayName)}-纯度检测-${screenshotTimestamp(testResult.testedAt)}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
    message.success('探测结果截图已下载');
  } catch (error) {
    message.error(`截图生成失败：${errorMessage(error)}`);
  } finally {
    screenshotting.value = false;
  }
}

function clearElapsedTimer(): void {
  if (!elapsedTimer) return;
  clearInterval(elapsedTimer);
  elapsedTimer = undefined;
}

function clearOutput(): void {
  result.value = undefined;
  liveProgress.value = undefined;
  runError.value = '';
}

function abortModelDiscovery(): void {
  modelController?.abort();
  customModelController?.abort();
  modelController = undefined;
  customModelController = undefined;
  modelsLoading.value = false;
  customModelsLoading.value = false;
}

function abortActiveRun(): void {
  if (!runController) return;
  cancelling.value = true;
  runController.abort();
}

async function loadRelays(): Promise<void> {
  relayLoadError.value = '';
  try {
    await relayStore.fetchRelays();
  } catch (error) {
    relayLoadError.value = errorMessage(error);
  }
}

async function loadModels(relayId: string): Promise<void> {
  modelController?.abort();
  const relay = relayStore.relays.find((item) => item.id === relayId);
  if (!relay) {
    modelOptions.value = [];
    model.value = '';
    modelsLoading.value = false;
    modelLoadError.value = '';
    return;
  }

  const controller = new AbortController();
  modelController = controller;
  modelsLoading.value = true;
  modelLoadError.value = '';
  const fallbackModel = relay.model.trim();
  if (!model.value) model.value = fallbackModel;
  modelOptions.value = normalizeModels(modelOptions.value, fallbackModel);

  try {
    const discoveredModels = await discoverRelayModels(relayId, controller.signal);
    if (modelController !== controller || selectedRelayId.value !== relayId) return;
    modelOptions.value = normalizeModels(discoveredModels, fallbackModel);
    if (!modelOptions.value.includes(model.value)) {
      model.value = modelOptions.value.includes(fallbackModel) ? fallbackModel : (modelOptions.value[0] ?? '');
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      modelLoadError.value = errorMessage(error);
      modelOptions.value = normalizeModels([], fallbackModel);
      model.value = fallbackModel;
    }
  } finally {
    if (modelController === controller) {
      modelController = undefined;
      modelsLoading.value = false;
    }
  }
}

async function loadCustomModels(): Promise<void> {
  customModelController?.abort();
  const baseUrl = customBaseUrl.value.trim();
  const apiKey = customApiKey.value.trim();
  if (!isHttpUrl(baseUrl)) {
    customModelLoadError.value = '请输入有效的 http/https Base URL';
    return;
  }
  if (!isCredentialSafeUrl(baseUrl)) {
    customModelLoadError.value = '公网 HTTP 会明文传输 API Key，请使用 HTTPS 或本机地址';
    return;
  }
  if (!apiKey) {
    customModelLoadError.value = '请先填写 API Key';
    return;
  }

  const controller = new AbortController();
  customModelController = controller;
  customModelsLoading.value = true;
  customModelSearched.value = false;
  customModelLoadError.value = '';
  try {
    const discoveredModels = await discoverDraftModels(
      { baseUrl, apiKey, platform: customPlatform.value, timeout: customTimeout },
      controller.signal
    );
    if (customModelController !== controller || source.value !== 'custom') return;
    customModelOptions.value = normalizeModels(discoveredModels, customModel.value);
    customModelSearched.value = true;
    if (!customModel.value && customModelOptions.value.length) customModel.value = customModelOptions.value[0];
  } catch (error) {
    if (!controller.signal.aborted && customModelController === controller) {
      customModelLoadError.value = errorMessage(error);
      customModelOptions.value = normalizeModels([], customModel.value);
      customModelSearched.value = true;
    }
  } finally {
    if (customModelController === controller) {
      customModelController = undefined;
      customModelsLoading.value = false;
    }
  }
}

async function startTest(): Promise<void> {
  const relay = selectedRelay.value;
  if (!canRun.value || (source.value === 'saved' && !relay)) return;
  if (source.value === 'custom' && !customBaseUrlValid.value) {
    runError.value = '请输入有效的 http/https Base URL';
    return;
  }
  if (source.value === 'custom' && !customBaseUrlSafe.value) {
    runError.value = '公网 HTTP 会明文传输 API Key，请使用 HTTPS 或本机地址';
    return;
  }
  if (!activeModelValid.value) {
    runError.value = activeModelTrimmed.value ? '检测模型不能超过 160 个字符' : '请输入检测模型';
    return;
  }
  if (!gpt56TargetCompatible.value) {
    runError.value = 'GPT-5.6 深度检测仅支持 OpenAI Responses 中转站';
    return;
  }
  if (gpt56ReferenceIssue.value) {
    runError.value = gpt56ReferenceIssue.value;
    return;
  }
  runController?.abort();
  const controller = new AbortController();
  runController = controller;
  running.value = true;
  cancelling.value = false;
  runError.value = '';
  result.value = undefined;
  liveProgress.value = undefined;
  elapsedSeconds.value = 0;
  clearElapsedTimer();
  elapsedTimer = setInterval(() => { elapsedSeconds.value += 1; }, 1_000);

  const requestedModel = activeModelTrimmed.value;
  const gpt56 = buildGpt56Config();
  try {
    const onProgress = (progress: PurityTestProgress): void => {
      if (runController !== controller) return;
      liveProgress.value = progress;
      elapsedSeconds.value = Math.max(elapsedSeconds.value, Math.floor(progress.elapsedMs / 1_000));
    };
    if (source.value === 'saved' && relay) {
      result.value = await runPurityTestStream(
        relay.id,
        { mode: mode.value, model: requestedModel, gpt56 },
        onProgress,
        controller.signal
      );
    } else {
      const customInput: CustomPurityTestInput = {
        baseUrl: customBaseUrl.value.trim(),
        apiKey: customApiKey.value.trim(),
        model: requestedModel,
        mode: mode.value,
        gpt56,
        platform: customPlatform.value,
        protocol: isGpt56Mode.value ? 'responses' : customPlatform.value === 'anthropic' ? 'auto' : customProtocol.value,
        timeout: customTimeout
      };
      result.value = await runCustomPurityTestStream(customInput, onProgress, controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) runError.value = errorMessage(error);
  } finally {
    if (runController === controller) {
      runController = undefined;
      running.value = false;
      cancelling.value = false;
      clearElapsedTimer();
    }
  }
}

function cancelTest(): void {
  if (!runController || cancelling.value) return;
  cancelling.value = true;
  runController.abort();
}

watch(
  () => relayStore.relays,
  (relays) => {
    const currentEnabled = relays.some((relay) => relay.id === selectedRelayId.value && relay.enabled);
    if (!currentEnabled) selectedRelayId.value = relays.find((relay) => relay.enabled)?.id ?? '';
  },
  { immediate: true }
);

watch(
  selectedRelayId,
  (relayId) => {
    abortModelDiscovery();
    const relay = relayStore.relays.find((item) => item.id === relayId);
    model.value = relay?.model ?? '';
    modelOptions.value = normalizeModels([], relay?.model);
    modelLoadError.value = '';
    clearOutput();
    if (source.value === 'saved' && relay) void loadModels(relayId);
  },
  { immediate: true }
);

watch(source, (value) => {
  abortModelDiscovery();
  clearOutput();
  if (running.value) abortActiveRun();
  if (value === 'saved') {
    const relay = selectedRelay.value;
    if (relay) {
      modelOptions.value = normalizeModels([], relay.model);
      model.value = relay.model;
      void loadModels(relay.id);
    }
  } else {
    if (isGpt56Mode.value) {
      customPlatform.value = 'openai';
      customProtocol.value = 'responses';
    }
    customModelLoadError.value = '';
    customModelSearched.value = false;
  }
});

watch([customBaseUrl, customApiKey, customPlatform], () => {
  if (source.value !== 'custom') return;
  customModelController?.abort();
  customModelController = undefined;
  customModelsLoading.value = false;
  customModelOptions.value = [];
  customModel.value = '';
  customModelSearched.value = false;
  customModelLoadError.value = '';
  clearOutput();
});

watch(customModel, () => {
  customModelController?.abort();
  customModelController = undefined;
  customModelsLoading.value = false;
  clearOutput();
});

watch(customProtocol, () => {
  clearOutput();
});

watch(mode, () => {
  clearOutput();
});

watch([gpt56Trials, trustedBaseUrl, trustedApiKey, trustedModel], () => {
  if (isGpt56Mode.value) clearOutput();
});

watch(model, () => {
  if (source.value === 'saved') clearOutput();
});

onMounted(() => {
  if (!relayStore.loaded && !relayStore.loading) void loadRelays();
});

onBeforeUnmount(() => {
  runController?.abort();
  abortModelDiscovery();
  clearElapsedTimer();
});
</script>

<template>
  <div class="page-view">
    <main class="page-content purity-page-content">
      <section class="purity-runner" aria-labelledby="purity-title">
        <div class="purity-heading">
          <div>
            <div class="purity-title-row">
              <span class="purity-title-icon" aria-hidden="true"><ExperimentOutlined /></span>
              <h1 id="purity-title">纯度检测</h1>
              <a-tag :color="activePlatform === 'anthropic' ? 'purple' : 'blue'">
                {{ activePlatform === 'anthropic' ? 'Anthropic' : 'OpenAI' }}
              </a-tag>
            </div>
            <p>黑盒检测无法证明真实上游，结果仅代表本次请求观察到的风险信号。密钥只在本次会话内使用。</p>
          </div>
        </div>

        <div v-if="relayLoadError" class="purity-error" role="alert">
          <span>{{ relayLoadError }}</span>
          <a-button size="small" @click="loadRelays">重试</a-button>
        </div>
        <div v-if="runError" class="purity-error" role="alert">
          <span>{{ runError }}</span>
          <a-button size="small" :disabled="!canRun" @click="startTest">重新检测</a-button>
        </div>

        <a-spin :spinning="relayStore.loading">
          <div class="purity-console">
            <div class="purity-console-head">
              <div class="purity-console-heading">
                <span>检测来源</span>
                <strong>{{ activeSourceLabel }}</strong>
              </div>
              <a-segmented
                class="purity-source-switch"
                :value="source"
                :disabled="running"
                :options="sourceOptions"
                aria-label="选择检测来源"
                @update:value="updateSource"
              />
            </div>

            <div v-if="source === 'saved'" class="purity-source-fields purity-saved-fields">
              <label class="purity-field">
                <span class="purity-field-label">中转站</span>
                <a-select
                  v-model:value="selectedRelayId"
                  :disabled="running || relayStore.loading || !relayStore.relays.length"
                  show-search
                  option-filter-prop="label"
                  placeholder="选择已保存的中转站"
                >
                  <a-select-option
                    v-for="relay in relayStore.relays"
                    :key="relay.id"
                    :value="relay.id"
                    :label="relayOptionLabel(relay)"
                    :disabled="!relay.enabled"
                  >
                    <div class="purity-relay-option">
                      <span>{{ relayOptionLabel(relay) }}</span>
                      <a-tag v-if="!relay.enabled">已停用</a-tag>
                    </div>
                  </a-select-option>
                </a-select>
              </label>

              <div class="purity-field">
                <div class="purity-field-label purity-model-label">
                  <span>检测模型</span>
                  <span v-if="!modelsLoading && modelOptions.length">{{ modelOptions.length }} 个</span>
                </div>
                <a-space-compact block>
                  <a-select
                    v-model:value="model"
                    :disabled="running || modelsLoading || !selectedRelay"
                    :loading="modelsLoading"
                    :options="modelOptions.map((value) => ({ value, label: value }))"
                    show-search
                    option-filter-prop="label"
                    placeholder="选择探测到的模型"
                  />
                  <a-tooltip title="重新探测模型">
                    <a-button
                      class="purity-model-refresh"
                      :loading="modelsLoading"
                      :disabled="running || !selectedRelay"
                      aria-label="重新探测模型"
                      @click="selectedRelay && loadModels(selectedRelay.id)"
                    >
                      <template #icon><ReloadOutlined /></template>
                    </a-button>
                  </a-tooltip>
                </a-space-compact>
              </div>
            </div>

            <div v-else class="purity-source-fields purity-custom-fields">
              <label class="purity-field purity-custom-url-field">
                <span class="purity-field-label">Base URL</span>
                <a-input
                  v-model:value="customBaseUrl"
                  :disabled="running"
                  :maxlength="500"
                  autocomplete="url"
                  placeholder="https://api.example.com/v1"
                />
              </label>

              <label class="purity-field">
                <span class="purity-field-label">API Key <small>仅本次会话</small></span>
                <a-input-password
                  v-model:value="customApiKey"
                  :disabled="running"
                  :maxlength="500"
                  autocomplete="off"
                  placeholder="sk-..."
                />
              </label>

              <div class="purity-field" role="group" aria-labelledby="purity-platform-label">
                <span id="purity-platform-label" class="purity-field-label">API 类型</span>
                <a-segmented
                  :value="customPlatform"
                  :disabled="running"
                  :options="platformOptions"
                  block
                  aria-labelledby="purity-platform-label"
                  @update:value="updateCustomPlatform"
                />
              </div>

              <div class="purity-field purity-custom-model-field">
                <div class="purity-field-label purity-model-label">
                  <span>检测模型</span>
                  <span v-if="!customModelsLoading && customModelOptions.length">{{ customModelOptions.length }} 个</span>
                </div>
                <a-space-compact block>
                  <a-auto-complete
                    v-model:value="customModel"
                    :options="customModelOptions.map((value) => ({ value }))"
                    :disabled="running"
                    :filter-option="false"
                  >
                    <a-input :disabled="running" :maxlength="160" placeholder="可手动输入，或查询模型" />
                  </a-auto-complete>
                  <a-tooltip title="查询可用模型">
                    <a-button
                      class="purity-model-discover"
                      :loading="customModelsLoading"
                      :disabled="running || !customBaseUrlSafe || !customApiKeyReady"
                      aria-label="查询可用模型"
                      @click="loadCustomModels"
                    >
                      <template #icon><ApiOutlined /></template>
                    </a-button>
                  </a-tooltip>
                </a-space-compact>
              </div>

              <div v-if="customPlatform === 'openai'" class="purity-field purity-protocol-field" role="group" aria-labelledby="purity-protocol-label">
                <span id="purity-protocol-label" class="purity-field-label">OpenAI 协议</span>
                <a-segmented
                  :value="customProtocol"
                  :disabled="running"
                  :options="protocolOptions"
                  block
                  aria-labelledby="purity-protocol-label"
                  @update:value="updateCustomProtocol"
                />
              </div>
            </div>

            <!-- GPT-5.6 deep mode keeps optional trusted-reference inputs adjacent to the candidate endpoint. -->
            <div v-if="isGpt56Mode" class="gpt56-config" aria-labelledby="gpt56-config-title">
              <div class="gpt56-config-heading">
                <div>
                  <span id="gpt56-config-title">GPT-5.6 深度证据链</span>
                  <small>OpenAI Responses</small>
                </div>
                <a-tag :color="trustedReferenceComplete ? 'success' : 'default'">
                  {{ trustedReferenceComplete ? '可信参考端已配置' : '仅辅助指纹' }}
                </a-tag>
              </div>
              <div class="gpt56-config-fields">
                <label class="purity-field gpt56-trials-field">
                  <span class="purity-field-label">加密状态轮数</span>
                  <a-input-number v-model:value="gpt56Trials" :disabled="running" :min="3" :max="20" :precision="0" />
                </label>
                <label class="purity-field">
                  <span class="purity-field-label">可信参考 Base URL <small>可选</small></span>
                  <a-input v-model:value="trustedBaseUrl" :disabled="running" :maxlength="500" autocomplete="url" placeholder="https://api.openai.com/v1" />
                </label>
                <label class="purity-field">
                  <span class="purity-field-label">可信参考 API Key <small>仅本次会话</small></span>
                  <a-input-password v-model:value="trustedApiKey" :disabled="running" :maxlength="500" autocomplete="off" placeholder="sk-..." />
                </label>
                <label class="purity-field">
                  <span class="purity-field-label">可信参考模型 <small>可选</small></span>
                  <a-input v-model:value="trustedModel" :disabled="running" :maxlength="160" placeholder="gpt-5.6" />
                </label>
              </div>
            </div>

            <div class="purity-console-bottom">
              <div class="purity-status-track" role="status" aria-label="检测配置状态">
                <span class="purity-status-item"><i />{{ activeSourceLabel }}</span>
                <span class="purity-status-item"><i />{{ activePlatform === 'anthropic' ? 'Anthropic' : 'OpenAI' }}</span>
                <span class="purity-status-item purity-status-model" :title="activeModelTrimmed || '待选择模型'"><i />{{ activeModelTrimmed || '待选择模型' }}</span>
                <span class="purity-status-item" :class="activeStatusClass">
                  <i />{{ activeStatusLabel }}
                </span>
              </div>

              <div class="purity-console-actions">
                <div class="purity-mode-field purity-field" role="group" aria-labelledby="purity-mode-label">
                  <span id="purity-mode-label" class="purity-field-label">检测模式</span>
                  <a-segmented :value="mode" :disabled="running" :options="modeOptions" block aria-labelledby="purity-mode-label" @update:value="updateMode" />
                </div>
                <div class="purity-actions">
                  <a-button v-if="running" danger :disabled="cancelling" @click="cancelTest">
                    <template #icon><StopOutlined /></template>
                    {{ cancelling ? '正在取消' : '取消检测' }}
                  </a-button>
                  <a-button v-else type="primary" :disabled="!canRun" @click="startTest">
                    <template #icon><ExperimentOutlined /></template>
                    开始检测
                  </a-button>
                </div>
              </div>
            </div>
          </div>

          <div class="purity-tool-note">
            <template v-if="source === 'saved' && !relayStore.loading && !relayStore.relays.length">尚未保存中转站配置。</template>
            <template v-else-if="source === 'saved' && !relayStore.loading && !enabledRelays.length">没有已启用的中转站。</template>
            <template v-else-if="activeModelsLoading">正在查询 {{ activeSourceLabel }} 的可用模型...</template>
            <template v-else-if="activeModelLoadError">
              模型查询失败：{{ activeModelLoadError }}<template v-if="activeModel">；已保留模型 {{ activeModel }}</template>
            </template>
            <template v-else-if="isGpt56Mode && !gpt56TargetCompatible">GPT-5.6 深度检测仅可用于支持 OpenAI Responses 的中转站。</template>
            <template v-else-if="isGpt56Mode && gpt56ReferenceIssue">{{ gpt56ReferenceIssue }}</template>
            <template v-else-if="isGpt56Mode && !trustedReferenceTouched">未配置可信参考端，将仅运行 Juice 指纹与字面量输出对照。</template>
            <template v-else-if="isGpt56Mode">将执行 {{ gpt56Trials }} 轮加密状态正负对照、Juice 指纹和字面量输出对照。</template>
            <template v-else-if="source === 'custom' && !customBaseUrl.trim()">填写 Base URL、API Key 和模型后即可开始检测。</template>
            <template v-else-if="source === 'custom' && customBaseUrlValid && !customBaseUrlSafe">公网 HTTP 会明文传输 API Key，请改用 HTTPS；本机 127.0.0.1 / localhost 可继续使用 HTTP。</template>
            <template v-else-if="source === 'custom' && customModelSearched && !customModelOptions.length && !activeModelTrimmed">未发现可用模型，可手动输入模型名称。</template>
            <template v-else-if="source === 'custom' && activeModelTrimmed.length > 160">检测模型不能超过 160 个字符。</template>
            <template v-else-if="source === 'custom'">自定义连接不会保存 API Key；将按 {{ modeLabel(mode) }}模式发起本次检测。</template>
            <template v-else-if="selectedRelay">
              已加载 {{ modelOptions.length }} 个模型；将通过 {{ selectedRelay.name }} 发起{{ modeLabel(mode) }}检测，可能产生少量 Token 消耗。
            </template>
          </div>
        </a-spin>
      </section>

      <section class="purity-output" aria-live="polite" aria-label="纯度检测结果">
        <div v-if="running" class="purity-live-state">
          <div class="purity-live-header">
            <div class="purity-live-title">
              <a-spin size="small" />
              <div>
                <strong>{{ cancelling ? '正在取消检测' : `正在执行${modeLabel(mode)}检测` }}</strong>
                <span>{{ liveProgress?.message ?? '正在连接中转站，等待第一项探针结果' }}</span>
              </div>
            </div>
            <span class="purity-live-elapsed">已用时 {{ formatElapsed(elapsedSeconds) }}</span>
          </div>

          <a-progress
            class="purity-live-progress"
            :percent="livePercent"
            :show-info="false"
            :status="cancelling ? 'exception' : 'active'"
          />

          <div class="purity-metrics purity-live-metrics" aria-label="实时检测指标">
            <div>
              <span>{{ liveGpt56 ? '当前阶段' : '已完成探针' }}</span>
              <strong v-if="liveGpt56">{{ gpt56StatusLabel(liveGpt56.stage) }}</strong>
              <strong v-else>{{ liveProgress?.completedChecks ?? 0 }} / {{ liveProgress?.totalChecks ?? '-' }}</strong>
            </div>
            <div>
              <span>成功响应</span>
              <strong>{{ formatInteger(liveProgress?.successfulRequests ?? 0) }} / {{ formatInteger(liveProgress?.requestCount ?? 0) }}</strong>
            </div>
            <div><span>Token</span><strong>{{ formatInteger(liveProgress?.usage.totalTokens ?? 0) }}</strong></div>
            <div><span>当前进度</span><strong>{{ livePercent }}%</strong></div>
          </div>

          <div v-if="liveGpt56" class="gpt56-live-panel" aria-label="GPT-5.6 实时证据链">
            <div class="gpt56-summary-grid">
              <div class="gpt56-summary-item">
                <span>加密状态</span>
                <a-tag :color="gpt56StatusColor(liveGpt56.encrypted.status)">{{ gpt56StatusLabel(liveGpt56.encrypted.status) }}</a-tag>
                <strong v-if="liveGpt56.encrypted.enabled">{{ liveGpt56.encrypted.attempts }} / {{ liveGpt56.encrypted.targetAttempts }} 轮</strong>
                <strong v-else>未配置</strong>
              </div>
              <div class="gpt56-summary-item">
                <span>Juice 指纹</span>
                <a-tag :color="gpt56StatusColor(liveGpt56.juice.status)">{{ gpt56StatusLabel(liveGpt56.juice.status) }}</a-tag>
                <strong>{{ liveGpt56.juice.likelyModel || '--' }}</strong>
              </div>
              <div class="gpt56-summary-item">
                <span>字面量对照</span>
                <a-tag :color="gpt56StatusColor(liveGpt56.literalControl.status)">{{ gpt56StatusLabel(liveGpt56.literalControl.status) }}</a-tag>
                <strong>{{ liveGpt56.literalControl.exact }} / 2 精确</strong>
              </div>
              <div class="gpt56-summary-item">
                <span>线路质量</span>
                <a-tag :color="gpt56StatusColor(liveGpt56.network.status)">{{ gpt56StatusLabel(liveGpt56.network.status) }}</a-tag>
                <strong>{{ liveGpt56.network.retryCount }} 次重试</strong>
              </div>
            </div>

            <div v-if="liveGpt56.encrypted.enabled" class="gpt56-control-grid">
              <div><span>完整状态</span><strong>{{ liveGpt56.encrypted.fullExact }} / {{ liveGpt56.encrypted.requiredMatches }}</strong></div>
              <div><span>去 ID</span><strong>{{ liveGpt56.encrypted.withoutIdsExact }} / {{ liveGpt56.encrypted.requiredMatches }}</strong></div>
              <div><span>仅正文</span><strong>{{ liveGpt56.encrypted.messageOnlyExact }}</strong></div>
              <div><span>损坏密文</span><strong>{{ liveGpt56.encrypted.corruptedCiphertextExact }}</strong></div>
            </div>

            <div class="gpt56-effort-list">
              <div v-for="effort in liveGpt56.juice.efforts" :key="effort.effort" class="gpt56-effort-row">
                <span>{{ gpt56EffortLabel(effort.effort) }}</span>
                <a-progress :percent="Math.round((effort.completed / effort.requested) * 100)" :show-info="false" size="small" />
                <strong>{{ effort.matchedSamples }} / {{ effort.completed || 0 }}</strong>
              </div>
            </div>
          </div>

          <div class="purity-check-section purity-live-checks">
            <div class="purity-section-heading">
              <div><h2>实时检测明细</h2><span>{{ liveChecks.length }} 项已返回</span></div>
              <span>结果会随探针完成持续更新</span>
            </div>

            <div v-if="liveChecks.length" class="purity-check-list">
              <article v-for="check in liveChecks" :key="check.id" class="purity-check-row">
                <div class="purity-check-status" :class="`status-${check.status}`" aria-hidden="true">
                  <CheckCircleOutlined v-if="check.status === 'pass'" />
                  <ExclamationCircleOutlined v-else-if="check.status === 'warning'" />
                  <CloseCircleOutlined v-else-if="check.status === 'fail'" />
                  <MinusCircleOutlined v-else />
                </div>
                <div class="purity-check-content">
                  <div class="purity-check-title">
                    <div>
                      <strong>{{ check.name }}</strong>
                      <a-tag :color="checkMeta[check.status].color">{{ checkMeta[check.status].label }}</a-tag>
                    </div>
                    <div class="purity-check-score">
                      <strong>{{ scoreText(check.score) }}</strong><span>{{ check.score === null ? '' : ' / 100' }}</span>
                    </div>
                  </div>
                  <p>{{ check.summary }}</p>
                  <ul v-if="check.evidence.length" class="purity-evidence">
                    <li v-for="(evidence, evidenceIndex) in check.evidence" :key="`${check.id}-${evidenceIndex}`">{{ evidence }}</li>
                  </ul>
                  <div class="purity-check-meta">
                    <span>权重 {{ check.weight }}</span>
                    <span>{{ check.requestCount }} 次请求</span>
                    <span>{{ formatDuration(check.durationMs) }}</span>
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="purity-live-pending">
              <a-spin size="small" />
              <span>第一项探针完成后将在此显示结果</span>
            </div>
          </div>
        </div>

        <template v-else-if="result">
          <div class="purity-result-actions">
            <a-button :loading="screenshotting" @click="captureResult">
              <template #icon><CameraOutlined /></template>
              {{ screenshotting ? '正在生成' : '截图' }}
            </a-button>
          </div>

          <div ref="resultCaptureRef" class="purity-capture">
            <div class="purity-result-header" :class="`tone-${verdictMeta[result.verdict].tone}`">
              <div class="purity-score">
                <a-progress
                  type="circle"
                  :percent="scorePercent"
                  :size="112"
                  :stroke-width="8"
                  :stroke-color="scoreColor(result)"
                  :format="formatProgress"
                />
                <span>{{ result.score === null ? '未评分' : '综合评分' }}</span>
              </div>

              <div class="purity-result-main">
                <div class="purity-result-title">
                  <h2>{{ result.relayName }}</h2>
                  <a-tag :color="verdictMeta[result.verdict].color">{{ verdictMeta[result.verdict].label }}</a-tag>
                  <a-tag>{{ confidenceLabels[result.confidence] }}</a-tag>
                </div>
                <p>{{ result.summary }}</p>
                <div class="purity-result-meta">
                  <span>{{ protocolLabel(result) }}</span>
                  <span>请求模型：<strong class="mono">{{ result.requestedModel || '默认模型' }}</strong></span>
                  <span>检测于 {{ formatTestedAt(result.testedAt) }}</span>
                </div>
                <div v-if="result.reportedModels.length" class="purity-reported-models">
                  <span>响应报告模型</span>
                  <a-tag v-for="reportedModel in result.reportedModels" :key="reportedModel" class="mono">
                    {{ reportedModel }}
                  </a-tag>
                </div>
              </div>
            </div>

            <div class="purity-metrics" aria-label="检测指标">
              <div><span>请求</span><strong>{{ formatInteger(result.requestCount) }}</strong></div>
              <div><span>成功响应</span><strong>{{ formatInteger(result.successfulRequests) }} / {{ formatInteger(result.requestCount) }}</strong></div>
              <div><span>Token</span><strong>{{ formatInteger(totalTokens) }}</strong></div>
              <div><span>总耗时</span><strong>{{ formatDuration(result.totalDuration) }}</strong></div>
            </div>

            <div v-if="resultGpt56" class="gpt56-report" aria-label="GPT-5.6 检测证据链">
              <div class="purity-section-heading">
                <div><h2>GPT-5.6 证据链</h2><span>Responses 专用</span></div>
                <a-tag :color="gpt56StatusColor(resultGpt56.stage)">{{ gpt56StatusLabel(resultGpt56.stage) }}</a-tag>
              </div>
              <div class="gpt56-summary-grid">
                <div class="gpt56-summary-item">
                  <span>加密状态兼容性</span>
                  <a-tag :color="gpt56StatusColor(resultGpt56.encrypted.status)">{{ gpt56StatusLabel(resultGpt56.encrypted.status) }}</a-tag>
                  <strong>{{ resultGpt56.encrypted.fullExact }} / {{ resultGpt56.encrypted.requiredMatches }} · {{ resultGpt56.encrypted.withoutIdsExact }} / {{ resultGpt56.encrypted.requiredMatches }}</strong>
                  <small>{{ resultGpt56.encrypted.summary }}</small>
                </div>
                <div class="gpt56-summary-item">
                  <span>Juice 型号指纹</span>
                  <a-tag :color="gpt56StatusColor(resultGpt56.juice.status)">{{ gpt56StatusLabel(resultGpt56.juice.status) }}</a-tag>
                  <strong>{{ resultGpt56.juice.likelyModel || '未分类' }}</strong>
                  <small>{{ resultGpt56.juice.summary }}</small>
                </div>
                <div class="gpt56-summary-item">
                  <span>字面量输出完整性</span>
                  <a-tag :color="gpt56StatusColor(resultGpt56.literalControl.status)">{{ gpt56StatusLabel(resultGpt56.literalControl.status) }}</a-tag>
                  <strong>{{ resultGpt56.literalControl.exact }} / {{ resultGpt56.literalControl.completed }} 精确</strong>
                  <small>{{ resultGpt56.literalControl.summary }}</small>
                </div>
                <div class="gpt56-summary-item">
                  <span>检测线路质量</span>
                  <a-tag :color="gpt56StatusColor(resultGpt56.network.status)">{{ gpt56StatusLabel(resultGpt56.network.status) }}</a-tag>
                  <strong>{{ resultGpt56.network.successfulRequests }} / {{ resultGpt56.network.requestCount }} 成功</strong>
                  <small>{{ resultGpt56.network.summary }}</small>
                </div>
              </div>

              <div v-if="resultGpt56.encrypted.enabled" class="gpt56-control-grid gpt56-result-controls">
                <div><span>可信挑战</span><strong>{{ resultGpt56.encrypted.attempts }} / {{ resultGpt56.encrypted.targetAttempts }}</strong></div>
                <div><span>可信端舍弃</span><strong>{{ resultGpt56.encrypted.trustedRejected }}</strong></div>
                <div><span>阴性命中</span><strong>{{ resultGpt56.encrypted.messageOnlyExact + resultGpt56.encrypted.corruptedCiphertextExact }}</strong></div>
                <div><span>候选请求错误</span><strong>{{ resultGpt56.encrypted.candidateErrors }}</strong></div>
              </div>

              <div class="gpt56-observation-table">
                <div class="gpt56-observation-head"><span>档位</span><span>结果</span><span>指纹候选</span><span>耗时</span></div>
                <div v-for="(observation, observationIndex) in resultGpt56.juice.observations" :key="`${observation.effort}-${observationIndex}`" class="gpt56-observation-row">
                  <span>{{ gpt56EffortLabel(observation.effort) }}</span>
                  <span>{{ observation.normalizedValue ?? gpt56StatusLabel(observation.status) }}</span>
                  <span>{{ observation.matchedModels.join(' · ') || '--' }}</span>
                  <span>{{ formatDuration(observation.durationMs) }}</span>
                </div>
              </div>
            </div>

            <div v-if="result.anomalies.length" class="purity-anomalies" role="status">
              <div class="purity-anomalies-title"><ExclamationCircleOutlined /><strong>需关注的异常信号</strong></div>
              <ul><li v-for="(anomaly, anomalyIndex) in result.anomalies" :key="`${anomalyIndex}-${anomaly}`">{{ anomaly }}</li></ul>
            </div>

            <div class="purity-check-section">
              <div class="purity-section-heading">
                <div><h2>检测明细</h2><span>{{ result.checks.length }} 项探针</span></div>
                <span>权重仅用于本次综合评分</span>
              </div>

              <div v-if="result.checks.length" class="purity-check-list">
                <article v-for="check in result.checks" :key="check.id" class="purity-check-row">
                  <div class="purity-check-status" :class="`status-${check.status}`" aria-hidden="true">
                    <CheckCircleOutlined v-if="check.status === 'pass'" />
                    <ExclamationCircleOutlined v-else-if="check.status === 'warning'" />
                    <CloseCircleOutlined v-else-if="check.status === 'fail'" />
                    <MinusCircleOutlined v-else />
                  </div>
                  <div class="purity-check-content">
                    <div class="purity-check-title">
                      <div>
                        <strong>{{ check.name }}</strong>
                        <a-tag :color="checkMeta[check.status].color">{{ checkMeta[check.status].label }}</a-tag>
                      </div>
                      <div class="purity-check-score">
                        <strong>{{ scoreText(check.score) }}</strong><span>{{ check.score === null ? '' : ' / 100' }}</span>
                      </div>
                    </div>
                    <p>{{ check.summary }}</p>
                    <ul v-if="check.evidence.length" class="purity-evidence">
                      <li v-for="(evidence, evidenceIndex) in check.evidence" :key="`${check.id}-${evidenceIndex}`">{{ evidence }}</li>
                    </ul>
                    <div class="purity-check-meta">
                      <span>权重 {{ check.weight }}</span>
                      <span>{{ check.requestCount }} 次请求</span>
                      <span>{{ formatDuration(check.durationMs) }}</span>
                    </div>
                  </div>
                </article>
              </div>
              <a-empty v-else :image="false" description="本次检测没有可展示的探针结果" />
            </div>

            <div class="purity-disclaimer">
              <InfoCircleOutlined />
              <span>{{ result.disclaimer || '黑盒检测无法证明真实上游，结果仅用于识别本次响应中的异常风险。' }}</span>
            </div>
          </div>
        </template>

        <div v-else class="purity-empty" role="status">
          <FileSearchOutlined class="purity-empty-icon" aria-hidden="true" />
          <span>尚无检测结果</span>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.purity-page-content { padding-bottom: 36px; }
.purity-runner { padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.purity-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.purity-title-row { display: flex; align-items: center; min-width: 0; gap: 9px; }
.purity-title-row h1 { margin: 0; font-size: 22px; line-height: 30px; font-weight: 650; }
.purity-title-row :deep(.ant-tag) { margin-inline-end: 0; }
.purity-title-icon { width: 24px; height: 24px; display: grid; flex: 0 0 auto; place-items: center; border-radius: 5px; background: var(--accent-soft); color: var(--accent); font-size: 15px; }
.purity-heading p { max-width: 760px; margin: 5px 0 0 33px; color: var(--muted); font-size: 13px; line-height: 20px; }
.purity-error { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #c95757 38%, var(--border)); border-radius: 6px; background: color-mix(in srgb, #c95757 8%, var(--surface)); overflow-wrap: anywhere; }
.purity-console { padding: 16px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; background: var(--surface); box-shadow: var(--shadow); }
.purity-console-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
.purity-console-heading { display: flex; min-width: 0; align-items: baseline; gap: 9px; }
.purity-console-heading span { color: var(--muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.purity-console-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.purity-source-switch { flex: 0 0 auto; }
.purity-source-fields { display: grid; align-items: end; gap: 14px; padding-top: 16px; }
.purity-saved-fields { grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); }
.purity-custom-fields { grid-template-columns: repeat(12, minmax(0, 1fr)); }
.purity-custom-url-field { grid-column: span 5; }
.purity-custom-fields > .purity-field:nth-child(2) { grid-column: span 4; }
.purity-custom-fields > .purity-field:nth-child(3) { grid-column: span 3; }
.purity-custom-model-field { grid-column: span 8; }
.purity-protocol-field { grid-column: span 4; }
.purity-field { display: block; min-width: 0; }
.purity-field-label { display: block; margin-bottom: 5px; color: var(--muted); font-size: 12px; }
.purity-field-label small { margin-left: 5px; color: var(--accent); font-size: 10px; }
.purity-field :deep(.ant-select), .purity-field :deep(.ant-segmented), .purity-field :deep(.ant-space-compact) { width: 100%; }
.purity-field :deep(.ant-input), .purity-field :deep(.ant-input-affix-wrapper), .purity-field :deep(.ant-auto-complete) { width: 100%; }
.purity-model-label { display: flex; justify-content: space-between; gap: 8px; }
.purity-model-label span:last-child { font-variant-numeric: tabular-nums; }
.purity-model-refresh { width: 34px; flex: 0 0 34px; }
.purity-model-discover { width: 38px; flex: 0 0 38px; }
.purity-mode-field :deep(.ant-segmented-item) { min-width: 0; flex: 1; text-align: center; }
.gpt56-config { margin-top: 16px; padding-top: 15px; border-top: 1px solid var(--border); }
.gpt56-config-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.gpt56-config-heading > div { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.gpt56-config-heading span { color: var(--text); font-size: 13px; font-weight: 600; }
.gpt56-config-heading small { color: var(--muted); font-size: 11px; }
.gpt56-config-heading :deep(.ant-tag) { flex: 0 0 auto; margin-inline-end: 0; }
.gpt56-config-fields { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 12px; }
.gpt56-config-fields > .purity-field:nth-child(1) { grid-column: span 2; }
.gpt56-config-fields > .purity-field:nth-child(2) { grid-column: span 4; }
.gpt56-config-fields > .purity-field:nth-child(3) { grid-column: span 3; }
.gpt56-config-fields > .purity-field:nth-child(4) { grid-column: span 3; }
.gpt56-trials-field :deep(.ant-input-number) { width: 100%; }
.purity-console-bottom { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--border); }
.purity-status-track { display: flex; min-width: 0; flex: 1 1 auto; flex-wrap: wrap; align-items: center; gap: 7px 15px; padding-bottom: 4px; color: var(--muted); font-size: 11px; }
.purity-status-item { display: inline-flex; min-width: 0; align-items: center; gap: 6px; }
.purity-status-item i { width: 6px; height: 6px; flex: 0 0 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.purity-status-item.is-loading i { background: #b7792d; box-shadow: 0 0 0 3px rgba(183,121,45,.13); }
.purity-status-item.is-error i { background: #c95757; box-shadow: 0 0 0 3px rgba(201,87,87,.13); }
.purity-status-item.is-waiting i { background: var(--muted); box-shadow: 0 0 0 3px color-mix(in srgb, var(--muted) 16%, transparent); }
.purity-status-model { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.purity-console-actions { display: flex; flex: 0 0 auto; align-items: flex-end; gap: 12px; }
.purity-console-actions .purity-mode-field { width: 296px; }
.purity-actions { width: 132px; min-width: 110px; }
.purity-actions :deep(.ant-btn) { width: 100%; }
.purity-relay-option { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: 12px; }
.purity-relay-option > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.purity-relay-option :deep(.ant-tag) { flex: 0 0 auto; margin-inline-end: 0; }
.purity-tool-note { min-height: 17px; margin-top: 9px; color: var(--muted); font-size: 11px; line-height: 17px; }
.purity-output { padding-top: 24px; }
.purity-live-state, .purity-empty { min-height: 320px; }
.purity-live-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.purity-live-title { display: flex; align-items: center; min-width: 0; gap: 12px; }
.purity-live-title > div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.purity-live-title strong { color: var(--text); font-size: 14px; }
.purity-live-title span, .purity-live-elapsed { color: var(--muted); font-size: 12px; }
.purity-live-title span { overflow-wrap: anywhere; }
.purity-live-elapsed { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.purity-live-progress { display: block; margin: 10px 0 0; line-height: 1; }
.purity-live-progress :deep(.ant-progress-inner) { display: block; }
.purity-live-metrics { margin-top: 10px; }
.gpt56-live-panel, .gpt56-report { margin-top: 20px; }
.gpt56-summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.gpt56-summary-item { display: flex; min-width: 0; flex-direction: column; gap: 5px; padding: 12px 14px; border-right: 1px solid var(--border); }
.gpt56-summary-item:last-child { border-right: 0; }
.gpt56-summary-item > span { color: var(--muted); font-size: 11px; }
.gpt56-summary-item :deep(.ant-tag) { align-self: flex-start; margin-inline-end: 0; }
.gpt56-summary-item strong { overflow: hidden; color: var(--text); font-size: 13px; line-height: 19px; text-overflow: ellipsis; white-space: nowrap; }
.gpt56-summary-item small { min-height: 34px; color: var(--muted); font-size: 11px; line-height: 17px; overflow-wrap: anywhere; }
.gpt56-control-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 10px; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-subtle); }
.gpt56-control-grid > div { min-width: 0; padding: 9px 12px; border-right: 1px solid var(--border); }
.gpt56-control-grid > div:last-child { border-right: 0; }
.gpt56-control-grid span { display: block; color: var(--muted); font-size: 11px; }
.gpt56-control-grid strong { display: block; margin-top: 3px; overflow: hidden; font-size: 14px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.gpt56-effort-list { display: grid; gap: 7px; margin-top: 12px; }
.gpt56-effort-row { display: grid; grid-template-columns: 42px minmax(0, 1fr) 60px; align-items: center; gap: 10px; color: var(--muted); font-size: 11px; }
.gpt56-effort-row > span { font-weight: 600; }
.gpt56-effort-row strong { color: var(--text); font-size: 11px; font-variant-numeric: tabular-nums; text-align: right; }
.gpt56-effort-row :deep(.ant-progress) { line-height: 1; }
.gpt56-observation-table { margin-top: 12px; overflow-x: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.gpt56-observation-head, .gpt56-observation-row { display: grid; grid-template-columns: 72px 100px minmax(180px, 1fr) 86px; min-width: 500px; gap: 12px; padding: 8px 10px; font-size: 12px; }
.gpt56-observation-head { color: var(--muted); font-size: 11px; background: var(--surface-subtle); }
.gpt56-observation-row { border-top: 1px solid var(--border); font-family: 'SFMono-Regular', Consolas, monospace; }
.gpt56-observation-row span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.purity-live-checks { padding-top: 20px; }
.purity-live-pending { display: flex; min-height: 150px; align-items: center; justify-content: center; gap: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.purity-empty { display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; color: var(--muted); font-size: 13px; }
.purity-empty-icon { color: var(--accent); font-size: 46px; line-height: 1; opacity: .72; }
.purity-result-actions { display: flex; justify-content: flex-end; margin-bottom: 12px; }
.purity-capture { display: flow-root; background: var(--app-bg); }
.purity-result-header { display: grid; grid-template-columns: 132px minmax(0, 1fr); align-items: center; gap: 22px; padding: 20px 22px; border: 1px solid var(--border); border-left-width: 4px; border-radius: 6px; background: var(--surface); }
.purity-result-header.tone-normal { border-left-color: #3e9b72; }
.purity-result-header.tone-likely { border-left-color: #4f7fa8; }
.purity-result-header.tone-suspicious { border-left-color: #b7792d; }
.purity-result-header.tone-abnormal { border-left-color: #c95757; }
.purity-result-header.tone-inconclusive { border-left-color: var(--muted); }
.purity-score { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
.purity-score :deep(.ant-progress-text) { color: var(--text); font-size: 25px; font-weight: 650; font-variant-numeric: tabular-nums; }
.purity-result-main { min-width: 0; }
.purity-result-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.purity-result-title h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 20px; line-height: 28px; }
.purity-result-title :deep(.ant-tag) { margin-inline-end: 0; }
.purity-result-main > p { max-width: 920px; margin: 7px 0 10px; color: var(--text); line-height: 22px; overflow-wrap: anywhere; }
.purity-result-meta { display: flex; flex-wrap: wrap; gap: 5px 18px; color: var(--muted); font-size: 12px; }
.purity-result-meta strong { color: var(--text); font-weight: 500; overflow-wrap: anywhere; }
.purity-reported-models { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.purity-reported-models > span { margin-right: 2px; color: var(--muted); font-size: 12px; }
.purity-reported-models :deep(.ant-tag) { max-width: 100%; margin-inline-end: 0; overflow: hidden; text-overflow: ellipsis; }
.purity-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 14px; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.purity-metrics > div { min-width: 0; padding: 12px 16px; border-right: 1px solid var(--border); }
.purity-metrics > div:last-child { border-right: 0; }
.purity-metrics span { display: block; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.purity-metrics strong { display: block; overflow: hidden; font-size: 16px; line-height: 22px; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.purity-anomalies { margin-top: 14px; padding: 12px 14px; border: 1px solid #ddc49d; border-radius: 6px; background: #fff8eb; }
.purity-anomalies-title { display: flex; align-items: center; gap: 8px; color: #a76a22; }
:global(:root[data-theme='dark']) .purity-anomalies { border-color: #70572f; background: #29231a; }
:global(:root[data-theme='dark']) .purity-anomalies-title { color: #d29a54; }
.purity-anomalies ul { margin: 8px 0 0; padding-left: 20px; color: var(--text); font-size: 13px; line-height: 20px; }
.purity-anomalies li { overflow-wrap: anywhere; }
.purity-anomalies li + li { margin-top: 3px; }
.purity-check-section { padding-top: 24px; }
.purity-section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.purity-section-heading > div { display: flex; align-items: baseline; gap: 9px; }
.purity-section-heading h2 { margin: 0; font-size: 17px; line-height: 24px; }
.purity-section-heading span { color: var(--muted); font-size: 11px; }
.purity-check-list { border-top: 1px solid var(--border); }
.purity-check-row { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 12px; padding: 15px 4px; border-bottom: 1px solid var(--border); }
.purity-check-status { width: 24px; height: 24px; display: grid; place-items: center; font-size: 17px; }
.purity-check-status.status-pass { color: #3e9b72; }
.purity-check-status.status-warning { color: #b7792d; }
.purity-check-status.status-fail { color: #c95757; }
.purity-check-status.status-skipped { color: var(--muted); }
.purity-check-content { min-width: 0; }
.purity-check-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.purity-check-title > div:first-child { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; gap: 8px; }
.purity-check-title :deep(.ant-tag) { margin-inline-end: 0; }
.purity-check-score { flex: 0 0 auto; min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
.purity-check-score strong { font-size: 16px; }
.purity-check-score span { color: var(--muted); font-size: 11px; }
.purity-check-content > p { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.purity-evidence { margin: 9px 0 0; padding: 8px 10px 8px 27px; border-radius: 4px; background: var(--surface-subtle); color: var(--text); font: 12px/19px 'SFMono-Regular', Consolas, monospace; }
.purity-evidence li { overflow-wrap: anywhere; }
.purity-evidence li + li { margin-top: 3px; }
.purity-check-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.purity-disclaimer { display: flex; align-items: flex-start; gap: 8px; margin-top: 18px; padding: 10px 12px; border-radius: 6px; background: var(--surface-subtle); color: var(--muted); font-size: 12px; line-height: 19px; }
.purity-disclaimer :deep(.anticon) { margin-top: 3px; flex: 0 0 auto; color: var(--accent); }
.purity-disclaimer span { overflow-wrap: anywhere; }

@media (max-width: 1000px) {
  .purity-custom-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .purity-custom-url-field,
  .purity-custom-fields > .purity-field:nth-child(2),
  .purity-custom-fields > .purity-field:nth-child(3),
  .purity-custom-model-field,
  .purity-protocol-field { grid-column: span 1; }
  .gpt56-config-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gpt56-config-fields > .purity-field:nth-child(n) { grid-column: span 1; }
  .purity-console-bottom { align-items: stretch; flex-direction: column; gap: 12px; }
  .purity-console-actions { justify-content: flex-end; }
  .purity-actions { display: flex; justify-content: flex-end; align-items: flex-end; }
  .purity-actions :deep(.ant-btn) { width: auto; min-width: 132px; }
}

@media (max-width: 620px) {
  .purity-heading p { margin-left: 0; }
  .purity-title-row { flex-wrap: wrap; }
  .purity-console { padding: 12px; }
  .purity-console-head { align-items: stretch; flex-direction: column; gap: 10px; }
  .purity-source-switch { width: 100%; }
  .purity-source-switch :deep(.ant-segmented-item) { flex: 1; text-align: center; }
  .purity-saved-fields, .purity-custom-fields { grid-template-columns: 1fr; }
  .purity-custom-url-field,
  .purity-custom-fields > .purity-field:nth-child(2),
  .purity-custom-fields > .purity-field:nth-child(3),
  .purity-custom-model-field,
  .purity-protocol-field { grid-column: span 1; }
  .gpt56-config-fields { grid-template-columns: 1fr; }
  .gpt56-config-fields > .purity-field:nth-child(n) { grid-column: span 1; }
  .purity-console-actions { align-items: stretch; flex-direction: column; }
  .purity-console-actions .purity-mode-field { width: 100%; }
  .purity-mode-field :deep(.ant-segmented-item-label) { padding-inline: 8px; }
  .purity-actions { width: 100%; }
  .purity-actions :deep(.ant-btn) { width: 100%; }
  .purity-status-track { gap: 7px 12px; }
  .purity-status-model { max-width: min(100%, 220px); }
  .purity-live-header { align-items: flex-start; flex-direction: column; gap: 8px; }
  .purity-live-elapsed { margin-left: 34px; }
  .purity-result-header { grid-template-columns: 1fr; gap: 14px; padding: 18px 16px; }
  .purity-score { justify-self: center; }
  .purity-result-main { text-align: center; }
  .purity-result-title, .purity-result-meta, .purity-reported-models { justify-content: center; }
  .purity-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .purity-metrics > div:nth-child(even) { border-right: 0; }
  .purity-metrics > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .gpt56-summary-grid, .gpt56-control-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .gpt56-summary-item:nth-child(even), .gpt56-control-grid > div:nth-child(even) { border-right: 0; }
  .gpt56-summary-item:nth-child(-n + 2), .gpt56-control-grid > div:nth-child(-n + 2) { border-bottom: 1px solid var(--border); }
  .purity-section-heading { align-items: flex-start; flex-direction: column; gap: 3px; }
  .purity-check-row { padding-inline: 0; }
}

@media (max-width: 420px) {
  .purity-metrics { grid-template-columns: 1fr; }
  .purity-metrics > div, .purity-metrics > div:nth-child(even) { border-right: 0; border-bottom: 1px solid var(--border); }
  .purity-metrics > div:last-child { border-bottom: 0; }
  .gpt56-summary-grid, .gpt56-control-grid { grid-template-columns: 1fr; }
  .gpt56-summary-item, .gpt56-summary-item:nth-child(even), .gpt56-control-grid > div, .gpt56-control-grid > div:nth-child(even) { border-right: 0; border-bottom: 1px solid var(--border); }
  .gpt56-summary-item:last-child, .gpt56-control-grid > div:last-child { border-bottom: 0; }
  .purity-check-title { flex-direction: column; gap: 6px; }
  .purity-check-score { text-align: left; }
}
</style>
