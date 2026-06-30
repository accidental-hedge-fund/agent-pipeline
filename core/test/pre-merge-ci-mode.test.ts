// Tests for ci_mode: local pre-merge CI gate (#350).
//
// Verifies that:
//  - ci_mode: github (default) still calls getPrChecks (regression guard)
//  - ci_mode: local with a passing test-gate advances without calling getPrChecks
//  - ci_mode: local with a failing test-gate blocks to needs-human
//  - ci_mode: local with no test-gate event + no worktree blocks fail-closed
//  - ci_mode: local with no test-gate event + worktree runs inline gate (absent → recovered)
//  - ci_mode: local with stale SHA + worktree runs inline gate (archive scenario recovered)
//  - ci_mode: local with stale SHA + worktree + inline fails → blocks
//  - ci_mode: local with stale SHA + no worktree → blocks fail-closed
//  - ci_mode: local still blocks on a conflicting PR (mergeability gate still runs)
//  - ci_mode: local blocks when pr_head_sha absent in event (old event format) + no worktree → fail-closed
//  - ci_mode: local final SHA re-check: push during mergeability re-fetch blocks (bug-1 fix)

import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig, Stage } from "../scripts/types.ts";
import type { RunEvent, StageAccountingEvent } from "../scripts/run-store.ts";
import type { TestGateResult } from "../scripts/testgate.ts";

const SHA_HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
// SHA at which the test gate ran; differs from SHA_HEAD to simulate a pre-merge
// mutation (archive commit or rebase) that moved the PR head after the test gate ran.
const SHA_PRE_MUTATION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// SHA that arrives via a push during the mergeability re-fetch (used for bug-1 final SHA re-check test).
const SHA_PUSHED_DURING_STEP2 = "cccccccccccccccccccccccccccccccccccccccc";

// Fake runTestGate that immediately resolves with the given result.
function fakeRunTestGate(result: TestGateResult): NonNullable<AdvancePreMergeDeps["runTestGate"]> {
  return async () => result;
}

// Fake worktree returned from getForIssue for inline-gate tests.
const FAKE_WT = { path: "/fake/wt", slug: "slug" } as Awaited<
  ReturnType<NonNullable<AdvancePreMergeDeps["getForIssue"]>>
>;
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
    // Default: throw to catch accidental inline gate invocations in tests that
    // don't provide a worktree (getForIssue → null blocks before this is reached).
    runTestGate: async () => { throw new Error("runTestGate should not be called in this test"); },
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
// 3.5 — ci_mode: local with no test-gate event: inline gate runs when worktree
//        exists; blocks fail-closed when no worktree is available
// ---------------------------------------------------------------------------

test("pre-merge ci_mode: local absent result + no worktree → blocks fail-closed (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const emptyEvents: RunEvent[] = [
    { schema_version: 1, type: "run_start", at: "2026-06-30T00:00:00Z", run_id: "350-run", issue: 350, repo: "acme/test" },
  ];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => emptyEvents,
    // getForIssue → null (default): blocks before reaching runTestGate
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance: no worktree for inline gate");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local no runDir + no worktree → blocks fail-closed (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    // readRunEvents omitted; getForIssue → null: blocks before runTestGate
  });

  const out = await advance(makeCfg("local"), 350, {}, deps);

  assert.equal(out.advanced, false, "must not advance without a runDir and no worktree");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local absent result + worktree + inline gate passes (attempts=0) → advances (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const emptyEvents: RunEvent[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    readRunEvents: async () => emptyEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: false, passed: true, attempts: 0 }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, true, "absent result + inline gate pass (attempts=0) must advance");
});

test("pre-merge ci_mode: local inline gate skipped → blocks fail-closed (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const emptyEvents: RunEvent[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => emptyEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: true }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "skipped inline gate must block fail-closed");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("skipped")),
    `blocked reason must mention ci_mode: local and skipped; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local inline gate passes but attempts>0 → blocks (fix commits not pushed) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const emptyEvents: RunEvent[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => emptyEvents,
    getForIssue: async () => FAKE_WT,
    // passed=true but attempts=1 means the implementer ran and may have created commits
    runTestGate: fakeRunTestGate({ skipped: false, passed: true, attempts: 1 }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "inline gate with attempts>0 must block (fix commits not pushed)");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("implementer")),
    `blocked reason must mention ci_mode: local and implementer; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local absent result + worktree + inline gate fails → blocks (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const emptyEvents: RunEvent[] = [];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => emptyEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: false, passed: false }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "absent result + inline gate failure must block");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("inline")),
    `blocked reason must mention ci_mode: local and inline; got: ${blockedReasons.join("; ")}`,
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
// SHA-aware guard: stale test-gate event → run inline gate (#350 pre-merge fix)
// ---------------------------------------------------------------------------
// When the PR head moved after the test gate ran (archive commit, rebase, developer
// push), the code used to block immediately ("re-run the pipeline") — a dead-end loop.
// The fix runs the test gate inline against the current worktree so recovery is
// deterministic. The final SHA re-check (bug-1 fix) catches any push that arrives
// between the inline gate completion and the mergeability re-fetch.

