// Bounded-concurrency task pool for roadmap phases (#292).

/**
 * Run an array of async task factories with bounded concurrency.
 * Results are returned in the same order as the input tasks.
 * Rejects immediately if any task rejects.
 */
export async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (tasks.length === 0) return [];
  const cap = Math.max(1, Math.floor(concurrency));

  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]!();
    }
  }

  const workerCount = Math.min(cap, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
