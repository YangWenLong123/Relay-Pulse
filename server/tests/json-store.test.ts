import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonStore } from '../src/lib/json-store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('JsonStore', () => {
  it('serializes concurrent updates without losing data', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-store-'));
    directories.push(directory);
    const file = path.join(directory, 'data.json');
    const store = new JsonStore<number[]>(file, []);
    await store.initialize();
    await Promise.all(Array.from({ length: 20 }, (_, value) => store.update((items) => [...items, value])));
    expect((await store.read()).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, value) => value));
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(20);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports corrupt JSON without overwriting it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-store-'));
    directories.push(directory);
    const file = path.join(directory, 'data.json');
    await writeFile(file, '{broken', 'utf8');
    const store = new JsonStore<number[]>(file, []);
    await expect(store.initialize()).rejects.toThrow('数据文件格式损坏');
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
});
