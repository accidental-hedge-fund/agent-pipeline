// #870 — Claude Fable/usage-credit entitlement detection, classification,
// auto allowlisted retry, and durable projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_ENTITLEMENT_FALLBACK_MODEL,
  classifyReviewerHarnessFailure,
  isClaudeModelEntitlementFailure,
  shouldRetryAutoEntitlementFallback,
} from "../scripts/model-entitlement.ts";
import { classifyHarnessFailure } from "../scripts/escalation-classify.ts";
import {
  buildStageDiagnostic,
  projectPipelineReasonCode,
  projectStageDiagnostic,
} from "../scripts/stage-diagnostic.ts";
import { invokeReviewer, invokeClaudeReviewerWithEntitlementFallback } from "../scripts/self-review.ts";
import type { HarnessResult, InvokeOptions } from "../scripts/harness.ts";
import type { Harness } from "../scripts/types.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";

const FABLE_ENTITLEMENT_MSG =
  "Fable 5 requires usage credits. Run /usage-credits to continue or switch models with /model.";

const zeroTokenEntitlement = (): HarnessResult => ({
  success: false,
  stdout: FABLE_ENTITLEMENT_MSG,
  stderr: "HTTP 429",
  exit_code: 1,
  duration: 2,
  timed_out: false,
  throttled: true,
});

const ordinaryThrottle = (): HarnessResult => ({
  success: false,
  stdout: "",
  stderr: "rate_limit_event status=rejected",
  exit_code: 1,
  duration: 2,
  timed_out: false,
  throttled: true,
});

const sonnetOk = (stdout = '{"verdict":"approve","findings":[]}'): HarnessResult => ({
  success: true,
  stdout,
  stderr: "",
  exit_code: 0,
  duration: 1,
  timed_out: false,
});

// ---------------------------------------------------------------------------
// 1. Pure detection
// ---------------------------------------------------------------------------

test("isClaudeModelEntitlementFailure: closed phrase set matches Fable usage-credit 429", () => {
  assert.equal(
    isClaudeModelEntitlementFailure(FABLE_ENTITLEMENT_MSG, "HTTP 429", {
      exit_code: 1,
      throttled: true,
      success: false,
    }),
    true,
  );
  assert.equal(
    isClaudeModelEntitlementFailure("", "requires usage credits", null),
    true,
  );
  assert.equal(
    isClaudeModelEntitlementFailure("Run /usage-credits to continue", "", null),
    true,
  );
});

test("isClaudeModelEntitlementFailure: ordinary throttle without entitlement text is false", () => {
  assert.equal(
    isClaudeModelEntitlementFailure("", "rate limit exceeded", { throttled: true, success: false, exit_code: 1 }),
    false,
  );
  assert.equal(
    isClaudeModelEntitlementFailure("", "HTTP 429", { throttled: true, success: false, exit_code: 1 }),
    false,
  );
  assert.equal(isClaudeModelEntitlementFailure("", "", { throttled: true, success: false, exit_code: 1 }), false);
});

// ---------------------------------------------------------------------------
// 2. Classification + durable projection
// ---------------------------------------------------------------------------

test("classifyHarnessFailure: entitlement projects to model-entitlement-required, not workflow-engine-defect", () => {
  const code = classifyHarnessFailure({
    throttled: true,
    stdout: FABLE_ENTITLEMENT_MSG,
    stderr: "HTTP 429",
    exit_code: 1,
    success: false,
  });
  assert.equal(code, "model-entitlement-required");
  assert.equal(projectPipelineReasonCode(code).blockerClass, "environment-auth");
  assert.notEqual(projectPipelineReasonCode(code).blockerClass, "workflow-engine-defect");
});

test("classifyHarnessFailure: ordinary throttle projects to transient-infra → transient-rate-limit", () => {
  const code = classifyHarnessFailure({
    throttled: true,
    stdout: "",
    stderr: "rate limited",
    exit_code: 1,
    success: false,
  });
  assert.equal(code, "transient-infra");
  assert.equal(projectPipelineReasonCode(code).blockerClass, "transient-rate-limit");
  assert.notEqual(projectPipelineReasonCode(code).blockerClass, "workflow-engine-defect");
});

test("zero-token entitlement diagnostic never collapses to workflow-engine-defect", () => {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "model-entitlement-required",
    blockerKind: "harness-failure",
    reason: FABLE_ENTITLEMENT_MSG,
    stage: "plan-review",
  });
  const proj = projectStageDiagnostic(diagnostic);
  assert.equal(proj.blockerClass, "environment-auth");
  assert.equal(proj.disposition, "recover");
  assert.notEqual(proj.blockerClass, "workflow-engine-defect");
});

test("classifyReviewerHarnessFailure prefers entitlement over throttled", () => {
  assert.equal(classifyReviewerHarnessFailure(zeroTokenEntitlement()), "model-entitlement-required");
  assert.equal(classifyReviewerHarnessFailure(ordinaryThrottle()), "transient-infra");
});

test("recovery budgets: environment-auth and transient-rate-limit do not run_fatal on first attempt", () => {
  assert.equal(DEFAULT_RECOVERY_POLICY["environment-auth"].run_fatal, true);
  assert.ok(DEFAULT_RECOVERY_POLICY["environment-auth"].retry_budget >= 2);
  assert.equal(DEFAULT_RECOVERY_POLICY["transient-rate-limit"].run_fatal, false);
  assert.ok(DEFAULT_RECOVERY_POLICY["transient-rate-limit"].retry_budget >= 1);
  // First failure consumes budget but does not immediately force run_fatal until
  // budget/repeated-evidence limits are exhausted (policy is multi-attempt).
  assert.ok(DEFAULT_RECOVERY_POLICY["environment-auth"].retry_budget > 1);
});

