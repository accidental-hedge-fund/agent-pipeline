// Unit tests for auto_recover countRecoveryAttempts (#270).
// Verifies that recovery attempt counting is idempotent when a transient error
// causes the RECOVERY_MARKER comment to be posted more than once.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countRecoveryAttempts,
  tryAutoRecover,
  type AutoRecoverDeps,
} from "../scripts/stages/auto_recover.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

test("countRecoveryAttempts: zero comments → 0", () => {
  assert.equal(countRecoveryAttempts([]), 0);
});

test("countRecoveryAttempts: one recovery comment → 1", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1);
});

test("countRecoveryAttempts: two distinct rounds → 2", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nRound 1." },
    { body: "## Pipeline: Auto-Recovery (2/2)\n\nRound 2." },
  ];
  assert.equal(countRecoveryAttempts(comments), 2);
});

test("countRecoveryAttempts: duplicate round token (retry) counts as one — regression for #270", () => {
  // If postComment sees a transient error after GitHub accepted the write,
  // a retry posts the same marker body again. The count must still be 1,
  // not 2, so the next run does not consume a budget slot that was never used.
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1, "duplicate round token deduped to 1 attempt");
});

test("countRecoveryAttempts: Limit comment is excluded from count", () => {
  // The Limit comment also contains the RECOVERY_MARKER substring; it must not
  // be counted as an additional recovery attempt.
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nRound 1." },
    { body: "## Pipeline: Auto-Recovery Limit\n\nNo more retries." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1);
});

test("countRecoveryAttempts: only Limit comment → 0 recovery attempts", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery Limit\n\nNo more retries." },
  ];
  assert.equal(countRecoveryAttempts(comments), 0);
});

test("countRecoveryAttempts: unrelated comments are ignored", () => {
  const comments = [
    { body: "## Review 2 — approve\n\nLooks good." },
    { body: "## Pipeline: Blocked at pre merge\n\nCI failed." },
  ];
  assert.equal(countRecoveryAttempts(comments), 0);
});

// ---------------------------------------------------------------------------
// tryAutoRecover — #499 correction_event emission (source_kind: "retry")
// ---------------------------------------------------------------------------

const CFG = {
  repo: "acme/repo",
  repo_dir: "/tmp/repo",
  base_branch: "main",
  auto_recovery_max_retries: 2,
} as unknown as PipelineConfig;

function memRunStoreDeps(): { deps: RunStoreDeps; lines: () => string[] } {
  const appends: string[] = [];
  const deps: RunStoreDeps = {
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    writeFile: async () => {},
    appendFile: async (_p, data) => { appends.push(data); },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
  return { deps, lines: () => appends };
}

function baseDeps(overrides: Partial<AutoRecoverDeps> = {}): AutoRecoverDeps {
  return {
    getOnDiskForIssue: async () => ({ path: "/tmp/repo/.worktrees/x", slug: "x" }) as Awaited<ReturnType<AutoRecoverDeps["getOnDiskForIssue"]>>,
    hasCommitsAhead: async () => false,
    getIssueDetail: async () => ({ comments: [] }) as Awaited<ReturnType<AutoRecoverDeps["getIssueDetail"]>>,
    removeWorktree: async () => {},
    postComment: async () => {},
    removeLabel: async () => {},
    addLabel: async () => {},
    ...overrides,
  };
}

test("tryAutoRecover: successful recovery (reset to ready) appends one correction_event with source_kind: retry", async () => {
  const { deps: runStoreDeps, lines } = memRunStoreDeps();
  const out = await tryAutoRecover(CFG, 499, undefined, "/tmp/run", runStoreDeps, baseDeps());
  assert.equal(out.advanced, true);
  assert.equal(lines().length, 1);
  const event = JSON.parse(lines()[0]);
  assert.equal(event.type, "correction_event");
  assert.equal(event.source_kind, "retry");
  assert.equal(event.actor_kind, "pipeline");
  assert.equal(event.failure_class, "harness-crash");
});

test("tryAutoRecover: no worktree to recover → no-op, no correction_event", async () => {
  const { deps: runStoreDeps, lines } = memRunStoreDeps();
  const out = await tryAutoRecover(CFG, 499, undefined, "/tmp/run", runStoreDeps, baseDeps({
    getOnDiskForIssue: async () => null,
  }));
  assert.equal(out.status, "no-op");
  assert.equal(lines().length, 0);
});

test("tryAutoRecover: worktree already has commits → no-op, no correction_event", async () => {
  const { deps: runStoreDeps, lines } = memRunStoreDeps();
  const out = await tryAutoRecover(CFG, 499, undefined, "/tmp/run", runStoreDeps, baseDeps({
    hasCommitsAhead: async () => true,
  }));
  assert.equal(out.status, "no-op");
  assert.equal(lines().length, 0);
});

test("tryAutoRecover: recovery limit reached → blocked, no correction_event (a bare retry attempt is not a correction)", async () => {
  const { deps: runStoreDeps, lines } = memRunStoreDeps();
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nRound 1." },
    { body: "## Pipeline: Auto-Recovery (2/2)\n\nRound 2." },
  ];
  const out = await tryAutoRecover(CFG, 499, undefined, "/tmp/run", runStoreDeps, baseDeps({
    getIssueDetail: async () => ({ comments }) as Awaited<ReturnType<AutoRecoverDeps["getIssueDetail"]>>,
  }));
  assert.equal(out.status, "blocked");
  assert.equal(lines().length, 0);
});

test("tryAutoRecover: no runDir supplied → recovery still succeeds but no correction_event is emitted", async () => {
  const out = await tryAutoRecover(CFG, 499, undefined, undefined, undefined, baseDeps());
  assert.equal(out.advanced, true);
});
