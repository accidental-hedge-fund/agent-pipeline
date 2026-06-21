// Benchmark and reliability regression suite for pipeline hotspot paths (#266).
//
// All scenarios use injectable fake deps — no real network, git, or subprocess
// calls. Each benchmark scenario produces a BenchmarkResult with p50/p95 wall
// time, gh call count, and stage duration. Each reliability scenario asserts the
// production code handles a known failure mode correctly (these are regression
// tests: they pass with current correct code and would fail if the guard were
// removed).
//
// Run via: cd core && npm test
// Or from the repo root: npm run ci

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computePercentiles, makeGhCounter, type BenchmarkResult } from "./bench-helpers.ts";
import { advanceReview, type AdvanceReviewDeps } from "../scripts/stages/review-routing.ts";
import { advance, type AdvancePreMergeDeps } from "../scripts/stages/pre_merge.ts";
import { runStatus, runSummaryByRunId, type RunStatusDeps, type RunSummaryDeps } from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { ReviewerInvocation } from "../scripts/self-review.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// Minimal config used by all scenarios. Only the fields accessed by the tested
// paths are populated; cast to PipelineConfig to satisfy the type without
// providing every field.
const cfg = {
  repo: "acme/test-repo",
  repo_dir: "/fake/repo",
  base_branch: "main",
  worktree_root: ".worktrees",
  domain: "test",
  invocation: "pipeline",
  marker_footer: "*Automated by Claude Code Pipeline Skill*",
  review_mode: "prompt-harness",
  harnesses: { implementer: "claude", reviewer: "codex" },
  models: { planning: "sonnet", implementing: "sonnet", review: "opus", fix: "sonnet", intake: "sonnet", sweep: "sonnet" },
  review_policy: {
    block_threshold: "medium",
    min_confidence: 0.7,
    max_adversarial_rounds: 3,
    risk_proportional: false,
    ceiling_action: "park",
    surface_recurrence_rounds: 3,
  },
  steps: { plan_review: true, standard_review: true, adversarial_review: true, docs: true },
  eval_gate: { enabled: false, mode: "gate", timeout: 300, max_attempts: 2 },
  shipcheck_gate: { enabled: false, mode: "advisory", max_rounds: 1, rubric_path: "", block_on_partial: false },
  trusted_override_actors: [],
  implementation_ready_message: "",
  conventions_default: "",
  review_timeout: 1500,
  ci_timeout: 60,
  ci_poll_interval: 0, // no real sleep in tests
  openspec: { enabled: "off", bootstrap: false },
  last30days: { enabled: false, timeout: 600 },
} as unknown as PipelineConfig;

// A well-formed 40-char hex SHA used for PR head refs.
const FAKE_SHA = "a".repeat(40);

// A minimal approve verdict JSON returned by the fake runReview dep.
const APPROVE_VERDICT_JSON = JSON.stringify({
  verdict: "approve",
  summary: "LGTM",
  findings: [],
  next_steps: [],
  commit_sha: FAKE_SHA,
});

// Fake reviewer invocation returning an immediate approve verdict.
const fakeApproveReview: () => Promise<ReviewerInvocation> = async () => ({
  result: {
    success: true,
    stdout: APPROVE_VERDICT_JSON,
    stderr: "",
    exit_code: 0,
    duration: 0.001,
    timed_out: false,
  },
  effectiveReviewer: "codex",
  selfReview: false,
});

