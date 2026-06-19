// Tests for bounded auto-loop mode (#149).
//
// Coverage:
//   7.1  Config: valid auto_loop resolves; absent → disabled default; unknown
//        sub-key, non-positive max_rounds, and unknown stages entry each fail.
//   7.2  Default-unchanged regression: auto_loop disabled → isAutoLoopEligible
//        always returns false (waiting + blocked outcomes unchanged).
//   7.3  Allowlist gating: allowlisted stage continues; non-allowlisted stops;
//        non-recoverable outcome always stops.
//   7.4  Budget accounting: canAutoLoopContinue decrements rounds and checks
//        wall-clock with a fake clock.
//   7.5  Human checkpoints: plan-review is a hard stop regardless of allowlist.
//   7.6  Recurrence: review-loop-recurrence parks at needs-human via an
//        advanced→needs-human transition, so the auto-loop never sees the
//        recurrence outcome; tested via isAutoLoopEligible on the finalized
//        outcome returned after a needs-human advance.
//   7.7  Override/sandbox: isAutoLoopRecoverable does not affect review_policy
//        or harness_sandbox (those stay in cfg, untouched by helpers).
//   7.8  Evidence: isAutoLoopRecoverable returns correct values for every
//        Outcome variant.
//
// All tests are pure; no real network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isAutoLoopRecoverable,
  isAutoLoopEligible,
  canAutoLoopContinue,
} from "../scripts/pipeline.ts";
import { validateConfig } from "../scripts/config.ts";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import type { BlockerKind, Outcome, PipelineConfig, Stage } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAutoLoop(overrides: Partial<PipelineConfig["auto_loop"]> = {}): PipelineConfig["auto_loop"] {
  return {
    enabled: true,
    max_rounds: 3,
    max_wallclock_minutes: 60,
    stages: ["eval-gate", "shipcheck-gate"],
    ...overrides,
  };
}

const WAITING: Outcome = { advanced: false, status: "waiting", reason: "CI pending" };
const BLOCKED: Outcome = { advanced: false, status: "blocked", reason: "eval failed" };
const BLOCKED_NEEDS_HUMAN: Outcome = { advanced: false, status: "blocked", reason: "shipcheck fail verdict", blockerKind: "needs-human" as BlockerKind };
const ERROR_OUT: Outcome = { advanced: false, status: "error", reason: "harness crash" };
const NOOP: Outcome = { advanced: false, status: "no-op", reason: "nothing to do" };
const FINALIZED: Outcome = { advanced: false, status: "finalized", reason: "done" };
const ADVANCED: Outcome = { advanced: true, from: "eval-gate" as Stage, to: "shipcheck-gate" as Stage, summary: "ok" };

// validateConfig deps that inject YAML text without real filesystem.
function makeValidateDeps(yamlText: string) {
  return {
    readFile: (p: string) => (p.endsWith("pipeline.yml") ? yamlText : null),
    findGitRoot: (_startDir: string) => "/fake/repo",
  };
}

// ---------------------------------------------------------------------------
// 7.1  Config: validation
// ---------------------------------------------------------------------------

test("auto_loop: valid block resolves without diagnostics", () => {
  const yaml = `
auto_loop:
  enabled: true
  max_rounds: 4
  max_wallclock_minutes: 30
  stages:
    - eval-gate
    - shipcheck-gate
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.valid, true);
});

test("auto_loop: absent → no diagnostics (disabled default)", () => {
  const result = validateConfig("/fake/repo", makeValidateDeps("base_branch: main"));
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
});

test("auto_loop: DEFAULT_CONFIG has enabled:false", () => {
  assert.equal(DEFAULT_CONFIG.auto_loop.enabled, false);
  assert.equal(DEFAULT_CONFIG.auto_loop.max_rounds, 3);
  assert.equal(DEFAULT_CONFIG.auto_loop.max_wallclock_minutes, 60);
  assert.deepEqual(DEFAULT_CONFIG.auto_loop.stages, []);
});

test("auto_loop: unknown sub-key rejected (7.1 — prove test bites without fix)", () => {
  const yaml = `
auto_loop:
  enabled: true
  max_minutes: 5
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path.includes("max_minutes") || d.message.includes("max_minutes")));
});

test("auto_loop: non-positive max_rounds rejected", () => {
  const yaml = `
auto_loop:
  enabled: true
  max_rounds: 0
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path.includes("max_rounds")));
});

test("auto_loop: non-integer max_rounds rejected", () => {
  const yaml = `
auto_loop:
  enabled: true
  max_rounds: 1.5
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path.includes("max_rounds")));
});

