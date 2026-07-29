import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class JsonStore<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly initialValue: T
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await this.readUnsafe();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.writeUnsafe(this.initialValue);
    }
  }

  async read(): Promise<T> {
    await this.queue;
    return this.readUnsafe();
  }

  async update(mutator: (current: T) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const current = await this.readUnsafe();
      result = await mutator(current);
      await this.writeUnsafe(result);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async readUnsafe(): Promise<T> {
    const raw = await readFile(this.filePath, 'utf8');
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`数据文件格式损坏：${path.basename(this.filePath)}`);
    }
  }

  private async writeUnsafe(value: T): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
