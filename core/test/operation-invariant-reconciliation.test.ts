// Operation-invariant reconciliation (#1324). Injected I/O only.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  collectErrorNameClassificationHits,
  DELIVERY_STAGES,
  deliveryStageInvariant,
  isCandidateBoundEvidenceValid,
  missingDeliveryStageInvariants,
  missingOperationInvariantFields,
  observationFromAdapterAttempt,
} from "../scripts/issue-stage-adapters.ts";
import { pipelineStageFromLabels } from "../scripts/loop/precondition.ts";
import {
  classifyDrift,
  computeNextAction,
  localRemoteIdentityDrift,
  observeExternalIdentity,
  reconstructedLocalState,
  recoveryRecipeCompletesOriginalMutation,
  repairShaMismatchIsHumanStop,
  type ReconcileObserveDeps,
} from "../scripts/loop/reconcile.ts";
import { isLoopNextAction, type LoopExternalIdentity } from "../scripts/loop/types.ts";
import {
  archiveReplayDecision,
  bindArtifactBodyToLogicalOperation,
  integrationSideEffectCertainty,
  logicalOperationIdFromArtifactBody,
  mayReplaySideEffect,
  successorMutationsAllowed,
  treatmentForSideEffectCertainty,
} from "../scripts/operation-observation.ts";
import { missingMergeInvariantFields } from "../scripts/stages/merge-supervision.ts";
import { missingShipPhaseInvariantFields } from "../scripts/stages/ship-supervision.ts";
import { pipelineStageFromLabels as trainPipelineStageFromLabels } from "../scripts/stages/train.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(__dirname, "..");

test("implementation artifact bodies retain their admitted operation identity (#1454)", () => {
  const body = bindArtifactBodyToLogicalOperation("Closes #1454", "lop-current-1454");
  assert.equal(logicalOperationIdFromArtifactBody(body), "lop-current-1454");
  assert.equal(bindArtifactBodyToLogicalOperation(body, "lop-other"), body);
});

function identity(overrides: Partial<LoopExternalIdentity> = {}): LoopExternalIdentity {
  return {
    issue_number: 1369,
    issue_open: true,
    ready_label_present: false,
    blocked_label_present: false,
    pr_number: 42,
    pr_state: "merged",
    head_branch: "pipeline/1369-fix",
    head_sha: "a".repeat(40),
    merge_commit_sha: "c".repeat(40),
    checks_conclusion: "success",
    pipeline_stage: "fix-2",
    observed_at: "2026-09-01T00:00:00.000Z",
    integration_certainty: "known_complete",
    artifact_role: "implementation",
    artifact_identity: `pr:42:${"a".repeat(40)}`,
    candidate_epoch: "a".repeat(40),
    ...overrides,
  };
}

function fakeObserve(overrides: Partial<ReconcileObserveDeps> = {}): ReconcileObserveDeps {
  return {
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:fix-2"] };
    },
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return [];
    },
    async getPrDetail() {
      return null;
    },
    async getPrChecks() {
      return [];
    },
    async getPrArtifactBinding(pr, detail) {
      return {
        role: "implementation",
        artifactIdentity: `pr:${pr}:${detail.head_sha}`,
        candidateSha: detail.head_sha,
        candidateEpoch: detail.head_sha,
      };
    },
    async getLocalHead() {
      return null;
    },
    async baseBranchContainsSha() {
      return null;
    },
    async getExternalDependencyIssueState() {
      return null;
    },
    async getLabelEvents() {
      return [];
    },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("contract: every delivery stage, merge, and ship phase declares the eight invariant fields", () => {
  assert.deepEqual(missingDeliveryStageInvariants(), []);
  assert.deepEqual(missingMergeInvariantFields(), []);
  assert.deepEqual(missingShipPhaseInvariantFields(), []);
  for (const stage of DELIVERY_STAGES) {
    const missing = missingOperationInvariantFields(deliveryStageInvariant(stage));
    assert.deepEqual(missing, [], stage);
  }
});

test("contract: omitting reconstruction_rule fails and names the operation", () => {
  const missing = missingOperationInvariantFields({
    ...deliveryStageInvariant("pre-merge"),
    reconstruction_rule: "",
  });
  assert.ok(missing.includes("reconstruction_rule"));
});

