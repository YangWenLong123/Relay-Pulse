import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../lib/http-error.js';
import { HistoryRepository } from '../repositories/history-repository.js';
import { RelayRepository } from '../repositories/relay-repository.js';
import type { Relay, RelayProtocol, TestErrorType, TestResult } from '../types.js';
import { RelayTester } from './relay-tester.js';

export type ConcurrentResult<R> = PromiseSettledResult<R> | { status: 'cancelled' };

interface ActiveTest {
  controller: AbortController;
  completion: Promise<void>;
}

export async function runConcurrent<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
  shouldStop: () => boolean = () => false
): Promise<ConcurrentResult<R>[]> {
  const results = new Array<ConcurrentResult<R> | undefined>(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (cursor < values.length && !shouldStop()) {
      const index = cursor++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(values[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, consume));
  return Array.from({ length: values.length }, (_, index) => results[index] ?? { status: 'cancelled' });
}

export class TestCoordinator {
  private readonly active = new Map<string, Set<ActiveTest>>();

  constructor(
    private readonly relays: RelayRepository,
    private readonly history: HistoryRepository,
    private readonly tester = new RelayTester()
  ) {}

  async testRelay(
    id: string,
    options: { model?: string; message?: string; protocol?: RelayProtocol; signal?: AbortSignal } = {}
  ): Promise<TestResult> {
    const relay = await this.relays.find(id);
    if (!relay.enabled) throw new HttpError(409, '该中转站已停用');

    const controller = new AbortController();
    let complete!: () => void;
    const activeTest: ActiveTest = {
      controller,
      completion: new Promise<void>((resolve) => {
        complete = resolve;
      })
    };
    const abort = (): void => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.register(id, activeTest);
    try {
      const result = await this.tester.test(relay, { ...options, signal: controller.signal });
      await Promise.all([this.relays.applyTestResult(result), this.history.add(result)]);
      return result;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      complete();
      this.unregister(id, activeTest);
    }
  }

  async batchTest(
    ids: string[],
    options: { message?: string; signal?: AbortSignal } = {}
  ): Promise<TestResult[]> {
    const settled = await runConcurrent(
      ids,
      config.batchConcurrency,
      (id) => this.testRelay(id, { message: options.message, signal: options.signal }),
      () => options.signal?.aborted ?? false
    );
    return Promise.all(
      settled.map(async (item, index) => {
        if (item.status === 'fulfilled') return item.value;
        const result = await this.failureResult(
          ids[index]!,
          item.status === 'cancelled' ? new HttpError(499, '批量测试已取消') : item.reason,
          item.status === 'cancelled' || options.signal?.aborted === true
        );
        await Promise.all([this.relays.applyTestResult(result), this.history.add(result)]);
        return result;
      })
    );
  }

  async cancelRelay(id: string): Promise<void> {
    const tests = [...(this.active.get(id) ?? [])];
    tests.forEach((test) => test.controller.abort());
    await Promise.allSettled(tests.map((test) => test.completion));
  }

  private register(id: string, test: ActiveTest): void {
    const tests = this.active.get(id) ?? new Set<ActiveTest>();
    tests.add(test);
    this.active.set(id, tests);
  }

  private unregister(id: string, test: ActiveTest): void {
    const tests = this.active.get(id);
    if (!tests) return;
    tests.delete(test);
    if (!tests.size) this.active.delete(id);
  }

  private async failureResult(id: string, error: unknown, cancelled: boolean): Promise<TestResult> {
    let relay: Relay | undefined;
    try {
      relay = await this.relays.find(id);
    } catch {
      relay = undefined;
    }
    const httpError = error instanceof HttpError ? error : undefined;
    const errorType: Exclude<TestErrorType, null> = cancelled
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
