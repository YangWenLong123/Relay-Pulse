import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { JsonStore } from '../lib/json-store.js';
import { KeyCipher } from '../lib/key-cipher.js';
import type {
  CodexAccount,
  CodexAccountUsageSnapshot,
  CodexAccountStatus,
  CodexSessionImport,
  PublicCodexAccount
} from '../types.js';

type StoredCodexAccount = Omit<CodexAccount, 'session'> & { session: string };

export interface CodexAccountPatch {
  enabled?: boolean;
  name?: string;
}

export interface CodexAccountImportResult {
  accounts: PublicCodexAccount[];
  createdCount: number;
  updatedCount: number;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const raw = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function nestedAuthClaim(payload: Record<string, unknown> | undefined, key: string): string {
  if (!payload) return '';
  const auth = payload['https://api.openai.com/auth'];
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return '';
  return stringValue((auth as Record<string, unknown>)[key]);
}

function accountIdFromSession(session: CodexSessionImport): string {
  const direct = stringValue(session.chatgpt_account_id) || stringValue(session.account_id);
  if (direct) return direct;
  const accessPayload = decodeJwtPayload(session.access_token);
  const idPayload = decodeJwtPayload(stringValue(session.id_token));
  const fromClaim = nestedAuthClaim(accessPayload, 'chatgpt_account_id') || nestedAuthClaim(idPayload, 'chatgpt_account_id');
  if (fromClaim) return fromClaim;
  throw new HttpError(400, 'session 文件缺少 account_id 或 chatgpt_account_id');
}

function expiryFromToken(token: string): string | null {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp * 1000).toISOString();
}

function explicitExpiry(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    return new Date(milliseconds).toISOString();
  }
  const explicit = stringValue(value);
  if (!explicit) return null;
  if (/^\d+$/.test(explicit)) return explicitExpiry(Number(explicit));
  const timestamp = Date.parse(explicit);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function expiresAtFromSession(session: CodexSessionImport): string | null {
  const explicit = explicitExpiry(session.expired ?? session.expires_at);
  if (explicit) return explicit;
  return expiryFromToken(session.access_token) || expiryFromToken(stringValue(session.id_token));
}

function accountStatus(expiresAt: string | null, current = new Date()): CodexAccountStatus {
  if (expiresAt && Date.parse(expiresAt) <= current.getTime()) return 'expired';
  return 'untested';
}

