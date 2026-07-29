import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HistoryRepository } from '../src/repositories/history-repository.js';
import { RelayRepository } from '../src/repositories/relay-repository.js';
import { RelayTester } from '../src/services/relay-tester.js';
import { TestCoordinator } from '../src/services/test-coordinator.js';
import type { Relay, TestResult } from '../src/types.js';

const directories: string[] = [];

class ControlledTester extends RelayTester {
  active = 0;
  maximum = 0;

  override async test(relay: Relay, options: { signal?: AbortSignal } = {}): Promise<TestResult> {
    this.active += 1;
    this.maximum = Math.max(this.maximum, this.active);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 12);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    this.active -= 1;
    if (relay.name === '抛出异常') throw new Error('isolated worker failure');
    const cancelled = options.signal?.aborted ?? false;
    return {
      id: randomUUID(),
      success: !cancelled,
      relayId: relay.id,
      relayName: relay.name,
      model: relay.model,
      protocol: 'chat',
      statusCode: cancelled ? null : 200,
      responseText: cancelled ? '' : 'ok',
      totalDuration: 12,
      dnsDuration: null,
      tcpDuration: null,
      tlsDuration: null,
      firstByteDuration: cancelled ? null : 8,
      errorType: cancelled ? 'cancelled' : null,
      errorMessage: cancelled ? '连接测试已取消' : '',
      testedAt: new Date().toISOString()
    };
  }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('TestCoordinator batch reliability', () => {
  it('limits concurrency, isolates failures, and returns cancelled queued items after stop', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-pulse-coordinator-'));
    directories.push(directory);
    const relays = new RelayRepository(path.join(directory, 'relays.json'));
    const history = new HistoryRepository(path.join(directory, 'history.json'));
    const tester = new ControlledTester();
    await Promise.all([relays.initialize(), history.initialize()]);
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        relays.create({
          name: index === 0 ? '抛出异常' : `线路 ${index}`,
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          model: 'gpt-test',
          protocol: 'chat',
          enabled: true,
          timeout: 30000,
          remark: ''
        })
      )
    );
    const coordinator = new TestCoordinator(relays, history, tester);
    const first = await coordinator.batchTest(created.slice(0, 5).map((relay) => relay.id));
    expect(first).toHaveLength(5);
    expect(first.filter((result) => !result.success)).toHaveLength(1);
    expect(tester.maximum).toBeLessThanOrEqual(4);

    const controller = new AbortController();
    const stoppedPromise = coordinator.batchTest(created.map((relay) => relay.id), { signal: controller.signal });
    setTimeout(() => controller.abort(), 2);
    const stopped = await stoppedPromise;
    expect(stopped).toHaveLength(created.length);
    expect(stopped.some((result) => result.errorType === 'cancelled')).toBe(true);

    const singlePromise = coordinator.testRelay(created[1]!.id);
    while (tester.active === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    await coordinator.cancelRelay(created[1]!.id);
    expect((await singlePromise).errorType).toBe('cancelled');
  });
});