test("1.3 exit zero is not verified completion", () => {
  const obs = observationFromAdapterAttempt({
    stage: "fix-2",
    domain: "test",
    logical_operation_id: "lop-exit0",
    issue: 1324,
    exitCode: 0,
    postconditionProven: false,
  });
  assert.equal(obs.complete, false);
  assert.equal(obs.certainty, "uncertain");
  assert.equal(obs.process_exit_is_completion, false);
});

test("2.1 contradictory labels: pre-merge plus design-gate yields pre-merge and does not throw", () => {
  const labels = ["pipeline:pre-merge", "pipeline:design-gate"];
  assert.equal(pipelineStageFromLabels(labels), "pre-merge");
  assert.equal(trainPipelineStageFromLabels(labels), "pre-merge");
});

test("2.2 train and loop derivation match", () => {
  const labels = ["pipeline:review-2", "pipeline:fix-2", "blocked"];
  assert.equal(pipelineStageFromLabels(labels), trainPipelineStageFromLabels(labels));
  assert.equal(pipelineStageFromLabels(labels), "fix-2");
});

test("2.3 needs-human wins when co-present with an in-flight stage", () => {
  assert.equal(
    pipelineStageFromLabels(["pipeline:needs-human", "pipeline:review-2"]),
    "needs-human",
  );
});

test("3.1 reconstruct is in the closed LoopNextAction set", () => {
  assert.equal(isLoopNextAction("reconstruct"), true);
  assert.equal(isLoopNextAction("teleport"), false);
});

test("3.2 contradictions without typed-request evidence return reconstruct", () => {
  for (const cls of ["ledger-ahead", "external-absent", "identity-mismatch"] as const) {
    const action = computeNextAction("merged", identity({ pr_state: "open" }), cls, false, false);
    assert.equal(action, "reconstruct");
    assert.notEqual(action, "noop");
    assert.notEqual(action, "hold-for-human");
  }
});

test("3.2 waiting/paused/blocked contradictions without typed authority reconstruct", () => {
  const live = identity({
    pr_state: "open",
    local_head_sha: "b".repeat(40),
    rebase_in_progress: true,
    product_dirt: true,
  });
  const bound = identity({ head_sha: "a".repeat(40), pr_state: "open" });
  for (const state of ["waiting", "paused", "blocked"] as const) {
    assert.equal(classifyDrift(state, live, bound), "identity-mismatch", state);
    for (const cls of ["ledger-ahead", "identity-mismatch"] as const) {
      const action = computeNextAction(state, live, cls, false, false);
      assert.equal(action, "reconstruct", `${state} + ${cls}`);
      assert.notEqual(action, "noop", `${state} + ${cls}`);
      assert.notEqual(action, "hold-for-human", `${state} + ${cls}`);
    }
  }
});

test("3.4 hold-for-human still requires current typed-request evidence", () => {
  assert.equal(computeNextAction("waiting", identity(), null, false, true), "hold-for-human");
  assert.equal(
    computeNextAction("merged", identity({ pr_state: "open" }), "ledger-ahead", false, true),
    "hold-for-human",
  );
});

test("4.1 later open PR does not hide a prior merged-and-contained PR", () => {
  const certainty = integrationSideEffectCertainty([
    {
      number: 10,
      state: "merged",
      merge_commit_sha: "c".repeat(40),
      contained: true,
      artifact_role: "implementation",
      artifact_identity: "pr:10:head",
      candidate_sha: "a".repeat(40),
      candidate_epoch: "a".repeat(40),
      logical_operation_id: "lop-current",
    },
    {
      number: 99,
      state: "open",
      merge_commit_sha: null,
      contained: null,
      candidate_sha: "a".repeat(40),
      candidate_epoch: "a".repeat(40),
      logical_operation_id: "lop-current",
    },
  ], { candidateSha: "a".repeat(40), logicalOperationId: "lop-current" });
  assert.equal(certainty, "known_complete");
  assert.equal(successorMutationsAllowed(certainty).openSuccessorPr, false);
  assert.equal(successorMutationsAllowed(certainty).rebaseContainedCommits, false);
});

