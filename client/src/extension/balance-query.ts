import type { BalanceConfigFormValue, BalanceSnapshot } from '../types';
import { endpointUrl } from './relay-utils';

interface BalanceRelay {
  baseUrl: string;
  apiKey: string;
  balanceConfig?: BalanceConfigFormValue;
  balance?: BalanceSnapshot;
}

type JsonRecord = Record<string, unknown>;

function dayKey(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numeric(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function generic(payload: unknown): Omit<BalanceSnapshot, 'success' | 'errorMessage' | 'queriedAt'> {
  if (!isRecord(payload)) throw new Error('余额接口返回格式无效');
  const data = isRecord(payload.data) ? payload.data : payload;
  const quota = isRecord(data.quota) ? data.quota : {};
  const total = firstNumber(data.total, quota.total, data.limit);
  const used = firstNumber(data.used, quota.used, data.usedQuota);
  const remaining = firstNumber(data.remaining, quota.remaining, data.balance) ?? (total !== null && used !== null ? total - used : null);
  if (remaining === null) throw new Error('返回内容不包含可识别的余额字段');
  return { remaining, total, used, unit: text(data.unit, text(quota.unit, 'USD')), planName: text(data.planName, text(data.plan, '')) };
}

function newApi(payload: unknown): Omit<BalanceSnapshot, 'success' | 'errorMessage' | 'queriedAt'> {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) throw new Error(isRecord(payload) ? text(payload.message, '查询失败') : '余额接口返回格式无效');
  const quota = numeric(payload.data.quota);
  const used = numeric(payload.data.used_quota ?? payload.data.usedQuota);
  if (quota === null || used === null) throw new Error('返回内容不包含可识别的额度字段');
  return { remaining: quota / 500000, total: (quota + used) / 500000, used: used / 500000, unit: 'USD', planName: text(payload.data.group, '默认套餐') };
}

function url(relay: BalanceRelay, config: BalanceConfigFormValue): string {
  const endpoint = config.template === 'newapi' ? '/api/user/self' : '/v1/usage';
  const base = config.requestUrl || relay.baseUrl;
  const parsed = new URL(base);
  if (parsed.pathname.replace(/\/+$/, '').endsWith(endpoint)) return parsed.toString();
  return endpointUrl(base, endpoint);
}

function withDailyConsumption(previous: BalanceSnapshot | undefined, snapshot: BalanceSnapshot): BalanceSnapshot {
  const usageDate = dayKey(snapshot.queriedAt);
  const priorUsageDate = previous?.dailyUsageDate ?? (previous ? dayKey(previous.queriedAt) : '');
  const priorConsumed = priorUsageDate === usageDate ? previous?.dailyConsumed ?? 0 : 0;
  if (!snapshot.success || snapshot.remaining === null || !previous?.success || previous.remaining === null) {
    return { ...snapshot, dailyUsageDate: usageDate, dailyConsumed: priorConsumed };
  }
  return {
    ...snapshot,
    dailyUsageDate: usageDate,
    dailyConsumed: priorConsumed + Math.max(0, previous.remaining - snapshot.remaining)
  };
}

export async function queryBalance(relay: BalanceRelay, signal?: AbortSignal): Promise<BalanceSnapshot> {
  const config = relay.balanceConfig;
  if (!config?.enabled) throw new Error('请先启用余额查询配置');
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
    const response = await fetch(url(relay, config), { method: 'GET', headers, signal: controller.signal });
    const raw = await response.text();
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? '凭证无效或没有查询权限' : `查询请求失败（HTTP ${response.status}）`);
    const payload: unknown = JSON.parse(raw);
    const result = config.template === 'newapi' ? newApi(payload) : generic(payload);
    return withDailyConsumption(relay.balance, { ...result, success: true, errorMessage: '', queriedAt });
  } catch (error) {
    return withDailyConsumption(relay.balance, {
      success: false,
      remaining: null,
      total: null,
      used: null,
      unit: '',
      planName: '',
      errorMessage: controller.signal.aborted ? '余额查询超时或已取消' : (error as Error).message || '余额查询失败',
      queriedAt
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
