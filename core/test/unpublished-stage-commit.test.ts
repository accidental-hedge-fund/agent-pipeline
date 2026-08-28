// #1272 unpublished stage-commit publish: classifier, recipe identity,
// executor, recover-parked, park-release, timeout-park drift. Injected deps
// only — no real network, git, or subprocess.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  authorshipHintFromRound,
  blockerKindFromComments,
  classifyNeverPushedLocalOnly,
  classifyPipelineAuthoredTip,
  classifyPublishableUnpublishedStageCommit,
  executePublishUnpublishedStageCommit,
  inspectPublishableUnpublishedStageCommit,
  isManagedIssueBranch,
  isPostPrResidualReviewStage,
  isPrePrEngineDefectPark,
  isUnguardedTimeoutParkSource,
  PUBLISH_UNPUBLISHED_STAGE_COMMIT,
  resolveTimeoutParkForUnpublishedCommit,
  SALVAGE_SUBJECT_PREFIX,
} from "../scripts/unpublished-stage-commit.ts";
import { DEFAULT_RECOVERY_POLICY } from "../scripts/loop/recovery.ts";
import { RECOVERY_RECIPES, isRecoveryRecipe } from "../scripts/loop/types.ts";
import { realExecuteRecovery } from "../scripts/pipeline.ts";
import { buildStageDiagnostic } from "../scripts/stage-diagnostic.ts";
import {
  defaultTryPublishUnpublishedStageCommit,
  runRecoverParked,
  type RecoverParkedDeps,
} from "../scripts/recover-parked.ts";
import { evaluateRemoveSafety, releaseWorktreeForParkedIssue } from "../scripts/worktree.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";
import { withTrailers } from "../scripts/traceability.ts";

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "owner/repo", repo_dir: "/repo", base_branch: "main", domain: "test" };
}

function salvageSubject(n: number): string {
  return `${SALVAGE_SUBJECT_PREFIX}${n})`;
}

function salvageBody(stageLabel: string): string {
  return `Pipeline-salvaged commit: the ${stageLabel} harness completed work in the worktree.`;
}

