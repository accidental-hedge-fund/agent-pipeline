// Tests for ci_mode: local pre-merge CI gate (#350).
//
// Verifies that:
//  - ci_mode: github (default) still calls getPrChecks (regression guard)
//  - ci_mode: local with a passing test-gate advances without calling getPrChecks
//  - ci_mode: local with a failing test-gate blocks to needs-human
//  - ci_mode: local with no test-gate event blocks (fail-closed; no runDir)
//  - ci_mode: local with no test-gate event blocks (fail-closed; runDir present but no events)
//  - ci_mode: local still blocks on a conflicting PR (mergeability gate still runs)
//  - ci_mode: local blocks when PR head moved after test gate ran (OpenSpec archive scenario)
//  - ci_mode: local blocks when PR head moved after test gate ran (BEHIND/conflict rebase scenario)
//  - ci_mode: local blocks when pr_head_sha absent in event (old event format; fail-closed)
//  - ci_mode: local blocks when developer push moves head before first pre-merge eval (review-2 regression)

import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";
import type { RunEvent, StageAccountingEvent } from "../scripts/run-store.ts";

const SHA_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// SHA at which the test gate ran; differs from SHA_HEAD to simulate a pre-merge
// mutation (archive commit or rebase) that moved the PR head after the test gate ran.
const SHA_PRE_MUTATION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_NUMBER = 350;

function makeStageAccountingEvent(
  outcome: "success" | "failure",
  prHeadSha?: string | null,
): StageAccountingEvent {
  return {
    schema_version: 1,
    type: "stage_accounting",
    at: "2026-06-30T00:00:00Z",
    run_id: "350-run",
    issue: 350,
    stage: "test-gate",
    harness: "test-gate",
    model_slot: null,
    model: null,
    started_at: "2026-06-30T00:00:00Z",
    ended_at: "2026-06-30T00:01:00Z",
    duration_ms: 60000,
    command_count: 1,
    subprocess_count: 1,
    outcome,
    blocker_kind: outcome === "success" ? null : "test-gate-exhausted",
    cost_source: "unknown",
    cost_usd: null,
    ...(prHeadSha !== undefined ? { pr_head_sha: prHeadSha } : {}),
  } as StageAccountingEvent;
}

function makeCfg(ciMode: "github" | "local" = "github"): PipelineConfig {
  return {
    ci_mode: ciMode,
    ci_no_run_grace_s: 60,
    steps: { docs: false },
    eval_gate: { enabled: false },
    shipcheck_gate: { enabled: false },
    base_branch: "main",
  } as unknown as PipelineConfig;
}

const reviewComment = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

/** Deps that pass SHA gate, no worktree (archive/spec gates skip), clean mergeability. */
function makeBaseDeps(overrides: Partial<AdvancePreMergeDeps> = {}): AdvancePreMergeDeps {
  return {
    getPrForIssue: async () => PR_NUMBER,
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewComment }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrCommits: async () => [],
    getForIssue: async () => null,
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async () => {},
    getGhActor: async () => "test-actor",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 3.2 — ci_mode: github (default) still calls getPrChecks (regression guard)
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: github — calls getPrChecks and advances on green checks (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  let getPrChecksCalled = false;
  const deps = makeBaseDeps({
    getPrChecks: async () => {
      getPrChecksCalled = true;
      return [{ name: "ci", bucket: "pass" }] as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrChecks"]>>
      >;
    },
  });

  const out = await advance(makeCfg("github"), 350, {}, deps);

  assert.equal(getPrChecksCalled, true, "github mode must call getPrChecks");
  assert.equal(out.advanced, true, "github mode must advance on green CI");
});

// ---------------------------------------------------------------------------
// 3.3 — ci_mode: local with test-gate pass advances without calling getPrChecks
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local with passing test-gate advances without calling getPrChecks (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  let getPrChecksCalled = false;
  // Include pr_head_sha matching the current PR head so the SHA guard passes.
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_HEAD)];

  const deps = makeBaseDeps({
    getPrChecks: async () => {
      getPrChecksCalled = true;
      return [];
    },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(getPrChecksCalled, false, "local mode must NOT call getPrChecks");
  assert.equal(out.advanced, true, "local mode with passing test-gate must advance");
  assert.equal((out as { to: string }).to, "ready-to-deploy");
});

