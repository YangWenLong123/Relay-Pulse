import { describe, expect, it } from 'vitest';
import { runConcurrent } from '../src/utils/concurrency';

describe('client batch runner', () => {
  it('limits concurrency and can stop queued work', async () => {
    let active = 0;
    let maximum = 0;
    let stopped = false;
    const visited: number[] = [];
    await runConcurrent(
      [0, 1, 2, 3, 4, 5],
      2,
      async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        visited.push(value);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (value === 1) stopped = true;
      },
      () => stopped
    );
    expect(maximum).toBe(2);
    expect(visited.length).toBeLessThan(6);
  });

  it('continues after one worker rejects', async () => {
    const visited: number[] = [];
    const result = await runConcurrent([0, 1, 2], 1, async (value) => {
      visited.push(value);
      if (value === 1) throw new Error('failed');
    });
    expect(visited).toEqual([0, 1, 2]);
    expect(result.map((item) => item.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
