<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { ConfigProvider, theme as antTheme } from 'ant-design-vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';
import { useThemeStore } from './stores/theme';
import AppLayout from './components/AppLayout.vue';

const themeStore = useThemeStore();
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
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <AppLayout />
  </ConfigProvider>
</template>
