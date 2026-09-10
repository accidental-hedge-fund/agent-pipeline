import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { realExecuteRecovery } from "../scripts/pipeline.ts";
import { PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV } from "../scripts/loop/pack-loop-liveness.ts";
import { buildEngineFingerprint } from "../scripts/evidence-subject.ts";
import { rebindTesterEvidenceAfterPr } from "../scripts/rebind-tester-evidence-after-pr.ts";
import { runDirPath } from "../scripts/run-store.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import { encodeReviewArtifact, type ReviewArtifact } from "../scripts/stages/review-parsing.ts";
import {
  computeConfigDigest,
  TESTER_EVIDENCE_KIND,
  TESTER_EVIDENCE_SCHEMA_VERSION,
  testerEvidencePath,
  type TesterEvidence,
} from "../scripts/tester-evidence.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "owner/repo", repo_dir: "/repo", base_branch: "main" };
}

const PERSISTED_ENGINE = {
  version: "1.40.1",
  root: "/skill/core",
  templates_fingerprint: "e".repeat(64),
  commit_sha: "f".repeat(40),
};

function persistedEngineIdentity() {
  return PERSISTED_ENGINE;
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

test("exact-candidate FRG recovery never invokes substantive fixture repair", async (t) => {
  const prior = process.env[PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV];
  process.env[PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV] = "1";
  t.after(() => {
    if (prior === undefined) delete process.env[PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV];
    else process.env[PIPELINE_EXACT_FRG_NO_ENGINE_REPAIR_ENV] = prior;
  });
  let repairs = 0;
  const execute = realExecuteRecovery(cfg(), {
    repairPipelineItem: async () => { repairs++; return { succeeded: true, evidence: "unexpected" }; },
  });
  const result = await execute(mechanicalInput());
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /inapplicable during exact-candidate FRG/);
  assert.equal(repairs, 0);
});

test("production review recovery delegates substantive repair without clearing the block first", async () => {
  let repairs = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    clearBlocked: async () => { clears++; },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "review finding repaired", candidateHead: "b".repeat(40) };
    },
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "blocking finding survived a verified repair cycle",
    stage: "review-2",
  });

  const result = await execute({
    ...mechanicalInput(),
    blockerClass: "review-findings",
    diagnostic,
  });

  assert.equal(result.succeeded, true);
  assert.equal(repairs, 1);
  assert.equal(clears, 0);
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

function needsHumanAckInput() {
  const diagnostic = buildStageDiagnostic({
    blockerKind: "needs-human",
    reason: "1 unacknowledged human comment(s) after the latest plan — re-plan or post a scope override to proceed.",
    stage: "fix-1",
  });
  return {
    ...mechanicalInput(),
    action: "resync_workflow_state" as const,
    diagnostic,
  };
}

function review1FalseHumanBody(): string {
  const heading = "## Review 1 (Standard) — needs-attention (commit 889e161)";
  const banner =
    "**Reviewer coverage (#694):** configured=1 attempted=1 usable=1 independent=1 required=0 outcome=`complete` (usable=1/1 independent=1 required=0)";
  const rest =
    "**Reviewer**: codex\n\nThis change accepts unbound evidence and can rewrite a failed score as a pass instead.";
  const artifact: ReviewArtifact = {
    round: 1,
    reviewedSha: "889e16168df7dd346800d413b9891b09afa8cd9b",
    diffHash: "9cf19f7cc5343e62",
    blockingKeys: ["2483a1e1", "9a2daa69", "cac26b15"],
    review1Risk: "standard",
    bodyHash: "0".repeat(64),
  };
  return `${heading}\n\n${banner}\n${rest}\n${encodeReviewArtifact(artifact)}`;
}

const ACK_WARNING = "## Pipeline: New human input detected\n\n1 human comment(s) were posted after the latest plan.";

test("resync_workflow_state: #1038 Review-1 heading+artifact clears false needs-human", async () => {
  let detailReads = 0;
  let clears = 0;
  const comments = [
    { author: "bot", body: "## Revised Implementation Plan\n\nDo X.", createdAt: "2026-08-17T01:24:02Z" },
    { author: "bot", body: review1FalseHumanBody(), createdAt: "2026-08-17T01:45:39Z" },
    { author: "bot", body: ACK_WARNING, createdAt: "2026-08-17T01:45:45Z" },
  ];
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => "bot",
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "ack",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: detailReads++ === 0 ? ["blocked", "pipeline:fix-1"] : ["pipeline:fix-1"],
      comments,
    }),
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => assert.fail("model repair must not run for false human-ack"),
  });
  const result = await execute(needsHumanAckInput());
  assert.equal(result.succeeded, true);
  assert.equal(clears, 1);
  assert.match(result.evidence, /cleared.*verified/);
});

test("resync_workflow_state: operator-scope-change does not clear needs-human", async () => {
  let clears = 0;
  const comments = [
    { author: "bot", body: "## Revised Implementation Plan\n\nDo X.", createdAt: "2026-08-17T01:24:02Z" },
    { author: "alice", body: "please also change X", createdAt: "2026-08-17T01:45:39Z" },
    { author: "bot", body: ACK_WARNING, createdAt: "2026-08-17T01:45:45Z" },
  ];
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => "bot",
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "ack",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked", "pipeline:fix-1"],
      comments,
    }),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(needsHumanAckInput());
  assert.equal(result.succeeded, false);
  assert.equal(clears, 0);
  assert.match(result.error ?? "", /operator-scope-change remains/);
});