test("pre-merge ci_mode: local stale SHA + worktree + inline gate passes → advances (archive scenario) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  // Test gate ran at SHA_PRE_MUTATION; archive commit moved head to SHA_HEAD.
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];
  const reviewCommentWithCurrentHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentWithCurrentHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    readRunEvents: async () => passEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: false, passed: true, attempts: 0 }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  // Stale SHA → inline gate runs on current worktree (archive commit is just spec files,
  // tests still pass) → localTestedSha set → pipeline advances.
  assert.equal(out.advanced, true, "stale SHA + inline gate pass must advance (archive scenario)");
});

test("pre-merge ci_mode: local stale SHA + worktree + inline gate passes → advances (rebase scenario) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];
  const reviewCommentWithCurrentHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentWithCurrentHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    readRunEvents: async () => passEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: false, passed: true, attempts: 0 }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, true, "stale SHA + inline gate pass must advance (rebase scenario)");
});

test("pre-merge ci_mode: local stale SHA + worktree + inline gate fails → blocks (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];
  const reviewCommentWithCurrentHead = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

  const deps = makeBaseDeps({
    getIssueDetail: async () =>
      ({ comments: [{ body: reviewCommentWithCurrentHead }] }) as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getIssueDetail"]>>
      >,
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => passEvents,
    getForIssue: async () => FAKE_WT,
    runTestGate: fakeRunTestGate({ skipped: false, passed: false }),
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "stale SHA + inline gate failure must block");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("inline")),
    `blocked reason must mention ci_mode: local and inline; got: ${blockedReasons.join("; ")}`,
  );
});

test("pre-merge ci_mode: local stale SHA + no worktree → blocks fail-closed (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Test gate ran at SHA_PRE_MUTATION; PR head now at SHA_HEAD (developer push).
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_PRE_MUTATION)];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => passEvents,
    // getForIssue → null (default): blocks before reaching runTestGate
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "stale SHA + no worktree must block fail-closed");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Bug-1 fix: final SHA re-check catches push that arrives during Step 2
// ---------------------------------------------------------------------------
// Scenario: test gate result has prHeadSha = SHA_HEAD (matches prDetail on Step 1).
// A push arrives during the mergeability re-fetch → freshPrDetail.head_sha = SHA_PUSHED.
// The final re-check must block rather than certify the freshly pushed (untested) commit.

test("pre-merge ci_mode: local final SHA re-check: push during Step 2 mergeability re-fetch blocks (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Initial result matches SHA_HEAD → no inline run needed.
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success", SHA_HEAD)];

  let getPrDetailCallCount = 0;
  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async () => passEvents,
    getPrDetail: async () => {
      getPrDetailCallCount++;
      const sha = getPrDetailCallCount === 1
        ? SHA_HEAD          // first fetch (Step 0.5 / Step 1): matches test-gate event
        : SHA_PUSHED_DURING_STEP2; // second fetch (Step 2): push arrived during mergeability poll
      return { head_sha: sha, mergeable: true, mergeable_state: "CLEAN" } as Awaited<
        ReturnType<NonNullable<AdvancePreMergeDeps["getPrDetail"]>>
      >;
    },
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "push during Step 2 must not result in certifying an untested commit");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local") && r.includes("PR head moved")),
    `blocked reason must mention ci_mode: local and PR head moved; got: ${blockedReasons.join("; ")}`,
  );
});

// ---------------------------------------------------------------------------
// Fail-closed: absent pr_head_sha in event → treated as stale → inline gate path
// ---------------------------------------------------------------------------
// An old-format event (no pr_head_sha) is treated identically to a stale SHA:
// !tgResult.prHeadSha → isStale = true → run inline gate. If no worktree is
// available, this blocks fail-closed.

test("pre-merge ci_mode: local absent pr_head_sha + no worktree → blocks fail-closed (old event format) (#350)", async (t) => {
  t.mock.method(console, "log", () => {});

  const blockedReasons: string[] = [];
  // Event without pr_head_sha (legacy format — no second arg).
  const passEvents: RunEvent[] = [makeStageAccountingEvent("success")];

  const deps = makeBaseDeps({
    getPrChecks: async () => { throw new Error("should not be called"); },
    setBlocked: async (_cfg, _n, reason) => { blockedReasons.push(reason); },
    readRunEvents: async (_runDir: string) => passEvents,
    // getForIssue → null (default): blocks before reaching runTestGate
  });

  const out = await advance(makeCfg("local"), 350, { runDir: "/fake/run/dir" }, deps);

  assert.equal(out.advanced, false, "must not advance when pr_head_sha is absent and no worktree");
  assert.equal((out as { status: string }).status, "blocked");
  assert.ok(
    blockedReasons.some((r) => r.includes("ci_mode: local")),
    `blocked reason must mention ci_mode: local; got: ${blockedReasons.join("; ")}`,
  );
});
