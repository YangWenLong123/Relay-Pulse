import { describe, expect, it } from 'vitest';
import {
  codexProxyBaseUrl,
  MAX_CODEX_SESSION_IMPORT_COUNT,
  MAX_CODEX_SESSION_FILE_BYTES,
  parseCodexSessionFiles
} from '../src/utils/codex-account';

function sessionFile(name: string, content: string, size = new Blob([content]).size): File {
  return {
    name,
    size,
    text: async () => content
  } as File;
}

describe('parseCodexSessionFiles', () => {
  it('parses valid session JSON files and retains supported session fields', async () => {
    const files = [
      sessionFile('account-one.json', JSON.stringify({ access_token: 'test-access-token', account_id: 'account-one' })),
      sessionFile('account-two.json', JSON.stringify({ access_token: 'test-access-token-two', refresh_token: 'test-refresh-token' }))
    ];

    await expect(parseCodexSessionFiles(files)).resolves.toEqual([
      { access_token: 'test-access-token', account_id: 'account-one' },
      { access_token: 'test-access-token-two', refresh_token: 'test-refresh-token' }
    ]);
  });

  it('parses a sub2api account bundle and normalizes its credentials', async () => {
    const files = [sessionFile('sub2api.json', JSON.stringify({
      proxies: [],
      accounts: [{
        name: 'sub2api@example.test',
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: 'sub2api-access-token',
          refresh_token: 'sub2api-refresh-token',
          chatgpt_account_id: 'sub2api-account-id',
          organization_id: 'sub2api-workspace-id',
          expires_at: 1_800_000_000
        }
      }]
    }))];

    await expect(parseCodexSessionFiles(files)).resolves.toMatchObject([{
      access_token: 'sub2api-access-token',
      refresh_token: 'sub2api-refresh-token',
      account_id: 'sub2api-account-id',
      chatgpt_account_id: 'sub2api-account-id',
      workspace_id: 'sub2api-workspace-id',
      email: 'sub2api@example.test',
      expired: '2027-01-15T08:00:00.000Z'
    }]);
  });

  it('parses Codex-Manager account arrays and Codex auth exports', async () => {
    const files = [
      sessionFile('codex-manager.json', JSON.stringify([{
        email: 'manager@example.test',
        account_id: 'manager-account-id',
        workspace_id: 'manager-workspace-id',
        access_token: 'manager-access-token',
        refresh_token: 'manager-refresh-token',
        expires_at: '2027-03-01T00:00:00Z'
      }])),
      sessionFile('auth.json', JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'codex-auth-account-id',
          access_token: 'codex-auth-access-token',
          refresh_token: 'codex-auth-refresh-token',
          id_token: 'codex-auth-id-token'
        },
        last_refresh: '2026-08-10T00:00:00Z'
      }))
    ];

    await expect(parseCodexSessionFiles(files)).resolves.toMatchObject([
      {
        email: 'manager@example.test',
        name: 'manager@example.test',
        account_id: 'manager-account-id',
        workspace_id: 'manager-workspace-id',
        access_token: 'manager-access-token',
        expired: '2027-03-01T00:00:00.000Z'
      },
      {
        account_id: 'codex-auth-account-id',
        access_token: 'codex-auth-access-token',
        refresh_token: 'codex-auth-refresh-token',
        id_token: 'codex-auth-id-token',
        last_refresh: '2026-08-10T00:00:00Z'
      }
    ]);
  });

  it('rejects malformed JSON and session JSON without an access token', async () => {
    await expect(parseCodexSessionFiles([sessionFile('broken.json', '{')]))
      .rejects.toThrow('broken.json 不是有效 JSON 文件');

    await expect(parseCodexSessionFiles([sessionFile('missing-token.json', JSON.stringify({ refresh_token: 'test-refresh-token' }))]))
      .rejects.toThrow('missing-token.json 缺少 access_token');
  });

  it('rejects files over the import size limit before reading their contents', async () => {
    const text = async (): Promise<string> => {
      throw new Error('should not read an oversized file');
    };
    const oversized = {
      name: 'too-large.json',
      size: MAX_CODEX_SESSION_FILE_BYTES + 1,
      text
    } as File;

    await expect(parseCodexSessionFiles([oversized])).rejects.toThrow('too-large.json 超过 2MB 限制');
  });

  it('rejects account bundles over the import count limit', async () => {
    const accounts = Array.from({ length: MAX_CODEX_SESSION_IMPORT_COUNT + 1 }, (_, index) => ({
      account_id: `account-${index}`,
      access_token: `access-token-${index}`
    }));

    await expect(parseCodexSessionFiles([sessionFile('too-many.json', JSON.stringify(accounts))]))
      .rejects.toThrow(`单次最多导入 ${MAX_CODEX_SESSION_IMPORT_COUNT} 个账号`);
  });
});

describe('codexProxyBaseUrl', () => {
  it.each([
    [null, ''],
    ['', ''],
    ['http://127.0.0.1:58000', 'http://127.0.0.1:58000/v1'],
    ['http://127.0.0.1:58000/', 'http://127.0.0.1:58000/v1'],
    ['https://proxy.example.test/v1///', 'https://proxy.example.test/v1']
  ])('normalizes %j to %j', (baseUrl, expected) => {
    expect(codexProxyBaseUrl(baseUrl)).toBe(expected);
  });
});