test("4.1 merged completion must match the active operation and candidate (#1454)", () => {
  const merged = {
    number: 10,
    state: "merged" as const,
    contained: true,
    artifact_role: "implementation" as const,
    artifact_identity: "pr:10:head",
    candidate_sha: "a".repeat(40),
    candidate_epoch: "a".repeat(40),
    logical_operation_id: "lop-old",
  };
  assert.equal(
    integrationSideEffectCertainty([merged], {
      candidateSha: "b".repeat(40),
      logicalOperationId: "lop-current",
    }),
    "uncertain",
  );
  assert.equal(
    integrationSideEffectCertainty([merged], {
      candidateSha: "a".repeat(40),
      logicalOperationId: "lop-current",
    }),
    "uncertain",
  );
});

test("4.1 truncated linked-PR scan is uncertain, never known_absent", () => {
  const openOnly = integrationSideEffectCertainty(
    [{ number: 99, state: "open", merge_commit_sha: null, contained: null }],
    { truncated: true },
  );
  assert.equal(openOnly, "uncertain");
  assert.notEqual(openOnly, "known_absent");
  assert.equal(successorMutationsAllowed(openOnly).openSuccessorPr, false);
  assert.equal(successorMutationsAllowed(openOnly).rebaseContainedCommits, false);
  assert.equal(integrationSideEffectCertainty([], { truncated: true }), "uncertain");
  assert.equal(
    integrationSideEffectCertainty(
      [{ number: 10, state: "merged", merge_commit_sha: "c".repeat(40), contained: true }],
      { truncated: true },
    ),
    "uncertain",
  );
});

test("4.2/4.3 squash-merge while fix-2 is known_complete even if the issue is still open", async () => {
  const deps = fakeObserve({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:fix-2"] };
    },
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return [10, 99];
    },
    async getPrDetail(pr) {
      if (pr === 10) {
        return {
          state: "merged",
          head_ref: "pipeline/1369-fix",
          head_sha: "a".repeat(40),
          merge_commit_sha: "c".repeat(40),
        };
      }
      return {
        state: "open",
        head_ref: "pipeline/1369-fix",
        head_sha: "a".repeat(40),
        merge_commit_sha: null,
      };
    },
    async baseBranchContainsSha(sha) {
      return sha === "c".repeat(40);
    },
  });
  const observed = await observeExternalIdentity(deps, "1369");
  assert.equal(observed.pr_state, "merged");
  assert.equal(observed.pr_number, 10);
  assert.equal(observed.integration_certainty, "known_complete");
  assert.equal(observed.pipeline_stage, "fix-2");
  assert.equal(observed.issue_open, true);
  assert.equal(successorMutationsAllowed(observed.integration_certainty!).openSuccessorPr, false);
});

test("4.2 merged candidate A cannot complete later active candidate B (#1454)", async () => {
  const deps = fakeObserve({
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return [10, 99];
    },
    async getPrDetail(pr) {
      return pr === 10
        ? {
            state: "merged",
            head_ref: "pipeline/1369-fix",
            head_sha: "a".repeat(40),
            merge_commit_sha: "c".repeat(40),
          }
        : {
            state: "open",
            head_ref: "pipeline/1369-fix",
            head_sha: "b".repeat(40),
            merge_commit_sha: null,
          };
    },
    async baseBranchContainsSha() {
      return true;
    },
  });
  const observed = await observeExternalIdentity(deps, "1369");
  assert.equal(observed.integration_certainty, "uncertain");
  assert.equal(observed.pr_number, 99);
  assert.equal(observed.head_sha, "b".repeat(40));
});

test("4.1 truncated listLinkedPrs does not declare integration absent", async () => {
  const deps = fakeObserve({
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return { numbers: [99], truncated: true };
    },
    async getPrDetail() {
      return {
        state: "open",
        head_ref: "pipeline/1369-fix",
        head_sha: "b".repeat(40),
        merge_commit_sha: null,
      };
    },
  });
  const observed = await observeExternalIdentity(deps, "1369");
  assert.equal(observed.integration_certainty, "uncertain");
  assert.notEqual(observed.integration_certainty, "known_absent");
  assert.equal(successorMutationsAllowed(observed.integration_certainty!).openSuccessorPr, false);
});