test("resync_workflow_state: needs-human without ack-gate warning still clears", async () => {
  let detailReads = 0;
  let clears = 0;
  const comments = [
    { author: "bot", body: "## Revised Implementation Plan\n\nDo X.", createdAt: "2026-08-17T01:24:02Z" },
    { author: "bot", body: "## Pipeline: Review ceiling\n\nParked.", createdAt: "2026-08-17T01:45:39Z" },
  ];
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => "bot",
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "ceiling",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: detailReads++ === 0 ? ["blocked", "pipeline:fix-1"] : ["pipeline:fix-1"],
      comments,
    }),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(needsHumanAckInput());
  assert.equal(result.succeeded, true);
  assert.equal(clears, 1);
});

test("resync_workflow_state: missing comments fail closed on needs-human", async () => {
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getGhActor: async () => "bot",
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "ack",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked", "pipeline:fix-1"],
    }),
    clearBlocked: async () => {
      clears++;
    },
  });
  const result = await execute(needsHumanAckInput());
  assert.equal(result.succeeded, false);
  assert.equal(clears, 0);
  assert.match(result.error ?? "", /comments were not available/);
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

test("unlink_engine_scratch (#1020): scratch-only unlinks, clears blocked, never repairs", async () => {
  let clears = 0;
  let repairs = 0;
  let cleaned = false;
  const cleanedArgs: string[][] = [];
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return {
          stdout: cleaned ? "" : "?? artifacts/challenge-response-1010.json\n",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "clean") {
        cleanedArgs.push(args as string[]);
        cleaned = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: clears === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "should not run" };
    },
    onEngineClassRecovered: async () => {},
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "scratch porcelain blocked factory",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(repairs, 0, "must not invoke repair_pipeline_item for scratch-only");
  assert.equal(clears, 1);
  assert.ok(cleanedArgs.some((a) => a.includes("artifacts/challenge-response-1010.json")));
});

test("unlink_engine_scratch (#1020): product dirt fails closed without repair", async () => {
  let clears = 0;
  let repairs = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return {
          stdout: "?? artifacts/challenge-response-1.json\n M core/scripts/foo.ts\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "no" };
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "mixed dirt",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /product dirt/);
  assert.equal(clears, 0);
  assert.equal(repairs, 0);
});

test("unlink_engine_scratch (#1028): clean porcelain fails so restart/repair can run", async () => {
  // Bite: clean non-scratch workflow-engine failures must NOT succeed unlink
  // and clear blocked — that falsely recovered real engine defects.
  let clears = 0;
  let repairs = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: ["blocked", "pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "should not run from unlink" };
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "engine defect without scratch",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /no current engine-scratch/);
  assert.equal(clears, 0, "must not clear blocked without scratch evidence");
  assert.equal(repairs, 0);
});

test("DEFAULT_RECOVERY_POLICY recipe order: unlink before repair (#1020)", async () => {
  const { DEFAULT_RECOVERY_POLICY } = await import("../scripts/loop/recovery.ts");
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const unlinkIdx = recipes.indexOf("unlink_engine_scratch");
  const repairIdx = recipes.indexOf("repair_pipeline_item");
  assert.ok(unlinkIdx >= 0, "unlink_engine_scratch must be configured");
  assert.ok(repairIdx >= 0, "repair_pipeline_item must remain configured");
  assert.ok(
    unlinkIdx < repairIdx,
    `unlink must precede repair (got ${recipes.join(" → ")})`,
  );
});

test("checkpoint_owned_harness_dirt succeeds without repair or human hold (#1246)", async () => {
  let clears = 0;
  let repairs = 0;
  const files = new Map<string, string>();
  const rec = {
    schema_version: 1,
    issue: 42,
    domain: "owner-repo",
    stage: "implementing",
    attempt_id: "a1",
    worktree_path: "/wt/42",
    pre_head: "h0",
    pre_porcelain: [] as { path: string; xy: string }[],
    in_flight: true,
    last_known_porcelain: [{ path: "core/owned.ts", xy: " M" }],
    updated_at: "2026-08-26T00:00:00Z",
  };
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return { stdout: " M core/owned.ts\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    clearBlocked: async () => {
      clears++;
    },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "should not run" };
    },
    ownership: {
      readFile: async () => JSON.stringify(rec),
      writeFileAtomic: async (p, c) => {
        files.set(p, c);
      },
      mkdirp: async () => {},
      gitStatusPorcelain: async () => " M core/owned.ts\n",
      salvage: async () => ({ salvaged: true, message: "checkpoint" }),
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "owned harness leftovers",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "checkpoint_owned_harness_dirt",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(repairs, 0, "must not invoke repair_pipeline_item when checkpoint clears leftovers");
  assert.equal(clears, 1, "must not mint a human hold — clear blocked instead");
  assert.match(result.evidence, /checkpointed owned leftover/);
});

