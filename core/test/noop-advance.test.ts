/**
 * Unit tests for the shared noop-advance contract (#758).
 * Injected fakes only — no real network, git, or harness subprocess.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePostHarnessNoNewCommit,
  evaluatePreHarnessNoWork,
  formatNoopAdvanceEvidenceNote,
  noopAdvanceEvidenceFields,
  fixOverrideEmptyGoalCheck,
  fixExternalCommitGoalCheck,
  fixDoesNotReproduceGoalCheck,
  preMergeFindingsClearGoalCheck,
  preMergeArchiveCoherentGoalCheck,
  implementDeliverablePresentGoalCheck,
  firstSatisfiedGoalCheck,
  type GoalCheckResult,
} from "../scripts/noop-advance.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FIXED_NOW = () => new Date("2026-08-02T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Pure matrix: advance / escalate / not-applicable
// ---------------------------------------------------------------------------

test("evaluatePostHarnessNoNewCommit: satisfied goal → advance with evidence", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "fix-1",
    issueNumber: 758,
    now: FIXED_NOW,
    goalCheck: () => ({
      satisfied: true,
      rationaleClass: "fix-no-actionable-work",
      note: "already done",
    }),
  });
  assert.equal(result.decision, "advance");
  if (result.decision !== "advance") return;
  assert.equal(result.evidence.stage, "fix-1");
  assert.equal(result.evidence.headSha, SHA);
  assert.equal(result.evidence.rationaleClass, "fix-no-actionable-work");
  assert.equal(result.evidence.issueNumber, 758);
  assert.equal(result.evidence.note, "already done");
  assert.equal(result.evidence.at, "2026-08-02T12:00:00Z");
});

test("evaluatePostHarnessNoNewCommit: unsatisfied goal → escalate", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "fix-1",
    goalCheck: () => ({
      satisfied: false,
      note: "still broken",
    }),
  });
  assert.equal(result.decision, "escalate");
  if (result.decision !== "escalate") return;
  assert.match(result.note, /still broken/);
});

test("evaluatePostHarnessNoNewCommit: non-empty commit range → not-applicable", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA_B,
    salvaged: false,
    stage: "fix-1",
    goalCheck: () => {
      throw new Error("goal check must not run on non-empty range");
    },
  });
  assert.equal(result.decision, "not-applicable");
  if (result.decision !== "not-applicable") return;
  assert.match(result.reason, /non-empty commit range/);
});

test("evaluatePostHarnessNoNewCommit: successful salvage → not-applicable", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA, // even if equal before re-read, salvaged flag wins
    salvaged: true,
    stage: "fix-1",
    goalCheck: () => {
      throw new Error("goal check must not run after salvage commit");
    },
  });
  assert.equal(result.decision, "not-applicable");
  if (result.decision !== "not-applicable") return;
  assert.match(result.reason, /salvage created a commit/);
});

test("evaluatePostHarnessNoNewCommit: missing heads → not-applicable", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: "",
    headAfter: "",
    salvaged: false,
    stage: "implementing",
    goalCheck: () => ({ satisfied: true, rationaleClass: "x", note: "n" }),
  });
  assert.equal(result.decision, "not-applicable");
});

test("evaluatePostHarnessNoNewCommit: unsatisfied does not claim advance evidence", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "pre-merge",
    goalCheck: () => ({ satisfied: false, note: "residual findings" }),
  });
  assert.equal(result.decision, "escalate");
  assert.ok(!("evidence" in result && (result as { evidence?: unknown }).evidence));
});

// ---------------------------------------------------------------------------
// Pre-harness (override-empty)
// ---------------------------------------------------------------------------

test("evaluatePreHarnessNoWork: override-empty satisfied → advance", async () => {
  const result = await evaluatePreHarnessNoWork({
    headSha: SHA,
    stage: "fix-1",
    issueNumber: 391,
    now: FIXED_NOW,
    goalCheck: () => fixOverrideEmptyGoalCheck({ triggeringCount: 3, effectiveCount: 0 }),
  });
  assert.equal(result.decision, "advance");
  if (result.decision !== "advance") return;
  assert.equal(result.evidence.rationaleClass, "fix-no-actionable-work");
  assert.match(result.evidence.note, /already dispositioned/);
});

test("evaluatePreHarnessNoWork: non-empty effective set → escalate", async () => {
  const result = await evaluatePreHarnessNoWork({
    headSha: SHA,
    stage: "fix-1",
    goalCheck: () => fixOverrideEmptyGoalCheck({ triggeringCount: 2, effectiveCount: 1 }),
  });
  assert.equal(result.decision, "escalate");
});

// ---------------------------------------------------------------------------
// Goal-check builders (historical scenarios)
// ---------------------------------------------------------------------------

test("#698-shaped: pre-merge findings clear → satisfied", () => {
  const ok = preMergeFindingsClearGoalCheck({
    reverifyBlockingCount: 0,
    reverifyUnparseable: false,
    headSha: SHA,
  });
  assert.equal(ok.satisfied, true);
  if (!ok.satisfied) return;
  assert.equal(ok.rationaleClass, "pre-merge-findings-clear");
});

test("#698-shaped: still-broken re-verify → unsatisfied", () => {
  const bad = preMergeFindingsClearGoalCheck({
    reverifyBlockingCount: 2,
    reverifyUnparseable: false,
    headSha: SHA,
  });
  assert.equal(bad.satisfied, false);
});

test("#714-shaped: empty active set → archive coherent", () => {
  const ok = preMergeArchiveCoherentGoalCheck({ activeIds: [] });
  assert.equal(ok.satisfied, true);
  if (!ok.satisfied) return;
  assert.equal(ok.rationaleClass, "pre-merge-archive-coherent");
});

test("#714-shaped: residual active ids → not coherent", () => {
  const bad = preMergeArchiveCoherentGoalCheck({ activeIds: ["change-a", "change-b"] });
  assert.equal(bad.satisfied, false);
  if (bad.satisfied) return;
  assert.match(bad.note ?? "", /change-a/);
});

test("#747-shaped: findings clear still advances after partition (shared check)", async () => {
  // Partition is stage-owned; terminal clean disposition uses the shared path.
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "pre-merge",
    now: FIXED_NOW,
    goalCheck: () =>
      preMergeFindingsClearGoalCheck({
        reverifyBlockingCount: 0,
        reverifyUnparseable: false,
        headSha: SHA,
      }),
  });
  assert.equal(result.decision, "advance");
});

test("#588-shaped: implement deliverable present → satisfied", () => {
  const ok = implementDeliverablePresentGoalCheck({
    deliverablePresent: true,
    worktreeClean: true,
    gatesGreen: true,
    deliverableDescription: "OpenSpec change foo present",
  });
  assert.equal(ok.satisfied, true);
  if (!ok.satisfied) return;
  assert.equal(ok.rationaleClass, "implement-deliverable-present");
});

test("#588-shaped: missing deliverable → unsatisfied", () => {
  const bad = implementDeliverablePresentGoalCheck({
    deliverablePresent: false,
    worktreeClean: true,
  });
  assert.equal(bad.satisfied, false);
});

test("fix external-commit / DNR goal checks", () => {
  const ext = fixExternalCommitGoalCheck({
    advance: true,
    reviewSha: SHA,
    headAfter: SHA_B,
  });
  assert.equal(ext.satisfied, true);

  const dnr = fixDoesNotReproduceGoalCheck({
    advance: true,
    coveredCount: 2,
    headAfter: SHA,
  });
  assert.equal(dnr.satisfied, true);

  const miss = fixDoesNotReproduceGoalCheck({
    advance: false,
    coveredCount: 0,
    headAfter: SHA,
    missingCount: 1,
  });
  assert.equal(miss.satisfied, false);
});

test("firstSatisfiedGoalCheck: external then DNR", async () => {
  const composed = firstSatisfiedGoalCheck([
    () =>
      fixExternalCommitGoalCheck({
        advance: false,
        reviewSha: SHA,
        headAfter: SHA,
      }),
    () =>
      fixDoesNotReproduceGoalCheck({
        advance: true,
        coveredCount: 1,
        headAfter: SHA,
      }),
  ]);
  const r = await composed();
  assert.equal(r.satisfied, true);
  if (!r.satisfied) return;
  assert.match(r.note, /non-reproducing/);
});

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

test("formatNoopAdvanceEvidenceNote names SHA and rationale class", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "implementing",
    issueNumber: 588,
    now: FIXED_NOW,
    goalCheck: () =>
      implementDeliverablePresentGoalCheck({
        deliverablePresent: true,
        worktreeClean: true,
      }),
  });
  assert.equal(result.decision, "advance");
  if (result.decision !== "advance") return;
  const note = formatNoopAdvanceEvidenceNote(result.evidence);
  assert.match(note, /## Pipeline: noop-advance evidence/);
  assert.match(note, /implementing/);
  assert.match(note, /implement-deliverable-present/);
  assert.match(note, new RegExp(SHA.slice(0, 12)));
  assert.match(note, /#588/);

  const fields = noopAdvanceEvidenceFields(result.evidence);
  assert.equal(fields.gate, "noop-advance");
  assert.equal(fields.result, "pass");
  assert.equal(fields.rationale_class, "implement-deliverable-present");
});

// ---------------------------------------------------------------------------
// Bite: removing shared evaluation path must fail source-pin style consumers
// ---------------------------------------------------------------------------

test("shared module exports the evaluation surface stages must use", async () => {
  // Regression bite: if the shared path is deleted, this import fails.
  const mod = await import("../scripts/noop-advance.ts");
  assert.equal(typeof mod.evaluatePostHarnessNoNewCommit, "function");
  assert.equal(typeof mod.evaluatePreHarnessNoWork, "function");
  assert.equal(typeof mod.formatNoopAdvanceEvidenceNote, "function");
});

test("async goal checks are supported", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "fix-2",
    goalCheck: async (): Promise<GoalCheckResult> => {
      await Promise.resolve();
      return {
        satisfied: true,
        rationaleClass: "fix-no-actionable-work",
        note: "async ok",
      };
    },
  });
  assert.equal(result.decision, "advance");
});
