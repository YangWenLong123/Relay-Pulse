import { HttpError } from '../lib/http-error.js';
import type {
  CodexAccount,
  CodexAccountModelsResult,
  CodexAccountUsageResult,
  CodexAccountUsageSnapshot,
  CodexUsageWindow,
  CodexSessionImport,
  PublicCodexAccount
} from '../types.js';
import { CodexAccountRepository } from '../repositories/codex-account-repository.js';

export type CodexAccountFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CodexAccountServiceOptions {
  fetch?: CodexAccountFetch;
  upstreamBaseUrl: string;
  clientVersion?: string;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const USAGE_INSTRUCTIONS = 'Reply with a single short token.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function modelId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';
  for (const key of ['id', 'slug', 'model', 'name']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function extractModels(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 4 || candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => {
        const id = modelId(item);
        if (id) found.add(id);
        else visit(item, depth + 1);
      });
      return;
    }
    if (!isRecord(candidate)) return;
    for (const key of ['data', 'models', 'results', 'items']) {
      if (candidate[key] !== undefined) visit(candidate[key], depth + 1);
    }
  };
  visit(value, 0);
  return [...found].sort((left, right) => left.localeCompare(right));
}

function compactError(status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = isRecord(parsed.error) ? parsed.error : parsed;
      if (typeof error.message === 'string') message = error.message;
    }
  } catch {
    // Keep a compact non-JSON response for diagnostics.
  }
  message = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').replace(/\s+/g, ' ').slice(0, 240);
  if (status === 401 || status === 403) return '上游拒绝了账号凭证';
  if (status === 429) return '上游账号触发限流或额度限制';
  return message || `模型探测失败（HTTP ${status}）`;
}

function readHeaderInt(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function readHeaderBoolean(headers: Headers, name: string): boolean | null {
  const raw = headers.get(name)?.trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function parseUsageWindow(headers: Headers, prefix: 'primary' | 'secondary'): CodexUsageWindow | null {
  const usedPercent = readHeaderInt(headers, `x-codex-${prefix}-used-percent`);
  const windowMinutes = readHeaderInt(headers, `x-codex-${prefix}-window-minutes`);
  if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) return null;
  const resetAfterSeconds = Math.max(0, readHeaderInt(headers, `x-codex-${prefix}-reset-after-seconds`) ?? 0);
  const resetAt = readHeaderInt(headers, `x-codex-${prefix}-reset-at`);
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetAfterSeconds,
    resetAt: resetAt && resetAt > 0 ? new Date(resetAt * 1000).toISOString() : null,
    windowMinutes
  };
}

function usageSnapshotFromHeaders(headers: Headers, fallbackPlanType: string): CodexAccountUsageSnapshot | null {
  const primary = parseUsageWindow(headers, 'primary');
  const secondary = parseUsageWindow(headers, 'secondary');
  const planType = headers.get('x-codex-plan-type')?.trim() || fallbackPlanType || '未知';
  const activeLimit = headers.get('x-codex-active-limit')?.trim() || '';
  const creditsBalance = headers.get('x-codex-credits-balance')?.trim() || null;
  const creditsHasCredits = readHeaderBoolean(headers, 'x-codex-credits-has-credits');
  const creditsUnlimited = readHeaderBoolean(headers, 'x-codex-credits-unlimited');
  if (!primary && !secondary && !activeLimit && !headers.has('x-codex-plan-type')) return null;
  return {
    planType,
    activeLimit,
    creditsBalance,
    creditsHasCredits,
    creditsUnlimited,
    primary,
    secondary,
    updatedAt: new Date().toISOString()
  };
}

function sessionWithToken(session: CodexSessionImport, token: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}): CodexSessionImport {
  const next = {
    ...session,
    access_token: token.access_token,
    refresh_token: token.refresh_token || session.refresh_token,
    id_token: token.id_token || session.id_token
  };
  if (typeof token.expires_in === 'number' && token.expires_in > 0) {
    next.expired = new Date(Date.now() + token.expires_in * 1000).toISOString();
  }
  return next;
}

function modelsEndpoint(baseUrl: string, clientVersion: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname.toLowerCase().endsWith('/models')) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  }
  url.searchParams.set('client_version', clientVersion);
  return url.toString();
}

export class CodexAccountService {
  private readonly fetcher: CodexAccountFetch;
  private readonly upstreamBaseUrl: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly accounts: CodexAccountRepository,
    options: CodexAccountServiceOptions
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.upstreamBaseUrl = options.upstreamBaseUrl.replace(/\/+$/, '');
    this.clientVersion = options.clientVersion?.trim() || '0.145.0';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async discoverModels(id: string, signal?: AbortSignal): Promise<CodexAccountModelsResult> {
    const account = await this.accounts.find(id);
    const models = await this.fetchModels(account, signal);
    const publicAccount = await this.accounts.setModels(id, models);
    return { account: publicAccount, models };
  }

