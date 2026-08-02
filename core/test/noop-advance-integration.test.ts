/**
 * Integration-style regressions for the shared noop-advance contract (#758).
 * Replays #698 / #714 / #747 / #588 and recovery first-recipe paths through
 * shared evaluation adapters — injected deps only, no real network/git.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  evaluatePostHarnessNoNewCommit,
  evaluatePreHarnessNoWork,
  implementDeliverablePresentGoalCheck,
  preMergeArchiveCoherentGoalCheck,
  preMergeFindingsClearGoalCheck,
  fixOverrideEmptyGoalCheck,
  fixExternalCommitGoalCheck,
  fixDoesNotReproduceGoalCheck,
  formatNoopAdvanceEvidenceNote,
} from "../scripts/noop-advance.ts";
import { evaluatePreMergeNoopCleanDisposition } from "../scripts/stages/pre-merge-autofix.ts";
import { realExecuteRecovery } from "../scripts/pipeline.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// Source pins: stages must route through shared evaluation
// ---------------------------------------------------------------------------

test("source pin: fix stage imports and calls shared noop-advance evaluation", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /from "\.\.\/noop-advance\.ts"/);
  assert.match(src, /evaluatePostHarnessNoNewCommit/);
  assert.match(src, /evaluatePreHarnessNoWork/);
  assert.match(src, /formatNoopAdvanceEvidenceNote/);
});

test("source pin: planning implement uses shared evaluation + harness-round hook", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/planning.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /from "\.\.\/noop-advance\.ts"/);
  assert.match(src, /evaluatePostHarnessNoNewCommit/);
  assert.match(src, /implementDeliverablePresentGoalCheck/);
  assert.match(src, /onCleanNoNewCommit/);
});

test("source pin: pre-merge noop-clean disposition uses shared adapter", async () => {
  const autofix = await readFile(
    fileURLToPath(new URL("../scripts/stages/pre-merge-autofix.ts", import.meta.url)),
    "utf8",
  );
  const shaGate = await readFile(
    fileURLToPath(new URL("../scripts/stages/pre-merge-sha-gate.ts", import.meta.url)),
    "utf8",
  );
  assert.match(autofix, /evaluatePreMergeNoopCleanDisposition/);
  assert.match(autofix, /evaluatePostHarnessNoNewCommit/);
  assert.match(shaGate, /evaluatePreMergeNoopCleanDisposition/);
});

test("source pin: pre-merge archive uses pre-merge-archive-coherent check", async () => {
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/pre-merge-openspec-archive.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /preMergeArchiveCoherentGoalCheck/);
  assert.match(src, /evaluatePostHarnessNoNewCommit/);
});

// ---------------------------------------------------------------------------
// #698 via shared adapter
// ---------------------------------------------------------------------------

test("#698 via shared path: noop-clean re-verify clean → advance", async () => {
  const result = await evaluatePreMergeNoopCleanDisposition({
    headSha: SHA,
    reverifyBlockingCount: 0,
    reverifyUnparseable: false,
    issueNumber: 698,
  });
  assert.equal(result.decision, "advance");
  if (result.decision !== "advance") return;
  assert.equal(result.evidence.rationaleClass, "pre-merge-findings-clear");
  assert.match(formatNoopAdvanceEvidenceNote(result.evidence), /pre-merge-findings-clear/);
});

test("#698 via shared path: noop-clean re-verify still broken → escalate", async () => {
  const result = await evaluatePreMergeNoopCleanDisposition({
    headSha: SHA,
    reverifyBlockingCount: 2,
    reverifyUnparseable: false,
    issueNumber: 698,
  });
  assert.equal(result.decision, "escalate");
});

// ---------------------------------------------------------------------------
// #714 archive coherence via shared check
// ---------------------------------------------------------------------------

test("#714 via shared path: empty active set is archive-coherent advance", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: "h",
    headAfter: "h",
    salvaged: false,
    stage: "pre-merge",
    goalCheck: () => preMergeArchiveCoherentGoalCheck({ activeIds: [] }),
  });
  assert.equal(result.decision, "advance");
});

test("#714 via shared path: residual active ids escalate (fail closed)", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: "h",
    headAfter: "h",
    salvaged: false,
    stage: "pre-merge",
    goalCheck: () => preMergeArchiveCoherentGoalCheck({ activeIds: ["still-active"] }),
  });
  assert.equal(result.decision, "escalate");
  if (result.decision !== "escalate") return;
  assert.match(result.note, /still-active/);
});

// ---------------------------------------------------------------------------
// #747 partition terminal disposition still uses findings-clear check
// ---------------------------------------------------------------------------

test("#747 via shared path: clean allowlisted noop re-verify uses findings-clear", async () => {
  // Partition itself is stage-owned; terminal clean disposition must not hard-block
  // solely for no commit when re-verify is clean.
  const ok = preMergeFindingsClearGoalCheck({
    reverifyBlockingCount: 0,
    reverifyUnparseable: false,
    headSha: SHA,
  });
  assert.equal(ok.satisfied, true);
  const result = await evaluatePreMergeNoopCleanDisposition({
    headSha: SHA,
    reverifyBlockingCount: 0,
    reverifyUnparseable: false,
  });
  assert.equal(result.decision, "advance");
});

// ---------------------------------------------------------------------------
// Fix-stage recipes via shared contract
// ---------------------------------------------------------------------------

test("fix override-empty / external / DNR map through shared evaluation", async () => {
  const pre = await evaluatePreHarnessNoWork({
    headSha: SHA,
    stage: "fix-1",
    goalCheck: () => fixOverrideEmptyGoalCheck({ triggeringCount: 2, effectiveCount: 0 }),
  });
  assert.equal(pre.decision, "advance");

  const ext = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "fix-1",
    goalCheck: () =>
      fixExternalCommitGoalCheck({
        advance: true,
        reviewSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        headAfter: SHA,
      }),
  });
  assert.equal(ext.decision, "advance");

  const dnr = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "fix-1",
    goalCheck: () =>
      fixDoesNotReproduceGoalCheck({
        advance: true,
        coveredCount: 1,
        headAfter: SHA,
      }),
  });
  assert.equal(dnr.decision, "advance");
});

// ---------------------------------------------------------------------------
// #588 fresh process / re-entry style: shared evaluation + planning source path
// ---------------------------------------------------------------------------

test("#588 re-entry: implement-deliverable-present advances without empty commit", async () => {
  // Simulates a fresh process re-entry: only inputs are HEAD SHAs + artifact
  // presence (as a new process would observe), not in-memory helper-only state.
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "implementing",
    issueNumber: 588,
    goalCheck: () =>
      implementDeliverablePresentGoalCheck({
        deliverablePresent: true,
        worktreeClean: true,
        gatesGreen: true,
        deliverableDescription: "OpenSpec change generalized-noop-advance-contract present",
      }),
  });
  assert.equal(result.decision, "advance");
  if (result.decision !== "advance") return;
  assert.equal(result.evidence.rationaleClass, "implement-deliverable-present");
  assert.equal(result.evidence.headSha, SHA);
});

test("#588 bite: missing deliverable does not advance", async () => {
  const result = await evaluatePostHarnessNoNewCommit({
    headBefore: SHA,
    headAfter: SHA,
    salvaged: false,
    stage: "implementing",
    goalCheck: () =>
      implementDeliverablePresentGoalCheck({
        deliverablePresent: false,
        worktreeClean: true,
      }),
  });
  assert.equal(result.decision, "escalate");
});

test("#588 planning path source pin: clean no-new-commit routes through shared eval", async () => {
  // Fresh-path bite: if planning only kept an in-memory helper and the stage
  // re-entry still hard-blocked without goal check, this source pin fails.
  const src = await readFile(
    fileURLToPath(new URL("../scripts/stages/planning.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /implementDeliverablePresentGoalCheck/);
  assert.match(src, /deliverableAdvance/);
  assert.match(src, /without empty implementer commit/);
  // Must not hard-block no-commits before consulting shared evaluation.
  const noCommitsBlock = src.indexOf('return blockedOutcome("no commits produced", "no-commits")');
  const sharedEval = src.indexOf("evaluatePostHarnessNoNewCommit");
  assert.ok(sharedEval !== -1, "expected shared evaluatePostHarnessNoNewCommit call");
  assert.ok(noCommitsBlock !== -1, "expected no-commits blockedOutcome");
  assert.ok(
    sharedEval < noCommitsBlock || src.includes("noopResult"),
    "shared evaluation must gate no-commits for implement clean path",
  );
});

// ---------------------------------------------------------------------------
// #787 recovery first recipe
// ---------------------------------------------------------------------------

test("#787: implementation-ci default recipes lead with verify_head_goal", () => {
  assert.equal(DEFAULT_RECOVERY_POLICY["implementation-ci"].recipes[0], "verify_head_goal");
  assert.ok(DEFAULT_RECOVERY_POLICY["implementation-ci"].recipes.includes("repair_pipeline_item"));
  assert.ok(
    DEFAULT_RECOVERY_POLICY["implementation-ci"].recipes.indexOf("verify_head_goal") <
      DEFAULT_RECOVERY_POLICY["implementation-ci"].recipes.indexOf("repair_pipeline_item"),
    "goal satisfaction must precede model repair",
  );
});

test("#787: verify_head_goal advances no-commits without repair_pipeline_item", async () => {
  let repairs = 0;
  let clears = 0;
  let posts = 0;
  const cfg: PipelineConfig = {
    ...DEFAULT_CONFIG,
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  };
  const execute = realExecuteRecovery(cfg, {
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "should not run" };
    },
    clearBlocked: async () => {
      clears++;
    },
    postComment: async () => {
      posts++;
    },
    getOnDiskForIssue: async () => ({ path: "/wt", branch: "pipeline/1", slug: "s" } as any),
    gitHead: async () => SHA,
    listChangeDirs: () => ["generalized-noop-advance-contract"],
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "no-commits",
    reason: "implement produced no commits",
    stage: "implementing",
  });
  const result = await execute({
    runId: "loop-1",
    itemId: "42",
    blockerClass: "implementation-ci",
    attemptId: "a1",
    candidateIdentity: `repo=owner/repo|head=${SHA}|attempt=0`,
    action: "verify_head_goal",
    diagnostic,
    evidence: { pr_number: 1, pipeline_run_id: "run-1", candidate_identity: "x" },
  });
  assert.equal(result.succeeded, true);
  assert.equal(repairs, 0, "must not charge model-repair budget / invoke repair");
  assert.equal(clears, 1);
  assert.equal(posts, 1);
  assert.match(result.evidence, /verify_head_goal/);
  assert.match(result.evidence, /without model repair/);
});

test("#787: verify_head_goal escalates when deliverable absent (next recipe may run)", async () => {
  let repairs = 0;
  const cfg: PipelineConfig = {
    ...DEFAULT_CONFIG,
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  };
  const execute = realExecuteRecovery(cfg, {
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "repair" };
    },
    getOnDiskForIssue: async () => ({ path: "/wt", branch: "pipeline/1", slug: "s" } as any),
    gitHead: async () => SHA,
    listChangeDirs: () => [],
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "no-commits",
    reason: "no commits",
    stage: "implementing",
  });
  const result = await execute({
    runId: "loop-1",
    itemId: "42",
    blockerClass: "implementation-ci",
    attemptId: "a1",
    candidateIdentity: `repo=owner/repo|head=${SHA}|attempt=0`,
    action: "verify_head_goal",
    diagnostic,
    evidence: { pr_number: 1, pipeline_run_id: "run-1", candidate_identity: "x" },
  });
  assert.equal(result.succeeded, false);
  assert.equal(repairs, 0);
  assert.match(result.error ?? "", /does not satisfy|not satisfied|absent|implement goal/i);
});
