import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
export class JsonStore {
    filePath;
    initialValue;
    queue = Promise.resolve();
    constructor(filePath, initialValue) {
        this.filePath = filePath;
        this.initialValue = initialValue;
    }
    async initialize() {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        try {
            await this.readUnsafe();
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            await this.writeUnsafe(this.initialValue);
        }
    }
    async read() {
        await this.queue;
        return this.readUnsafe();
    }
    async update(mutator) {
        let result;
        const operation = this.queue.then(async () => {
            const current = await this.readUnsafe();
            result = await mutator(current);
            await this.writeUnsafe(result);
        });
        this.queue = operation.catch(() => undefined);
        await operation;
        return result;
    }
    async readUnsafe() {
        const raw = await readFile(this.filePath, 'utf8');
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error(`数据文件格式损坏：${path.basename(this.filePath)}`);
        }
    }
    async writeUnsafe(value) {
        const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
                encoding: 'utf8',
                mode: 0o600
            });
            await rename(temporaryPath, this.filePath);
        }
        catch (error) {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