// ---------------------------------------------------------------------------
// 3.4 — ci_mode: local with test-gate failure blocks to needs-human
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local with failing test-gate blocks to needs-human (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const failEvents: RunEvent[] = [makeStageAccountingEvent("failure")];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => failEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false);
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("failure")),
    `blocked reason must mention ci_mode: local and failure; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// 3.5 — ci_mode: local with no test-gate event blocks (fail-closed)
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local with no test-gate event (runDir provided) blocks fail-closed (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // No stage_accounting events for test-gate — only a run_start
  const emptyEvents: RunEvent[] = [
    { schema_version: 1, type: "run_start", at: "2026-06-30T00:00:00Z", run_id: "350-run", issue: 350, repo: "acme/test" },
  ];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => emptyEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance when no test-gate event present");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local with no runDir blocks fail-closed (never silently advances) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    // readRunEvents omitted — defaults to real readEvents which would get null runDir
  });

  // No runDir provided → latestTestGateOutcome returns null → fail-closed
  const out = await advance(makeCfg("local"), 350, {}, deps);

  assert.equal(out.advanced, false, "must not advance without a runDir");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// 3.6 — ci_mode: local still blocks on a conflicting PR (mergeability gate runs)
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local — mergeability gate still runs (conflicting PR blocks) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_HEAD)];
  let getPrDetailCalls = 0;

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    getPrDetail: async () => {
      getPrDetailCalls++;
      if (getPrDetailCalls === 1) {
        // Step 0.5 early conflict check: not conflicting
        return { head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" } as Awaited<
          ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
        >;
      }
      // Step 2 mergeability re-fetch: PR became conflicting
      return { head_sha: SHA_HEAD, mergeable: false, mergeable_state: "DIRTY" } as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >;
    },
    getForIssue: async () => ({ path: "/fake/wt", slug: "slug" }) as Awaited<
      ReturnType<NonNullable<AdvancePreMergeDeps["getForIssue"]>>
    >,
    rebaseAlreadyAttempted: () => true, // skip rebase attempt so we go straight to block
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance on a conflicting PR even with ci_mode: local");
  // Either blocked (needs-human) or some other non-advanced status is acceptable.
  assert.ok(
    ["blocked", "waiting"].includes((out as { status: string }).status),
    `status must be blocked or waiting; got: ${(out as { status: string }).status}`,
  );
});

// ---------------------------------------------------------------------------
// SHA-aware guard: block when PR head moved after test gate ran (#350 review-2)
// ---------------------------------------------------------------------------
// The guard now uses pr_head_sha recorded IN the test-gate event (not pollingCtx),
// so it catches head movement that occurs before pollingCtx is populated (e.g. a
// developer push while review runs → delta review passes → pre-merge is first call).

test("pre-merge ci_mode: local — blocks when PR head moved after test gate ran (archive scenario) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Test gate ran at SHA_PRE_MUTATION; event records that tested SHA.
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];

  // SHA gate passes: reviewed SHA matches current head (SHA_HEAD, the archive head).
  const reviewCommentWithCurrentHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentWithCurrentHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      // Current head is SHA_HEAD (after the archive commit was pushed).
      ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  // No pollingCtx needed: SHA comes from the event's pr_head_sha field.
  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance when head moved after test gate ran");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some(
      (r) => r.includes("ci_mode: local") && r.includes("PR head changed") &&
        r.includes(SHA_PRE_MUTATION.slice(0, 7)) && r.includes(SHA_HEAD.slice(0, 7)),
    ),
    `blocked reason must mention ci_mode: local, PR head changed, and both SHAs; got: ${blockedReasons.join("; ")}`,
  );
});

// Models the second pre-merge poll iteration after a BEHIND rebase was pushed.
// The test gate ran at SHA_PRE_MUTATION; after the rebase, current head = SHA_HEAD.
// Local mode must block rather than advance with a result from the pre-rebase commit.

test("pre-merge ci_mode: local — blocks when PR head moved after test gate ran (BEHIND rebase scenario) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Event records the tested SHA (SHA_PRE_MUTATION, before the rebase).
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];

  const reviewCommentWithCurrentHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentWithCurrentHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      // Current head is SHA_HEAD (after the rebase commit was pushed).
      ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance when head moved after test gate ran (rebase)");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some(
      (r) => r.includes("ci_mode: local") && r.includes("PR head changed"),
    ),
    `blocked reason must mention ci_mode: local and PR head changed; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Regression test: developer push before first pre-merge eval (#350 review-2)
// ---------------------------------------------------------------------------
// Scenario: test gate ran at SHA_PRE_MUTATION → developer pushes new commit (SHA_HEAD)
// → delta review accepts SHA_HEAD → pre-merge first call, pollingCtx unset.
// With review-1 fix: preArchiveSha captured as SHA_HEAD (current) → SHA guard passes (BUG).
// With review-2 fix: pr_head_sha in event = SHA_PRE_MUTATION ≠ SHA_HEAD → blocks (CORRECT).

test("pre-merge ci_mode: local — blocks when developer push moves head before first pre-merge eval (#350 review-2)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Test gate ran at SHA_PRE_MUTATION and event records that SHA.
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];

  // Delta review passed at SHA_HEAD (developer's new commit).
  const reviewCommentAtNewHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentAtNewHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrDetail: async () =>
      // Current head = SHA_HEAD (developer's push, not the tested commit).
      ({ head_sha: SHA_HEAD, mergeable: true, mergeable_state: "CLEAN" }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  // No pollingCtx (first call in this run): preArchiveSha would be set to SHA_HEAD
  // by the review-1 implementation, making the old guard a no-op. The review-2
  // fix reads pr_head_sha from the event (SHA_PRE_MUTATION) instead.
  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not certify untested developer commit");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some(
      (r) => r.includes("ci_mode: local") && r.includes("PR head changed"),
    ),
    `blocked reason must mention ci_mode: local and PR head changed; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed: block when pr_head_sha absent in event (old event format)
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local — blocks when event has no pr_head_sha (old format; fail-closed) (#350 review-2)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Event without pr_head_sha (legacy format — no second arg).
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success")];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance when pr_head_sha is absent");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});
