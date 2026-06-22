// Tests for roadmap/pool.ts (#292)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPool } from "../scripts/roadmap/pool.ts";

describe("runPool", () => {
  it("returns empty array for empty input", async () => {
    const result = await runPool([], 4);
    assert.deepEqual(result, []);
  });

  it("preserves input order in results", async () => {
    const tasks = [3, 1, 2].map((v) => () => Promise.resolve(v));
    const result = await runPool(tasks, 4);
    assert.deepEqual(result, [3, 1, 2]);
  });

  it("caps concurrency to the given limit", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const concurrency = 3;
    const taskCount = 10;

    const tasks = Array.from({ length: taskCount }, (_, i) => async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Yield to allow other tasks to start before resolving
      await new Promise<void>((resolve) => setImmediate(resolve));
      inflight--;
      return i;
    });

    const result = await runPool(tasks, concurrency);

    assert.equal(result.length, taskCount);
    assert.deepEqual(result, Array.from({ length: taskCount }, (_, i) => i));
    assert.ok(maxInflight <= concurrency, `max inflight ${maxInflight} exceeded concurrency cap ${concurrency}`);
  });

  it("propagates rejections", async () => {
    const tasks: Array<() => Promise<number>> = [
      () => Promise.resolve(1),
      () => Promise.reject(new Error("task failed")),
      () => Promise.resolve(3),
    ];
    await assert.rejects(() => runPool(tasks, 4), /task failed/);
  });

  it("handles single task", async () => {
    const result = await runPool([() => Promise.resolve(42)], 1);
    assert.deepEqual(result, [42]);
  });

  it("handles concurrency of 1 (serial execution)", async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((v) => async () => {
      order.push(v);
      return v;
    });
    const result = await runPool(tasks, 1);
    assert.deepEqual(result, [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
  });
});