test("DEFAULT_RECOVERY_POLICY recipe order: checkpoint owned leftovers before repair (#1246)", async () => {
  const { DEFAULT_RECOVERY_POLICY } = await import("../scripts/loop/recovery.ts");
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const unlinkIdx = recipes.indexOf("unlink_engine_scratch");
  const checkpointIdx = recipes.indexOf("checkpoint_owned_harness_dirt");
  const publishIdx = recipes.indexOf("publish_unpublished_stage_commit");
  const repairIdx = recipes.indexOf("repair_pipeline_item");
  assert.ok(checkpointIdx >= 0, "checkpoint_owned_harness_dirt must be configured");
  assert.ok(publishIdx >= 0, "publish_unpublished_stage_commit must be configured");
  const rebindIdx = recipes.indexOf("rebind_tester_evidence_after_pr");
  assert.ok(checkpointIdx >= 0, "checkpoint_owned_harness_dirt must be configured");
  assert.ok(publishIdx >= 0, "publish_unpublished_stage_commit must be configured");
  assert.ok(rebindIdx >= 0, "rebind_tester_evidence_after_pr must be configured");
  assert.ok(
    unlinkIdx < checkpointIdx && checkpointIdx < publishIdx && publishIdx < rebindIdx && rebindIdx < repairIdx,
    `got ${recipes.join(" → ")}`,
  );
});

test("rebind_tester_evidence_after_pr executes the shared bind and does not repair", async () => {
  let repairs = 0;
  let clears = 0;
  let rebindCalls = 0;
  let trustedReadDir = "";
  const execute = realExecuteRecovery({ ...cfg(), repo_dir: "/separate-candidate" }, {
    clearBlocked: async () => { clears++; },
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "must not run" };
    },
    rebindTesterEvidenceAfterPr: async () => {
      rebindCalls++;
      return {
        ok: true,
        action: "bind",
        candidateSha: "a".repeat(40),
        evidence: { candidate_sha: "a".repeat(40) } as never,
        suiteCommandInvoked: false,
      };
    },
    resolveRunEngineIdentity: async () => persistedEngineIdentity(),
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: "a".repeat(40) }) as never,
    resolveRunStoreRepoDir: async () => "/target-primary",
    readTrustedSurfaceDecision: async (runDir) => {
      trustedReadDir = runDir;
      return ({
      outcome: "passthrough",
      candidate_sha: "a".repeat(40),
      effective_verifier_hash: "c".repeat(64),
      }) as never;
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: "a".repeat(40),
    },
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(rebindCalls, 1);
  assert.equal(repairs, 0);
  assert.equal(clears, 1);
  assert.equal(trustedReadDir, runDirPath("/target-primary", "run-1"),
    "candidate recovery reads the release-owned target store, never the separate candidate clone");
  assert.match(result.evidence, /rebind_tester_evidence_after_pr/);
});

test("rebind_tester_evidence_after_pr refreshes stale pre-PR trusted surface", async () => {
  const sha = "a".repeat(40);
  const verifierHash = "c".repeat(64);
  let computedFor: string | null = null;
  let persistedFor: string | null = null;
  let reboundTrustedSurface: { outcome?: string; candidate_sha?: string } | null = null;
  const freshDecision = {
    schema_version: 1,
    path_class_schema_version: 1,
    outcome: "passthrough",
    candidate_sha: sha,
    base_sha: "b".repeat(40),
    triggering_paths: [],
    classes: [],
    effective_verifier_hash: verifierHash,
    reason: { code: "no_trusted_paths_changed", summary: "passthrough" },
  } as const;
  const execute = realExecuteRecovery(cfg(), {
    resolveRunEngineIdentity: async () => persistedEngineIdentity(),
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: sha }) as never,
    readTrustedSurfaceDecision: async () => ({
      outcome: "blocked",
      candidate_sha: "0".repeat(40),
      effective_verifier_hash: null,
    }) as never,
    computeTrustedSurfaceFromObjectSource: async (input) => {
      computedFor = input.candidateSha;
      assert.equal(input.enginePin.commit_sha, PERSISTED_ENGINE.commit_sha);
      return freshDecision;
    },
    persistTrustedSurfaceDecision: async (_runDir, decision) => {
      persistedFor = decision.candidate_sha;
      return decision;
    },
    rebindTesterEvidenceAfterPr: async (input) => {
      reboundTrustedSurface = input.trustedSurface;
      return {
        ok: true,
        action: "bind",
        candidateSha: sha,
        evidence: { candidate_sha: sha } as never,
        suiteCommandInvoked: false,
      };
    },
    clearBlocked: async () => {},
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "stale pre-PR trusted surface",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "blocked",
      pr_head: sha,
    },
  });

  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });

  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(computedFor, sha);
  assert.equal(persistedFor, sha);
  assert.deepEqual(reboundTrustedSurface, freshDecision);
});

test("rebind_tester_evidence_after_pr passes pushed worktree HEAD for the mismatch guard", async () => {
  const pushed = "a".repeat(40);
  const prHead = "b".repeat(40);
  let receivedPushed: string | null | undefined;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitHead: async () => pushed,
    resolveRunEngineIdentity: async () => persistedEngineIdentity(),
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: prHead } as never),
    readTrustedSurfaceDecision: async () => ({
      outcome: "passthrough",
      candidate_sha: prHead,
      effective_verifier_hash: "c".repeat(64),
    }) as never,
    rebindTesterEvidenceAfterPr: async (input) => {
      receivedPushed = input.pushedHeadSha ?? null;
      return {
        ok: false,
        code: "tester_rebind_pr_head_mismatch",
        summary: `tester rebind: linked PR head ${prHead} disagrees with pushed head ${pushed}`,
        candidateSha: prHead,
        evidence: null,
        diagnostic: buildStageDiagnostic({
          reasonCode: "workflow-engine-defect",
          blockerKind: "harness-failure",
          reason: "mismatch",
          stage: "design-gate",
        }),
        blocker: {
          schema_version: 1,
          kind: "tester_rebind_blocker",
          code: "tester_rebind_pr_head_mismatch",
          candidate_sha: prHead,
          pr: 99,
          summary: "mismatch",
        },
      };
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: prHead,
    },
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(receivedPushed, pushed);
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /tester_rebind_pr_head_mismatch/);
});

