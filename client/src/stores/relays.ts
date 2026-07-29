import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import * as api from '../api/relays';
import type { Relay, RelayFormValue, TestResult } from '../types';

export const useRelayStore = defineStore('relays', () => {
  const relays = ref<Relay[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const refreshingBalanceIds = ref<Set<string>>(new Set());
  let balanceRefreshTimer: number | undefined;

  const stats = computed(() => ({
    total: relays.value.length,
    enabled: relays.value.filter((relay) => relay.enabled).length,
    success: relays.value.filter((relay) => relay.lastTestStatus === 'success').length,
    failed: relays.value.filter((relay) => relay.lastTestStatus === 'failed').length
  }));

  async function fetchRelays(): Promise<void> {
    loading.value = true;
    try {
      relays.value = await api.listRelays();
      loaded.value = true;
      void refreshDueBalances();
    } finally {
      loading.value = false;
    }
  }

  async function create(value: RelayFormValue): Promise<Relay> {
    const relay = await api.createRelay(value);
    relays.value = [relay, ...relays.value];
    return relay;
  }

  async function update(id: string, value: Partial<RelayFormValue>): Promise<Relay> {
    const relay = await api.updateRelay(id, value);
    replace(relay);
    return relay;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteRelay(id);
    relays.value = relays.value.filter((relay) => relay.id !== id);
  }

  async function duplicate(id: string): Promise<Relay> {
    const relay = await api.duplicateRelay(id);
    relays.value = [relay, ...relays.value];
    return relay;
  }

  async function batchToggle(ids: string[], enabled: boolean): Promise<void> {
    const updated = await api.batchToggleRelays(ids, enabled);
    const map = new Map(updated.map((relay) => [relay.id, relay]));
    relays.value = relays.value.map((relay) => map.get(relay.id) ?? relay);
  }

  async function queryBalance(id: string): Promise<Relay> {
    if (refreshingBalanceIds.value.has(id)) {
      const existing = relays.value.find((relay) => relay.id === id);
      if (!existing) throw new Error('中转站不存在');
      return existing;
    }
    refreshingBalanceIds.value = new Set(refreshingBalanceIds.value).add(id);
    try {
      const relay = await api.queryRelayBalance(id);
      replace(relay);
      return relay;
    } finally {
      const next = new Set(refreshingBalanceIds.value);
      next.delete(id);
      refreshingBalanceIds.value = next;
    }
  }

  async function refreshDueBalances(): Promise<void> {
    const now = Date.now();
    const due = relays.value.filter((relay) => {
      const config = relay.balanceConfig;
      if (!config?.enabled || refreshingBalanceIds.value.has(relay.id)) return false;
      if (!relay.balance?.queriedAt) return true;
      const last = Date.parse(relay.balance.queriedAt);
      return config.intervalMinutes > 0 && Number.isFinite(last) && now - last >= config.intervalMinutes * 60_000;
    });
    await Promise.allSettled(due.map((relay) => queryBalance(relay.id)));
  }

  function startBalanceAutoRefresh(): void {
    if (balanceRefreshTimer !== undefined) return;
    balanceRefreshTimer = window.setInterval(() => void refreshDueBalances(), 60_000);
  }

  function stopBalanceAutoRefresh(): void {
    if (balanceRefreshTimer === undefined) return;
    window.clearInterval(balanceRefreshTimer);
    balanceRefreshTimer = undefined;
  }

  function applyResult(result: TestResult): void {
    const relay = relays.value.find((item) => item.id === result.relayId);
    if (!relay) return;
    replace({
      ...relay,
      lastTestAt: result.testedAt,
      lastTestStatus: result.success ? 'success' : 'failed',
      lastLatency: result.totalDuration
    });
  }

  function replace(relay: Relay): void {
    relays.value = relays.value.map((item) => (item.id === relay.id ? relay : item));
  }

  return {
    relays,
    loading,
    loaded,
    refreshingBalanceIds,
    stats,
    fetchRelays,
    create,
    update,
    remove,
    duplicate,
    batchToggle,
    queryBalance,
    refreshDueBalances,
    startBalanceAutoRefresh,
    stopBalanceAutoRefresh,
    applyResult
  };
});
