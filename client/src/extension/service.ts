import type { BalanceConfigFormValue, BalanceTemplate, Relay, RelayFormValue, RelayProtocol, TestErrorType, TestResult } from '../types';
import { queryBalance } from './balance-query';
import { ExtensionRelayTester, type RelayTestClient } from './relay-tester';
import { normalizeBaseUrl, publicRelay, type StoredRelay } from './relay-utils';
import type { ExtensionStorage } from './storage';

const stateKey = 'relay-pulse-state-v1';
const protocols = new Set<RelayProtocol>(['auto', 'responses', 'chat']);
const balanceTemplates = new Set<BalanceTemplate>(['generic', 'newapi']);
const testErrorTypes = new Set<TestErrorType>([
  'auth',
  'rate_limit',
  'model_not_found',
  'not_found',
  'server',
  'timeout',
  'cancelled',
  'dns',
  'connection',
  'tls',
  'network',
  'invalid_response',
  'http_error',
  null
]);

interface ExtensionState {
  version: 1;
  relays: StoredRelay[];
  history: TestResult[];
}

export interface ExtensionHistoryQuery {
  relayId?: string;
  success?: boolean;
  from?: string;
  to?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredRelay(value: unknown): value is StoredRelay {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.baseUrl === 'string' &&
    typeof value.apiKey === 'string' &&
    typeof value.model === 'string' &&
    protocols.has(value.protocol as RelayProtocol) &&
    typeof value.enabled === 'boolean' &&
    typeof value.timeout === 'number' &&
    typeof value.remark === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastTestAt === null || typeof value.lastTestAt === 'string') &&
    ['success', 'failed', 'untested'].includes(String(value.lastTestStatus)) &&
    (value.lastLatency === null || typeof value.lastLatency === 'number') &&
    (value.balanceConfig === undefined || isBalanceConfig(value.balanceConfig))
  );
}

function isBalanceConfig(value: unknown): value is BalanceConfigFormValue {
  if (!isRecord(value)) return false;
  return (
    balanceTemplates.has(value.template as BalanceTemplate) &&
    typeof value.requestUrl === 'string' &&
    (value.apiKey === undefined || typeof value.apiKey === 'string') &&
    (value.accessToken === undefined || typeof value.accessToken === 'string') &&
    typeof value.userId === 'string' &&
    typeof value.timeout === 'number' &&
    typeof value.intervalMinutes === 'number' &&
    typeof value.enabled === 'boolean'
  );
}

function isTestResult(value: unknown): value is TestResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.success === 'boolean' &&
    typeof value.relayId === 'string' &&
    typeof value.relayName === 'string' &&
    typeof value.model === 'string' &&
    (value.protocol === 'responses' || value.protocol === 'chat') &&
    (value.statusCode === null || typeof value.statusCode === 'number') &&
    typeof value.responseText === 'string' &&
    typeof value.totalDuration === 'number' &&
    testErrorTypes.has(value.errorType as TestErrorType) &&
    typeof value.errorMessage === 'string' &&
    typeof value.testedAt === 'string'
  );
}

function initialState(): ExtensionState {
  return { version: 1, relays: [], history: [] };
}

function cloneState(state: ExtensionState): ExtensionState {
  return {
    version: 1,
    relays: state.relays.map((relay) => ({ ...relay })),
    history: state.history.map((result) => ({ ...result }))
  };
}

