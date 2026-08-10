import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAccountRepository } from '../src/repositories/codex-account-repository.js';

const directories: string[] = [];

async function createRepository(secret = 'test-session-passphrase'): Promise<{ repository: CodexAccountRepository; filePath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-codex-account-'));
  directories.push(directory);
  const filePath = path.join(directory, 'codex-accounts.json');
  const repository = new CodexAccountRepository(filePath, secret);
  await repository.initialize();
  return { repository, filePath };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'account-test-1234567890',
    email: 'person@example.test',
    name: '测试账号',
    plan_type: 'plus',
    access_token: 'test-only-access-token-that-must-not-be-exposed',
    refresh_token: 'test-only-refresh-token-that-must-not-be-exposed',
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CodexAccountRepository', () => {
  it('encrypts sessions on disk and only returns public, masked account data', async () => {
    const { repository, filePath } = await createRepository();
    const imported = await repository.importMany([session()]);

    expect(imported).toMatchObject({ createdCount: 1, updatedCount: 0 });
    expect(imported.accounts[0]).toMatchObject({
      email: 'person@example.test',
      name: '测试账号',
      planType: 'plus',
      accountIdMasked: 'accou...67890',
      modelCount: 0
    });
    expect(JSON.stringify(imported)).not.toContain('test-only-access-token');
    expect(JSON.stringify(imported)).not.toContain('account-test-1234567890');

    const stored = await readFile(filePath, 'utf8');
    expect(stored).toContain('enc:v1:');
    expect(stored).not.toContain('test-only-access-token');
    expect(stored).not.toContain('test-only-refresh-token');

    const loaded = await repository.find(imported.accounts[0]!.id);
    expect(loaded.session.access_token).toBe('test-only-access-token-that-must-not-be-exposed');
    expect(loaded.session.refresh_token).toBe('test-only-refresh-token-that-must-not-be-exposed');
  });

  it('updates an existing account by account id without creating another public record', async () => {
    const { repository } = await createRepository();
    const first = await repository.importMany([session({ name: '初始名称' })]);
    const second = await repository.importMany([session({ name: '更新后的名称', plan_type: 'pro' })]);

    expect(second).toMatchObject({ createdCount: 0, updatedCount: 1 });
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0]).toMatchObject({ id: first.accounts[0]!.id, name: '更新后的名称', planType: 'pro' });
    expect(await repository.listPublic()).toHaveLength(1);
  });

  it('accepts numeric expires_at values used by sub2api exports', async () => {
    const { repository } = await createRepository();
    const imported = await repository.importMany([session({
      expires_at: 1_800_000_000,
      expired: undefined
    })]);

    expect(imported.accounts[0]?.expiresAt).toBe('2027-01-15T08:00:00.000Z');
  });

  it('migrates plaintext records when encryption is enabled and rejects a mismatched secret', async () => {
    const { repository, filePath } = await createRepository();
    const imported = await repository.importMany([session()]);

    const legacyRecords = JSON.parse(await readFile(filePath, 'utf8')) as Array<{ session: string }>;
    legacyRecords[0]!.session = JSON.stringify(session());
    await writeFile(filePath, JSON.stringify(legacyRecords), 'utf8');

    const restarted = new CodexAccountRepository(filePath, 'test-session-passphrase');
    await restarted.initialize();
    expect((await restarted.find(imported.accounts[0]!.id)).session.access_token).toBe('test-only-access-token-that-must-not-be-exposed');
    expect(await readFile(filePath, 'utf8')).not.toContain('test-only-access-token');
    expect(await readFile(filePath, 'utf8')).toContain('enc:v1:');
    await expect(new CodexAccountRepository(filePath, 'different-test-passphrase').initialize()).rejects.toThrow('GPT 账号 session 解密失败');
  });

  it('redacts bearer values before persisting account errors', async () => {
    const { repository } = await createRepository();
    const imported = await repository.importMany([session()]);
    const updated = await repository.setError(imported.accounts[0]!.id, 'upstream rejected Bearer test-only-secret-value');

    expect(updated.lastError).toContain('Bearer ***');
    expect(updated.lastError).not.toContain('test-only-secret-value');
    expect(JSON.stringify(updated)).not.toContain('test-only-access-token');
  });
});
