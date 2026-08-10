import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { PoolStatus } from '../types';

export const usePoolStatusStore = defineStore('pool-status', () => {
  const status = ref<PoolStatus>();
  const running = computed(() => status.value?.active === true);

  function setStatus(value: PoolStatus): void {
    status.value = value;
  }

  return { status, running, setStatus };
});
