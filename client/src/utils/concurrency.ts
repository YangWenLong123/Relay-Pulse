export async function runConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<PromiseSettledResult<void>[]> {
  let cursor = 0;
  const results = new Array<PromiseSettledResult<void> | undefined>(values.length);
  async function consume(): Promise<void> {
    while (cursor < values.length && !shouldStop()) {
      const index = cursor++;
      try {
        await worker(values[index]!, index);
        results[index] = { status: 'fulfilled', value: undefined };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, consume));
  return results.filter((result): result is PromiseSettledResult<void> => result !== undefined);
}