test("4.1 failed linked-PR detail reads are uncertain, never known_absent", async () => {
  const incomplete = integrationSideEffectCertainty(
    [{ number: 99, state: "open", merge_commit_sha: null, contained: null }],
    { incompleteDetails: true },
  );
  assert.equal(incomplete, "uncertain");
  assert.notEqual(incomplete, "known_absent");
  assert.equal(
    integrationSideEffectCertainty([], { incompleteDetails: true }),
    "uncertain",
  );
  assert.equal(
    integrationSideEffectCertainty(
      [{
        number: 10,
        state: "merged",
        merge_commit_sha: "c".repeat(40),
        contained: true,
        artifact_role: "implementation",
        artifact_identity: "pr:10:head",
        candidate_sha: "a".repeat(40),
        candidate_epoch: "a".repeat(40),
      }],
      { incompleteDetails: true },
    ),
    "known_complete",
  );

  const deps = fakeObserve({
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return [10, 99];
    },
    async getPrDetail() {
      return null;
    },
  });
  const observed = await observeExternalIdentity(deps, "1369");
  assert.equal(observed.integration_certainty, "uncertain");
  assert.notEqual(observed.integration_certainty, "known_absent");
  assert.equal(successorMutationsAllowed(observed.integration_certainty!).openSuccessorPr, false);
  assert.equal(successorMutationsAllowed(observed.integration_certainty!).rebaseContainedCommits, false);
});

test("5.1 SideEffectCertainty gates replay", () => {
  assert.equal(mayReplaySideEffect("known_complete"), false);
  assert.equal(mayReplaySideEffect("known_absent"), true);
  assert.equal(mayReplaySideEffect("uncertain"), false);
  assert.equal(treatmentForSideEffectCertainty("known_complete"), "complete");
  assert.equal(treatmentForSideEffectCertainty("known_absent"), "replay");
  assert.equal(treatmentForSideEffectCertainty("uncertain"), "cooling");
});

test("5.2 claimed SHA versus on-disk HEAD with unfinished rebase is local/remote drift, not human STOP", () => {
  const live = identity({
    local_head_sha: "b".repeat(40),
    rebase_in_progress: true,
    product_dirt: true,
    pr_state: "open",
  });
  const bound = identity({ head_sha: "a".repeat(40) });
  assert.equal(localRemoteIdentityDrift(live, bound), true);
  assert.equal(classifyDrift("in_progress", live, bound), "identity-mismatch");
  assert.equal(
    repairShaMismatchIsHumanStop({
      claimedSha: "a".repeat(40),
      onDiskSha: "b".repeat(40),
      rebaseInProgress: true,
      productDirt: true,
    }),
    false,
  );
  assert.equal(
    computeNextAction("in_progress", live, "identity-mismatch", false, false),
    "reconstruct",
  );
});

test("5.3 a recovery recipe is not verified completion of the original mutation", () => {
  assert.equal(recoveryRecipeCompletesOriginalMutation("worktree_rematerialize"), false);
  assert.equal(recoveryRecipeCompletesOriginalMutation("rebase_abort"), false);
});

test("5.4 completed archive plus unfinished-rebase dirt does not replay and does not skip fail-closed", () => {
  const decision = archiveReplayDecision({
    archiveAlreadyDone: true,
    rebaseInProgress: true,
    productDirt: ["openspec/changes/prove-invariants-and-reconcile/proposal.md"],
  });
  assert.equal(decision.archive_certainty, "known_complete");
  assert.equal(decision.replay_archive, false);
  assert.equal(decision.dirty_fail_closed, true);
  assert.equal(decision.rebase_in_progress, true);
});