function facts(overrides: Partial<Parameters<typeof classifyPublishableUnpublishedStageCommit>[0]> = {}) {
  return {
    issueNumber: 268,
    headBranch: "pipeline/268-use-case-closed",
    porcelain: "",
    commitsAheadOfBase: true,
    linkedOpenPr: false,
    tipSubject: salvageSubject(268),
    tipBody: salvageBody("implement"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1.1 Classifier
// ---------------------------------------------------------------------------

test("classifier: salvage tip on managed branch is publishable", () => {
  const c = classifyPublishableUnpublishedStageCommit(facts());
  assert.deepEqual(c, { publishable: true, tipKind: "salvage" });
});

test("classifier: checkpoint tip (owned-harness-leftover body) is publishable", () => {
  const c = classifyPublishableUnpublishedStageCommit(
    facts({ tipBody: salvageBody("owned-harness-leftover") }),
  );
  assert.deepEqual(c, { publishable: true, tipKind: "checkpoint" });
});

test("classifier: implement tip with issue trailers is publishable", () => {
  const body = withTrailers("feat: close use case (#268)\n\nImplement the stage.", 268, "268/run");
  const nl = body.indexOf("\n");
  const c = classifyPublishableUnpublishedStageCommit(
    facts({
      tipSubject: body.slice(0, nl),
      tipBody: body.slice(nl + 1),
    }),
  );
  assert.deepEqual(c, { publishable: true, tipKind: "implement" });
});

test("classifier: unknown product dirt refuses", () => {
  const c = classifyPublishableUnpublishedStageCommit(facts({ porcelain: " M core/secret.ts\n" }));
  assert.equal(c.publishable, false);
  if (!c.publishable) assert.match(c.reason, /unknown product dirt/);
});

test("classifier: engine scratch porcelain is still publishable", () => {
  const c = classifyPublishableUnpublishedStageCommit(facts({ porcelain: "?? tasks/todo.md\n" }));
  assert.equal(c.publishable, true);
});

test("classifier: unmarked operator tip refuses", () => {
  const c = classifyPublishableUnpublishedStageCommit(
    facts({ tipSubject: "wip: my local edits", tipBody: "no trailers" }),
  );
  assert.equal(c.publishable, false);
  if (!c.publishable) assert.match(c.reason, /not pipeline-authored/);
});

test("classifier: existing open PR refuses", () => {
  const c = classifyPublishableUnpublishedStageCommit(facts({ linkedOpenPr: true }));
  assert.equal(c.publishable, false);
  if (!c.publishable) assert.match(c.reason, /linked open PR/);
});

test("classifier: non-managed branch refuses", () => {
  assert.equal(isManagedIssueBranch("main", 268), false);
  const c = classifyPublishableUnpublishedStageCommit(facts({ headBranch: "main" }));
  assert.equal(c.publishable, false);
});

test("classifier: authorshipHint from checkpoint counts when log is empty", () => {
  const c = classifyPublishableUnpublishedStageCommit(
    facts({ tipSubject: "", tipBody: "", authorshipHint: "checkpoint" }),
  );
  assert.deepEqual(c, { publishable: true, tipKind: "checkpoint" });
});

test("classifyPipelineAuthoredTip: salvage vs checkpoint vs implement vs unmarked", () => {
  assert.equal(classifyPipelineAuthoredTip(1, salvageSubject(1), salvageBody("implement")), "salvage");
  assert.equal(
    classifyPipelineAuthoredTip(1, salvageSubject(1), salvageBody("owned-harness-leftover")),
    "checkpoint",
  );
  assert.equal(
    classifyPipelineAuthoredTip(1, "feat: x", "Issue: #1\nPipeline-Run: 1/t"),
    "implement",
  );
  assert.equal(classifyPipelineAuthoredTip(1, "docs: readme", "no trailers"), null);
});

// ---------------------------------------------------------------------------
// 1.2 Recipe identity locked string
// ---------------------------------------------------------------------------

test("recipe id publish_unpublished_stage_commit is locked across catalogue, policy, recover-parked", async () => {
  assert.equal(PUBLISH_UNPUBLISHED_STAGE_COMMIT, "publish_unpublished_stage_commit");
  assert.equal(isRecoveryRecipe(PUBLISH_UNPUBLISHED_STAGE_COMMIT), true);
  assert.ok(RECOVERY_RECIPES.includes(PUBLISH_UNPUBLISHED_STAGE_COMMIT));
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  assert.ok(recipes.includes(PUBLISH_UNPUBLISHED_STAGE_COMMIT));
  const recoverSrc = await readFile(
    fileURLToPath(new URL("../scripts/recover-parked.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    recoverSrc.includes("publish_unpublished_stage_commit") ||
      recoverSrc.includes("PUBLISH_UNPUBLISHED_STAGE_COMMIT"),
    "recover-parked must name the recipe",
  );
  const typesSrc = await readFile(
    fileURLToPath(new URL("../scripts/loop/types.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(typesSrc.includes('"publish_unpublished_stage_commit"'));
});

test("policy-order: unlink, checkpoint, publish, then repair; repair is not first", () => {
  const recipes = DEFAULT_RECOVERY_POLICY["workflow-engine-defect"].recipes;
  const unlink = recipes.indexOf("unlink_engine_scratch");
  const checkpoint = recipes.indexOf("checkpoint_owned_harness_dirt");
  const publish = recipes.indexOf("publish_unpublished_stage_commit");
  const repair = recipes.indexOf("repair_pipeline_item");
  assert.ok(unlink < checkpoint && checkpoint < publish && publish < repair, recipes.join(" → "));
  assert.notEqual(recipes[0], "repair_pipeline_item");
});

// ---------------------------------------------------------------------------
// Timeout park consult
// ---------------------------------------------------------------------------

test("timeout park: checkpoint + salvaged false publishes", () => {
  const d = resolveTimeoutParkForUnpublishedCommit(facts(), {
    salvaged: false,
    ownershipCheckpointed: true,
    ownershipCheckpointFailed: false,
  });
  assert.equal(d.action, "publish");
  assert.equal(authorshipHintFromRound({ salvaged: false, ownershipCheckpointed: true }), "checkpoint");
});

test("timeout park: no recovered work blocks", () => {
  const d = resolveTimeoutParkForUnpublishedCommit(facts({ tipSubject: "", tipBody: "" }), {
    salvaged: false,
    ownershipCheckpointed: false,
    ownershipCheckpointFailed: false,
  });
  assert.equal(d.action, "block");
});

test("timeout park: classifier-proven implement tip publishes without salvage/checkpoint flags", () => {
  const body = withTrailers("feat: close use case (#268)\n\nImplement the stage.", 268, "268/run");
  const nl = body.indexOf("\n");
  const d = resolveTimeoutParkForUnpublishedCommit(
    facts({
      tipSubject: body.slice(0, nl),
      tipBody: body.slice(nl + 1),
    }),
    {
      salvaged: false,
      ownershipCheckpointed: false,
      ownershipCheckpointFailed: false,
    },
  );
  assert.equal(d.action, "publish");
  assert.equal(d.classification.publishable, true);
  if (d.classification.publishable) assert.equal(d.classification.tipKind, "implement");
});

test("timeout park: failed checkpoint blocks", () => {
  const d = resolveTimeoutParkForUnpublishedCommit(facts(), {
    salvaged: false,
    ownershipCheckpointed: false,
    ownershipCheckpointFailed: true,
  });
  assert.equal(d.action, "block");
});

// ---------------------------------------------------------------------------
// 3.1 / 3.2 Executor
// ---------------------------------------------------------------------------

test("executor: does not force-push, does not triage or raw issue-edit, transitions via resume", async () => {
  const pushArgs: string[][] = [];
  const labels: string[] = [];
  const transitions: Array<{ from: string; to: string }> = [];
  let createdPr: { title: string; body: string } | null = null;
  const result = await executePublishUnpublishedStageCommit(cfg(), 268, {
    inspect: async () => ({
      facts: facts(),
      classification: { publishable: true as const, tipKind: "salvage" as const },
      worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
    }),
    resumeFromImplementing: async (_c, _n, wt, opts, resumeDeps) => {
      assert.equal(wt.branch, "pipeline/268-x");
      assert.match(opts.prBody, /Closes #268/);
      const git = (resumeDeps as { gitInWorktree?: typeof import("../scripts/worktree.ts").gitInWorktree })
        ?.gitInWorktree;
      if (git) {
        await git(wt.path, ["push", "-u", "origin", wt.branch], { ignoreFailure: true });
      }
      createdPr = { title: opts.prTitle, body: opts.prBody };
      const trans = (resumeDeps as { transition?: typeof import("../scripts/gh.ts").transition })?.transition;
      if (trans) await trans(cfg(), 268, "implementing", "design-gate", opts.transitionMessage(42));
      return { advanced: true, from: "implementing", to: "design-gate", summary: "PR #42 opened" };
    },
    resumeDeps: {
      gitInWorktree: async (_p: string, args: string[]) => {
        pushArgs.push([...args]);
        return { stdout: "", stderr: "", code: 0 };
      },
      transition: async (_c: unknown, _n: unknown, from: string, to: string) => {
        transitions.push({ from, to });
      },
    },
    getIssueDetail: async () =>
      ({ title: "use case closed", body: "", comments: [], number: 268, labels, state: "open" }) as never,
    createPr: async (_c, spec) => {
      createdPr = spec;
      return 42;
    },
    clearBlocked: async () => {
      labels.push("cleared");
    },
    setBlocked: async () => {
      throw new Error("executor must not setBlocked on success");
    },
    probeImplementDeliverable: async () => ({ present: true }),
  });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.ok(!pushArgs.some((a) => a.includes("--force") || a.includes("--force-with-lease")));
  assert.ok(createdPr);
  assert.match(createdPr!.body, /Closes #268/);
  assert.deepEqual(transitions, [{ from: "implementing", to: "design-gate" }]);
  assert.ok(labels.includes("cleared"));
  assert.doesNotMatch(result.evidence, /needs-human|human-decision-required|triage/);
});

test("executor: push failure parks as harness-failure and does not mint needs-human", async () => {
  const kinds: string[] = [];
  const result = await executePublishUnpublishedStageCommit(cfg(), 268, {
    inspect: async () => ({
      facts: facts(),
      classification: { publishable: true as const, tipKind: "checkpoint" as const },
      worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
    }),
    resumeFromImplementing: async (_c, _n, _wt, _opts, resumeDeps) => {
      const blocker = (resumeDeps as { setBlocked?: (...args: never[]) => Promise<void> }).setBlocked;
      await blocker?.(cfg() as never, 268 as never, "origin rejected" as never, "implementing" as never, "push-failed" as never);
      return { advanced: false, status: "blocked", reason: "origin rejected", blockerKind: "push-failed" };
    },
    setBlocked: async (_c, _n, _reason, _stage, kind) => {
      kinds.push(kind);
    },
    probeImplementDeliverable: async () => ({ present: true }),
  });
  assert.equal(result.succeeded, false);
  assert.ok(kinds.includes("harness-failure") || /harness-failure/.test(result.error ?? ""));
  assert.ok(!kinds.includes("needs-human"));
  assert.doesNotMatch(result.error ?? "", /needs-human|human-decision-required/);
});

test("executor: missing deliverable probe refuses publish", async () => {
  let resumed = 0;
  const result = await executePublishUnpublishedStageCommit(cfg(), 268, {
    inspect: async () => ({
      facts: facts(),
      classification: { publishable: true as const, tipKind: "salvage" as const },
      worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
    }),
    resumeFromImplementing: async () => {
      resumed++;
      return { advanced: true, from: "implementing", to: "review-1", summary: "no" };
    },
  });
  assert.equal(result.succeeded, false);
  assert.equal(resumed, 0);
  assert.match(result.error ?? "", /probe required/);
});

test("executor: unsatisfied deliverable does not publish", async () => {
  let resumed = 0;
  const result = await executePublishUnpublishedStageCommit(cfg(), 268, {
    inspect: async () => ({
      facts: facts(),
      classification: { publishable: true as const, tipKind: "salvage" as const },
      worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
    }),
    resumeFromImplementing: async () => {
      resumed++;
      return { advanced: true, from: "implementing", to: "review-1", summary: "no" };
    },
    probeImplementDeliverable: async () => ({ present: false }),
  });
  assert.equal(result.succeeded, false);
  assert.equal(resumed, 0);
  assert.match(result.error ?? "", /deliverable unsatisfied/);
});

test("inspect: injectable git/gh, no network", async () => {
  const inspected = await inspectPublishableUnpublishedStageCommit(cfg(), 268, {
    getOnDiskForIssue: async () => ({ path: "/wt/268", slug: "268-x" }),
    gitInWorktree: async (_p, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "pipeline/268-x\n", stderr: "", code: 0 };
      if (args[0] === "log") {
        return { stdout: `${salvageSubject(268)}\n\n${salvageBody("implement")}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    hasCommitsAhead: async () => true,
    getPrForIssue: async () => null,
  });
  assert.equal(inspected.classification.publishable, true);
});

test("inspect: PR lookup error without fallback is indeterminate, not no-PR", async () => {
  const inspected = await inspectPublishableUnpublishedStageCommit(cfg(), 268, {
    getOnDiskForIssue: async () => ({ path: "/wt/268", slug: "268-x" }),
    gitInWorktree: async (_p, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "pipeline/268-x\n", stderr: "", code: 0 };
      if (args[0] === "log") {
        return { stdout: `${salvageSubject(268)}\n\n${salvageBody("implement")}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    hasCommitsAhead: async () => true,
    getPrForIssue: async () => {
      throw new Error("API 401");
    },
  });
  assert.equal(inspected.facts?.prLookupFailed, true);
  assert.equal(inspected.classification.publishable, false);
  if (!inspected.classification.publishable) {
    assert.match(inspected.classification.reason, /indeterminate/);
  }
});

test("inspect: PR lookup error with successful branch fallback is not indeterminate", async () => {
  const inspected = await inspectPublishableUnpublishedStageCommit(cfg(), 268, {
    getOnDiskForIssue: async () => ({ path: "/wt/268", slug: "268-x" }),
    gitInWorktree: async (_p, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") return { stdout: "pipeline/268-x\n", stderr: "", code: 0 };
      if (args[0] === "log") {
        return { stdout: `${salvageSubject(268)}\n\n${salvageBody("implement")}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    hasCommitsAhead: async () => true,
    getPrForIssue: async () => {
      throw new Error("API 401");
    },
    getPrForBranch: async () => null,
  });
  assert.equal(inspected.facts?.prLookupFailed, false);
  assert.equal(inspected.classification.publishable, true);
});

test("classifier: prLookupFailed refuses even when linkedOpenPr is false", () => {
  const c = classifyPublishableUnpublishedStageCommit(facts({ prLookupFailed: true, linkedOpenPr: false }));
  assert.equal(c.publishable, false);
  if (!c.publishable) assert.match(c.reason, /indeterminate/);
});

// ---------------------------------------------------------------------------
// 3.4 realExecuteRecovery
// ---------------------------------------------------------------------------

function mechanicalInput() {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "timed out after 2405s",
    stage: "implementing",
  });
  return {
    runId: "loop-1",
    itemId: "268",
    blockerClass: "workflow-engine-defect" as const,
    attemptId: "attempt-1",
    candidateIdentity: `repo=owner/repo|head=${"a".repeat(40)}|attempt=0`,
    action: "publish_unpublished_stage_commit" as const,
    diagnostic,
    evidence: { pr_number: null, pipeline_run_id: "run-1", candidate_identity: "issue:268" },
  };
}

test("realExecuteRecovery: publish_unpublished_stage_commit succeeds without repair or human hold", async () => {
  let repairs = 0;
  let clears = 0;
  const execute = realExecuteRecovery(cfg(), {
    repairPipelineItem: async () => {
      repairs++;
      return { succeeded: true, evidence: "should not run" };
    },
    clearBlocked: async () => {
      clears++;
    },
    getOnDiskForIssue: async () => ({ path: "/wt/268", slug: "268-x" }) as never,
    gitInWorktree: async () => ({ stdout: "", stderr: "", code: 0 }),
    publishUnpublished: {
      inspect: async () => ({
        facts: facts(),
        classification: { publishable: true as const, tipKind: "checkpoint" as const },
        worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
      }),
      resumeFromImplementing: async () => ({
        advanced: true,
        from: "implementing",
        to: "design-gate",
        summary: "PR #9",
      }),
      probeImplementDeliverable: async () => ({ present: true }),
    },
  });
  const result = await execute(mechanicalInput());
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.equal(repairs, 0);
  assert.equal(clears, 1);
  assert.doesNotMatch(result.evidence, /needs-human|human_intervention/);
});

test("realExecuteRecovery: fix-round unpublished timeout claims the same recipe (not implementing-only)", async () => {
  const diagnostic = buildStageDiagnostic({
    reasonCode: "workflow-engine-defect",
    blockerKind: "harness-failure",
    reason: "timed out after 1200s",
    stage: "fix-1",
  });
  const execute = realExecuteRecovery(cfg(), {
    repairPipelineItem: async () => ({ succeeded: true, evidence: "no" }),
    clearBlocked: async () => {},
    publishUnpublished: {
      inspect: async () => ({
        facts: facts(),
        classification: { publishable: true as const, tipKind: "salvage" as const },
        worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
      }),
      resumeFromImplementing: async () => ({
        advanced: true,
        from: "implementing",
        to: "review-1",
        summary: "PR #9",
      }),
      probeImplementDeliverable: async () => ({ present: true }),
    },
  });
  const result = await execute({ ...mechanicalInput(), diagnostic });
  assert.equal(result.succeeded, true, result.error ?? result.evidence);
  assert.match(result.evidence, /publish_unpublished_stage_commit/);
});

// ---------------------------------------------------------------------------
// 4. recover-parked
// ---------------------------------------------------------------------------

function recoverHarness(state: {
  labels: string[];
  pr?: number | null;
  publish?: "cleared" | "no-op" | "keep";
}) {
  const labels = [...state.labels];
  let reentries = 0;
  const comments: Array<{ author: string; body: string; createdAt: string }> = [
    {
      author: "bot",
      body: "## Pipeline: Blocked\n\n<!-- pipeline-blocker-kind: harness-failure -->",
      createdAt: "2026-08-14T00:00:00Z",
    },
  ];
  const deps: RecoverParkedDeps = {
    withIssueLock: async (_d, _i, fn) => fn(),
    getIssueDetail: async () => ({
      number: 268,
      type: "issue",
      title: "t",
      body: "",
      state: "open",
      url: "https://example/268",
      labels,
      comments,
    }),
    getPrForIssue: async () => (state.pr === undefined ? 99 : state.pr),
    getPrDetail: async () => ({ head_sha: "a".repeat(40), number: state.pr ?? 0 }),
    postComment: async () => {},
    clearBlocked: async () => {
      const i = labels.indexOf("blocked");
      if (i >= 0) labels.splice(i, 1);
    },
    getGhActor: async () => "bot",
    now: () => new Date("2026-08-14T16:51:26Z"),
    reenterAdvance: async () => {
      reentries++;
    },
    log: () => {},
    tryUnlinkEngineScratch: async () => ({ kind: "no-op", reason: "no scratch" }),
    tryResumeStaleBlocked: async () => ({ kind: "no-op", reason: "not eligible" }),
    tryPublishUnpublishedStageCommit: async () => {
      if (state.publish === "cleared") {
        const i = labels.indexOf("blocked");
        if (i >= 0) labels.splice(i, 1);
        return { kind: "cleared", reason: "published unpublished commit" };
      }
      if (state.publish === "keep") return { kind: "keep", reason: "push failed" };
      return { kind: "no-op", reason: "not publishable" };
    },
  };
  return {
    deps,
    get reentries() {
      return reentries;
    },
  };
}

test("recover-parked: unpublished salvage park publishes instead of fail-closed", async () => {
  const h = recoverHarness({
    labels: ["pipeline:implementing", "blocked"],
    pr: null,
    publish: "cleared",
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.equal(result.status, "deterministic-cleared");
  assert.doesNotMatch(result.message, /no linked open PR/);
  assert.equal(result.reentered, true);
  assert.equal(h.reentries, 1);
});

test("recover-parked: plan-review engine-defect without PR re-enters", async () => {
  const h = recoverHarness({
    labels: ["pipeline:plan-review", "blocked"],
    pr: null,
    publish: "no-op",
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.notEqual(result.status, "fail-closed");
  assert.doesNotMatch(result.message, /no linked open PR; keep park/);
  assert.equal(result.status, "recovered");
  assert.equal(result.reentered, true);
});

test("recover-parked: failed publication keeps the park instead of re-entering", async () => {
  const h = recoverHarness({
    labels: ["pipeline:implementing", "blocked"],
    pr: null,
    publish: "keep",
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.equal(result.status, "still-parked");
  assert.match(result.message, /push failed/);
  assert.doesNotMatch(result.message, /no linked open PR; keep park/);
  assert.equal(h.reentries, 0);
  assert.ok(h.deps);
});

test("recover-parked: dry-run does not invoke the publish executor", async () => {
  let executeCalls = 0;
  const h = recoverHarness({
    labels: ["pipeline:implementing", "blocked"],
    pr: null,
    publish: "cleared",
  });
  const result = await runRecoverParked(
    cfg(),
    268,
    { dryRun: true },
    {
      ...h.deps,
      tryPublishUnpublishedStageCommit: async () => {
        executeCalls++;
        return { kind: "cleared", reason: "should not run" };
      },
      publishUnpublishedDeps: {
        inspect: async () => ({
          facts: facts(),
          classification: { publishable: true as const, tipKind: "salvage" as const },
          worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
        }),
      },
    },
  );
  assert.equal(executeCalls, 0);
  assert.equal(result.status, "still-parked");
  assert.match(result.message, /dry-run: would publish/);
  assert.equal(result.reentered, undefined);
});

test("recover-parked: missing blocker kind does not auto-re-enter a pre-PR park", async () => {
  const h = recoverHarness({
    labels: ["pipeline:implementing", "blocked"],
    pr: null,
    publish: "no-op",
  });
  h.deps.getIssueDetail = async () => ({
    number: 268,
    type: "issue",
    title: "t",
    body: "",
    state: "open",
    url: "https://example/268",
    labels: ["pipeline:implementing", "blocked"],
    comments: [],
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.equal(result.status, "fail-closed");
  assert.match(result.message, /no linked open PR; keep park/);
  assert.equal(h.reentries, 0);
});

test("defaultTry: PR lookup failure keeps the park instead of no-op re-entry", async () => {
  const result = await defaultTryPublishUnpublishedStageCommit(cfg(), 268, {} as never, {
    inspect: async () => ({
      facts: { ...facts(), prLookupFailed: true },
      classification: { publishable: false as const, reason: "PR linkage is indeterminate" },
      worktree: { path: "/wt/268", slug: "268-x", branch: "pipeline/268-x" },
    }),
    execute: async () => {
      throw new Error("execute must not run when PR linkage is indeterminate");
    },
  });
  assert.equal(result.kind, "keep");
  assert.match(result.reason, /indeterminate/);
});

test("recover-parked: residual-review park without PR still fail-closes", async () => {
  const h = recoverHarness({
    labels: ["pipeline:review-1", "blocked"],
    pr: null,
    publish: "no-op",
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.equal(result.status, "fail-closed");
  assert.match(result.message, /no linked open PR; keep park/);
  assert.equal(h.reentries, 0);
});

test("recover-parked: successful publish does not consume senior fingerprint", async () => {
  const h = recoverHarness({
    labels: ["pipeline:implementing", "blocked"],
    pr: null,
    publish: "cleared",
  });
  const result = await runRecoverParked(cfg(), 268, {}, h.deps);
  assert.equal(result.status, "deterministic-cleared");
  assert.equal(result.fingerprintId, undefined);
  assert.equal(result.overridesApplied, undefined);
});

test("isPrePrEngineDefectPark / residual-review stage helpers", () => {
  assert.equal(isPrePrEngineDefectPark({ stage: "plan-review", blockerKind: "harness-failure" }), true);
  assert.equal(isPrePrEngineDefectPark({ stage: "review-1", blockerKind: "harness-failure" }), false);
  assert.equal(isPrePrEngineDefectPark({ stage: "implementing", needsHumanLabel: true }), false);
  assert.equal(isPrePrEngineDefectPark({ stage: "implementing" }), false);
  assert.equal(isPrePrEngineDefectPark({ stage: "implementing", blockerKind: null }), false);
  assert.equal(isPrePrEngineDefectPark({ stage: "planning", blockerKind: "unknown-kind" }), false);
  assert.equal(isPrePrEngineDefectPark({ stage: "plan-review", blockerKind: "environment-auth" }), true);
  assert.equal(isPostPrResidualReviewStage("review-1"), true);
  assert.equal(isPostPrResidualReviewStage("implementing"), false);
  assert.equal(blockerKindFromComments([{ body: "<!-- pipeline-blocker-kind: environment-auth -->" }]), "environment-auth");
});

// ---------------------------------------------------------------------------
// 5. Park-release never-pushed
// ---------------------------------------------------------------------------

test("classifyNeverPushedLocalOnly: no proof and no merged PR → local-only", () => {
  assert.equal(
    classifyNeverPushedLocalOnly({ localOnly: "unverifiable", boundProofMatches: false, linkedMergedPr: false }),
    true,
  );
});

test("classifyNeverPushedLocalOnly: bound proof keeps unverifiable", () => {
  assert.equal(
    classifyNeverPushedLocalOnly({ localOnly: "unverifiable", boundProofMatches: true, linkedMergedPr: false }),
    "unverifiable",
  );
});

test("classifyNeverPushedLocalOnly: linked merged PR keeps unverifiable", () => {
  assert.equal(
    classifyNeverPushedLocalOnly({ localOnly: "unverifiable", boundProofMatches: false, linkedMergedPr: true }),
    "unverifiable",
  );
});

test("evaluateRemoveSafety: local-only never allows force", () => {
  const r = evaluateRemoveSafety({ dirty: false, localOnly: true, force: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.blockReason, "local-only");
});

test("park-release #268 never-pushed salvage retains as local-only, not squash-merge wording", async () => {
  let forcePassed: boolean | undefined;
  const result = await releaseWorktreeForParkedIssue(cfg(), 268, {
    listOnDisk: async () => [
      {
        path: "/repo/.worktrees/pipeline-268-x",
        branch: "pipeline/268-x",
        issueNumber: 268,
        slug: "268-x",
        underManagedRoot: true,
      },
    ],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => "unverifiable",
    hasLinkedMergedPr: async () => false,
    pathExists: () => true,
    removeWorktree: async (_c, _n, _s, _p, _r, force) => {
      forcePassed = force;
    },
  });
  assert.equal(result.action, "retained");
  assert.match(result.reason, /local-only/);
  assert.doesNotMatch(result.reason, /cannot verify all commits are merged/);
  assert.doesNotMatch(result.reason, /use --force to proceed if work was squash-merged/);
  assert.equal(forcePassed, undefined);
});

test("park-release: proven squash-merge (bound proof) stays unverifiable path, not local-only reclass", async () => {
  const safety = evaluateRemoveSafety({
    dirty: false,
    localOnly: "unverifiable",
    force: false,
    boundProofMatches: true,
  });
  assert.equal(safety.ok, true);
});

test("park-release: linked merged PR + unverifiable is not reclassified as local-only", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(cfg(), 268, {
    listOnDisk: async () => [
      {
        path: "/repo/.worktrees/pipeline-268-x",
        branch: "pipeline/268-x",
        issueNumber: 268,
        slug: "268-x",
        underManagedRoot: true,
      },
    ],
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => "unverifiable",
    hasLinkedMergedPr: async () => true,
    hasRemoteBranchTip: async () => false,
    resolveOpenPrHeadForBranch: async () => null,
    pathExists: () => true,
    removeWorktree: async () => {
      removed = true;
    },
  });
  // Unverifiable without bound proof still retains (missing recoverability).
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
  assert.doesNotMatch(result.reason, /^local-only \(unpushed\)/);
});

// ---------------------------------------------------------------------------
// 6.1 Drift guard
// ---------------------------------------------------------------------------

test("timeout-park drift guard: unguarded synthetic site fails", () => {
  const unguarded = `
    if (result.timed_out) {
      const reason = \`timed out after \${result.duration}s\`;
      await setBlocked(cfg, issue, reason, "implementing", "harness-failure");
    }
  `;
  assert.equal(isUnguardedTimeoutParkSource(unguarded), true);
});

test("timeout-park drift guard: consulting site passes", () => {
  const guarded = `
    const park = resolveTimeoutParkForUnpublishedCommit(facts, ctx);
    if (park.action === "block") {
      const reason = \`timed out after \${n}s\`;
      await setBlocked(cfg, issue, reason, "implementing", "harness-failure");
    }
  `;
  assert.equal(isUnguardedTimeoutParkSource(guarded), false);
});

test("timeout-park drift guard: implementing and fix afterRound consult the classifier", async () => {
  const planning = await readFile(
    fileURLToPath(new URL("../scripts/stages/planning.ts", import.meta.url)),
    "utf8",
  );
  const fix = await readFile(
    fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(isUnguardedTimeoutParkSource(planning), false);
  assert.equal(isUnguardedTimeoutParkSource(fix), false);
  assert.ok(planning.includes("resolveTimeoutParkForUnpublishedCommit"));
  assert.ok(fix.includes("resolveTimeoutParkForUnpublishedCommit"));
  assert.doesNotMatch(fix, /linkedOpenPr:\s*true/);
  assert.ok(fix.includes("getPrForIssue"));
  assert.ok(fix.includes("executePublishUnpublishedStageCommit"));
  assert.ok(
    planning.includes("executePublishUnpublishedStageCommit"),
    "planning timeout publish must use the shared executor",
  );
  assert.ok(planning.includes("prLookupFailed"), "planning timeout must fail closed on PR lookup errors");
});