// Base advanceReview deps shared by multiple tests (non-worktree gh calls).
// Each test may override individual seams.
function makeBaseReviewDeps(counter?: ReturnType<typeof makeGhCounter>): AdvanceReviewDeps {
  const track = counter ? counter.track.bind(counter) : <T>(fn: (...args: never[]) => Promise<T>) => fn;
  return {
    getGhActor: track(async () => "test-actor"),
    getPrForIssue: track(async () => 42),
    getPrDetail: track(async () => ({
      number: 42,
      title: "Test PR",
      body: "",
      state: "open" as const,
      url: "https://github.com/acme/test-repo/pull/42",
      head_ref: "pipeline/42-test",
      head_sha: FAKE_SHA,
      base_ref: "main",
      mergeable: true,
      mergeable_state: "CLEAN",
      draft: false,
      additions: 10,
      deletions: 2,
      changed_files: 3,
    })),
    getPrDiff: track(async () => "diff --git a/src/foo.ts b/src/foo.ts\n+// change\n"),
    getIssueDetail: track(async () => ({
      number: 42,
      type: "issue" as const,
      title: "Test issue",
      body: "test body",
      state: "open" as const,
      url: "https://github.com/acme/test-repo/issues/42",
      labels: ["pipeline:review-1"],
      comments: [],
    })),
    // getForIssue is NOT tracked (filesystem, not gh)
    getForIssue: async () => ({ path: "/fake/worktree", slug: "test" }),
    runReview: fakeApproveReview,
    postComment: track(async () => {}),
    postPrComment: track(async () => {}),
    transition: track(async () => {}),
    setBlocked: track(async () => {}),
    createIssue: async () => 0,
    addIssueComment: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Section 1: Shared benchmark infrastructure — verified by importing and using
// the helpers (no standalone test needed; the benchmarks below exercise them).
// ---------------------------------------------------------------------------

describe("benchmark-reliability-suite", () => {

  // -------------------------------------------------------------------------
  // Section 2: Status latency benchmark (variable worktree counts)
  // -------------------------------------------------------------------------

  /**
   * Run the "status lookup" path N samples with a fake worktree list of size
   * `worktreeCount`. The status lookup simulates:
   *   1. One fake gh call (getIssueDetail equivalent) — provides a non-zero
   *      base gh_call_count so the super-linearity check in 2.3 is meaningful.
   *   2. A linear scan through `worktreeCount` fake worktree records to find
   *      the target issue (mirrors what getForIssue / listActive does in production).
   *
   * The target issue is placed at the END of the list (worst-case scan) so that
   * scaling measurements reflect the real upper bound.
   */
  async function runStatusBenchmark(worktreeCount: number, scenario: string): Promise<BenchmarkResult> {
    const SAMPLES = 30;
    const counter = makeGhCounter();
    const samples: number[] = [];

    // Fake worktree records: issue 1..worktreeCount; target = last one (worst-case scan).
    const targetIssue = worktreeCount;
    const fakeWorktrees = Array.from({ length: worktreeCount }, (_, i) => ({
      issueNumber: i + 1,
      path: `/fake/wt-${i}`,
      slug: `slug-${i}`,
    }));

    // Drive the PRODUCTION runStatus(json) path through injected deps, so a regression
    // in the real status code (e.g. dropping getForIssue, or adding extra gh calls)
    // actually changes this benchmark. The gh-style deps are counted; getForIssue does
    // the in-process worktree scan whose O(N) cost is what scales latency with
    // worktreeCount, while gh_call_count stays flat (status makes a fixed number of gh
    // calls regardless of how many worktrees exist).
    const deps = {
      getIssueDetail: counter.track(async () => ({
        number: targetIssue,
        type: "issue" as const,
        title: "Test issue",
        body: "",
        state: "open" as const,
        url: `https://github.com/acme/test-repo/issues/${targetIssue}`,
        labels: ["pipeline:review-1"],
        comments: [],
      })),
      getPrForIssue: counter.track(async () => 99),
      getForIssue: async () => {
        // Worst-case linear scan of the synthetic worktree list (target placed last).
        let found: { path: string; slug: string } | null = null;
        for (const wt of fakeWorktrees) {
          if (wt.issueNumber === targetIssue) { found = { path: wt.path, slug: wt.slug }; break; }
        }
        return found;
      },
      getLabelEvents: counter.track(async () => [{ label: "pipeline:review-1", createdAt: "2026-06-20T00:00:00Z" }]),
    } as unknown as RunStatusDeps;

    // runStatus(json) prints the assembled payload to stdout; silence it during timing.
    const origLog = console.log;
    console.log = () => {};
    let stageDuration = 0;
    try {
      const stageStart = performance.now();
      for (let i = 0; i < SAMPLES; i++) {
        const t0 = performance.now();
        await runStatus(cfg, targetIssue, deps, { json: true });
        samples.push(performance.now() - t0);
      }
      stageDuration = performance.now() - stageStart;
    } finally {
      console.log = origLog;
    }

    const { p50, p95 } = computePercentiles(samples);
    return {
      scenario,
      p50_ms: p50,
      p95_ms: p95,
      gh_call_count: counter.calls,
      stage_duration_ms: stageDuration,
    };
  }

  test("status latency — 1 worktree", async () => {
    const result = await runStatusBenchmark(1, "status-latency-1");

    assert.equal(result.scenario, "status-latency-1");
    assert.ok(typeof result.p50_ms === "number" && result.p50_ms >= 0, `p50_ms must be >= 0, got ${result.p50_ms}`);
    assert.ok(typeof result.p95_ms === "number" && result.p95_ms >= 0, `p95_ms must be >= 0, got ${result.p95_ms}`);
    assert.ok(typeof result.gh_call_count === "number" && result.gh_call_count >= 0, `gh_call_count must be >= 0, got ${result.gh_call_count}`);
    assert.ok(typeof result.stage_duration_ms === "number" && result.stage_duration_ms >= 0, `stage_duration_ms must be >= 0, got ${result.stage_duration_ms}`);

    console.log(`[bench] ${result.scenario}: p50=${result.p50_ms.toFixed(3)}ms p95=${result.p95_ms.toFixed(3)}ms gh_calls=${result.gh_call_count} total=${result.stage_duration_ms.toFixed(1)}ms`);
  });

  test("status latency — 10 worktrees", async () => {
    const result = await runStatusBenchmark(10, "status-latency-10");

    assert.equal(result.scenario, "status-latency-10");
    assert.ok(typeof result.p50_ms === "number" && result.p50_ms >= 0, `p50_ms must be >= 0, got ${result.p50_ms}`);
    assert.ok(typeof result.p95_ms === "number" && result.p95_ms >= 0, `p95_ms must be >= 0, got ${result.p95_ms}`);
    assert.ok(typeof result.gh_call_count === "number" && result.gh_call_count >= 0, `gh_call_count must be >= 0, got ${result.gh_call_count}`);
    assert.ok(typeof result.stage_duration_ms === "number" && result.stage_duration_ms >= 0, `stage_duration_ms must be >= 0, got ${result.stage_duration_ms}`);

    console.log(`[bench] ${result.scenario}: p50=${result.p50_ms.toFixed(3)}ms p95=${result.p95_ms.toFixed(3)}ms gh_calls=${result.gh_call_count} total=${result.stage_duration_ms.toFixed(1)}ms`);
  });

  test("status latency — 50 worktrees", async () => {
    const result = await runStatusBenchmark(50, "status-latency-50");

    assert.equal(result.scenario, "status-latency-50");
    assert.ok(typeof result.p50_ms === "number" && result.p50_ms >= 0, `p50_ms must be >= 0, got ${result.p50_ms}`);
    assert.ok(typeof result.p95_ms === "number" && result.p95_ms >= 0, `p95_ms must be >= 0, got ${result.p95_ms}`);
    assert.ok(typeof result.gh_call_count === "number" && result.gh_call_count >= 0, `gh_call_count must be >= 0, got ${result.gh_call_count}`);
    assert.ok(typeof result.stage_duration_ms === "number" && result.stage_duration_ms >= 0, `stage_duration_ms must be >= 0, got ${result.stage_duration_ms}`);

    console.log(`[bench] ${result.scenario}: p50=${result.p50_ms.toFixed(3)}ms p95=${result.p95_ms.toFixed(3)}ms gh_calls=${result.gh_call_count} total=${result.stage_duration_ms.toFixed(1)}ms`);
  });

  test("status latency — gh_call_count does not grow super-linearly with worktree count", async () => {
    // Run all three sizes and compare gh_call_count. Since the gh calls (issue detail,
    // PR lookup, label events) are a fixed per-sample overhead and the worktree scan
    // (getForIssue) makes no gh calls, the count per sample is constant regardless of N.
    const result1 = await runStatusBenchmark(1, "status-latency-1");
    const result50 = await runStatusBenchmark(50, "status-latency-50");

    // Sanity cap: super-linearity check is meaningful only when there is a non-zero
    // baseline. When gh_call_count(1) > 0, assert that scaling to 50 worktrees
    // does not multiply calls by more than 100× (a linear scaling of 50× would
    // mean gh_call_count(50) = 50 × gh_call_count(1), well within the cap).
    if (result1.gh_call_count > 0) {
      assert.ok(
        result50.gh_call_count < result1.gh_call_count * 100,
        `gh_call_count(50)=${result50.gh_call_count} should be < gh_call_count(1)*100=${result1.gh_call_count * 100}`,
      );
    }
    // When the base count is 0 (purely in-memory scan with no gh calls):
    // assert that 50 worktrees also makes 0 gh calls (i.e., it stays constant).
    else {
      assert.equal(
        result50.gh_call_count,
        result1.gh_call_count,
        `gh_call_count must be constant when no gh calls are made (both should be ${result1.gh_call_count})`,
      );
    }

    console.log(`[bench] super-linearity check: gh_calls(1)=${result1.gh_call_count} gh_calls(50)=${result50.gh_call_count}`);
  });

  // -------------------------------------------------------------------------
  // Section 3: Stage-loop gh call count benchmark
  // -------------------------------------------------------------------------

  test("stage-loop: gh call count per review iteration is within documented budget", async () => {
    // The gh call budget per review-stage iteration (observational, not a timing
    // gate — this constant documents the actual count so regressions are visible).
    // If someone adds gh calls to the review path, this test surfaces it.
    //
    // Observed breakdown for a single advanceReview call (approve, no cache hit):
    //   getGhActor           → 1
    //   getPrForIssue        → 1
    //   getPrDetail (pre)    → 1
    //   getPrDiff            → 1
    //   getPrDetail (post)   → 1
    //   getIssueDetail       → 1
    //   postComment          → 1
    //   transition           → 1
    // Total: 8 (getForIssue and runReview are not gh calls)
    const REVIEW_STAGE_GH_CALL_BUDGET = 15; // observational cap; actual is ~8

    const counter = makeGhCounter();
    const deps = makeBaseReviewDeps(counter);

    const stageStart = performance.now();
    const outcome = await advanceReview(cfg, 42, 1, {}, 0, deps);
    const stageDuration = performance.now() - stageStart;

    const result: BenchmarkResult = {
      scenario: "stage-loop-gh-call-count",
      p50_ms: stageDuration,
      p95_ms: stageDuration,
      gh_call_count: counter.calls,
      stage_duration_ms: stageDuration,
    };

    // BenchmarkResult fields must be present and numeric.
    assert.equal(result.scenario, "stage-loop-gh-call-count");
    assert.ok(result.p50_ms >= 0, `p50_ms >= 0, got ${result.p50_ms}`);
    assert.ok(result.p95_ms >= 0, `p95_ms >= 0, got ${result.p95_ms}`);
    assert.ok(result.gh_call_count >= 0, `gh_call_count >= 0, got ${result.gh_call_count}`);
    assert.ok(result.stage_duration_ms >= 0, `stage_duration_ms >= 0, got ${result.stage_duration_ms}`);

    // The core assertion: gh calls stay within the observational budget.
    assert.ok(
      result.gh_call_count <= REVIEW_STAGE_GH_CALL_BUDGET,
      `gh_call_count=${result.gh_call_count} exceeds observational budget=${REVIEW_STAGE_GH_CALL_BUDGET}. ` +
      `If you added gh calls to the review path, update REVIEW_STAGE_GH_CALL_BUDGET and add a comment.`,
    );

    // Stage must have advanced (the happy-path approve outcome).
    assert.ok(outcome.advanced, `expected review stage to advance; got: ${JSON.stringify(outcome)}`);

    console.log(`[bench] ${result.scenario}: gh_calls=${result.gh_call_count} (budget=${REVIEW_STAGE_GH_CALL_BUDGET}) duration=${result.stage_duration_ms.toFixed(1)}ms`);
  });

  // -------------------------------------------------------------------------
  // Section 4: Pre-merge polling call-count benchmark
  // -------------------------------------------------------------------------

  test("pre-merge polling: gh_call_count for getPrChecks equals K + 1 (K pending + 1 success)", async () => {
    const K = 3; // pending poll count before success

    // Counter specifically for CI polling (getPrChecks calls).
    // The gh_call_count in the BenchmarkResult for this scenario is the number
    // of times getPrChecks was invoked — K pending polls + 1 final success = K+1.
    let ciPollCount = 0;
    let pollIndex = 0;

    // Fake checks: first K calls return "pending", K+1th returns "success".
    const fakePrChecks = async () => {
      ciPollCount++;
      pollIndex++;
      if (pollIndex <= K) {
        return [{ name: "ci", state: "IN_PROGRESS", bucket: "pending", description: "running" }];
      }
      return [{ name: "ci", state: "SUCCESS", bucket: "pass", description: "passed" }];
    };

    // Fake SHA gate: pass immediately by returning no review comments + no allowlist.
    // enforceReviewShaGate returns null (gate passes) when getIssueDetail returns
    // no pipeline-authored review comments AND trusted_override_actors is empty.
    const fakeIssueDetail = async () => ({
      number: 42,
      type: "issue" as const,
      title: "Test",
      body: "",
      state: "open" as const,
      url: "https://github.com/acme/test-repo/issues/42",
      labels: ["pipeline:pre-merge"],
      comments: [], // no review comments → SHA gate passes immediately
    });

    const fakePrDetail = async () => ({
      number: 42,
      title: "Test PR",
      body: "",
      state: "open" as const,
      url: "https://github.com/acme/test-repo/pull/42",
      head_ref: "pipeline/42-test",
      head_sha: FAKE_SHA,
      base_ref: "main",
      mergeable: true,
      mergeable_state: "CLEAN",
      draft: false,
      additions: 5,
      deletions: 1,
      changed_files: 2,
    });

    const deps: AdvancePreMergeDeps = {
      getPrForIssue: async () => 42,
      getGhActor: async () => "test-actor",
      getIssueDetail: fakeIssueDetail,
      getPrDetail: fakePrDetail,
      getPrCommits: async () => [],
      getPrDiff: async () => "diff --git a/src/foo.ts b/src/foo.ts\n+// change\n",
      getPrChecks: fakePrChecks,
      getForIssue: async () => null, // no worktree → OpenSpec/rebase steps skip
      setBlocked: async () => {},
      transition: async () => {},
      openspecIsActive: () => false,
      changeDirExists: () => false,
      openspecArchive: async () => ({ success: true, output: "", unavailable: false }),
      gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
      branchDeveloperCommits: async () => [],
      tryRebaseAndPush: async () => false,
      rebaseAlreadyAttempted: () => true,
      markRebaseAttempted: () => {},
    };

    // Simulate the polling loop manually: advance() returns "waiting" on each
    // pending poll. The caller (advancePolling in production) re-invokes advance()
    // until it advances or blocks. Here we loop directly with fake deps, skipping
    // the real setTimeout delay (ci_poll_interval=0 in our test cfg).
    //
    // This matches exactly what advancePolling does:
    //   while (not advanced && not blocked) → advance() → wait → repeat
    const stageStart = performance.now();
    let finalOutcome = { advanced: false as boolean, status: "waiting" as string, reason: "" };
    let loopIterations = 0;
    const MAX_LOOP = K + 5; // guard against infinite loops in case of a bug
    while (loopIterations < MAX_LOOP) {
      const outcome = await advance(cfg, 42, {}, deps);
      loopIterations++;
      if (outcome.advanced || (outcome as { status?: string }).status !== "waiting") {
        finalOutcome = outcome as typeof finalOutcome;
        break;
      }
    }
    const stageDuration = performance.now() - stageStart;

    const result: BenchmarkResult = {
      scenario: "pre-merge-polling-call-count",
      p50_ms: stageDuration,
      p95_ms: stageDuration,
      // gh_call_count is specifically the CI poll (getPrChecks) count for this scenario.
      gh_call_count: ciPollCount,
      stage_duration_ms: stageDuration,
    };

    // BenchmarkResult fields must be present and numeric.
    assert.equal(result.scenario, "pre-merge-polling-call-count");
    assert.ok(result.p50_ms >= 0, `p50_ms >= 0`);
    assert.ok(result.p95_ms >= 0, `p95_ms >= 0`);
    assert.ok(result.gh_call_count >= 0, `gh_call_count >= 0`);
    assert.ok(result.stage_duration_ms >= 0, `stage_duration_ms >= 0`);

    // Core assertion: exactly K + 1 CI polls (K pending + 1 success).
    assert.equal(
      result.gh_call_count,
      K + 1,
      `expected exactly K+1=${K + 1} CI poll calls, got ${result.gh_call_count}`,
    );

    // Stage exits cleanly (no throw) and advances after K+1 polls.
    assert.ok(finalOutcome.advanced, `expected pre-merge to advance after K+1 polls; got: ${JSON.stringify(finalOutcome)}`);

    console.log(`[bench] ${result.scenario}: CI polls=${result.gh_call_count} (K=${K}) iterations=${loopIterations} duration=${result.stage_duration_ms.toFixed(1)}ms`);
  });

  // -------------------------------------------------------------------------
  // Section 5: Harness timeout reliability test
  // -------------------------------------------------------------------------

  test("harness timeout: stage transitions to blocked, not advance or uncaught throw", async () => {
    // RED: fails without harness-timeout handling because stage would advance past
    // a timed-out harness (or throw uncaught). The current code calls setBlocked
    // and returns { advanced: false, status: "blocked" } on harness failure.

    let blockedReason: string | undefined;
    const deps: AdvanceReviewDeps = {
      ...makeBaseReviewDeps(),
      // Inject a fake runReview that returns a timed_out harness result.
      runReview: async () => ({
        result: {
          success: false,
          stdout: "",
          stderr: "process killed: timeout after 1200s",
          exit_code: null as unknown as number,
          duration: 1200,
          timed_out: true,
        },
        effectiveReviewer: "codex",
        selfReview: false,
      }),
      setBlocked: async (_cfg, _issue, reason) => {
        blockedReason = reason;
      },
    };

    const outcome = await advanceReview(cfg, 42, 1, {}, 0, deps);

    // Stage must transition to blocked — not advance, not throw.
    assert.equal(outcome.advanced, false, "stage must NOT advance on harness timeout");
    assert.equal(
      (outcome as { status?: string }).status,
      "blocked",
      `stage must set status=blocked on timeout; got ${JSON.stringify(outcome)}`,
    );

    // The blocked reason must reference the timeout so the operator can diagnose.
    assert.ok(
      blockedReason !== undefined && blockedReason.length > 0,
      "setBlocked must be called with a reason",
    );
    assert.ok(
      blockedReason?.includes("timed out") || blockedReason?.includes("timeout"),
      `blocked reason must reference timeout; got: "${blockedReason}"`,
    );

    console.log(`[reliability] harness-timeout: outcome=${JSON.stringify(outcome)} blocked_reason="${blockedReason}"`);
  });

  // -------------------------------------------------------------------------
  // Section 6: Partial GitHub transition failure reliability test
  // -------------------------------------------------------------------------

  test("partial transition failure: label-add error surfaces blocked outcome, stage does not silently advance", async () => {
    // RED: fails without partial-failure handling because stage would propagate
    // the transition error as an uncaught throw rather than returning a blocked
    // outcome. The fix wraps the transition call in a try/catch and calls
    // setBlocked so the caller receives { advanced: false, status: "blocked" }.

    let transitionAttempted = false;
    let blockedReason: string | undefined;

    const deps: AdvanceReviewDeps = {
      ...makeBaseReviewDeps(),
      transition: async () => {
        transitionAttempted = true;
        // Simulate: gh comment create succeeds, gh label add fails.
        throw new Error("gh label add: label 'pipeline:review-2' not found in repository");
      },
      setBlocked: async (_cfg, _issue, reason) => {
        blockedReason = reason;
      },
    };

    const outcome = await advanceReview(cfg, 42, 1, {}, 0, deps);

    // Transition must have been attempted (the stage reached the label-apply step).
    assert.ok(transitionAttempted, "transition must have been attempted before failing");

    // Stage must return blocked — not throw, not advance.
    assert.equal(outcome.advanced, false, "stage must NOT advance when transition throws");
    assert.equal(
      (outcome as { status?: string }).status,
      "blocked",
      `stage must return status=blocked on label-add failure; got ${JSON.stringify(outcome)}`,
    );

    // setBlocked must be called with a reason referencing the label failure.
    assert.ok(blockedReason !== undefined, "setBlocked must be called with a reason");
    assert.ok(
      blockedReason!.includes("label"),
      `blocked reason must reference label; got: "${blockedReason}"`,
    );

    console.log(`[reliability] partial-transition-failure: outcome=${JSON.stringify(outcome)} blocked_reason="${blockedReason}"`);
  });

  test("partial transition failure on non-approve path: needs-attention below-policy verdict blocks on label-add error", async () => {
    // RED: fails without the safeTransitionFn helper on the no-blocking-advancement
    // path (partition.blocking.length === 0). Before the fix, that path called
    // transitionFn directly with no try/catch, so a label-add error propagated as
    // an uncaught exception rather than returning { advanced: false, status: "blocked" }.
    //
    // Setup: needs-attention verdict with one low-severity finding. With
    // block_threshold="medium" in the test config, the finding lands in advisory
    // (partition.blocking.length === 0), so the no-blocking advancement path is
    // taken. The transition is then guarded by safeTransitionFn.

    const BELOW_POLICY_VERDICT = JSON.stringify({
      verdict: "needs-attention",
      summary: "One minor style issue",
      findings: [{
        severity: "low",
        title: "Unused variable",
        body: "Variable `x` is declared but never used.",
        confidence: 0.9,
        recommendation: "Remove the unused variable.",
        file: "src/foo.ts",
      }],
      next_steps: ["Remove unused variable"],
      commit_sha: FAKE_SHA,
    });

    let transitionAttempted = false;
    let blockedReason: string | undefined;

    const deps: AdvanceReviewDeps = {
      ...makeBaseReviewDeps(),
      runReview: async () => ({
        result: {
          success: true,
          stdout: BELOW_POLICY_VERDICT,
          stderr: "",
          exit_code: 0,
          duration: 0.001,
          timed_out: false,
        },
        effectiveReviewer: "codex",
        selfReview: false,
      }),
      transition: async () => {
        transitionAttempted = true;
        throw new Error("gh label add: label 'pipeline:review-2' not found in repository");
      },
      setBlocked: async (_cfg, _issue, reason) => {
        blockedReason = reason;
      },
    };

    const outcome = await advanceReview(cfg, 42, 1, {}, 0, deps);

    assert.ok(transitionAttempted, "transition must have been attempted before failing");
    assert.equal(outcome.advanced, false, "stage must NOT advance when transition throws on non-approve path");
    assert.equal(
      (outcome as { status?: string }).status,
      "blocked",
      `stage must return status=blocked on label-add failure (non-approve path); got ${JSON.stringify(outcome)}`,
    );
    assert.ok(blockedReason !== undefined, "setBlocked must be called with a reason");
    assert.ok(
      blockedReason!.includes("label"),
      `blocked reason must reference label; got: "${blockedReason}"`,
    );

    console.log(`[reliability] partial-transition-non-approve: outcome=${JSON.stringify(outcome)} blocked_reason="${blockedReason}"`);
  });

  // -------------------------------------------------------------------------
  // Section 7: Artifact corruption / missing file reliability tests
  // -------------------------------------------------------------------------

  test("artifact corruption — missing summary.json: surfaces a clear error state (not uncaught throw)", async () => {
    // RED: fails without artifact-corruption guard because stage would throw
    // uncaught on a missing summary.json rather than setting exit code 1 and
    // emitting a diagnostic to stderr.

    const prevExitCode = process.exitCode;
    const errors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const deps: RunSummaryDeps = {
        readFile: async () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
        latestSummaryForIssue: async () => null,
        readBundle: async () => null,
      };

      // Must not throw — should set exitCode=1 and emit a diagnostic.
      await runSummaryByRunId("/fake/repo", "42-2026-01-01T00:00:00Z", deps);

      // RED: fails without artifact-corruption guard because stage throws uncaught on null/bad JSON
      assert.equal(
        process.exitCode,
        1,
        "missing summary.json must set process.exitCode to 1, not throw",
      );
      assert.ok(errors.length > 0, "a diagnostic must be emitted to stderr");
      assert.ok(
        errors.some((e) => e.includes("summary.json") || e.includes("no summary.json")),
        `diagnostic must mention summary.json; got: ${errors.join(" | ")}`,
      );
    } finally {
      console.error = origConsoleError;
      process.exitCode = prevExitCode;
    }

    console.log(`[reliability] missing-summary-json: exit code handled, diagnostic emitted`);
  });

  test("artifact corruption — malformed summary.json: surfaces a clear error state (not uncaught throw)", async () => {
    // RED: fails without artifact-corruption guard because stage would throw
    // uncaught on a malformed (non-JSON) summary.json rather than setting exit
    // code 1 and emitting a diagnostic to stderr.

    const prevExitCode = process.exitCode;
    const errors: string[] = [];
    const origConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };

    try {
      const deps: RunSummaryDeps = {
        readFile: async () => "this is not valid JSON { broken",
        latestSummaryForIssue: async () => null,
        readBundle: async () => null,
      };

      // Must not throw — should set exitCode=1 and emit a diagnostic.
      await runSummaryByRunId("/fake/repo", "42-2026-01-01T00:00:00Z", deps);

      // RED: fails without artifact-corruption guard because stage throws uncaught on null/bad JSON
      assert.equal(
        process.exitCode,
        1,
        "malformed summary.json must set process.exitCode to 1, not throw",
      );
      assert.ok(errors.length > 0, "a diagnostic must be emitted to stderr");
      assert.ok(
        errors.some((e) => e.includes("corrupt") || e.includes("invalid JSON") || e.includes("summary.json")),
        `diagnostic must reference the corruption; got: ${errors.join(" | ")}`,
      );
    } finally {
      console.error = origConsoleError;
      process.exitCode = prevExitCode;
    }

    console.log(`[reliability] malformed-summary-json: exit code handled, diagnostic emitted`);
  });

}); // end describe("benchmark-reliability-suite")
