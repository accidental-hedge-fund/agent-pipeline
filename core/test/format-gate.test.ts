// Unit tests for the format/lint normalization gate (#182).
// All deps are injected; no real filesystem or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runFormatGate, type FormatGateDeps } from "../scripts/stages/format-gate.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// Minimal config builder — only format_gate is relevant here.
function cfg(format_gate: PipelineConfig["format_gate"]): Pick<PipelineConfig, "format_gate"> {
  return { format_gate };
}

// Dep factories
function exec(code: number, combined = ""): FormatGateDeps["execInWorktree"] {
  return async () => ({ code, combined });
}

function execSeq(results: { code: number; combined?: string }[]): FormatGateDeps["execInWorktree"] {
  let i = 0;
  return async () => {
    const r = results[i++] ?? { code: 0 };
    return { code: r.code, combined: r.combined ?? "" };
  };
}

function dirty(isDirty: boolean): FormatGateDeps["gitIsDirty"] {
  return async () => isDirty;
}

/** Returns isDirty values in sequence (last value repeats after exhaustion). */
function dirtySeq(values: boolean[]): FormatGateDeps["gitIsDirty"] {
  let i = 0;
  return async () => values[i < values.length ? i++ : values.length - 1];
}

function commitTracker(): { commits: string[]; gitCommit: FormatGateDeps["gitCommit"] } {
  const commits: string[] = [];
  return {
    commits,
    gitCommit: async (_path, message) => { commits.push(message); return { ok: true }; },
  };
}

// ---------------------------------------------------------------------------
// 5.1 No-op when format_gate is empty
// ---------------------------------------------------------------------------