test("rebind_tester_evidence_after_pr binds a subject-less passed record with pinned engine identity", async () => {
  const repoDir = fs.mkdtempSync(join(os.tmpdir(), "rebind-recovery-"));
  const runId = "1468-2026-09-05T21-00-00-000Z";
  const runDir = runDirPath(repoDir, runId);
  const sha = "a".repeat(40);
  const engine = {
    version: "1.40.1",
    root: "/skill/core",
    templates_fingerprint: "e".repeat(64),
    commit_sha: "f".repeat(40),
  };
  const engineFp = buildEngineFingerprint({
    version: engine.version,
    templates_fingerprint: engine.templates_fingerprint,
    commit_sha: engine.commit_sha,
  });
  const subjectless: TesterEvidence = {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: sha,
    run_id: runId,
    issue: 42,
    pr: null,
    worktree_id: "pipeline-42-wt",
    config_digest: computeConfigDigest({
      command_identity: "npm test",
      enabled: true,
      timeout: 300,
      max_output_chars: 4000,
    }),
    toolchain_fingerprint: { node: "v24.0.0", platform: "linux", arch: "x64" },
    started_at: "2026-09-05T20:00:00Z",
    ended_at: "2026-09-05T20:00:05Z",
    duration_ms: 5000,
    overall_status: "passed",
    commands: [
      {
        identity: "npm test",
        exit_code: 0,
        duration_ms: 4800,
        status: "passed",
        output_excerpt: "ok",
      },
    ],
    output_excerpt: "ok",
    producer: { component: "test-build-gate" },
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(testerEvidencePath(runDir), `${JSON.stringify(subjectless, null, 2)}\n`);
  fs.writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      issue: 42,
      repo: "acme/widget",
      profile: null,
      started_at: "2026-09-05T21:00:00Z",
      engine,
    }, null, 2)}\n`,
  );
  let receivedFingerprint: string | null | undefined;
  const execute = realExecuteRecovery(
    { ...cfg(), domain: "acme", repo_dir: repoDir },
    {
      getOnDiskForIssue: async () => null,
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: sha }) as never,
      readTrustedSurfaceDecision: async () => ({
        outcome: "passthrough",
        candidate_sha: sha,
        effective_verifier_hash: "c".repeat(64),
      }) as never,
      clearBlocked: async () => {},
      rebindTesterEvidenceAfterPr: async (input) => {
        receivedFingerprint = input.engineFingerprint;
        return rebindTesterEvidenceAfterPr(input);
      },
    },
  );
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: sha,
      subject_omitted_because_unobservable: true,
    },
  });
  try {
    const result = await execute({
      ...mechanicalInput(),
      action: "rebind_tester_evidence_after_pr",
      blockerClass: "workflow-engine-defect",
      diagnostic,
      evidence: {
        pr_number: 99,
        pipeline_run_id: runId,
        candidate_identity: `pr:99:run:${runId}`,
      },
    });
    assert.equal(result.succeeded, true, result.error ?? result.evidence);
    assert.equal(receivedFingerprint, engineFp);
    const stored = JSON.parse(fs.readFileSync(testerEvidencePath(runDir), "utf8")) as TesterEvidence;
    assert.equal(stored.evidence_subject?.schema_version, 1);
    assert.equal(stored.evidence_subject?.candidate_sha, sha);
    assert.equal(stored.evidence_subject?.engine_fingerprint, engineFp);
    assert.equal(stored.pr, 99);

    const successorDir = runDirPath(repoDir, "1468-2026-09-05T22-00-00-000Z");
    fs.mkdirSync(successorDir, { recursive: true });
    let reproduced = false;
    const successor = await rebindTesterEvidenceAfterPr({
      cfg: { ...cfg(), domain: "acme", repo_dir: repoDir },
      issueNumber: 42,
      stage: "design-gate",
      runDir: successorDir,
      prNumber: 99,
      prHeadSha: sha,
      trustedSurface: {
        outcome: "passthrough",
        candidate_sha: sha,
        effective_verifier_hash: "c".repeat(64),
      },
      domain: "acme",
      engineFingerprint: engineFp,
      resolvePriorShaMatchedTester: async () => stored,
      reproduce: async () => {
        reproduced = true;
        return { ok: false };
      },
    });
    assert.equal(successor.ok, true);
    if (successor.ok) {
      assert.equal(successor.action, "already-bound");
      assert.equal(successor.suiteCommandInvoked, false);
    }
    assert.equal(reproduced, false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("rebind_tester_evidence_after_pr bind uses blocked-run engine A after install updates to B", async () => {
  const repoDir = fs.mkdtempSync(join(os.tmpdir(), "rebind-engine-ab-"));
  const runId = "1468-2026-09-06T00-00-00-000Z";
  const runDir = runDirPath(repoDir, runId);
  const sha = "a".repeat(40);
  const engineA = {
    version: "1.40.1",
    root: "/skill/core",
    templates_fingerprint: "a".repeat(64),
    commit_sha: "1".repeat(40),
  };
  const engineB = {
    version: "1.41.0",
    root: "/skill/core",
    templates_fingerprint: "b".repeat(64),
    commit_sha: "2".repeat(40),
  };
  const fpA = buildEngineFingerprint({
    version: engineA.version,
    templates_fingerprint: engineA.templates_fingerprint,
    commit_sha: engineA.commit_sha,
  });
  const fpB = buildEngineFingerprint({
    version: engineB.version,
    templates_fingerprint: engineB.templates_fingerprint,
    commit_sha: engineB.commit_sha,
  });
  const subjectless: TesterEvidence = {
    schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
    kind: TESTER_EVIDENCE_KIND,
    candidate_sha: sha,
    run_id: runId,
    issue: 42,
    pr: null,
    worktree_id: "pipeline-42-wt",
    config_digest: computeConfigDigest({
      command_identity: "npm test",
      enabled: true,
      timeout: 300,
      max_output_chars: 4000,
    }),
    toolchain_fingerprint: { node: "v24.0.0", platform: "linux", arch: "x64" },
    started_at: "2026-09-05T20:00:00Z",
    ended_at: "2026-09-05T20:00:05Z",
    duration_ms: 5000,
    overall_status: "passed",
    commands: [
      {
        identity: "npm test",
        exit_code: 0,
        duration_ms: 4800,
        status: "passed",
        output_excerpt: "ok",
      },
    ],
    output_excerpt: "ok",
    producer: { component: "test-build-gate" },
  };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(testerEvidencePath(runDir), `${JSON.stringify(subjectless, null, 2)}\n`);
  fs.writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      issue: 42,
      repo: "acme/widget",
      profile: null,
      started_at: "2026-09-05T21:00:00Z",
      engine: engineA,
    }, null, 2)}\n`,
  );
  let receivedFingerprint: string | null | undefined;
  const execute = realExecuteRecovery(
    { ...cfg(), domain: "acme", repo_dir: repoDir },
    {
      getOnDiskForIssue: async () => null,
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: sha }) as never,
      readTrustedSurfaceDecision: async () => ({
        outcome: "passthrough",
        candidate_sha: sha,
        effective_verifier_hash: "c".repeat(64),
      }) as never,
      clearBlocked: async () => {},
      rebindTesterEvidenceAfterPr: async (input) => {
        receivedFingerprint = input.engineFingerprint;
        return rebindTesterEvidenceAfterPr(input);
      },
    },
  );
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: sha,
      subject_omitted_because_unobservable: true,
    },
  });
  try {
    assert.notEqual(fpA, fpB);
    const result = await execute({
      ...mechanicalInput(),
      action: "rebind_tester_evidence_after_pr",
      blockerClass: "workflow-engine-defect",
      diagnostic,
      evidence: {
        pr_number: 99,
        pipeline_run_id: runId,
        candidate_identity: `pr:99:run:${runId}`,
      },
    });
    assert.equal(result.succeeded, true, result.error ?? result.evidence);
    assert.equal(receivedFingerprint, fpA);
    assert.notEqual(receivedFingerprint, fpB);
    const stored = JSON.parse(fs.readFileSync(testerEvidencePath(runDir), "utf8")) as TesterEvidence;
    assert.equal(stored.evidence_subject?.engine_fingerprint, fpA);
    assert.notEqual(stored.evidence_subject?.engine_fingerprint, fpB);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("rebind_tester_evidence_after_pr recovery does not clear a block with B-bound reproduced evidence", async () => {
  const repoDir = fs.mkdtempSync(join(os.tmpdir(), "rebind-engine-ab-repro-"));
  const runId = "1468-2026-09-06T00-00-00-000Z";
  const runDir = runDirPath(repoDir, runId);
  const sha = "a".repeat(40);
  const engineA = {
    version: "1.40.1",
    root: "/skill/core",
    templates_fingerprint: "a".repeat(64),
    commit_sha: "1".repeat(40),
  };
  const engineB = {
    version: "1.41.0",
    root: "/skill/core",
    templates_fingerprint: "b".repeat(64),
    commit_sha: "2".repeat(40),
  };
  const fpA = buildEngineFingerprint({
    version: engineA.version,
    templates_fingerprint: engineA.templates_fingerprint,
    commit_sha: engineA.commit_sha,
  });
  const fpB = buildEngineFingerprint({
    version: engineB.version,
    templates_fingerprint: engineB.templates_fingerprint,
    commit_sha: engineB.commit_sha,
  });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    join(runDir, "run.json"),
    `${JSON.stringify({
      schema_version: 1,
      run_id: runId,
      issue: 42,
      repo: "acme/widget",
      profile: null,
      started_at: "2026-09-05T21:00:00Z",
      engine: engineA,
    }, null, 2)}\n`,
  );
  let clears = 0;
  const execute = realExecuteRecovery(
    { ...cfg(), domain: "acme", repo_dir: repoDir },
    {
      getOnDiskForIssue: async () => null,
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: sha }) as never,
      readTrustedSurfaceDecision: async () => ({
        outcome: "passthrough",
        candidate_sha: sha,
        effective_verifier_hash: "c".repeat(64),
      }) as never,
      clearBlocked: async () => {
        clears++;
      },
      rebindTesterEvidenceAfterPr: async (input) =>
        rebindTesterEvidenceAfterPr({
          ...input,
          reproduce: async ({ candidateSha, runDir: dest }) => {
            const reproduced: TesterEvidence = {
              schema_version: TESTER_EVIDENCE_SCHEMA_VERSION,
              kind: TESTER_EVIDENCE_KIND,
              candidate_sha: candidateSha,
              run_id: runId,
              issue: 42,
              pr: 99,
              worktree_id: "pipeline-42-wt",
              config_digest: computeConfigDigest({
                command_identity: "npm test",
                enabled: true,
                timeout: 300,
                max_output_chars: 4000,
              }),
              toolchain_fingerprint: { node: "v24.0.0", platform: "linux", arch: "x64" },
              started_at: "2026-09-05T20:00:00Z",
              ended_at: "2026-09-05T20:00:05Z",
              duration_ms: 5000,
              overall_status: "passed",
              commands: [
                {
                  identity: "npm test",
                  exit_code: 0,
                  duration_ms: 4800,
                  status: "passed",
                  output_excerpt: "ok",
                },
              ],
              output_excerpt: "ok",
              producer: { component: "test-build-gate" },
              evidence_subject: {
                schema_version: 1,
                domain: "acme",
                issue: 42,
                pr: 99,
                run_id: runId,
                candidate_sha: candidateSha,
                diff_hash: null,
                policy_hash: "e".repeat(64),
                engine_fingerprint: fpB,
                verifier_fingerprint: "c".repeat(64),
                required_evidence_set_revision: "f".repeat(64),
              },
            };
            fs.mkdirSync(dest, { recursive: true });
            fs.writeFileSync(
              testerEvidencePath(dest),
              `${JSON.stringify(reproduced, null, 2)}\n`,
            );
            return { ok: true, candidate_sha: candidateSha };
          },
        }),
    },
  );
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: sha,
      subject_omitted_because_unobservable: true,
    },
  });
  try {
    assert.notEqual(fpA, fpB);
    const result = await execute({
      ...mechanicalInput(),
      action: "rebind_tester_evidence_after_pr",
      blockerClass: "workflow-engine-defect",
      diagnostic,
      evidence: {
        pr_number: 99,
        pipeline_run_id: runId,
        candidate_identity: `pr:99:run:${runId}`,
      },
    });
    const stored = JSON.parse(fs.readFileSync(testerEvidencePath(runDir), "utf8")) as TesterEvidence;
    assert.notEqual(stored.evidence_subject?.engine_fingerprint, fpB);
    assert.equal(stored.evidence_subject?.engine_fingerprint, fpA);
    assert.equal(result.succeeded, true, result.error ?? result.evidence);
    assert.equal(clears, 1);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("rebind_tester_evidence_after_pr fail-closes when blocked-run engine identity is malformed", async () => {
  const malformed = [
    { ...PERSISTED_ENGINE, root: undefined },
    { ...PERSISTED_ENGINE, root: "   " },
    { ...PERSISTED_ENGINE, templates_fingerprint: "not-a-digest" },
    { ...PERSISTED_ENGINE, templates_fingerprint: "E".repeat(64) },
    { ...PERSISTED_ENGINE, commit_sha: "not-a-sha" },
    { ...PERSISTED_ENGINE, commit_sha: "deadbeef" },
  ];
  for (const engine of malformed) {
    let clears = 0;
    let rebindCalls = 0;
    const execute = realExecuteRecovery(cfg(), {
      clearBlocked: async () => { clears++; },
      resolveRunEngineIdentity: async () => engine as never,
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: "a".repeat(40) }) as never,
      readTrustedSurfaceDecision: async () => ({
        outcome: "passthrough",
        candidate_sha: "a".repeat(40),
        effective_verifier_hash: "c".repeat(64),
      }) as never,
      rebindTesterEvidenceAfterPr: async () => {
        rebindCalls++;
        return {
          ok: true,
          action: "bind",
          candidateSha: "a".repeat(40),
          evidence: { candidate_sha: "a".repeat(40) } as never,
          suiteCommandInvoked: false,
        };
      },
    });
    const diagnostic = buildStageDiagnostic({
      reasonCode: "workflow-engine-defect",
      blockerKind: "harness-failure",
      reason: "required implementation evidence role, observed missing",
      stage: "design-gate",
      evidenceOrdering: {
        kind: "tester_rebind_after_pr",
        required_role: "implementation",
        observed_role: "missing",
        trusted_surface_outcome: "passthrough",
        pr_head: "a".repeat(40),
      },
    });
    const result = await execute({
      ...mechanicalInput(),
      action: "rebind_tester_evidence_after_pr",
      blockerClass: "workflow-engine-defect",
      diagnostic,
    });
    assert.equal(result.succeeded, false, JSON.stringify(engine));
    assert.equal(clears, 0, JSON.stringify(engine));
    assert.equal(rebindCalls, 0, JSON.stringify(engine));
    assert.match(result.error ?? "", /engine identity is absent or malformed/);
  }
});

