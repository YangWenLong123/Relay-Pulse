import type { CodexSessionFile } from '../api/codex-accounts';

export const MAX_CODEX_SESSION_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CODEX_SESSION_IMPORT_COUNT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function expirationValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  const text = stringValue(value);
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return expirationValue(Number(text));
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text;
}

function normalizedSession(value: Record<string, unknown>, label: string): CodexSessionFile {
  const accessToken = stringValue(value.access_token);
  if (!accessToken) throw new Error(`${label} 缺少 access_token`);
  return {
    ...value,
    access_token: accessToken,
    ...(stringValue(value.account_id) ? { account_id: stringValue(value.account_id) } : {}),
    ...(stringValue(value.chatgpt_account_id) ? { chatgpt_account_id: stringValue(value.chatgpt_account_id) } : {}),
    ...(stringValue(value.email) ? { email: stringValue(value.email) } : {}),
    ...(stringValue(value.name) ? { name: stringValue(value.name) } : {}),
    ...(stringValue(value.plan_type) ? { plan_type: stringValue(value.plan_type) } : {}),
    ...(stringValue(value.chatgpt_plan_type) ? { chatgpt_plan_type: stringValue(value.chatgpt_plan_type) } : {}),
    ...(stringValue(value.id_token) ? { id_token: stringValue(value.id_token) } : {}),
    ...(stringValue(value.refresh_token) ? { refresh_token: stringValue(value.refresh_token) } : {}),
    ...(stringValue(value.session_token) ? { session_token: stringValue(value.session_token) } : {}),
    ...(stringValue(value.last_refresh) ? { last_refresh: stringValue(value.last_refresh) } : {}),
    ...(expirationValue(value.expired ?? value.expires_at) ? { expired: expirationValue(value.expired ?? value.expires_at) } : {})
  };
}

function codexManagerSession(value: Record<string, unknown>, label: string): CodexSessionFile {
  return normalizedSession({
    ...value,
    name: stringValue(value.name) ?? stringValue(value.email),
    account_id: stringValue(value.account_id) ?? stringValue(value.chatgpt_account_id),
    expired: expirationValue(value.expired ?? value.expires_at)
  }, label);
}

function codexAuthSession(value: Record<string, unknown>, label: string): CodexSessionFile {
  if (!isRecord(value.tokens)) throw new Error(`${label} 缺少 tokens`);
  return normalizedSession({
    ...value,
    ...value.tokens,
    account_id: stringValue(value.tokens.account_id),
    last_refresh: stringValue(value.last_refresh)
  }, label);
}

function sub2apiSession(value: Record<string, unknown>, label: string): CodexSessionFile {
  if (!isRecord(value.credentials)) throw new Error(`${label} 缺少 credentials`);
  const name = stringValue(value.name);
  const email = name?.includes('@') ? name : stringValue(value.credentials.email);
  return normalizedSession({
    ...value.credentials,
    type: stringValue(value.type) ?? 'oauth',
    name,
    email,
    chatgpt_account_id: stringValue(value.credentials.chatgpt_account_id) ?? stringValue(value.credentials.account_id),
    account_id: stringValue(value.credentials.chatgpt_account_id) ?? stringValue(value.credentials.account_id),
    workspace_id: stringValue(value.credentials.organization_id),
    expired: expirationValue(value.credentials.expires_at)
  }, label);
}

function parsePayload(parsed: unknown, fileName: string): CodexSessionFile[] {
  if (Array.isArray(parsed)) {
    if (!parsed.length) throw new Error(`${fileName} 没有可导入的账号`);
    return parsed.map((item, index) => {
      if (!isRecord(item)) throw new Error(`${fileName} 第 ${index + 1} 个账号格式无效`);
      return codexManagerSession(item, `${fileName} 第 ${index + 1} 个账号`);
    });
  }
  if (!isRecord(parsed)) throw new Error(`${fileName} 不是有效的账号 JSON`);
  if (Array.isArray(parsed.accounts)) {
    const openaiAccounts = parsed.accounts.filter((item) => !isRecord(item) || !stringValue(item.platform) || stringValue(item.platform)?.toLowerCase() === 'openai');
    if (!openaiAccounts.length) throw new Error(`${fileName} 没有可导入的 OpenAI 账号`);
    return openaiAccounts.map((item, index) => {
      if (!isRecord(item)) throw new Error(`${fileName} 第 ${index + 1} 个账号格式无效`);
      return sub2apiSession(item, `${fileName} 第 ${index + 1} 个账号`);
    });
  }
  if (isRecord(parsed.tokens)) return [codexAuthSession(parsed, fileName)];
  return [codexManagerSession(parsed, fileName)];
}

export async function parseCodexSessionFiles(files: File[]): Promise<CodexSessionFile[]> {
  if (!files.length) return [];
  const sessions: CodexSessionFile[] = [];
  for (const file of files) {
    if (file.size > MAX_CODEX_SESSION_FILE_BYTES) throw new Error(`${file.name} 超过 2MB 限制`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} 不是有效 JSON 文件`);
    }
    sessions.push(...parsePayload(parsed, file.name));
    if (sessions.length > MAX_CODEX_SESSION_IMPORT_COUNT) {
      throw new Error(`单次最多导入 ${MAX_CODEX_SESSION_IMPORT_COUNT} 个账号`);
    }
  }
  return sessions;
}

export function codexProxyBaseUrl(baseUrl: string | null): string {
  if (!baseUrl) return '';
  return baseUrl.replace(/\/+$/, '').endsWith('/v1') ? baseUrl.replace(/\/+$/, '') : `${baseUrl.replace(/\/+$/, '')}/v1`;
}
