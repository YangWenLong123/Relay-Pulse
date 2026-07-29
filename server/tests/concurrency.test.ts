import { describe, expect, it } from 'vitest';
import { runConcurrent } from '../src/services/test-coordinator.js';

describe('batch concurrency', () => {
  it('never exceeds the configured worker count', async () => {
    let active = 0;
    let maximum = 0;
    const values = Array.from({ length: 16 }, (_, index) => index);
    const result = await runConcurrent(values, 4, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return value * 2;
    });
    expect(maximum).toBe(4);
    expect(result).toEqual(values.map((value) => ({ status: 'fulfilled', value: value * 2 })));
  });

  it('isolates worker failures and stops queued work', async () => {
    let stopped = false;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await runConcurrent(
      [0, 1, 2, 3, 4],
      2,
      async (value) => {
        started += 1;
        if (started === 2) release();
        await gate;
        if (value === 0) stopped = true;
        if (value === 1) throw new Error('one failed');
        return value;
      },
      () => stopped
    );
    expect(result.some((item) => item.status === 'rejected')).toBe(true);
    expect(result.some((item) => item.status === 'cancelled')).toBe(true);
  });
});
