// #759: worktree + review reconcile surfaces; #769/#770/#626/#675 fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bareOpenPrSupersedesStartedClaim,
  reconcileReviewCurrency,
  reconcileWorktreeLifecycle,
  sharedRepairIdentity,
} from "../scripts/reconcile-and-converge.ts";

// ---------------------------------------------------------------------------
// Worktree lifecycle (#769)
// ---------------------------------------------------------------------------

test("worktree reconcile: missing managed tree → rematerialize", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: false,
  });
  assert.ok(r.actions.some((a) => a.kind === "rematerialize"));
  assert.equal(r.blocked, true);
});

test("worktree reconcile: dirty without force → refuse_unsafe_remove", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: true,
    localOnly: false,
    force: false,
  });
  assert.ok(r.actions.some((a) => a.kind === "refuse_unsafe_remove"));
  assert.ok(!r.actions.some((a) => a.kind === "safe_remove_then_recreate"));
  assert.equal(r.blocked, true);
  assert.ok(r.removeSafety && !r.removeSafety.ok);
});

test("worktree reconcile: poisoned/mismatched HEAD does not retain-as-healthy (#769)", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: false,
    localOnly: false,
    actualHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    actualBranch: "pipeline/1-feat",
    expectedBranch: "pipeline/1-feat",
  });
  assert.ok(!r.actions.some((a) => a.kind === "retain" && a.reason.includes("healthy")));
  assert.ok(r.actions.some((a) => a.kind === "rematerialize" || a.kind === "refuse_unsafe_remove"));
  assert.equal(r.blocked, true);
});

test("worktree reconcile: branch mismatch is poisoned", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: false,
    localOnly: false,
    actualBranch: "pipeline/1-wrong",
    expectedBranch: "pipeline/1-feat",
  });
  assert.equal(r.blocked, true);
  assert.ok(r.actions.some((a) => /poisoned|mismatched/.test(a.reason)));
});

test("worktree reconcile: stale clean tree may safe_remove_then_recreate", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: false,
    localOnly: false,
    stalePathOrSlug: true,
  });
  assert.ok(r.actions.some((a) => a.kind === "safe_remove_then_recreate"));
  assert.ok(r.actions.every((a) => !a.requiresRemoveSafety || a.kind === "safe_remove_then_recreate"));
});

test("worktree reconcile: observation failure fails closed", () => {
  const r = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    observationFailed: true,
    observationError: "git status failed",
  });
  assert.ok(r.actions.some((a) => a.kind === "fail_closed"));
  assert.equal(r.blocked, true);
});

// ---------------------------------------------------------------------------
// Live/manual coexistence (#770)
// ---------------------------------------------------------------------------

test("worktree reconcile: re-check required before remove (#770)", () => {
  // First observe clean → safe remove planned.
  const clean = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: false,
    localOnly: false,
    stalePathOrSlug: true,
  });
  assert.ok(clean.actions.some((a) => a.kind === "safe_remove_then_recreate" && a.requiresRemoveSafety));

  // Manual dirtying before mutation → refuse.
  const dirty = reconcileWorktreeLifecycle({
    required: true,
    managedPresent: true,
    pathExists: true,
    dirty: true,
    localOnly: false,
    stalePathOrSlug: true,
    force: false,
  });
  assert.ok(dirty.actions.some((a) => a.kind === "refuse_unsafe_remove"));
  assert.ok(!dirty.actions.some((a) => a.kind === "safe_remove_then_recreate"));
});

// ---------------------------------------------------------------------------
// Review currency (#626 / #675)
// ---------------------------------------------------------------------------

test("review reconcile: exact-key recurrence without human authority does not mayApplyHumanHold (#626)", () => {
  const r = reconcileReviewCurrency({
    reviewedSha: "a".repeat(40),
    headSha: "a".repeat(40),
    currencyStatus: "current",
    unresolvedBlockingKeys: ["file.ts:12:bug"],
    exactKeyRecurrenceBound: true,
    humanDecisionRequiredAuthority: false,
  });
  assert.equal(r.mayApplyHumanHold, false);
  assert.equal(r.recoveryInput, true);
  assert.ok(r.actions.some((a) => a.kind === "hold_unresolved_keys"));
  assert.ok(r.actions.some((a) => a.kind === "emit_review_findings_recovery"));
  assert.ok(!r.actions.some((a) => a.kind === "reuse_verdict" && a.reason.includes("needs-human")));
});

test("review reconcile: review-ceiling exhaustion is recovery input not human hold (#675)", () => {
  const r = reconcileReviewCurrency({
    currencyStatus: "current",
    unresolvedBlockingKeys: [],
    reviewCeilingExhausted: true,
    humanDecisionRequiredAuthority: false,
  });
  assert.equal(r.mayApplyHumanHold, false);
  assert.equal(r.recoveryInput, true);
  assert.ok(r.actions.some((a) => a.kind === "surface_recovery_diagnostics"));
  assert.ok(r.actions.some((a) => a.kind === "emit_review_findings_recovery"));
  assert.equal(r.hold, false);
});

test("review reconcile: human hold requires current human-decision-required authority", () => {
  const without = reconcileReviewCurrency({
    currencyStatus: "current",
    reviewCeilingExhausted: true,
    exactKeyRecurrenceBound: true,
    humanDecisionRequiredAuthority: false,
  });
  assert.equal(without.mayApplyHumanHold, false);

  const withAuth = reconcileReviewCurrency({
    currencyStatus: "current",
    reviewCeilingExhausted: true,
    humanDecisionRequiredAuthority: true,
  });
  assert.equal(withAuth.mayApplyHumanHold, true);
});

test("review reconcile: unresolved keys hold without inventing human-decision authority", () => {
  const r = reconcileReviewCurrency({
    currencyStatus: "current",
    unresolvedBlockingKeys: ["k1"],
    humanDecisionRequiredAuthority: false,
  });
  assert.equal(r.hold, true);
  assert.equal(r.mayApplyHumanHold, false);
  assert.ok(r.actions.some((a) => a.kind === "hold_unresolved_keys"));
});

test("review reconcile: unbound recurrence is not treated as exact recurrence when flag false", () => {
  const r = reconcileReviewCurrency({
    currencyStatus: "current",
    exactKeyRecurrenceBound: false,
    unresolvedBlockingKeys: [],
  });
  assert.equal(r.recoveryInput, false);
  assert.ok(r.actions.some((a) => a.kind === "reuse_verdict"));
});

test("bare open PR does not supersede started recovery claim", () => {
  assert.equal(
    bareOpenPrSupersedesStartedClaim({ openPrExists: true, verifiedReadyOrMerged: false }),
    false,
  );
  assert.equal(
    bareOpenPrSupersedesStartedClaim({ openPrExists: true, verifiedReadyOrMerged: true }),
    true,
  );
});

test("shared repair identity is stable", () => {
  const a = sharedRepairIdentity({
    itemId: "759",
    candidateIdentity: "abc",
    evidenceFingerprint: "fp",
    action: "repair_pipeline_item",
  });
  const b = sharedRepairIdentity({
    itemId: "759",
    candidateIdentity: "abc",
    evidenceFingerprint: "fp",
    action: "repair_pipeline_item",
  });
  assert.equal(a, b);
});