function validateState(value: unknown): ExtensionState {
  if (value === undefined) return initialState();
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.relays) ||
    !value.relays.every(isStoredRelay) ||
    !Array.isArray(value.history) ||
    !value.history.every(isTestResult)
  ) {
    throw new Error('浏览器扩展存储数据格式错误，原数据未被覆盖');
  }
  return value as unknown as ExtensionState;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请输入${label}`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function apiKey(value: unknown): string {
  const normalized = text(value, 'API Key', 500);
  if (/[\r\n]/.test(normalized)) throw new Error('API Key 不能包含换行符');
  return normalized;
}

function protocol(value: unknown): RelayProtocol {
  if (!protocols.has(value as RelayProtocol)) throw new Error('请求协议无效');
  return value as RelayProtocol;
}

function timeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000 || value > 120000) {
    throw new Error('超时时间必须是 1000 到 120000 毫秒之间的整数');
  }
  return value;
}

function remark(value: unknown): string {
  if (typeof value !== 'string') throw new Error('备注格式错误');
  const normalized = value.trim();
  if (normalized.length > 500) throw new Error('备注不能超过 500 个字符');
  return normalized;
}

function balanceConfig(value: BalanceConfigFormValue, current?: BalanceConfigFormValue): BalanceConfigFormValue {
  const requestUrl = value.requestUrl.trim();
  if (requestUrl) normalizeBaseUrl(requestUrl);
  if (!balanceTemplates.has(value.template)) throw new Error('余额模板无效');
  if (!Number.isInteger(value.timeout) || value.timeout < 1000 || value.timeout > 120000) throw new Error('余额查询超时时间必须是 1000 到 120000 毫秒之间的整数');
  if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 0 || value.intervalMinutes > 1440) throw new Error('自动查询间隔必须是 0 到 1440 分钟之间的整数');
  const apiKeyValue = value.apiKey?.trim();
  const accessToken = value.accessToken?.trim();
  if ((apiKeyValue && /[\r\n]/.test(apiKeyValue)) || (accessToken && /[\r\n]/.test(accessToken))) throw new Error('余额查询凭证不能包含换行符');
  const userId = value.userId.trim();
  if (userId.length > 160) throw new Error('用户 ID 不能超过 160 个字符');
  return {
    template: value.template,
    requestUrl,
    apiKey: apiKeyValue || current?.apiKey,
    accessToken: accessToken || current?.accessToken,
    userId,
    timeout: value.timeout,
    intervalMinutes: value.intervalMinutes,
    enabled: value.enabled
  };
}

function id(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function abortError(): DOMException {
  return new DOMException('请求已取消', 'AbortError');
}

export class ExtensionRelayService {
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly activeTests = new Map<string, Set<AbortController>>();

  constructor(
    private readonly storage: ExtensionStorage,
    private readonly tester: RelayTestClient = new ExtensionRelayTester(),
    private readonly historyLimit = 1000
  ) {}

  async listRelays(): Promise<Relay[]> {
    return (await this.readState()).relays.map(publicRelay);
  }

  async createRelay(value: RelayFormValue): Promise<Relay> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const relay: StoredRelay = {
        id: id(),
        name: text(value.name, '名称', 80),
        baseUrl: normalizeBaseUrl(text(value.baseUrl, 'Base URL', 500)),
        apiKey: apiKey(value.apiKey),
        model: text(value.model, '模型', 160),
        protocol: protocol(value.protocol),
        enabled: value.enabled,
        timeout: timeout(value.timeout),
        remark: remark(value.remark),
        createdAt: now,
        updatedAt: now,
        lastTestAt: null,
        lastTestStatus: 'untested',
        lastLatency: null,
        balanceConfig: value.balanceConfig ? balanceConfig(value.balanceConfig) : undefined
      };
      state.relays.unshift(relay);
      return publicRelay(relay);
    });
  }

  async updateRelay(relayId: string, value: Partial<RelayFormValue>): Promise<Relay> {
    return this.mutate((state) => {
      const index = state.relays.findIndex((relay) => relay.id === relayId);
      if (index < 0) throw new Error('中转站不存在');
      const current = state.relays[index]!;
      const next: StoredRelay = {
        ...current,
        name: value.name === undefined ? current.name : text(value.name, '名称', 80),
        baseUrl: value.baseUrl === undefined ? current.baseUrl : normalizeBaseUrl(text(value.baseUrl, 'Base URL', 500)),
        apiKey: value.apiKey?.trim() ? apiKey(value.apiKey) : current.apiKey,
        model: value.model === undefined ? current.model : text(value.model, '模型', 160),
        protocol: value.protocol === undefined ? current.protocol : protocol(value.protocol),
        enabled: value.enabled === undefined ? current.enabled : value.enabled,
        timeout: value.timeout === undefined ? current.timeout : timeout(value.timeout),
        remark: value.remark === undefined ? current.remark : remark(value.remark),
        balanceConfig: value.balanceConfig === undefined ? current.balanceConfig : balanceConfig(value.balanceConfig, current.balanceConfig),
        updatedAt: new Date().toISOString()
      };
      state.relays[index] = next;
      return publicRelay(next);
    });
  }

  async deleteRelay(relayId: string): Promise<void> {
    await this.cancelRelayTest(relayId);
    await this.mutate((state) => {
      const length = state.relays.length;
      state.relays = state.relays.filter((relay) => relay.id !== relayId);
      if (state.relays.length === length) throw new Error('中转站不存在');
    });
  }

  async duplicateRelay(relayId: string): Promise<Relay> {
    return this.mutate((state) => {
      const source = state.relays.find((relay) => relay.id === relayId);
      if (!source) throw new Error('中转站不存在');
      const now = new Date().toISOString();
      const duplicate: StoredRelay = {
        ...source,
        id: id(),
        name: `${source.name} 副本`.slice(0, 80),
        createdAt: now,
        updatedAt: now,
        lastTestAt: null,
        lastTestStatus: 'untested',
        lastLatency: null
      };
      state.relays.unshift(duplicate);
      return publicRelay(duplicate);
    });
  }

  async getRelayApiKey(relayId: string): Promise<string> {
    return (await this.findStoredRelay(relayId)).apiKey;
  }

  async getRelayBalanceCredentials(relayId: string): Promise<{ apiKey: string; accessToken: string }> {
    const balanceConfig = (await this.findStoredRelay(relayId)).balanceConfig;
    return { apiKey: balanceConfig?.apiKey ?? '', accessToken: balanceConfig?.accessToken ?? '' };
  }

  async batchToggleRelays(relayIds: string[], enabled: boolean): Promise<Relay[]> {
    return this.mutate((state) => {
      const idSet = new Set(relayIds);
      const missing = relayIds.find((relayId) => !state.relays.some((relay) => relay.id === relayId));
      if (missing) throw new Error(`中转站不存在：${missing}`);
      const updatedAt = new Date().toISOString();
      state.relays = state.relays.map((relay) => idSet.has(relay.id) ? { ...relay, enabled, updatedAt } : relay);
      return state.relays.filter((relay) => idSet.has(relay.id)).map(publicRelay);
    });
  }

  async testRelay(
    relayId: string,
    value: { model?: string; message?: string; protocol?: RelayProtocol },
    signal?: AbortSignal
  ): Promise<TestResult> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.registerTest(relayId, controller);
    try {
      const relay = await this.findStoredRelay(relayId);
      if (!relay.enabled) throw new Error('该中转站已停用');
      const options = {
        model: value.model === undefined ? undefined : text(value.model, '模型', 160),
        message: value.message === undefined ? 'hi' : text(value.message, '测试消息', 4000),
        protocol: value.protocol === undefined ? undefined : protocol(value.protocol),
        signal: controller.signal
      };
      const result = await this.tester.test(relay, options);
      await this.saveTestResult(result);
      if (controller.signal.aborted || result.errorType === 'cancelled') throw abortError();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.unregisterTest(relayId, controller);
    }
  }

  async discoverRelayModels(relayId: string, signal?: AbortSignal): Promise<string[]> {
    const relay = await this.findStoredRelay(relayId);
    return this.tester.discoverModels(relay, signal);
  }

  async queryBalance(relayId: string, signal?: AbortSignal): Promise<Relay> {
    const relay = await this.findStoredRelay(relayId);
    const balance = await queryBalance(relay, signal);
    return this.mutate((state) => {
      const index = state.relays.findIndex((item) => item.id === relayId);
      if (index < 0) throw new Error('中转站不存在');
      const updated = { ...state.relays[index]!, balance, updatedAt: new Date().toISOString() };
      state.relays[index] = updated;
      return publicRelay(updated);
    });
  }

  async discoverDraftModels(
    value: { baseUrl: string; apiKey: string; timeout: number },
    signal?: AbortSignal
  ): Promise<string[]> {
    return this.tester.discoverModels(
      {
        baseUrl: normalizeBaseUrl(text(value.baseUrl, 'Base URL', 500)),
        apiKey: apiKey(value.apiKey),
        timeout: timeout(value.timeout)
      },
      signal
    );
  }

  async listHistory(query: ExtensionHistoryQuery = {}, signal?: AbortSignal): Promise<TestResult[]> {
    if (signal?.aborted) throw abortError();
    const state = await this.readState();
    if (signal?.aborted) throw abortError();
    const from = query.from ? Date.parse(query.from) : null;
    const to = query.to ? Date.parse(query.to) : null;
    return state.history.filter((result) => {
      const testedAt = Date.parse(result.testedAt);
      return (
        (!query.relayId || result.relayId === query.relayId) &&
        (query.success === undefined || result.success === query.success) &&
        (from === null || testedAt >= from) &&
        (to === null || testedAt <= to)
      );
    });
  }

  async deleteHistory(historyId: string): Promise<void> {
    await this.mutate((state) => {
      const length = state.history.length;
      state.history = state.history.filter((result) => result.id !== historyId);
      if (state.history.length === length) throw new Error('历史记录不存在');
    });
  }

  async clearHistory(): Promise<void> {
    await this.mutate((state) => {
      state.history = [];
    });
  }

  async cancelRelayTest(relayId: string): Promise<void> {
    for (const controller of this.activeTests.get(relayId) ?? []) controller.abort();
  }

  private async findStoredRelay(relayId: string): Promise<StoredRelay> {
    const relay = (await this.readState()).relays.find((item) => item.id === relayId);
    if (!relay) throw new Error('中转站不存在');
    return { ...relay };
  }

  private async saveTestResult(result: TestResult): Promise<void> {
    await this.mutate((state) => {
      const index = state.relays.findIndex((relay) => relay.id === result.relayId);
      if (index >= 0) {
        state.relays[index] = {
          ...state.relays[index]!,
          lastTestAt: result.testedAt,
          lastTestStatus: result.success ? 'success' : 'failed',
          lastLatency: result.totalDuration,
          updatedAt: new Date().toISOString()
        };
      }
      state.history = [result, ...state.history].slice(0, this.historyLimit);
    });
  }

  private registerTest(relayId: string, controller: AbortController): void {
    const tests = this.activeTests.get(relayId) ?? new Set<AbortController>();
    tests.add(controller);
    this.activeTests.set(relayId, tests);
  }

  private unregisterTest(relayId: string, controller: AbortController): void {
    const tests = this.activeTests.get(relayId);
    if (!tests) return;
    tests.delete(controller);
    if (!tests.size) this.activeTests.delete(relayId);
  }

  private async readState(): Promise<ExtensionState> {
    await this.writeQueue;
    return cloneState(validateState(await this.storage.get<unknown>(stateKey)));
  }

  private mutate<T>(mutation: (state: ExtensionState) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const state = cloneState(validateState(await this.storage.get<unknown>(stateKey)));
      const result = mutation(state);
      await this.storage.set({ [stateKey]: state });
      return result;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