test("6.1/6.2 #1369 dogfood fixture: squash-merge, contradictory labels, SHA drift, partial archive", async () => {
  const labels = ["pipeline:pre-merge", "pipeline:design-gate"];
  const stage = trainPipelineStageFromLabels(labels);
  assert.equal(stage, "pre-merge");

  const deps = fakeObserve({
    async getIssueStateAndLabels() {
      return { state: "open", labels: ["pipeline:fix-2", ...labels] };
    },
    async findPrForIssue() {
      return 99;
    },
    async listLinkedPrs() {
      return [10, 99];
    },
    async getPrDetail(pr) {
      if (pr === 10) {
        return {
          state: "merged",
          head_ref: "pipeline/1369-fix",
          head_sha: "a".repeat(40),
          merge_commit_sha: "c".repeat(40),
        };
      }
      return {
        state: "open",
        head_ref: "pipeline/1369-fix",
        head_sha: "b".repeat(40),
        merge_commit_sha: null,
      };
    },
    async baseBranchContainsSha(sha) {
      return sha === "c".repeat(40);
    },
    async getLocalHead() {
      return {
        branch: "pipeline/1369-fix",
        sha: "d".repeat(40),
        rebase_in_progress: true,
        product_dirt: true,
      };
    },
  });
  const observed = await observeExternalIdentity(deps, "1369");
  assert.equal(observed.pipeline_stage, "pre-merge");
  assert.equal(observed.pr_state, "open");
  assert.equal(observed.integration_certainty, "uncertain");
  assert.equal(observed.rebase_in_progress, true);
  assert.equal(observed.product_dirt, true);

  const mutations = successorMutationsAllowed(observed.integration_certainty!);
  assert.equal(mutations.openSuccessorPr, false);
  assert.equal(mutations.rebaseContainedCommits, false);

  const archive = archiveReplayDecision({
    archiveAlreadyDone: true,
    rebaseInProgress: true,
    productDirt: ["openspec/changes/x/spec.md"],
  });
  assert.equal(archive.replay_archive, false);
  assert.equal(archive.dirty_fail_closed, true);

  const next = computeNextAction(
    "in_progress",
    observed,
    classifyDrift("in_progress", observed, identity({ head_sha: "a".repeat(40) })),
    false,
    false,
  );
  assert.notEqual(next, "hold-for-human");
  assert.equal(repairShaMismatchIsHumanStop({
    claimedSha: "a".repeat(40),
    onDiskSha: "d".repeat(40),
    rebaseInProgress: true,
    productDirt: true,
  }), false);
});

test("6.3 class-guard: classifying by matching a thrown message fails", () => {
  const hits = collectErrorNameClassificationHits(
    `catch (e) { if (String(e.message).includes("ambiguous pipeline stage labels")) return "hold-for-human"; }`,
    "synthetic.ts",
  );
  assert.ok(hits.length > 0);
  assert.match(hits[0]!.reason, /ambiguous pipeline stage labels/);
});

test("6.3 class-guard: production scripts do not classify by thrown error message", () => {
  const hits: string[] = [];
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === "test") continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.name.endsWith(".ts")) continue;
      const source = readFileSync(abs, "utf8");
      if (source.includes("export function collectErrorNameClassificationHits")) continue;
      for (const hit of collectErrorNameClassificationHits(source, abs.slice(CORE_ROOT.length + 1))) {
        hits.push(hit.reason);
      }
    }
  }
  walk(join(CORE_ROOT, "scripts"));
  assert.deepEqual(hits, []);
});

test("6.4 contradictory labels, remote/local drift, stale evidence, remote mutation, partial ops", () => {
  assert.equal(
    pipelineStageFromLabels(["pipeline:pre-merge", "pipeline:design-gate"]),
    "pre-merge",
  );
  assert.equal(
    classifyDrift(
      "in_progress",
      identity({ local_head_sha: "b".repeat(40), rebase_in_progress: true, pr_state: "open" }),
      identity({ head_sha: "a".repeat(40) }),
    ),
    "identity-mismatch",
  );
  assert.equal(
    isCandidateBoundEvidenceValid("oldsha", "newsha"),
    false,
  );
  assert.equal(
    integrationSideEffectCertainty([
      {
        number: 10,
        state: "merged",
        contained: true,
        artifact_role: "implementation",
        artifact_identity: "pr:10:head",
        candidate_sha: "a".repeat(40),
        candidate_epoch: "a".repeat(40),
      },
      { number: 99, state: "open" },
    ]),
    "known_complete",
  );
  const partial = archiveReplayDecision({
    archiveAlreadyDone: true,
    rebaseInProgress: true,
    productDirt: ["openspec/changes/x"],
  });
  assert.equal(partial.replay_archive, false);
  assert.equal(partial.dirty_fail_closed, true);
});

test("reconstructedLocalState: ledger-ahead merged with open PR does not stay merged", () => {
  const next = reconstructedLocalState(identity({ pr_state: "open", merge_commit_sha: null }), "merged");
  assert.notEqual(next, "merged");
});