test("auto_loop: unknown stages entry rejected", () => {
  const yaml = `
auto_loop:
  enabled: true
  stages:
    - eval-gate
    - not-a-real-stage
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path.includes("stages")));
});

test("auto_loop: non-positive max_wallclock_minutes rejected", () => {
  const yaml = `
auto_loop:
  enabled: true
  max_wallclock_minutes: -5
`.trim();
  const result = validateConfig("/fake/repo", makeValidateDeps(yaml));
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((d) => d.path.includes("max_wallclock_minutes")));
});

// ---------------------------------------------------------------------------
// 7.2  Default-unchanged regression: disabled auto_loop → never eligible
// ---------------------------------------------------------------------------

test("isAutoLoopEligible: disabled → false for waiting at allowlisted stage", () => {
  const al = makeAutoLoop({ enabled: false, stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(WAITING, "eval-gate", al), false);
});

test("isAutoLoopEligible: disabled → false for blocked at allowlisted stage", () => {
  const al = makeAutoLoop({ enabled: false, stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(BLOCKED, "eval-gate", al), false);
});

test("isAutoLoopEligible: empty stages → false even when enabled", () => {
  const al = makeAutoLoop({ enabled: true, stages: [] });
  assert.equal(isAutoLoopEligible(WAITING, "eval-gate", al), false);
});

// ---------------------------------------------------------------------------
// 7.3  Allowlist gating
// ---------------------------------------------------------------------------

test("isAutoLoopEligible: waiting at allowlisted stage → true", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(WAITING, "eval-gate", al), true);
});

test("isAutoLoopEligible: blocked at allowlisted stage → true", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(BLOCKED, "eval-gate", al), true);
});

test("isAutoLoopEligible: waiting at non-allowlisted stage → false", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(WAITING, "review-1", al), false);
});

test("isAutoLoopEligible: blocked at non-allowlisted stage → false", () => {
  const al = makeAutoLoop({ stages: ["shipcheck-gate"] });
  assert.equal(isAutoLoopEligible(BLOCKED, "pre-merge", al), false);
});

test("isAutoLoopEligible: error outcome at allowlisted stage → false (non-recoverable)", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(ERROR_OUT, "eval-gate", al), false);
});

test("isAutoLoopEligible: no-op outcome at allowlisted stage → false (non-recoverable)", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(NOOP, "eval-gate", al), false);
});

test("isAutoLoopEligible: finalized outcome at allowlisted stage → false (non-recoverable)", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(FINALIZED, "eval-gate", al), false);
});

test("isAutoLoopEligible: advanced outcome → false (not non-advancing)", () => {
  const al = makeAutoLoop({ stages: ["eval-gate"] });
  assert.equal(isAutoLoopEligible(ADVANCED, "eval-gate", al), false);
});

test("isAutoLoopEligible: blocked with needs-human kind at allowlisted stage → false (non-recoverable)", () => {
  // shipcheck-gate failures set needs-human; the auto-loop must not retry them
  const al = makeAutoLoop({ stages: ["shipcheck-gate"] });
  assert.equal(isAutoLoopEligible(BLOCKED_NEEDS_HUMAN, "shipcheck-gate", al), false);
});

// ---------------------------------------------------------------------------
// 7.4  Budget accounting
// ---------------------------------------------------------------------------

test("canAutoLoopContinue: under both budgets → true", () => {
  const al = makeAutoLoop({ max_rounds: 3, max_wallclock_minutes: 60 });
  assert.equal(canAutoLoopContinue(al, 0, 0, 10_000), true);  // 10s elapsed, 0 rounds
});

test("canAutoLoopContinue: rounds at ceiling → false", () => {
  const al = makeAutoLoop({ max_rounds: 3, max_wallclock_minutes: 60 });
  assert.equal(canAutoLoopContinue(al, 3, 0, 10_000), false);
});

test("canAutoLoopContinue: rounds over ceiling → false", () => {
  const al = makeAutoLoop({ max_rounds: 3, max_wallclock_minutes: 60 });
  assert.equal(canAutoLoopContinue(al, 4, 0, 10_000), false);
});

test("canAutoLoopContinue: rounds under ceiling after spending some → true", () => {
  const al = makeAutoLoop({ max_rounds: 3, max_wallclock_minutes: 60 });
  assert.equal(canAutoLoopContinue(al, 2, 0, 10_000), true);
});

test("canAutoLoopContinue: wall-clock at ceiling → false (fake clock)", () => {
  const al = makeAutoLoop({ max_rounds: 10, max_wallclock_minutes: 5 });
  const startMs = 0;
  const nowMs = 5 * 60_000; // exactly 5 minutes elapsed
  assert.equal(canAutoLoopContinue(al, 0, startMs, nowMs), false);
});

test("canAutoLoopContinue: wall-clock over ceiling → false (fake clock)", () => {
  const al = makeAutoLoop({ max_rounds: 10, max_wallclock_minutes: 5 });
  assert.equal(canAutoLoopContinue(al, 0, 0, 6 * 60_000), false);
});

test("canAutoLoopContinue: wall-clock just under ceiling → true (fake clock)", () => {
  const al = makeAutoLoop({ max_rounds: 10, max_wallclock_minutes: 5 });
  assert.equal(canAutoLoopContinue(al, 0, 0, 4 * 60_000 + 59_000), true);
});

test("canAutoLoopContinue: both budgets exhausted → false", () => {
  const al = makeAutoLoop({ max_rounds: 2, max_wallclock_minutes: 1 });
  assert.equal(canAutoLoopContinue(al, 2, 0, 2 * 60_000), false);
});

test("canAutoLoopContinue: one round remaining, wall-clock fine → true", () => {
  const al = makeAutoLoop({ max_rounds: 3, max_wallclock_minutes: 60 });
  assert.equal(canAutoLoopContinue(al, 2, 0, 30_000), true);
});

// ---------------------------------------------------------------------------
// 7.5  Human checkpoints
// ---------------------------------------------------------------------------

test("isAutoLoopEligible: plan-review is a hard stop regardless of allowlist", () => {
  const al = makeAutoLoop({ stages: ["plan-review"] });
  // plan-review dispatch returns waiting — auto-loop must never retry it
  const waitingAtPlanReview: Outcome = { advanced: false, status: "waiting", reason: "plan-review is set mid-flight..." };
  assert.equal(isAutoLoopEligible(waitingAtPlanReview, "plan-review", al), false);
});

test("isAutoLoopEligible: plan-review with blocked outcome is also a hard stop", () => {
  const al = makeAutoLoop({ stages: ["plan-review"] });
  assert.equal(isAutoLoopEligible(BLOCKED, "plan-review", al), false);
});

test("isAutoLoopEligible: needs-human stage never reached (loop breaks first) — finalized outcome → false", () => {
  // The loop breaks on stage === "needs-human" before dispatch, but if a finalized
  // outcome ever arrived from needs-human dispatch, the helper should return false.
  const al = makeAutoLoop({ stages: ["needs-human"] });
  const finalized: Outcome = { advanced: false, status: "finalized", reason: "needs-human is terminal" };
  assert.equal(isAutoLoopEligible(finalized, "needs-human", al), false);
});

// ---------------------------------------------------------------------------
// 7.6  Recurrence: advanced→needs-human is caught by the loop's stage check
//      (not the auto-loop), so isAutoLoopEligible never sees the transition.
//      Test that isAutoLoopRecoverable returns false for the advanced outcome
//      (it only checks non-advancing outcomes).
// ---------------------------------------------------------------------------

test("isAutoLoopRecoverable: advanced outcome → false (loop handles advances normally)", () => {
  const advancedToNeedsHuman: Outcome = {
    advanced: true,
    from: "review-2",
    to: "needs-human",
    summary: "recurrence early-park",
  };
  assert.equal(isAutoLoopRecoverable(advancedToNeedsHuman), false);
});

// ---------------------------------------------------------------------------
// 7.7  Override/sandbox: helpers are pure and do not touch cfg
// ---------------------------------------------------------------------------

test("isAutoLoopRecoverable: does not mutate or depend on review_policy", () => {
  // Calling the helper does not throw and returns the correct value regardless
  // of what review_policy or harness_sandbox say.
  assert.equal(isAutoLoopRecoverable(WAITING), true);
  assert.equal(isAutoLoopRecoverable(BLOCKED), true);              // no kind → recoverable
  assert.equal(isAutoLoopRecoverable(BLOCKED_NEEDS_HUMAN), false); // needs-human → not recoverable
});

test("canAutoLoopContinue: does not depend on review_policy.max_adversarial_rounds", () => {
  // The auto-loop budget is independent of the review-round cap.
  const al = makeAutoLoop({ max_rounds: 5, max_wallclock_minutes: 120 });
  // Simulating 3 review re-runs already consumed (adversarial round ceiling) but
  // auto-loop budget still has rounds left — canAutoLoopContinue says yes.
  assert.equal(canAutoLoopContinue(al, 2, 0, 60_000), true);
});

// ---------------------------------------------------------------------------
// 7.8  Evidence: isAutoLoopRecoverable for every Outcome variant
// ---------------------------------------------------------------------------

test("isAutoLoopRecoverable: waiting → true", () => {
  assert.equal(isAutoLoopRecoverable(WAITING), true);
});

test("isAutoLoopRecoverable: blocked without blockerKind → true (pipeline can retry)", () => {
  assert.equal(isAutoLoopRecoverable(BLOCKED), true);
});

test("isAutoLoopRecoverable: blocked with needs-human kind → false (requires human intervention)", () => {
  assert.equal(isAutoLoopRecoverable(BLOCKED_NEEDS_HUMAN), false);
});

test("isAutoLoopRecoverable: error → false", () => {
  assert.equal(isAutoLoopRecoverable(ERROR_OUT), false);
});

test("isAutoLoopRecoverable: no-op → false", () => {
  assert.equal(isAutoLoopRecoverable(NOOP), false);
});

test("isAutoLoopRecoverable: finalized → false", () => {
  assert.equal(isAutoLoopRecoverable(FINALIZED), false);
});

test("isAutoLoopRecoverable: advanced → false", () => {
  assert.equal(isAutoLoopRecoverable(ADVANCED), false);
});