test("rebind_tester_evidence_after_pr fail-closes when blocked-run engine identity is absent", async () => {
  let clears = 0;
  let rebindCalls = 0;
  const execute = realExecuteRecovery(cfg(), {
    clearBlocked: async () => { clears++; },
    resolveRunEngineIdentity: async () => undefined,
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: "a".repeat(40) }) as never,
    readTrustedSurfaceDecision: async () => ({
      outcome: "passthrough",
      candidate_sha: "a".repeat(40),
      effective_verifier_hash: "c".repeat(64),
    }) as never,
    rebindTesterEvidenceAfterPr: async () => {
      rebindCalls++;
      return {
        ok: true,
        action: "bind",
        candidateSha: "a".repeat(40),
        evidence: { candidate_sha: "a".repeat(40) } as never,
        suiteCommandInvoked: false,
      };
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: "a".repeat(40),
    },
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.equal(clears, 0);
  assert.equal(rebindCalls, 0);
  assert.match(result.error ?? "", /engine identity is absent or malformed/);
});

test("rebind_tester_evidence_after_pr disabled-gate not-applicable does not report recovered", async () => {
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    clearBlocked: async () => { clears++; },
    resolveRunEngineIdentity: async () => persistedEngineIdentity(),
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: "a".repeat(40) }) as never,
    readTrustedSurfaceDecision: async () => ({
      outcome: "passthrough",
      candidate_sha: "a".repeat(40),
      effective_verifier_hash: "c".repeat(64),
    }) as never,
    rebindTesterEvidenceAfterPr: async () => ({
      ok: true,
      action: "not-applicable",
      candidateSha: "a".repeat(40),
      evidence: null,
      suiteCommandInvoked: false,
    }),
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "passthrough",
      pr_head: "a".repeat(40),
    },
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.equal(clears, 0);
  assert.match(result.error ?? "", /not-applicable/);
});

