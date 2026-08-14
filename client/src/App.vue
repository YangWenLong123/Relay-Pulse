<script setup lang="ts">
import { computed, onMounted, ref, watchEffect } from 'vue';
import { ConfigProvider, theme as antTheme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { setHttpApiBaseUrl } from './api/http';
import { useThemeStore } from './stores/theme';
import AppLayout from './components/AppLayout.vue';
import { ensureExtensionBackend, requiresExtensionBackend } from './extension/backend';

const themeStore = useThemeStore();
const needsExtensionBackend = requiresExtensionBackend();
const startupState = ref<'starting' | 'ready' | 'failed'>(needsExtensionBackend ? 'starting' : 'ready');
const startupError = ref('');
const themeConfig = computed(() => ({
  algorithm: themeStore.isDark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
  token: {
    colorPrimary: themeStore.isDark ? '#68a7a1' : '#397c78',
    colorInfo: themeStore.isDark ? '#78a9d1' : '#4f7fa8',
    borderRadius: 6,
    fontFamily: "Inter, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  }
}));

watchEffect(() => {
  document.documentElement.dataset.theme = themeStore.isDark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeStore.isDark ? '#151918' : '#f5f7f6');
});

async function startExtensionBackend(): Promise<void> {
  if (!needsExtensionBackend) return;

  startupState.value = 'starting';
  startupError.value = '';
  let result: Awaited<ReturnType<typeof ensureExtensionBackend>>;
  try {
    result = await ensureExtensionBackend();
  } catch (error) {
    startupError.value = error instanceof Error ? error.message : '无法启动本机服务';
    startupState.value = 'failed';
    return;
  }
  if (result.ok && result.apiUrl) {
    setHttpApiBaseUrl(result.apiUrl, result.extensionToken);
    startupState.value = 'ready';
    return;
  }

  startupError.value = result.error?.message ?? '无法启动本机服务';
  startupState.value = 'failed';
}

onMounted(() => {
  void startExtensionBackend();
});
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <div v-if="startupState === 'starting'" class="extension-backend-state" role="status">
      <a-spin />
      <span>正在连接本机服务…</span>
    </div>
    <main v-else-if="startupState === 'failed'" class="extension-backend-state extension-backend-error">
      <a-alert type="error" show-icon message="本机服务不可用" :description="startupError" />
      <a-button type="primary" @click="startExtensionBackend">重试</a-button>
      <p>请先运行配套后端目录中的本机服务组件安装脚本。</p>
    </main>
    <AppLayout v-else />
  </ConfigProvider>
</template>

<style scoped>
.extension-backend-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 100vh;
  padding: 24px;
  color: var(--text);
}

.extension-backend-error {
  flex-direction: column;
  align-items: stretch;
  width: min(520px, 100%);
  margin: 0 auto;
}

.extension-backend-error :deep(.ant-btn) {
  align-self: center;
}

.extension-backend-error p {
  margin: 0;
  color: var(--muted);
  text-align: center;
}
</style>
