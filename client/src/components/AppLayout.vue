<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  ApiOutlined,
  CloudServerOutlined,
  HomeOutlined,
  PictureOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons-vue';
import { MessageSquare, Moon, Sun } from '@lucide/vue';
import { getCodexProxyStatus } from '../api/codex-accounts';
import { getPoolStatus } from '../api/pool';
import { useCodexProxyStatusStore } from '../stores/codex-proxy-status';
import { usePoolStatusStore } from '../stores/pool-status';
import { useThemeStore } from '../stores/theme';
import { isStandaloneExtensionRuntime } from '../utils/runtime';

const route = useRoute();
const router = useRouter();
const themeStore = useThemeStore();
const codexProxyStatusStore = useCodexProxyStatusStore();
const poolStatusStore = usePoolStatusStore();

const themeTrigger = ref<HTMLElement>();
const menuMode = 'horizontal' as const;

const activeKey = computed(() => {
  if (route.path.startsWith('/usage')) return '/usage';
  if (route.path.startsWith('/codex-accounts')) return '/codex-accounts';
  if (route.path.startsWith('/playground')) return '/playground';
  if (route.path.startsWith('/drawing')) return '/drawing';
  if (route.path.startsWith('/purity')) return '/purity';
  return '/';
});
const poolRunning = computed(() => poolStatusStore.running);
const codexProxyRunning = computed(() => codexProxyStatusStore.running);

const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  typeof window === 'undefined' ? '' : window.location.protocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

function onNavClick({ key }: { key: string }): void {
  if (key !== route.path) void router.push(key);
}

async function loadPoolStatus(): Promise<void> {
  try {
    poolStatusStore.setStatus(await getPoolStatus());
  } catch {
    // Keep the last confirmed state when a transient status refresh fails.
  }
}

async function loadCodexProxyStatus(): Promise<void> {
  try {
    codexProxyStatusStore.setStatus(await getCodexProxyStatus());
  } catch {
    // Keep the last confirmed state when a transient status refresh fails.
  }
}

function createThemeTransitionFallback(x: number, y: number): HTMLElement {
  document.querySelector('.theme-transition-fallback')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'theme-transition-fallback';
  overlay.style.setProperty('--theme-transition-x', `${x}px`);
  overlay.style.setProperty('--theme-transition-y', `${y}px`);
  overlay.style.setProperty('--theme-transition-from', getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim());
  overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
  document.body.append(overlay);
  window.setTimeout(() => overlay.remove(), 600);
  return overlay;
}

async function onThemeToggle(): Promise<void> {
  const mode = themeStore.isDark ? 'light' : 'dark';

  const triggerBounds = themeTrigger.value?.getBoundingClientRect();
  const supportsReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!triggerBounds || supportsReducedMotion) {
    themeStore.setMode(mode);
    return;
  }

  const x = triggerBounds.left + triggerBounds.width / 2;
  const y = triggerBounds.top + triggerBounds.height / 2;
  document.documentElement.style.setProperty('--theme-transition-x', `${x}px`);
  document.documentElement.style.setProperty('--theme-transition-y', `${y}px`);

  if (typeof document.startViewTransition === 'function') {
    const transition = document.startViewTransition(async () => {
      themeStore.setMode(mode);
      await nextTick();
    });
    await transition.finished;
    return;
  }

  const fallback = createThemeTransitionFallback(x, y);
  themeStore.setMode(mode);
  await nextTick();
  requestAnimationFrame(() => fallback.classList.add('is-transitioning'));
}

onMounted(() => {
  if (!standaloneExtension) {
    void loadPoolStatus();
    void loadCodexProxyStatus();
  }
});
watch(
  () => route.path,
  () => {
    if (!standaloneExtension) {
      void loadPoolStatus();
      void loadCodexProxyStatus();
    }
  }
);
</script>

