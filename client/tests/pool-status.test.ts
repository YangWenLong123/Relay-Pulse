import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePoolStatusStore } from '../src/stores/pool-status';
import type { PoolStatus } from '../src/types';

const stoppedStatus: PoolStatus = {
  active: false,
  host: '127.0.0.1',
  port: null,
  baseUrl: null,
  startedAt: null,
  eligibleRelayCount: 0,
  cooldownRelayCount: 0,
  routingStrategy: 'round-robin',
  relayIds: [],
  modelMap: {},
  platform: null,
  apiKey: '',
  balanceSummary: [],
  balanceDetails: []
};

beforeEach(() => setActivePinia(createPinia()));

describe('pool status store', () => {
  it('shares service start and stop state with layout consumers immediately', () => {
    const workspaceStore = usePoolStatusStore();
    const layoutStore = usePoolStatusStore();

    workspaceStore.setStatus({ ...stoppedStatus, active: true, port: 58130 });
    expect(layoutStore.running).toBe(true);
    expect(layoutStore.status?.port).toBe(58130);

    workspaceStore.setStatus(stoppedStatus);
    expect(layoutStore.running).toBe(false);
  });
});
