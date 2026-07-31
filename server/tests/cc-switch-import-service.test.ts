import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import {
  CcSwitchImportService,
  type CcSwitchProviderInsert,
  type CcSwitchProviderRow
} from '../src/services/cc-switch-import-service.js';

const directories: string[] = [];

function row(overrides: Partial<CcSwitchProviderRow>): CcSwitchProviderRow {
  return {
    id: 'provider-id',
    app_type: 'codex',
    name: 'CC 线路',
    settings_config: '{}',
    sort_index: 0,
    is_current: 0,
    notes: null,
    ...overrides
  };
}

async function createRepository(): Promise<RelayRepository> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-cc-switch-'));
  directories.push(directory);
  const repository = new RelayRepository(path.join(directory, 'relays.json'));
  await repository.initialize();
  return repository;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('CcSwitchImportService', () => {
  it('exports OpenAI and Anthropic pools as CC Switch providers', async () => {
    const repository = await createRepository();
    const rows: CcSwitchProviderRow[] = [];
    const inserted: CcSwitchProviderInsert[] = [];
    const service = new CcSwitchImportService(repository, {
      loadRows: async () => rows,
      insertProvider: async (provider) => {
        inserted.push(provider);
        rows.push(row({
          id: provider.id,
          app_type: provider.appType,
          name: provider.name,
          settings_config: provider.settingsConfig,
          sort_index: provider.sortIndex,
          notes: provider.notes
        }));
      }
    });

    const openai = await service.exportPool({
      baseUrl: 'http://127.0.0.1:4001',
      apiKey: 'rp_openai',
      model: 'gpt-test',
      platform: 'openai'
    });
    const duplicate = await service.exportPool({
      baseUrl: 'http://127.0.0.1:4001',
      apiKey: 'rp_openai',
      model: 'gpt-test',
      platform: 'openai'
    });
    const anthropic = await service.exportPool({
      baseUrl: 'http://127.0.0.1:4002',
      apiKey: 'rp_anthropic',
      model: 'claude-test',
      platform: 'anthropic'
    });

    expect(openai).toMatchObject({ appType: 'codex', created: true });
    expect(duplicate).toMatchObject({ id: openai.id, created: false });
    expect(anthropic).toMatchObject({ appType: 'claude', created: true });
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.settingsConfig).toContain('http://127.0.0.1:4001/v1');
    expect(inserted[0]?.settingsConfig).toContain('rp_openai');
    expect(inserted[1]?.settingsConfig).toContain('ANTHROPIC_BASE_URL');
    expect(inserted[1]?.settingsConfig).toContain('rp_anthropic');
  });

  it('previews supported providers without exposing secrets and classifies skipped rows', async () => {
    const repository = await createRepository();
    await repository.create({
      name: '已有线路',
      baseUrl: 'https://codex.example.com/v1/',
      apiKey: 'sk-codex-secret',
      model: 'gpt-existing',
      platform: 'openai',
      protocol: 'auto',
      enabled: true,
      timeout: 30000,
      remark: ''
    });
    const rows = [
      row({
        id: 'codex-1',
        name: 'Codex 线路',
        is_current: 1,
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-codex-secret' },
          config: 'model = "gpt-5.1-codex"\nbase_url = "https://codex.example.com/v1/"\nwire_api = "responses"'
        })
      }),
      row({
        id: 'codex-2',
        name: '同地址不同密钥',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-another-secret' },
          config: 'base_url = "https://codex.example.com/v1"\nmodel = "gpt-5.2"\nwire_api = "chat_completions"'
        })
      }),
      row({
        id: 'claude-1',
        app_type: 'claude',
        name: 'Claude 线路',
        notes: '主配置',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_AUTH_TOKEN: 'sk-ant-secret',
            ANTHROPIC_BASE_URL: 'https://claude.example.com',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-5'
          }
        })
      }),
      row({ id: 'gemini-1', app_type: 'gemini', name: 'Gemini 线路' }),
      row({ id: 'invalid-1', app_type: 'codex', name: '缺少配置' })
    ];
    const service = new CcSwitchImportService(repository, { loadRows: async () => rows });

    const preview = await service.preview();

    expect(preview).toMatchObject({ unsupportedCount: 1, invalidCount: 1 });
    expect(preview.candidates).toHaveLength(3);
    expect(preview.candidates[0]).toMatchObject({
      id: 'codex:codex-1',
      baseUrl: 'https://codex.example.com/v1',
      protocol: 'responses',
      source: 'codex',
      isCurrent: true,
      alreadyExists: true
    });
    expect(preview.candidates[1]).toMatchObject({ protocol: 'chat', alreadyExists: false });
    expect(preview.candidates[2]).toMatchObject({
      id: 'claude:claude-1',
      platform: 'anthropic',
      model: 'claude-sonnet-4-5',
      alreadyExists: false
    });
    expect(JSON.stringify(preview)).not.toContain('sk-codex-secret');
    expect(JSON.stringify(preview)).not.toContain('sk-another-secret');
    expect(JSON.stringify(preview)).not.toContain('sk-ant-secret');
  });

  it('re-reads selected providers, skips duplicates, and appends imported relays', async () => {
    const repository = await createRepository();
    const existing = await repository.create({
      name: '已有线路',
      baseUrl: 'https://existing.example.com/v1',
      apiKey: 'sk-existing-secret',
      model: 'gpt-existing',
      platform: 'openai',
      protocol: 'auto',
      enabled: true,
      timeout: 30000,
      remark: ''
    });
    let loadCount = 0;
    const rows = [
      row({
        id: 'existing',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-existing-secret' },
          config: 'base_url = "https://existing.example.com/v1"\nmodel = "gpt-existing"'
        })
      }),
      row({
        id: 'new',
        app_type: 'claude',
        name: '新线路',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_API_KEY: 'sk-new-secret',
            ANTHROPIC_BASE_URL: 'https://new.example.com/v1/messages',
            ANTHROPIC_MODEL: 'claude-test'
          }
        })
      })
    ];
    const service = new CcSwitchImportService(repository, {
      loadRows: async () => {
        loadCount += 1;
        return rows;
      }
    });

    await service.preview();
    const result = await service.import(['codex:existing', 'claude:new']);

    expect(loadCount).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ name: '新线路', baseUrl: 'https://new.example.com/v1', platform: 'anthropic' });
    expect(JSON.stringify(result)).not.toContain('sk-new-secret');
    const stored = await repository.list();
    expect(stored.map((relay) => relay.id)).toEqual([existing.id, result.imported[0]!.id]);
    expect(stored[1]?.apiKey).toBe('sk-new-secret');
  });

  it('serializes concurrent imports so duplicate detection remains effective', async () => {
    const repository = await createRepository();
    const rows = [
      row({
        id: 'same-provider',
        settings_config: JSON.stringify({
          auth: { OPENAI_API_KEY: 'sk-shared-secret' },
          config: 'base_url = "https://shared.example.com/v1"\nmodel = "gpt-shared"'
        })
      })
    ];
    const service = new CcSwitchImportService(repository, { loadRows: async () => rows });

    const results = await Promise.all([
      service.import(['codex:same-provider']),
      service.import(['codex:same-provider'])
    ]);

    expect(results.map((result) => result.imported.length).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.duplicateCount).sort()).toEqual([0, 1]);
    expect(await repository.list()).toHaveLength(1);
  });
});