test("rebind_tester_evidence_after_pr fail-closed does not report recovered", async () => {
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    clearBlocked: async () => { clears++; },
    resolveRunEngineIdentity: async () => persistedEngineIdentity(),
    getPrForIssue: async () => 99,
    getPrDetail: async () => ({ number: 99, head_sha: "a".repeat(40) }) as never,
    readTrustedSurfaceDecision: async () => null,
    rebindTesterEvidenceAfterPr: async () => ({
      ok: false,
      code: "tester_rebind_trusted_surface_unobservable",
      summary: "tester rebind: trusted-surface is not passthrough/rebound with a trustworthy verifier pin",
      candidateSha: "a".repeat(40),
      evidence: null,
      diagnostic: buildStageDiagnostic({
        reasonCode: "workflow-engine-defect",
        blockerKind: "harness-failure",
        reason: "tester rebind failed",
        stage: "design-gate",
      }),
      blocker: {
        schema_version: 1,
        kind: "tester_rebind_blocker",
        code: "tester_rebind_trusted_surface_unobservable",
        candidate_sha: "a".repeat(40),
        pr: 99,
        summary: "blocked",
      },
    }),
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "required implementation evidence role, observed missing",
    stage: "design-gate",
    evidenceOrdering: {
      kind: "tester_rebind_after_pr",
      required_role: "implementation",
      observed_role: "missing",
      trusted_surface_outcome: "blocked",
      pr_head: "a".repeat(40),
    },
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "rebind_tester_evidence_after_pr",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.equal(clears, 0);
  assert.match(result.error ?? "", /tester_rebind_trusted_surface_unobservable/);
});