function maskAccountId(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 3)}***${value.slice(-3)}`;
  return `${value.slice(0, 5)}...${value.slice(-5)}`;
}

function normalizeSession(value: CodexSessionImport): CodexSessionImport {
  const session = { ...value };
  session.access_token = stringValue(value.access_token);
  if (!session.access_token) throw new HttpError(400, 'session 文件缺少 access_token');
  return session;
}

export class CodexAccountRepository {
  private readonly store: JsonStore<StoredCodexAccount[]>;
  private readonly cipher: KeyCipher;

  constructor(
    filePath = path.join(config.dataDir, 'codex-accounts.json'),
    encryptionSecret = config.accountSessionEncryptionSecret
  ) {
    this.store = new JsonStore(filePath, []);
    this.cipher = new KeyCipher(encryptionSecret);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    const records = await this.store.read();
    records.forEach((record) => this.toAccount(record));
    if (this.cipher.enabled && records.some((record) => !this.cipher.isEncrypted(record.session))) {
      await this.store.update((items) => items.map((record) => this.toStoredAccount(this.toAccount(record))));
    }
  }

  async list(): Promise<CodexAccount[]> {
    return (await this.store.read()).map((record) => this.toAccount(record));
  }

  async listPublic(): Promise<PublicCodexAccount[]> {
    return (await this.store.read()).map((record) => this.toPublic(this.toAccount(record)));
  }

  async find(id: string): Promise<CodexAccount> {
    const record = (await this.store.read()).find((item) => item.id === id);
    if (!record) throw new HttpError(404, 'GPT 账号不存在');
    return this.toAccount(record);
  }

  async importMany(inputs: CodexSessionImport[]): Promise<CodexAccountImportResult> {
    if (!inputs.length) throw new HttpError(400, '请至少导入一个 GPT session 文件');
    let createdCount = 0;
    let updatedCount = 0;
    const importedIds: string[] = [];
    await this.store.update((items) => {
      const next = [...items];
      const indexByAccount = new Map(next.map((item, index) => [this.toAccount(item).accountId, index]));
      for (const rawInput of inputs) {
        const session = normalizeSession(rawInput);
        const accountId = accountIdFromSession(session);
        const expiresAt = expiresAtFromSession(session);
        const email = stringValue(session.email) || `账号 ${maskAccountId(accountId)}`;
        const name = stringValue(session.name) || email;
        const planType = stringValue(session.chatgpt_plan_type) || stringValue(session.plan_type) || '未知';
        const existingIndex = indexByAccount.get(accountId);
        if (existingIndex === undefined) {
          const now = new Date().toISOString();
          const account: CodexAccount = {
            id: randomUUID(),
            accountId,
            email,
            name,
            planType,
            enabled: true,
            status: accountStatus(expiresAt),
            expiresAt,
            models: [],
            usageSnapshot: null,
            lastModelSyncAt: null,
            lastError: '',
            createdAt: now,
            updatedAt: now,
            session
          };
          next.push(this.toStoredAccount(account));
          indexByAccount.set(accountId, next.length - 1);
          importedIds.push(account.id);
          createdCount += 1;
          continue;
        }
        const current = this.toAccount(next[existingIndex]!);
        const updated: CodexAccount = {
          ...current,
          email,
          name,
          planType,
          status: accountStatus(expiresAt),
          expiresAt,
          usageSnapshot: null,
          lastError: '',
          updatedAt: new Date().toISOString(),
          session
        };
        next[existingIndex] = this.toStoredAccount(updated);
        importedIds.push(current.id);
        updatedCount += 1;
      }
      return next;
    });
    const byId = new Map((await this.listPublic()).map((account) => [account.id, account]));
    return {
      accounts: importedIds.map((id) => byId.get(id)).filter((account): account is PublicCodexAccount => Boolean(account)),
      createdCount,
      updatedCount
    };
  }

  async update(id: string, patch: CodexAccountPatch): Promise<PublicCodexAccount> {
    let updated: CodexAccount | undefined;
    await this.store.update((items) => items.map((record) => {
      if (record.id !== id) return record;
      const current = this.toAccount(record);
      updated = {
        ...current,
        enabled: patch.enabled ?? current.enabled,
        name: patch.name?.trim() || current.name,
        updatedAt: new Date().toISOString()
      };
      return this.toStoredAccount(updated);
    }));
    if (!updated) throw new HttpError(404, 'GPT 账号不存在');
    return this.toPublic(updated);
  }

  async remove(id: string): Promise<void> {
    let found = false;
    await this.store.update((items) => {
      found = items.some((record) => record.id === id);
      return items.filter((record) => record.id !== id);
    });
    if (!found) throw new HttpError(404, 'GPT 账号不存在');
  }

  async setModels(id: string, models: string[]): Promise<PublicCodexAccount> {
    let updated: CodexAccount | undefined;
    const normalizedModels = [...new Set(models.map((model) => model.trim()).filter(Boolean))].slice(0, 500);
    await this.store.update((items) => items.map((record) => {
      if (record.id !== id) return record;
      const current = this.toAccount(record);
      updated = {
        ...current,
        models: normalizedModels,
        status: accountStatus(current.expiresAt, new Date()) === 'expired' ? 'expired' : 'active',
        lastModelSyncAt: new Date().toISOString(),
        lastError: '',
        updatedAt: new Date().toISOString()
      };
      return this.toStoredAccount(updated);
    }));
    if (!updated) throw new HttpError(404, 'GPT 账号不存在');
    return this.toPublic(updated);
  }

  async setUsage(id: string, usageSnapshot: CodexAccountUsageSnapshot, session?: CodexSessionImport): Promise<PublicCodexAccount> {
    let updated: CodexAccount | undefined;
    await this.store.update((items) => items.map((record) => {
      if (record.id !== id) return record;
      const current = this.toAccount(record);
      const nextSession = session ?? current.session;
      const nextExpiry = expiresAtFromSession(nextSession) || current.expiresAt;
      updated = {
        ...current,
        session: nextSession,
        expiresAt: nextExpiry,
        planType: usageSnapshot.planType || current.planType,
        usageSnapshot,
        status: accountStatus(nextExpiry, new Date()) === 'expired' ? 'expired' : 'active',
        lastError: '',
        updatedAt: new Date().toISOString()
      };
      return this.toStoredAccount(updated);
    }));
    if (!updated) throw new HttpError(404, 'GPT 账号不存在');
    return this.toPublic(updated);
  }

  async setError(id: string, message: string, status: CodexAccountStatus = 'error'): Promise<PublicCodexAccount> {
    let updated: CodexAccount | undefined;
    const safeMessage = message.replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***').slice(0, 300);
    await this.store.update((items) => items.map((record) => {
      if (record.id !== id) return record;
      const current = this.toAccount(record);
      updated = { ...current, status, lastError: safeMessage, updatedAt: new Date().toISOString() };
      return this.toStoredAccount(updated);
    }));
    if (!updated) throw new HttpError(404, 'GPT 账号不存在');
    return this.toPublic(updated);
  }

  toPublic(account: CodexAccount): PublicCodexAccount {
    const { accountId, session, ...safe } = account;
    void session;
    return { ...safe, accountIdMasked: maskAccountId(accountId), modelCount: account.models.length };
  }

  private toStoredAccount(account: CodexAccount): StoredCodexAccount {
    return { ...account, session: this.cipher.encrypt(JSON.stringify(account.session)) };
  }

  private toAccount(record: StoredCodexAccount): CodexAccount {
    let session: CodexSessionImport;
    try {
      const raw = this.cipher.decrypt(record.session);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid session');
      session = parsed as CodexSessionImport;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new Error('GPT 账号 session 解密失败，请检查 ACCOUNT_SESSION_ENCRYPTION_SECRET');
    }
    return { ...record, usageSnapshot: record.usageSnapshot ?? null, session };
  }
}

export { accountIdFromSession, expiresAtFromSession, maskAccountId };