<template>
  <div class="app-layout" :class="{ 'app-layout-dashboard': route.path === '/', 'app-layout-workspace': route.path.startsWith('/playground') }">
    <header class="app-sidebar">
      <div class="brand">
        <div class="brand-mark">RP</div>
        <div class="brand-copy"><strong>Relay Pulse</strong><span>AI 中转站连接测试</span></div>
      </div>
      <a-menu class="app-nav" :mode="menuMode" :selected-keys="[activeKey]" :disabled-overflow="true" @click="onNavClick">
        <a-menu-item key="/">
          <template #icon><HomeOutlined /></template>
          <span class="app-nav-text">中转站管理</span>
        </a-menu-item>
        <a-menu-item key="/usage">
          <template #icon><ApiOutlined /></template>
          <span class="app-nav-label">
            <span class="app-nav-text">我的号池</span>
            <span class="relay-dot app-nav-dot" :class="poolRunning ? 'success' : 'failed'"></span>
          </span>
        </a-menu-item>
        <a-menu-item v-if="!standaloneExtension" key="/codex-accounts">
          <template #icon><CloudServerOutlined /></template>
          <span class="app-nav-label">
            <span class="app-nav-text">GPT 账号</span>
            <span class="relay-dot app-nav-dot" :class="codexProxyRunning ? 'success' : 'failed'"></span>
          </span>
        </a-menu-item>
        <a-menu-item v-if="!standaloneExtension" key="/playground" aria-label="游乐场">
          <template #icon><MessageSquare :size="15" aria-hidden="true" /></template>
          <span class="app-nav-text">游乐场</span>
        </a-menu-item>
        <a-menu-item v-if="!standaloneExtension" key="/purity">
          <template #icon><SafetyCertificateOutlined /></template>
          <span class="app-nav-text">中转站掺水检测</span>
        </a-menu-item>
        <a-menu-item v-if="!standaloneExtension" key="/drawing">
          <template #icon><PictureOutlined /></template>
          <span class="app-nav-text">绘图</span>
        </a-menu-item>
      </a-menu>
      <span ref="themeTrigger" class="app-theme-trigger">
        <a-tooltip :title="themeStore.isDark ? '切换到浅色模式' : '切换到深色模式'">
          <a-button
            class="theme-toggle"
            shape="circle"
            :aria-label="themeStore.isDark ? '切换到浅色模式' : '切换到深色模式'"
            :aria-pressed="themeStore.isDark"
            @click="onThemeToggle"
          >
            <template #icon>
              <Sun v-if="themeStore.isDark" :size="18" :stroke-width="1.9" aria-hidden="true" />
              <Moon v-else :size="18" :stroke-width="1.9" aria-hidden="true" />
            </template>
          </a-button>
        </a-tooltip>
      </span>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-layout { display: flex; flex-direction: column; min-height: 100vh; }
.app-sidebar {
  position: sticky;
  top: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  flex: 0 0 64px;
  gap: 20px;
  width: 100%;
  height: 64px;
  padding: 8px clamp(16px, 3vw, 48px);
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(12px);
}
.app-sidebar .brand { min-width: 0; padding: 6px 8px; }
.app-nav { min-width: 0; justify-content: center; justify-self: center; border-bottom: 0; background: transparent; }
.app-nav :deep(.ant-menu-item) {
  width: auto;
  height: 40px;
  margin: 0 3px;
  padding-inline: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-subtle);
  color: var(--text);
  line-height: 38px;
}
.app-nav :deep(.ant-menu-item::after) { display: none; }
.app-nav :deep(.ant-menu-item:hover) { border-color: var(--accent); color: var(--accent); }
.app-nav :deep(.ant-menu-item-selected) {
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.app-nav :deep(.ant-menu-item-selected::after) { display: none; }
.app-nav-label { display: inline-flex; align-items: center; gap: 8px; }
.app-nav-dot { transform: none; }
.app-sidebar > .app-theme-trigger { display: flex; justify-self: end; padding: 0 8px; }
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  min-width: 40px;
  height: 40px;
  padding: 0;
  border-color: var(--border);
  background: var(--surface-subtle);
  color: var(--text);
  transition: border-color .16s ease, background-color .16s ease, color .16s ease;
}
.theme-toggle :deep(.ant-btn-icon) { display: inline-flex; align-items: center; }
.theme-toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 56%, transparent);
  outline-offset: 2px;
}
.theme-toggle:hover,
.theme-toggle:focus-visible {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent);
}
.app-main { flex: 1; min-width: 0; min-height: 0; }
.app-layout-dashboard { height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; }
.app-layout-dashboard .app-main { height: auto; min-height: 0; overflow: hidden; }
.app-layout-workspace { height: 100vh; height: 100dvh; min-height: 0; overflow: hidden; }
.app-layout-workspace .app-main { height: auto; min-height: 0; overflow: hidden; }

@media (max-width: 900px) {
  .app-sidebar { grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto; gap: 12px; padding: 8px 16px; }
  .app-nav { justify-content: flex-start; justify-self: stretch; overflow-x: auto; scrollbar-width: none; }
  .app-nav::-webkit-scrollbar { display: none; }
  .app-nav :deep(.ant-menu-item) { margin-inline: 2px; padding-inline: 11px; }
  .app-sidebar > .app-theme-trigger { padding: 0; }
}

@media (max-width: 560px) {
  .app-sidebar { height: 60px; flex-basis: 60px; gap: 8px; padding-inline: 10px; }
  .app-sidebar .brand { gap: 8px; padding-inline: 0; }
  .app-sidebar .brand-mark { width: 30px; height: 30px; font-size: 12px; }
  .app-sidebar .brand-copy { display: none; }
  .app-nav-text { display: none; }
  .app-nav :deep(.ant-menu-item) { width: 40px; padding-inline: 0; text-align: center; }
  .app-nav :deep(.ant-menu-item .ant-menu-item-icon) { margin-inline-end: 0; }
  .app-nav-label { gap: 0; }
}
</style>