test("DEFAULT_RECOVERY_POLICY recipe order: review-findings unlink before repair (#1060)", async () => {
  const { DEFAULT_RECOVERY_POLICY } = await import("../scripts/loop/recovery.ts");
  const recipes = DEFAULT_RECOVERY_POLICY["review-findings"].recipes;
  const unlinkIdx = recipes.indexOf("unlink_engine_scratch");
  const repairIdx = recipes.indexOf("repair_pipeline_item");
  assert.ok(unlinkIdx >= 0, "unlink_engine_scratch must be first prep for findings");
  assert.ok(repairIdx >= 0, "repair_pipeline_item must remain configured");
  assert.ok(unlinkIdx < repairIdx, `got ${recipes.join(" → ")}`);
});

test("unlink_engine_scratch #1060: review-findings prep unlinks scratch, never clears blocked, never succeeds", async () => {
  let clears = 0;
  let cleaned = false;
  const cleanedArgs: string[][] = [];
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/599", slug: "599-x", branch: "pipeline/599-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return {
          stdout: cleaned ? "" : "?? artifacts/challenge-response-599.json\n",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "clean") {
        cleanedArgs.push(args as string[]);
        cleaned = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({
      number: 599,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/599",
      labels: ["blocked", "pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    onEngineClassRecovered: async () => {
      throw new Error("sibling filer must not run for findings prep");
    },
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "2 unresolved findings at d0c0d39",
    stage: "pre-merge",
  });
  const result = await execute({
    ...mechanicalInput(),
    itemId: "599",
    action: "unlink_engine_scratch",
    blockerClass: "review-findings",
    diagnostic,
  });
  assert.equal(result.succeeded, false, "prep must not count as findings recovery success");
  assert.match(result.error ?? result.evidence, /prep-complete for review-findings/);
  assert.match(result.error ?? result.evidence, /challenge-response-599/);
  assert.equal(clears, 0, "must not clear blocked for findings prep unlink");
  assert.ok(cleanedArgs.some((a) => a.includes("artifacts/challenge-response-599.json")));
});

test("unlink_engine_scratch #1060: review-findings no-scratch is not-applicable fall-through", async () => {
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    clearBlocked: async () => {
      clears++;
    },
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "findings without scratch",
    stage: "pre-merge",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "review-findings",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /prep not-applicable for review-findings|trying next recipe/);
  assert.equal(clears, 0);
});