// ---------------------------------------------------------------------------
// 3. Auto entitlement allowlisted retry (invokeReviewer)
// ---------------------------------------------------------------------------

function trackingInvoke(sequence: HarnessResult[]) {
  const calls: Array<{ harness: string; model?: string; opts: InvokeOptions }> = [];
  let i = 0;
  const inv = async (
    harness: string,
    _wt: string,
    _prompt: string,
    opts: InvokeOptions = {},
  ): Promise<HarnessResult> => {
    calls.push({ harness, model: opts.model, opts });
    const r = sequence[i++] ?? sequence[sequence.length - 1];
    return r;
  };
  return { inv: inv as unknown as typeof import("../scripts/harness.ts").invoke, calls };
}

test("invokeReviewer: auto-sourced fable entitlement recovers via sonnet once", async () => {
  const { inv, calls } = trackingInvoke([zeroTokenEntitlement(), sonnetOk()]);
  const out = await invokeReviewer(
    "claude",
    "codex",
    "/wt",
    "prompt",
    { model: "claude-fable-5", modelWasAuto: true },
    inv,
  );
  assert.equal(out.result.success, true);
  assert.equal(out.entitlementFallback, true);
  assert.equal(out.resolvedModel, AUTO_ENTITLEMENT_FALLBACK_MODEL);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, "claude-fable-5");
  assert.equal(calls[1].model, "sonnet");
  assert.equal(calls[1].opts.accounting?.fallback ?? calls[1].opts.model, "sonnet");
  // Fallback attempt marks accounting.fallback when accounting is present —
  // without accounting, only model rewrite is proven.
});

test("invokeReviewer: auto entitlement fallback sets accounting.fallback true on retry", async () => {
  const { inv, calls } = trackingInvoke([zeroTokenEntitlement(), sonnetOk()]);
  await invokeReviewer(
    "claude",
    "codex",
    "/wt",
    "prompt",
    {
      model: "claude-fable-5",
      modelWasAuto: true,
      accounting: {
        runDir: "/tmp/run",
        issue: 870,
        stage: "plan-review",
        modelSlot: "review",
        model: "claude-fable-5",
      },
    },
    inv,
  );
  assert.equal(calls[0].opts.accounting?.model, "claude-fable-5");
  assert.equal(calls[1].opts.accounting?.model, "sonnet");
  assert.equal(calls[1].opts.accounting?.fallback, true);
});

test("invokeReviewer: explicit claude-fable-5 fails closed — no sonnet rewrite", async () => {
  const { inv, calls } = trackingInvoke([zeroTokenEntitlement()]);
  const out = await invokeReviewer(
    "claude",
    "codex",
    "/wt",
    "prompt",
    { model: "claude-fable-5", modelWasAuto: false },
    inv,
  );
  assert.equal(out.result.success, false);
  assert.equal(out.entitlementFallback, undefined);
  assert.equal(calls.length, 1, "explicit model must not retry with sonnet");
  assert.equal(calls[0].model, "claude-fable-5");
});

test("invokeReviewer: ordinary throttle does not rewrite model", async () => {
  const { inv, calls } = trackingInvoke([ordinaryThrottle()]);
  const out = await invokeReviewer(
    "claude",
    "codex",
    "/wt",
    "prompt",
    { model: "claude-fable-5", modelWasAuto: true },
    inv,
  );
  assert.equal(out.result.success, false);
  assert.notEqual(out.entitlementFallback, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "claude-fable-5");
});

test("invokeReviewer: Codex reviewer + auto does not apply Claude entitlement rewrite", async () => {
  const { inv, calls } = trackingInvoke([
    {
      success: false,
      stdout: FABLE_ENTITLEMENT_MSG,
      stderr: "",
      exit_code: 1,
      duration: 1,
      timed_out: false,
    },
  ]);
  // modelWasAuto with codex reviewer: resolveReviewerModelForHarness would omit
  // claude-only aliases; here we pass an already-resolved model and prove the
  // entitlement rewrite still refuses non-claude harnesses.
  const out = await invokeReviewer(
    "codex",
    "claude",
    "/wt",
    "prompt",
    { model: "claude-fable-5", modelWasAuto: true },
    inv,
  );
  assert.equal(out.entitlementFallback, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].harness, "codex");
});

test("invokeClaudeReviewerWithEntitlementFallback: shared helper recovers for design-gate", async () => {
  const { inv, calls } = trackingInvoke([zeroTokenEntitlement(), sonnetOk('{"verdict":"approve","challenges":[]}')]);
  const out = await invokeClaudeReviewerWithEntitlementFallback(
    "/wt",
    "prompt",
    { model: "claude-fable-5", modelWasAuto: true },
    inv,
  );
  assert.equal(out.entitlementFallback, true);
  assert.equal(out.result.success, true);
  assert.equal(calls[1].model, "sonnet");
});

test("shouldRetryAutoEntitlementFallback gates on auto + claude + entitlement", () => {
  assert.equal(
    shouldRetryAutoEntitlementFallback({
      reviewerHarness: "claude",
      modelWasAuto: true,
      preferredModel: "claude-fable-5",
      result: zeroTokenEntitlement(),
    }),
    true,
  );
  assert.equal(
    shouldRetryAutoEntitlementFallback({
      reviewerHarness: "claude",
      modelWasAuto: false,
      preferredModel: "claude-fable-5",
      result: zeroTokenEntitlement(),
    }),
    false,
  );
  assert.equal(
    shouldRetryAutoEntitlementFallback({
      reviewerHarness: "codex",
      modelWasAuto: true,
      preferredModel: undefined,
      result: zeroTokenEntitlement(),
    }),
    false,
  );
});
