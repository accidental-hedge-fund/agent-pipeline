// Unit tests for RunStateCache.
//
// All tests inject fake gh/worktree functions via RunStateCacheDeps so no
// real network, git, or subprocess calls are made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStateCache } from "../scripts/run-state-cache.ts";
import type { RunStateCacheDeps } from "../scripts/run-state-cache.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = {} as PipelineConfig;

function fakeDeps(opts: {
  state?: "open" | "closed";
  labels?: string[];
  prNumber?: number | null;
  worktreePath?: string | null;
  worktreeSlug?: string | null;
} = {}): RunStateCacheDeps {
  return {
    getIssueStateAndLabels: async () => ({
      state: opts.state ?? "open",
      labels: opts.labels ?? [],
    }),
    getPrForIssue: async () => opts.prNumber ?? null,
    getOnDiskForIssue: async () =>
      opts.worktreePath
        ? { path: opts.worktreePath, slug: opts.worktreeSlug ?? "slug" }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Scenario: accessors throw before first refresh
// ---------------------------------------------------------------------------

test("RunStateCache: accessors throw before any refresh is called", () => {
  const cache = new RunStateCache(42);
  assert.equal(cache.populated, false);
  assert.throws(() => cache.issueState, /cache not populated/);
  assert.throws(() => cache.labels, /cache not populated/);
  assert.throws(() => cache.prNumber, /cache not populated/);
  assert.throws(() => cache.worktreePath, /cache not populated/);
  assert.throws(() => cache.worktreeSlug, /cache not populated/);
});

// ---------------------------------------------------------------------------
// Scenario: accessors return fresh data after refreshAfterSetup
// ---------------------------------------------------------------------------

test("RunStateCache: accessors return correct values after refreshAfterSetup", async () => {
  const cache = new RunStateCache(42);
  const deps = fakeDeps({
    state: "open",
    labels: ["pipeline:review-1"],
    prNumber: 123,
    worktreePath: "/repo/.worktrees/pipeline-42-my-slug",
    worktreeSlug: "my-slug",
  });
  await cache.refreshAfterSetup(cfg, deps);

  assert.equal(cache.populated, true);
  assert.equal(cache.issueState, "open");
  assert.deepEqual(cache.labels, ["pipeline:review-1"]);
  assert.equal(cache.prNumber, 123);
  assert.equal(cache.worktreePath, "/repo/.worktrees/pipeline-42-my-slug");
  assert.equal(cache.worktreeSlug, "my-slug");
});

// ---------------------------------------------------------------------------
// Scenario: refreshAfterFix updates cached values
// ---------------------------------------------------------------------------

test("RunStateCache: refreshAfterFix replaces previously cached values", async () => {
  const cache = new RunStateCache(42);

  await cache.refreshAfterSetup(cfg, fakeDeps({
    state: "open",
    labels: ["pipeline:review-1"],
    prNumber: null,
    worktreePath: null,
  }));

  assert.equal(cache.prNumber, null);

  await cache.refreshAfterFix(cfg, fakeDeps({
    state: "open",
    labels: ["pipeline:review-2"],
    prNumber: 456,
    worktreePath: "/repo/.worktrees/pipeline-42-after-fix",
    worktreeSlug: "after-fix",
  }));

  assert.equal(cache.prNumber, 456);
  assert.deepEqual(cache.labels, ["pipeline:review-2"]);
  assert.equal(cache.worktreePath, "/repo/.worktrees/pipeline-42-after-fix");
});

// ---------------------------------------------------------------------------
// Scenario: cache is injected via deps for unit testing (no real gh calls)
// ---------------------------------------------------------------------------

test("RunStateCache: injected via deps — stage reads cached values without real gh calls", async () => {
  // This test represents how a stage function accepts a RunStateCache through
  // its deps object and reads from it without issuing any real GitHub calls.
  // We verify by using only the fake deps injected into the cache and counting
  // gh-like calls to confirm none bypass the cache after population.

  let ghCallCount = 0;

  const deps: RunStateCacheDeps = {
    getIssueStateAndLabels: async () => {
      ghCallCount++;
      return { state: "open", labels: ["pipeline:fix-1"] };
    },
    getPrForIssue: async () => {
      ghCallCount++;
      return 789;
    },
    getOnDiskForIssue: async () => {
      // disk-only, not a gh call — not counted
      return { path: "/repo/.worktrees/pipeline-99-slug", slug: "slug" };
    },
  };

  const cache = new RunStateCache(99);
  await cache.refreshAfterSetup(cfg, deps);

  // Exactly 2 gh-like calls were made during refresh (state + PR).
  assert.equal(ghCallCount, 2);

  // Reading accessors multiple times makes zero additional gh calls.
  const _ = cache.prNumber;
  const __ = cache.labels;
  const ___ = cache.issueState;
  assert.equal(ghCallCount, 2, "accessor reads must not issue additional gh calls");
  assert.equal(cache.prNumber, 789);
  assert.deepEqual(cache.labels, ["pipeline:fix-1"]);
});