test("unlink_engine_scratch #1060: review-findings product dirt fails closed without clear", async () => {
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return {
          stdout: "?? artifacts/challenge-response-1.json\n M core/scripts/foo.ts\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    clearBlocked: async () => {
      clears++;
    },
  });
  const diagnostic = buildStageDiagnostic({
    blockerKind: "review-findings",
    reason: "mixed dirt under findings",
    stage: "pre-merge",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "review-findings",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /product dirt/);
  assert.equal(clears, 0);
});

// #1021: recover → live sibling coupling (injectable onEngineClassRecovered)

test("unlink_engine_scratch (#1021): successful recover invokes live sibling filer once", async () => {
  let clears = 0;
  let statusPhase = 0;
  const siblingCalls: Array<{ issueNumber: number; evidenceKey: string; action: string }> = [];
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1013", slug: "1013-x", branch: "pipeline/1013-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        statusPhase += 1;
        return {
          stdout: statusPhase === 1 ? "?? artifacts/challenge-response-1013.json\n" : "",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "clean") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({
      number: 1013,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/1013",
      labels: clears === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    onEngineClassRecovered: async (input) => {
      siblingCalls.push(input);
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "scratch porcelain blocked factory",
    evidenceKey: "ek-1013-scratch",
  });
  const result = await execute({
    ...mechanicalInput(),
    itemId: "1013",
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(clears, 1);
  assert.equal(siblingCalls.length, 1, "filer must be invoked exactly once after recover");
  assert.equal(siblingCalls[0]!.issueNumber, 1013);
  assert.equal(siblingCalls[0]!.evidenceKey, "ek-1013-scratch");
  assert.equal(siblingCalls[0]!.action, "unlink_engine_scratch");
});

test("unlink_engine_scratch exact-candidate FRG suppression skips the live sibling filer", async (t) => {
  const prior = process.env.PIPELINE_SUPPRESS_AUTO_FILE;
  process.env.PIPELINE_SUPPRESS_AUTO_FILE = "1";
  t.after(() => {
    if (prior === undefined) delete process.env.PIPELINE_SUPPRESS_AUTO_FILE;
    else process.env.PIPELINE_SUPPRESS_AUTO_FILE = prior;
  });
  let statusPhase = 0;
  let siblingCalls = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/1013", slug: "1013-x", branch: "pipeline/1013-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") return { stdout: statusPhase++ === 0 ? "?? artifacts/challenge-response-1013.json\n" : "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({ number: 1013, type: "issue", title: "t", body: "", state: "open", url: "u", labels: [] }),
    onEngineClassRecovered: async () => { siblingCalls++; },
  });
  const result = await execute({
    ...mechanicalInput(), itemId: "1013", action: "unlink_engine_scratch", blockerClass: "workflow-engine-defect",
    diagnostic: buildStageDiagnostic({ reasonCode: "workflow-engine-defect", blockerKind: "harness-failure", reason: "scratch" }),
  });
  assert.equal(result.succeeded, true, result.error);
  assert.equal(siblingCalls, 0);
});

test("unlink_engine_scratch (#1021): sibling filer throw does not reverse recover", async () => {
  let clears = 0;
  let statusPhase = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        statusPhase += 1;
        return {
          stdout: statusPhase === 1 ? "?? artifacts/challenge-response-1.json\n" : "",
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "clean") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    getIssueDetail: async () => ({
      number: 42,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example.test/42",
      labels: clears === 0 ? ["blocked", "pipeline:pre-merge"] : ["pipeline:pre-merge"],
    }),
    clearBlocked: async () => {
      clears++;
    },
    onEngineClassRecovered: async () => {
      throw new Error("gh issue create failed: simulated");
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "scratch",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, true, "sibling failure must not flip recover to failed");
  assert.equal(clears, 1, "blocked clear must stand after sibling throw");
});

test("unlink_engine_scratch (#1021): product dirt does not invoke live sibling filer", async () => {
  let siblingCalls = 0;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => ({ path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never),
    gitInWorktree: async (_path, args) => {
      if (args[0] === "status") {
        return {
          stdout: "?? artifacts/challenge-response-1.json\n M core/scripts/foo.ts\n",
          stderr: "",
          code: 0,
        };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    clearBlocked: async () => {},
    onEngineClassRecovered: async () => {
      siblingCalls++;
    },
  });
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "mixed dirt",
  });
  const result = await execute({
    ...mechanicalInput(),
    action: "unlink_engine_scratch",
    blockerClass: "workflow-engine-defect",
    diagnostic,
  });
  assert.equal(result.succeeded, false);
  assert.match(result.error ?? "", /product dirt/);
  assert.equal(siblingCalls, 0, "product dirt must never file a live sibling");
});

test("unlink_engine_scratch (#1021): human-authority path does not invoke live sibling filer", async () => {
  let siblingCalls = 0;
  let mutated = false;
  const execute = realExecuteRecovery(cfg(), {
    getOnDiskForIssue: async () => {
      mutated = true;
      return { path: "/wt/42", slug: "42-x", branch: "pipeline/42-x" } as never;
    },
    clearBlocked: async () => {
      mutated = true;
    },
    onEngineClassRecovered: async () => {
      siblingCalls++;
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
    action: "unlink_engine_scratch",
    blockerClass: "specification-decision",
    diagnostic: human,
  });
  assert.equal(result.succeeded, false);
  assert.equal(siblingCalls, 0, "human-decision must never file a live sibling");
  assert.equal(mutated, false, "human-authority must not mutate before reject");
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
