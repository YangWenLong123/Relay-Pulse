import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { CodexProxyStatus } from '../types';

export const useCodexProxyStatusStore = defineStore('codex-proxy-status', () => {
  const status = ref<CodexProxyStatus>();
  const running = computed(() => status.value?.active === true);

  function setStatus(value: CodexProxyStatus): void {
    status.value = value;
  }

  return { status, running, setStatus };
});