  async discoverMany(ids: string[], signal?: AbortSignal): Promise<{
    accounts: PublicCodexAccount[];
    failed: Array<{ id: string; message: string }>;
  }> {
    const results = await Promise.all(ids.map(async (id) => {
      try {
        return { ok: true as const, account: (await this.discoverModels(id, signal)).account };
      } catch (error) {
        const message = error instanceof HttpError ? error.message : '模型探测失败';
        return { ok: false as const, id, message };
      }
    }));
    return {
      accounts: results.filter((result): result is { ok: true; account: PublicCodexAccount } => result.ok).map((result) => result.account),
      failed: results.filter((result): result is { ok: false; id: string; message: string } => !result.ok)
        .map(({ id, message }) => ({ id, message }))
    };
  }

  async refreshUsage(id: string, signal?: AbortSignal): Promise<CodexAccountUsageResult> {
    let account = await this.accounts.find(id);
    let response = await this.fetchUsage(account, signal);
    if ((response.status === 401 || response.status === 403) && account.session.refresh_token) {
      await response.body?.cancel();
      const refreshed = await this.refreshSession(account.session, signal);
      const session = sessionWithToken(account.session, refreshed);
      account = { ...account, session };
      response = await this.fetchUsage(account, signal);
      if (response.status === 401 || response.status === 403) {
        await this.accounts.setError(id, '上游拒绝了账号凭证');
        throw new HttpError(502, '上游拒绝了账号凭证，请重新导入 session');
      }
      const body = await response.text();
      const usage = usageSnapshotFromHeaders(response.headers, account.planType);
      if (!usage) {
        const message = compactError(response.status, body);
        await this.accounts.setError(id, message);
        throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
      }
      const publicAccount = await this.accounts.setUsage(id, usage, session);
      return { account: publicAccount, usage };
    }

    const body = await response.text();
    const usage = usageSnapshotFromHeaders(response.headers, account.planType);
    if (usage && (response.ok || response.status === 429)) {
      const publicAccount = await this.accounts.setUsage(id, usage);
      return { account: publicAccount, usage };
    }
    const message = compactError(response.status, body);
    await this.accounts.setError(id, message, response.status === 401 || response.status === 403 ? 'error' : 'error');
    throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
  }

  private async fetchModels(account: CodexAccount, signal?: AbortSignal): Promise<string[]> {
    if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) {
      await this.accounts.setError(account.id, '账号凭证已过期', 'expired');
      throw new HttpError(409, '账号凭证已过期，请重新导入 session');
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(modelsEndpoint(this.upstreamBaseUrl, this.clientVersion), {
        method: 'GET',
        headers: this.authHeaders(account),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) {
        const message = compactError(response.status, body);
        const status = response.status === 401 || response.status === 403 ? 'error' : 'error';
        await this.accounts.setError(account.id, message, status);
        throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
      }
      if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
        await this.accounts.setError(account.id, '模型列表响应过大');
        throw new HttpError(502, '模型列表响应过大');
      }
      const parsed: unknown = body ? JSON.parse(body) : null;
      const models = extractModels(parsed);
      if (!models.length) {
        await this.accounts.setError(account.id, '上游未返回可识别的模型列表');
        throw new HttpError(502, '上游未返回可识别的模型列表');
      }
      return models;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { name?: unknown }).name === 'AbortError') throw new HttpError(504, '模型探测超时');
      await this.accounts.setError(account.id, '无法连接模型服务');
      throw new HttpError(502, '无法连接模型服务');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async fetchUsage(account: CodexAccount, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const model = account.models[0] || 'gpt-5.5';
      const headers = this.authHeaders(account);
      headers.set('Content-Type', 'application/json');
      headers.set('Accept', 'text/event-stream');
      return await this.fetcher(`${this.upstreamBaseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          instructions: USAGE_INSTRUCTIONS,
          input: [{ role: 'user', content: 'hi' }],
          store: false,
          stream: true
        }),
        signal: controller.signal,
        redirect: 'manual'
      });
    } catch (error) {
      if ((error as { name?: unknown }).name === 'AbortError') throw new HttpError(504, '额度刷新超时');
      throw new HttpError(502, '无法连接额度服务');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async refreshSession(session: CodexSessionImport, signal?: AbortSignal): Promise<{
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  }> {
    if (!session.refresh_token) throw new HttpError(409, '账号缺少 refresh_token，请重新导入 session');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(OPENAI_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: OPENAI_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: session.refresh_token,
          scope: 'openid profile email'
        }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, compactError(response.status, body));
      const parsed: unknown = body ? JSON.parse(body) : null;
      if (!isRecord(parsed) || typeof parsed.access_token !== 'string' || !parsed.access_token.trim()) {
        throw new HttpError(502, '刷新账号凭证返回格式无效');
      }
      return {
        access_token: parsed.access_token,
        refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
        id_token: typeof parsed.id_token === 'string' ? parsed.id_token : undefined,
        expires_in: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if ((error as { name?: unknown }).name === 'AbortError') throw new HttpError(504, '刷新账号凭证超时');
      throw new HttpError(502, '无法连接账号凭证服务');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private authHeaders(account: CodexAccount): Headers {
    const headers = new Headers({
      Authorization: `Bearer ${account.session.access_token}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'relay-pulse-codex-gateway/1.0'
    });
    headers.set('ChatGPT-Account-ID', account.accountId);
    headers.set('OpenAI-Account-ID', account.accountId);
    return headers;
  }
}

export { extractModels };
