import assert from "node:assert/strict";
import test from "node:test";
import { realExecuteRecovery } from "../scripts/pipeline.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "owner/repo", repo_dir: "/repo", base_branch: "main" };
}

function mechanicalInput() {
  const diagnostic = buildStageDiagnostic({ blockerKind: "merge-conflict", reason: "cannot apply base", stage: "pre-merge" });
  return {
    runId: "loop-1",
    itemId: "42",
    blockerClass: "workflow-state" as const,
    attemptId: "attempt-1",
    candidateIdentity: `repo=owner/repo|head=${"a".repeat(40)}|attempt=0`,
    action: "repair_pipeline_item" as const,
    diagnostic,
    evidence: {
      pr_number: 7,
      pipeline_run_id: "run-1",
      candidate_identity: "pr:7:run:run-1",
    },
  };
}

test("production recovery delegates repair_pipeline_item with deterministic claim identity", async () => {
  let received: unknown;
  const execute = realExecuteRecovery(cfg(), {
    repairPipelineItem: async (input) => {
      received = input;
      return { succeeded: true, evidence: "pushed verified repair" };
    },
  });
  const input = mechanicalInput();
  const result = await execute(input);
  assert.deepEqual(received, {
    runId: input.runId,
    itemId: input.itemId,
    attemptId: input.attemptId,
    candidateIdentity: input.candidateIdentity,
    diagnostic: input.diagnostic,
  });
  assert.deepEqual(result, { succeeded: true, evidence: "pushed verified repair" });
});

test("narrow recovery clears only a current mechanical block and verifies live state", async () => {
  let detailReads = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "conflict",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: detailReads++ === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => assert.fail("substantive repair must not run for resync"),
  });
  const result = await execute({ ...mechanicalInput(), action: "resync_workflow_state" });
  assert.equal(result.succeeded, true);
  assert.equal(clears, 1);
  assert.equal(detailReads, 2);
  assert.match(result.evidence, /cleared.*verified/);
});

test("authentication recovery verifies live credentials before clearing the mechanical block", async () => {
  let actorReads = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => {
      actorReads++;
      return "pipeline-bot";
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "auth",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: clears === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "environment-auth",
    blockerKind: "harness-failure",
    reason: "GitHub credentials expired",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "verify_authentication",
    blockerClass: "environment-auth",
    diagnostic,
  });
  assert.equal(result.succeeded, true);
  assert.equal(actorReads, 1);
  assert.equal(clears, 1);
});

test("authentication recovery preserves the block when credentials are still unusable", async () => {
  let cleared = false;
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => null,
    clearBlocked: async () => {
      cleared = true;
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "environment-auth",
    blockerKind: "harness-failure",
    reason: "GitHub credentials expired",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "verify_authentication",
    blockerClass: "environment-auth",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.equal(cleared, false);
  assert.match(result.error ?? "", /authenticated actor/);
});

test("human authority and malformed diagnostics are rejected before any mutation", async () => {
  let mutated = false;
  const execute = realExecuteRecovery(cfg(), {
    getIssueDetail: async () => {
      mutated = true;
      throw new Error("must not inspect");
    },
    clearBlocked: async () => {
      mutated = true;
    },
    repairPipelineItem: async () => {
      mutated = true;
      return { succeeded: true, evidence: "wrong" };
    },
  });
  const human = buildStageDiagnostic({
    blockerKind: "human-decision-required",
    reason: "choose API",
    authorityEvidence: [{
      category: "product-decision",
      finding_key: "deadbeef",
      finding_fingerprint: "0123456789abcdef",
      reviewed_sha: "abc1234",
    }],
  });
  const result = await execute({
    ...mechanicalInput(),
    blockerClass: "specification-decision",
    diagnostic: human,
  });
  assert.equal(result.succeeded, false);
  assert.equal(mutated, false);
  assert.match(result.error ?? "", /human_authority/);
});
