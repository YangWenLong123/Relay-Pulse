import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayRepository } from '../src/repositories/relay-repository.js';

const directories: string[] = [];
const input = {
  name: '加密线路',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-encryption-secret-value',
  model: 'gpt-test',
  protocol: 'auto' as const,
  enabled: true,
  timeout: 30000,
  remark: ''
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('optional API Key encryption', () => {
  it('encrypts persisted keys and preserves empty-key edits across restarts', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-key-'));
    directories.push(directory);
    const file = path.join(directory, 'relays.json');
    const repository = new RelayRepository(file, 'local-passphrase');
    await repository.initialize();
    const created = await repository.create(input);
    expect(await readFile(file, 'utf8')).not.toContain(input.apiKey);
    expect(await readFile(file, 'utf8')).toContain('enc:v1:');

    const restarted = new RelayRepository(file, 'local-passphrase');
    await restarted.initialize();
    await restarted.update(created.id, { apiKey: '', name: '重启后编辑' });
    expect((await restarted.find(created.id)).apiKey).toBe(input.apiKey);
    await expect(new RelayRepository(file, 'wrong-passphrase').initialize()).rejects.toThrow('API Key 解密失败');
  });
});
