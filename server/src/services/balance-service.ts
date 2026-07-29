import { endpointUrl } from '../lib/relay-utils.js';
import { HttpError } from '../lib/http-error.js';
import { RelayRepository } from '../repositories/relay-repository.js';
import type { BalanceSnapshot, Relay } from '../types.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function field(record: JsonRecord, key: string): unknown {
  return record[key];
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const result = numberValue(value);
    if (result !== null) return result;
  }
  return null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function payloadRecord(payload: unknown): JsonRecord {
  if (!isRecord(payload)) throw new Error('余额接口返回格式无效');
  return isRecord(payload.data) ? payload.data : payload;
}

function genericSnapshot(payload: unknown): Omit<BalanceSnapshot, 'success' | 'errorMessage' | 'queriedAt'> {
  const data = payloadRecord(payload);
  const quota = isRecord(data.quota) ? data.quota : {};
  const total = firstNumber(field(data, 'total'), field(quota, 'total'), field(data, 'limit'));
  const used = firstNumber(field(data, 'used'), field(quota, 'used'), field(data, 'usedQuota'));
  const remaining = firstNumber(field(data, 'remaining'), field(quota, 'remaining'), field(data, 'balance')) ??
    (total !== null && used !== null ? total - used : null);
  if (remaining === null) throw new Error('返回内容不包含可识别的余额字段');
  return {
    remaining,
    total,
    used,
    unit: text(field(data, 'unit'), text(field(quota, 'unit'), 'USD')),
    planName: text(field(data, 'planName'), text(field(data, 'plan'), ''))
  };
}

function newApiSnapshot(payload: unknown): Omit<BalanceSnapshot, 'success' | 'errorMessage' | 'queriedAt'> {
  if (!isRecord(payload)) throw new Error('余额接口返回格式无效');
  if (payload.success !== true || !isRecord(payload.data)) throw new Error(text(payload.message, '查询失败'));
  const data = payload.data;
  const quota = numberValue(data.quota);
  const usedQuota = numberValue(data.used_quota ?? data.usedQuota);
  if (quota === null || usedQuota === null) throw new Error('返回内容不包含可识别的额度字段');
  return {
    remaining: quota / 500000,
    total: (quota + usedQuota) / 500000,
    used: usedQuota / 500000,
    unit: 'USD',
    planName: text(data.group, '默认套餐')
  };
}

function requestUrl(relay: Relay): string {
  const config = relay.balanceConfig!;
  const endpoint = config.template === 'newapi' ? '/api/user/self' : '/v1/usage';
  const base = config.requestUrl || relay.baseUrl;
  const parsed = new URL(base);
  if (parsed.pathname.replace(/\/+$/, '').endsWith(endpoint)) return parsed.toString();
  return endpointUrl(base, endpoint);
}

export class BalanceService {
  constructor(private readonly relays: RelayRepository) {}

  async query(id: string, signal?: AbortSignal): Promise<Relay> {
    const relay = await this.relays.find(id);
    if (!relay.balanceConfig?.enabled) throw new HttpError(409, '请先启用余额查询配置');
    const snapshot = await this.fetchBalance(relay, signal);
    return this.relays.applyBalanceSnapshot(id, snapshot);
  }

  private async fetchBalance(relay: Relay, signal?: AbortSignal): Promise<BalanceSnapshot> {
    const config = relay.balanceConfig!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout);
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const queriedAt = new Date().toISOString();
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (config.template === 'newapi') {
        if (!config.accessToken || !config.userId) throw new Error('请填写 New API 访问令牌和用户 ID');
        headers.Authorization = `Bearer ${config.accessToken}`;
        headers['New-Api-User'] = config.userId;
      } else {
        headers.Authorization = `Bearer ${config.apiKey || relay.apiKey}`;
      }
      const response = await fetch(requestUrl(relay), { method: 'GET', headers, signal: controller.signal });
      const raw = await response.text();
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '凭证无效或没有查询权限' : `查询请求失败（HTTP ${response.status}）`);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('余额接口返回了非 JSON 内容');
      }
      const parsed = config.template === 'newapi' ? newApiSnapshot(payload) : genericSnapshot(payload);
      return { ...parsed, success: true, errorMessage: '', queriedAt };
    } catch (error) {
      return {
        success: false,
        remaining: null,
        total: null,
        used: null,
        unit: '',
        planName: '',
        errorMessage: controller.signal.aborted ? '余额查询超时或已取消' : (error as Error).message || '余额查询失败',
        queriedAt
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
