import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { RelayTester } from './relay-tester.js';
export async function runConcurrent(values, concurrency, worker, shouldStop = () => false) {
    const results = new Array(values.length);
    let cursor = 0;
    async function consume() {
        while (cursor < values.length && !shouldStop()) {
            const index = cursor++;
            try {
                results[index] = { status: 'fulfilled', value: await worker(values[index]) };
            }
            catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, consume));
    return Array.from({ length: values.length }, (_, index) => results[index] ?? { status: 'cancelled' });
}
export class TestCoordinator {
    relays;
    history;
    tester;
    active = new Map();
    constructor(relays, history, tester = new RelayTester()) {
        this.relays = relays;
        this.history = history;
        this.tester = tester;
    }
    async testRelay(id, options = {}) {
        const relay = await this.relays.find(id);
        if (!relay.enabled)
            throw new HttpError(409, '该中转站已停用');
        const controller = new AbortController();
        let complete;
        const activeTest = {
            controller,
            completion: new Promise((resolve) => {
                complete = resolve;
            })
        };
        const abort = () => controller.abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted)
            controller.abort();
        this.register(id, activeTest);
        try {
            const result = await this.tester.test(relay, { ...options, signal: controller.signal });
            await Promise.all([this.relays.applyTestResult(result), this.history.add(result)]);
            return result;
        }
        finally {
            options.signal?.removeEventListener('abort', abort);
            complete();
            this.unregister(id, activeTest);
        }
    }
    async batchTest(ids, options = {}) {
        const settled = await runConcurrent(ids, config.batchConcurrency, (id) => this.testRelay(id, { message: options.message, signal: options.signal }), () => options.signal?.aborted ?? false);
        return Promise.all(settled.map(async (item, index) => {
            if (item.status === 'fulfilled')
                return item.value;
            const result = await this.failureResult(ids[index], item.status === 'cancelled' ? new HttpError(499, '批量测试已取消') : item.reason, item.status === 'cancelled' || options.signal?.aborted === true);
            await Promise.all([this.relays.applyTestResult(result), this.history.add(result)]);
            return result;
        }));
    }
    async cancelRelay(id) {
        const tests = [...(this.active.get(id) ?? [])];
        tests.forEach((test) => test.controller.abort());
        await Promise.allSettled(tests.map((test) => test.completion));
    }
    register(id, test) {
        const tests = this.active.get(id) ?? new Set();
        tests.add(test);
        this.active.set(id, tests);
    }
    unregister(id, test) {
        const tests = this.active.get(id);
        if (!tests)
            return;
        tests.delete(test);
        if (!tests.size)
            this.active.delete(id);
    }
    async failureResult(id, error, cancelled) {
        let relay;
        try {
            relay = await this.relays.find(id);
        }
        catch {
            relay = undefined;
        }
        const httpError = error instanceof HttpError ? error : undefined;
        const errorType = cancelled
            ? 'cancelled'
            : httpError?.status === 404
                ? 'not_found'
                : 'http_error';
        return {
            id: randomUUID(),
            success: false,
            relayId: id,
            relayName: relay?.name ?? '未知中转站',
            model: relay?.model ?? '',
            protocol: relay?.protocol === 'chat' ? 'chat' : 'responses',
            statusCode: httpError?.status ?? null,
            responseText: '',
            totalDuration: 0,
            dnsDuration: null,
            tcpDuration: null,
            tlsDuration: null,
            firstByteDuration: null,
            errorType,
            errorMessage: cancelled ? '批量测试已取消' : httpError?.message ?? '批量测试任务失败',
            testedAt: new Date().toISOString()
        };
    }
}