test("format gate: no-op when format_gate is empty array", async () => {
  const result = await runFormatGate("/wt", cfg([]), 42, {
    execInWorktree: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.status, "ok");
});

test("format gate: no-op when format_gate is absent (undefined cast to empty)", async () => {
  // PipelineConfig always has format_gate, but we test the guard defensively.
  const result = await runFormatGate("/wt", { format_gate: undefined as unknown as [] }, 42, {
    execInWorktree: async () => { throw new Error("should not be called"); },
  });
  assert.equal(result.status, "ok");
});

// ---------------------------------------------------------------------------
// 5.2 Auto-fix path — changes produced, commit created, re-run passes → success
// ---------------------------------------------------------------------------

test("format gate: auto-fix produces changes, commit created, re-run passes → ok", async () => {
  const tracker = commitTracker();
  // First exec exits 0 (auto-fix ran successfully). Second exec (re-run) exits 0.
  // dirtySeq: pre-flight → false (clean), post-command → true (dirty, triggers commit),
  //           post-re-run → false (stable, no further changes).
  const result = await runFormatGate("/wt", cfg([{ command: "cargo fmt", auto_fix: true }]), 42, {
    execInWorktree: execSeq([{ code: 0 }, { code: 0 }]),
    gitIsDirty: dirtySeq([false, true, false]),
    gitCommit: tracker.gitCommit,
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(tracker.commits, ["chore: auto-format (#42)"]);
});

// ---------------------------------------------------------------------------
// 5.3 Auto-fix path — re-run exits non-zero → blocked
// ---------------------------------------------------------------------------

test("format gate: auto-fix re-run exits non-zero → blocked", async () => {
  const tracker = commitTracker();
  // dirtySeq: pre-flight → false (clean), post-command → true (dirty).
  const result = await runFormatGate("/wt", cfg([{ command: "cargo fmt", auto_fix: true }]), 99, {
    execInWorktree: execSeq([{ code: 0 }, { code: 1, combined: "still dirty after fmt" }]),
    gitIsDirty: dirtySeq([false, true]),
    gitCommit: tracker.gitCommit,
  });
  assert.equal(result.status, "blocked");
  assert.ok("reason" in result && result.reason.includes("cargo fmt"), `unexpected reason: ${JSON.stringify(result)}`);
  assert.ok("reason" in result && result.reason.includes("still dirty after fmt"));
  // Commit was still created (before the re-run)
  assert.equal(tracker.commits.length, 1);
});

// ---------------------------------------------------------------------------
// 5.4 Auto-fix path — no changes produced → no commit, proceed
// ---------------------------------------------------------------------------

test("format gate: auto-fix produces no changes → no commit, proceed", async () => {
  const tracker = commitTracker();
  const result = await runFormatGate("/wt", cfg([{ command: "cargo fmt", auto_fix: true }]), 7, {
    execInWorktree: exec(0),
    gitIsDirty: dirty(false),
    gitCommit: tracker.gitCommit,
  });
  assert.equal(result.status, "ok");
  assert.equal(tracker.commits.length, 0);
});

// ---------------------------------------------------------------------------
// 5.5 Check-only path — exits 0 → success
// ---------------------------------------------------------------------------

test("format gate: check-only exits 0 → ok", async () => {
  const result = await runFormatGate(
    "/wt",
    cfg([{ command: "cargo clippy -D warnings", auto_fix: false }]),
    1,
    { execInWorktree: exec(0) },
  );
  assert.equal(result.status, "ok");
});

// ---------------------------------------------------------------------------
// 5.6 Check-only path — exits non-zero → blocked
// ---------------------------------------------------------------------------

test("format gate: check-only exits non-zero → blocked with reason", async () => {
  const result = await runFormatGate(
    "/wt",
    cfg([{ command: "cargo clippy -D warnings", auto_fix: false }]),
    3,
    { execInWorktree: exec(1, "error[E0001]: unused variable") },
  );
  assert.equal(result.status, "blocked");
  assert.ok("reason" in result && result.reason.includes("cargo clippy -D warnings"));
  assert.ok("reason" in result && result.reason.includes("error[E0001]: unused variable"));
});

// ---------------------------------------------------------------------------
// 5.7 Multiple entries run in order; second failure blocks even after first passes
// ---------------------------------------------------------------------------

test("format gate: multiple entries — second failure blocks", async () => {
  // Entry 1 (check-only): exits 0. Entry 2 (check-only): exits 1.
  const calls: string[] = [];
  const result = await runFormatGate(
    "/wt",
    cfg([
      { command: "eslint src/", auto_fix: false },
      { command: "prettier --check src/", auto_fix: false },
    ]),
    10,
    {
      execInWorktree: async (_path, cmd) => {
        calls.push(cmd);
        if (cmd.startsWith("prettier")) return { code: 1, combined: "prettier would change files" };
        return { code: 0, combined: "" };
      },
    },
  );
  assert.deepEqual(calls, ["eslint src/", "prettier --check src/"]);
  assert.equal(result.status, "blocked");
  assert.ok("reason" in result && result.reason.includes("prettier --check src/"));
});

test("format gate: multiple entries — first success, second auto-fix, third check-only all pass → ok", async () => {
  const tracker = commitTracker();
  let call = 0;
  const result = await runFormatGate(
    "/wt",
    cfg([
      { command: "prettier --write src/", auto_fix: true },
      { command: "eslint src/", auto_fix: false },
    ]),
    5,
    {
      execInWorktree: async (_path, _cmd) => {
        call++;
        return { code: 0, combined: "" };
      },
      gitIsDirty: dirty(false),
      gitCommit: tracker.gitCommit,
    },
  );
  assert.equal(result.status, "ok");
  // prettier ran once (no dirty → no re-run), eslint ran once
  assert.equal(call, 2);
  assert.equal(tracker.commits.length, 0);
});

// ---------------------------------------------------------------------------
// Auto-fix first-run failure blocks (no commit attempted)
// ---------------------------------------------------------------------------

test("format gate: auto-fix first run exits non-zero → blocked, no commit", async () => {
  const tracker = commitTracker();
  const result = await runFormatGate(
    "/wt",
    cfg([{ command: "cargo fmt", auto_fix: true }]),
    1,
    {
      execInWorktree: exec(1, "rustfmt not installed"),
      gitIsDirty: dirty(false),
      gitCommit: tracker.gitCommit,
    },
  );
  assert.equal(result.status, "blocked");
  assert.ok("reason" in result && result.reason.includes("cargo fmt"));
  assert.equal(tracker.commits.length, 0);
});

// ---------------------------------------------------------------------------
// Regression: pre-existing dirty worktree blocks before any command runs (#182 finding 1)
// ---------------------------------------------------------------------------

test("format gate: pre-existing dirty worktree blocks before any command runs", async () => {
  const result = await runFormatGate(
    "/wt",
    cfg([{ command: "cargo fmt", auto_fix: true }]),
    42,
    {
      execInWorktree: async () => { throw new Error("should not be called"); },
      gitIsDirty: dirty(true),
    },
  );
  assert.equal(result.status, "blocked");
  assert.ok(
    "reason" in result && result.reason.includes("pre-existing uncommitted changes"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
});

// ---------------------------------------------------------------------------
// Regression: auto-fix re-run leaves dirty worktree → non-stable formatter (#182 review-2 finding 2)
// ---------------------------------------------------------------------------

test("format gate: auto-fix re-run exits 0 but leaves dirty worktree → blocked (non-stable formatter)", async () => {
  const tracker = commitTracker();
  // dirtySeq: pre-flight → false, post-command → true (dirty, triggers commit), post-re-run → true again (non-stable)
  const result = await runFormatGate("/wt", cfg([{ command: "cargo fmt", auto_fix: true }]), 42, {
    execInWorktree: execSeq([{ code: 0 }, { code: 0 }]),
    gitIsDirty: dirtySeq([false, true, true]),
    gitCommit: tracker.gitCommit,
  });
  assert.equal(result.status, "blocked");
  assert.ok(
    "reason" in result && result.reason.includes("non-stable"),
    `expected non-stable reason: ${JSON.stringify(result)}`,
  );
  assert.ok(
    "reason" in result && result.reason.includes("cargo fmt"),
    `expected command name in reason: ${JSON.stringify(result)}`,
  );
  // Commit was still created before the non-stable check
  assert.equal(tracker.commits.length, 1);
});

// ---------------------------------------------------------------------------
// Regression: auto-format commit failure returns blocked (#182 finding 2)
// ---------------------------------------------------------------------------

test("format gate: auto-format commit failure → blocked with error", async () => {
  const result = await runFormatGate(
    "/wt",
    cfg([{ command: "cargo fmt", auto_fix: true }]),
    77,
    {
      execInWorktree: exec(0),
      // pre-flight clean, post-command dirty
      gitIsDirty: dirtySeq([false, true]),
      gitCommit: async () => ({ ok: false, error: "git commit failed (exit 1): index locked" }),
    },
  );
  assert.equal(result.status, "blocked");
  assert.ok(
    "reason" in result && result.reason.includes("auto-format commit failed"),
    `unexpected reason: ${JSON.stringify(result)}`,
  );
  assert.ok(
    "reason" in result && result.reason.includes("index locked"),
    `expected error detail in reason: ${JSON.stringify(result)}`,
  );
});
