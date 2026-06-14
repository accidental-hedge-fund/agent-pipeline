// Planning stage: ready → planning → plan-review → implementing → review-1.
//
// Steps:
//   1. Generate the plan via the primary/implementer harness (just text, no code).
//   2. Post the plan as a comment, transition ready → planning.
//   3. Transition planning → plan-review and invoke the secondary/reviewer harness.
//   4. Send reviewer feedback back to the primary harness and require a revised plan.
//   5. Create the worktree.
//   6. Transition plan-review → implementing.
//   7. Run the primary implementer harness in the worktree against the revised impl prompt.
//   8. Verify commits exist, push branch, create PR, transition implementing → review-1.

import {
  addLabel,
  createPr,
  extractHumanPlanComments,
  getIssueDetail,
  getPrForIssue,
  postComment,
  setBlocked,
  transition,
} from "../gh.ts";
import { invoke, type HarnessResult } from "../harness.ts";
import { invokeReviewer, selfReviewBanner } from "../self-review.ts";
import {
  branchName,
  createWorktree,
  gitInWorktree,
  hasCommitsAhead,
  slugify,
} from "../worktree.ts";
import {
  buildImplementingPrompt,
  buildPlanningOpenspecPrompt,
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  buildPlanRevisionPrompt,
} from "../prompts/index.ts";
import { runTestGate, testGateBlockReason } from "../testgate.ts";
import { makePipelineRunId, withTrailers } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import * as openspec from "../openspec.ts";
import * as last30days from "../last30days.ts";
import {
  verifyHarnessCommits,
  verifyPlanRevisionOutput,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import type { Harness, Outcome, PipelineConfig, Stage } from "../types.ts";

export interface AdvanceOpts {
  dryRun?: boolean;
  /** Optional model override forwarded to harnesses that support it. */
  model?: string;
  /** Dispatch-wide run id for the commit traceability trailers (#20). */
  pipelineRunId?: string;
  /** Evidence-bundle run/state dir (#147); when set, the test gate records its
   *  command runs under the "planning" stage. Undefined → recording disabled. */
  stateDir?: string;
}

export async function advance(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts = {},
): Promise<Outcome> {
  if (openspec.shouldPlanWithOpenspec(cfg, cfg.repo_dir)) {
    return advanceOpenspec(cfg, issueNumber, opts);
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const title = detail.title;
  const body = detail.body;

  const primary: Harness = cfg.harnesses.implementer;
  const reviewer: Harness = cfg.harnesses.reviewer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  console.log(`[pipeline] #${issueNumber}: planning (impl=${primary}, plan-review=${reviewer})`);

  if (opts.dryRun) {
    console.log(`[pipeline] #${issueNumber}: [dry-run] would plan + ${reviewer} plan-review + ${primary} plan revision + implement + open PR`);
    return { advanced: true, from: "ready", to: "review-1", summary: "[dry-run] planning + plan-review" };
  }

  // ---- Step 0: optional carry-forward context (last30days) ----
  const carryForward = await gatherCarryForward(cfg, issueNumber, title, body);

  // ---- Step 1: generate plan ----
  const planPrompt = buildPlanningPrompt({ cfg, issueNumber, title, body, carryForward });
  let planResult: HarnessResult;
  try {
    planResult = await invoke(primary, cfg.repo_dir, planPrompt, {
      timeoutSec: cfg.implementation_timeout,
      model: opts.model ?? cfg.models.planning,
    });
  } catch (err) {
    const e = err as Error;
    await setBlocked(cfg, issueNumber, `Plan generation failed: ${e.message}`, "ready", "plan-gen-failed");
    return { advanced: false, status: "blocked", reason: `plan failed: ${e.message}` };
  }
  if (!planResult.success || !planResult.stdout.trim()) {
    const reason = planResult.timed_out
      ? `Plan generation timed out after ${planResult.duration.toFixed(0)}s`
      : `Plan generation failed (exit ${planResult.exit_code})`;
    await setBlocked(cfg, issueNumber, reason, "ready", "plan-gen-failed");
    return { advanced: false, status: "blocked", reason };
  }
  const plan = planResult.stdout.trim();

  // ---- Step 2: post plan, transition ready → planning ----
  await transition(cfg, issueNumber, "ready", "planning", "Implementation plan generated.");
  const planComment = `## Implementation Plan\n\n${plan}${footer(cfg)}`;
  await postComment(cfg, issueNumber, planComment);

  // Tag the primary harness early for visibility in transition/blocker comments.
  try {
    await addLabel(cfg, issueNumber, `harness:${primary}`);
  } catch {
    /* idempotent */
  }

  // ---- Steps 3+4: secondary plan review + revision (skippable via steps.plan_review) ----
  const specContext = openspec.openspecContext(cfg, cfg.repo_dir);
  let revisedPlan = plan;
  let preImplStage: Stage = "planning";
  if (cfg.steps.plan_review) {
    await transition(
      cfg,
      issueNumber,
      "planning",
      "plan-review",
      `Plan generated by ${primary}. ${reviewer} reviewing before implementation.`,
    );
    preImplStage = "plan-review";

    const reviewPrompt = buildPlanReviewPrompt({ cfg, issueNumber, title, body, plan, reviewer, implementer: primary, specContext });
    // #39: same-harness fallback — if the reviewer CLI is unspawnable, the
    // implementing harness reviews the plan, clearly labeled below.
    const { result: reviewResult, effectiveReviewer: planReviewer, selfReview: planSelfReview } =
      await invokeReviewer(reviewer, primary, cfg.repo_dir, reviewPrompt, {
        timeoutSec: cfg.review_timeout,
        model: opts.model ?? cfg.models.review,
      });
    if (!reviewResult.success || !reviewResult.stdout.trim()) {
      const reason = reviewResult.timed_out
        ? `Plan review timed out after ${reviewResult.duration.toFixed(0)}s`
        : `Plan review failed (exit ${reviewResult.exit_code})`;
      const blockMsg = planSelfReview
        ? `Neither the cross-harness reviewer (${reviewer}) nor the implementing harness (${primary}) is installed/spawnable for a plan self-review — ${reason}`
        : `Plan-review harness (${reviewer}) failed: ${reason}`;
      await setBlocked(cfg, issueNumber, blockMsg, "plan-review", "harness-failure");
      return { advanced: false, status: "blocked", reason };
    }
    const planReview = reviewResult.stdout.trim();
    const planReviewBanner = planSelfReview ? `${selfReviewBanner(reviewer, planReviewer)}\n\n` : "";
    await postComment(cfg, issueNumber, `## Plan Review\n\n${planReviewBanner}**Reviewer**: ${planReviewer}\n**Implementer**: ${primary}\n\n${planReview}${footer(cfg)}`);

    // #26: re-fetch comments so any human feedback left on the posted plan
    // during the reviewer run flows into the revision alongside the reviewer's.
    const humanComments = extractHumanPlanComments(
      (await getIssueDetail(cfg, issueNumber)).comments,
      planComment,
    );

    const revisionPrompt = buildPlanRevisionPrompt({ cfg, issueNumber, title, body, plan, feedback: planReview, reviewer, implementer: primary, humanFeedback: formatHumanFeedback(humanComments), specContext });
    const revisionResult = await invoke(primary, cfg.repo_dir, revisionPrompt, {
      timeoutSec: cfg.implementation_timeout,
      model: opts.model ?? cfg.models.planning,
    });
    if (!revisionResult.success || !revisionResult.stdout.trim()) {
      const reason = revisionResult.timed_out
        ? `Plan revision timed out after ${revisionResult.duration.toFixed(0)}s`
        : `Plan revision failed (exit ${revisionResult.exit_code})`;
      await setBlocked(cfg, issueNumber, `Plan revision by ${primary} failed: ${reason}`, "plan-review", "harness-failure");
      return { advanced: false, status: "blocked", reason };
    }
    // Verify the plan-revision output includes the required acknowledgement section (#68).
    const ackCheck = verifyPlanRevisionOutput(revisionResult.stdout, planReview);
    if (!ackCheck.ok) {
      await setBlocked(cfg, issueNumber, ackCheck.reason, "plan-review", "needs-human");
      return { advanced: false, status: "blocked", reason: ackCheck.reason };
    }
    if (ackCheck.warning) {
      console.warn(`[pipeline] #${issueNumber}: plan-revision warning — ${ackCheck.warning}`);
    }
    revisedPlan = revisionResult.stdout.trim();
    if (!validateHumanFeedbackAck(revisedPlan, humanComments)) {
      const commenters = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
      const reason = `Plan revision by ${primary} is missing the required "${HUMAN_FEEDBACK_ACK_HEADER}" section for human comments from ${commenters}`;
      await setBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      return { advanced: false, status: "blocked", reason };
    }
    await postComment(
      cfg,
      issueNumber,
      `## Revised Implementation Plan\n\n${revisedPlanHeader(primary, reviewer, humanComments).join("\n")}\n\n${revisedPlan}${footer(cfg)}`,
    );
  } else {
    console.log(`[pipeline] #${issueNumber}: plan-review step disabled; implementing the original plan`);
  }

  // ---- Step 5: create worktree ----
  const slug = slugify(title) || `issue-${issueNumber}`;
  let wt: { path: string; branch: string };
  try {
    wt = await createWorktree(cfg, issueNumber, slug);
    console.log(`[pipeline] #${issueNumber}: worktree at ${wt.path}`);
  } catch (err) {
    const e = err as Error;
    await setBlocked(cfg, issueNumber, `Worktree creation failed: ${e.message}`, preImplStage, "worktree-creation-failed");
    return { advanced: false, status: "blocked", reason: e.message };
  }

  // ---- Step 6: → implementing ----
  await transition(
    cfg,
    issueNumber,
    preImplStage,
    "implementing",
    cfg.steps.plan_review
      ? `Plan reviewed by ${reviewer}, revised by ${primary}. Implementation starting with ${primary}.`
      : `Plan-review step disabled. Implementation starting with ${primary} from the original plan.`,
  );

  // ---- Step 7: primary implementer harness ----
  const implPrompt = buildImplementingPrompt({ cfg, issueNumber, title, body, plan: revisedPlan, pipelineRunId, docsEnabled: cfg.steps.docs, specContext });
  const implHeadBefore = (
    await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const result = await invoke(primary, wt.path, implPrompt, {
    timeoutSec: cfg.implementation_timeout,
    model: opts.model,
  });

  if (!result.success) {
    const reason = result.timed_out
      ? `timed out after ${result.duration.toFixed(0)}s`
      : `exit ${result.exit_code}`;
    await setBlocked(
      cfg,
      issueNumber,
      `Implementation harness (${primary}) failed: ${reason}`,
      "implementing",
      "harness-failure",
    );
    return { advanced: false, status: "blocked", reason };
  }

  console.log(
    `[pipeline] #${issueNumber}: implementation done (${result.duration.toFixed(0)}s, harness=${primary})`,
  );

  // #131: the implementer may have done the work without committing — salvage
  // real uncommitted changes into a commit before the no-commit checks below.
  // A clean worktree (nothing salvaged) keeps the existing block path.
  await salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "implement", implHeadBefore);

  // ---- Step 8: verify commits ----
  const ahead = await hasCommitsAhead(wt.path, cfg.base_branch);
  if (!ahead) {
    await setBlocked(
      cfg,
      issueNumber,
      `Implementation harness (${primary}) completed but produced no commits.`,
      "implementing",
      "no-commits",
    );
    return { advanced: false, status: "blocked", reason: "no commits produced" };
  }

  // ---- Verify implementation commit references the issue (#68) ----
  if (implHeadBefore) {
    const implCheck = await enforceImplCommitRef(issueNumber, wt.path, implHeadBefore);
    if (!implCheck.ok) {
      await setBlocked(cfg, issueNumber, implCheck.reason, "implementing", "needs-human");
      return { advanced: false, status: "blocked", reason: implCheck.reason };
    }
  }

  // ---- Step 8.5: test/build gate (#15) — must pass before opening a PR ----
  const gate = await runTestGate(cfg, issueNumber, wt.path, {}, pipelineRunId, "planning", opts.stateDir);
  if (!gate.skipped && !gate.passed) {
    await setBlocked(cfg, issueNumber, testGateBlockReason(gate), "implementing", "test-gate-exhausted");
    return { advanced: false, status: "blocked", reason: "test gate failed" };
  }

  // ---- Step 9: push + PR ----
  const branch = branchName(issueNumber, slug);
  const push = await gitInWorktree(wt.path, ["push", "-u", "origin", branch], {
    ignoreFailure: true,
  });
  if (push.code !== 0) {
    await setBlocked(
      cfg,
      issueNumber,
      `Git push failed: ${push.stderr.trim()}`,
      "implementing",
      "push-failed",
    );
    return { advanced: false, status: "blocked", reason: `push failed` };
  }

  const planExcerpt = revisedPlan.length > 2000 ? revisedPlan.slice(0, 2000) + "\n\n[…plan truncated]" : revisedPlan;
  const prBody = [
    `Closes #${issueNumber}`,
    "",
    `## Summary`,
    `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
    "",
    `**Implemented by**: ${primary}`,
    `**Plan reviewed by**: ${reviewer}`,
    "",
    `## Revised Implementation Plan`,
    planExcerpt,
  ].join("\n") + footer(cfg);

  let prNumber: number;
  try {
    prNumber = await createPr(cfg, {
      branch,
      title: `[Pipeline] ${title} (#${issueNumber})`,
      body: prBody,
    });
  } catch (err) {
    const e = err as Error;
    // Check if a PR already exists (created by a prior partial run).
    const existing = await getPrForIssue(cfg, issueNumber);
    if (existing) {
      prNumber = existing;
    } else {
      await setBlocked(cfg, issueNumber, `PR creation failed: ${e.message}`, "implementing", "pr-creation-failed");
      return { advanced: false, status: "blocked", reason: e.message };
    }
  }

  console.log(`[pipeline] #${issueNumber}: PR #${prNumber} created`);

  // ---- Step 10: implementing → review-1 ----
  await transition(
    cfg,
    issueNumber,
    "implementing",
    "review-1",
    `${cfg.implementation_ready_message} PR #${prNumber} created by ${primary}. Plan reviewed by ${reviewer}.`,
  );

  return {
    advanced: true,
    from: "ready",
    to: "review-1",
    summary: `PR #${prNumber} opened after plan-review`,
  };
}

// ---------------------------------------------------------------------------
// OpenSpec planning flow (active when the target repo uses OpenSpec).
//
// Differs from the freeform flow above: the worktree is created FIRST (OpenSpec
// artifacts are files under `openspec/changes/<id>/`), the implementer authors a
// change (proposal/tasks/spec deltas) instead of a freeform plan, the change is
// validated structurally, and its proposal drives the cross-harness plan-review.
// ---------------------------------------------------------------------------

async function advanceOpenspec(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceOpts,
): Promise<Outcome> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const { title, body } = detail;
  const primary: Harness = cfg.harnesses.implementer;
  const reviewer: Harness = cfg.harnesses.reviewer;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  console.log(
    `[pipeline] #${issueNumber}: planning (OpenSpec; impl=${primary}, plan-review=${reviewer})`,
  );

  if (opts.dryRun) {
    console.log(
      `[pipeline] #${issueNumber}: [dry-run] would author + ${reviewer} review + revise an OpenSpec change + implement + open PR`,
    );
    return { advanced: true, from: "ready", to: "review-1", summary: "[dry-run] openspec planning" };
  }

  // ---- Step 0: optional carry-forward context (last30days) ----
  const carryForward = await gatherCarryForward(cfg, issueNumber, title, body);

  // ---- Worktree first: OpenSpec artifacts are files in the change folder. ----
  const slug = slugify(title) || `issue-${issueNumber}`;
  let wt: { path: string; branch: string };
  try {
    wt = await createWorktree(cfg, issueNumber, slug);
    console.log(`[pipeline] #${issueNumber}: worktree at ${wt.path}`);
  } catch (err) {
    const e = err as Error;
    await setBlocked(cfg, issueNumber, `Worktree creation failed: ${e.message}`, "ready", "worktree-creation-failed");
    return { advanced: false, status: "blocked", reason: e.message };
  }

  // ---- Bootstrap the OpenSpec workspace if the repo lacks one (opt-in). ----
  if (!openspec.isInitialized(wt.path)) {
    if (!cfg.openspec.bootstrap) {
      await setBlocked(
        cfg,
        issueNumber,
        "OpenSpec is required (openspec.enabled: on) but this repo has no `openspec/` " +
          "workspace. Set `openspec.bootstrap: true` in .github/pipeline.yml, or run `openspec init`.",
        "ready",
        "needs-human",
      );
      return { advanced: false, status: "blocked", reason: "openspec not initialized" };
    }
    console.log(`[pipeline] #${issueNumber}: bootstrapping OpenSpec (openspec init)`);
    const initRes = await openspec.init(wt.path);
    if (initRes.unavailable) {
      await setBlocked(
        cfg,
        issueNumber,
        "OpenSpec bootstrap requested but the `openspec` CLI is not on PATH " +
          "(install: `npm i -g @fission-ai/openspec`).",
        "ready",
        "needs-human",
      );
      return { advanced: false, status: "blocked", reason: "openspec CLI unavailable" };
    }
    if (!initRes.success) {
      await setBlocked(cfg, issueNumber, `openspec init failed:\n${initRes.output}`, "ready", "needs-human");
      return { advanced: false, status: "blocked", reason: "openspec init failed" };
    }
    await gitInWorktree(wt.path, ["add", "-A"], { ignoreFailure: true });
    await gitInWorktree(
      wt.path,
      ["commit", "-m", withTrailers(`chore: openspec init for #${issueNumber}`, issueNumber, pipelineRunId)],
      { ignoreFailure: true },
    );
  }

  // ---- Author the OpenSpec change (intent only, no code). ----
  const before = openspec.listChangeDirs(wt.path);
  // Capture HEAD before authoring so we can verify committed artifacts afterward (#68).
  const osAuthorHeadBefore = (
    await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const planResult = await invoke(primary, wt.path, buildPlanningOpenspecPrompt({ cfg, issueNumber, title, body, carryForward, pipelineRunId }), {

    timeoutSec: cfg.implementation_timeout,
    model: opts.model ?? cfg.models.planning,
  });
  if (!planResult.success) {
    const reason = planResult.timed_out
      ? `timed out after ${planResult.duration.toFixed(0)}s`
      : `exit ${planResult.exit_code}`;
    await setBlocked(cfg, issueNumber, `OpenSpec proposal authoring (${primary}) failed: ${reason}`, "ready", "harness-failure");
    return { advanced: false, status: "blocked", reason };
  }

  // #131: salvage authoring work the harness left uncommitted before the
  // commit-range verification below (the change folder may exist only on disk).
  await salvageIfNoNewCommit(
    wt.path,
    issueNumber,
    pipelineRunId,
    "OpenSpec authoring",
    osAuthorHeadBefore,
  );

  // ---- Discover the change the implementer created. ----
  const after = openspec.listChangeDirs(wt.path);
  const fresh = after.filter((c) => !before.includes(c));
  // Block on multiple new changes — silently selecting the first would hide a
  // non-compliant authoring run (#68, finding 3).
  const changeResult = enforceOpenspecChangeSingular(fresh, after);
  if (!changeResult.ok) {
    const blockMsg =
      changeResult.reason === "no openspec change created"
        ? "OpenSpec is active but the planning step produced no change under `openspec/changes/`. " +
          "Ensure the `openspec` CLI is installed and the repo is initialized (`openspec init`)."
        : changeResult.reason;
    await setBlocked(cfg, issueNumber, blockMsg, "ready", "needs-human");
    return { advanced: false, status: "blocked", reason: changeResult.reason };
  }
  const changeId = changeResult.changeId;

  // ---- Verify the authoring harness committed only openspec/ artifacts (#68). ----
  if (osAuthorHeadBefore) {
    const authorCheck = await verifyHarnessCommits(wt.path, osAuthorHeadBefore, {
      issueNumber,
      pathConstraint: {
        allowPattern: /^openspec\//,
        description:
          "OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage",
      },
    });
    if (!authorCheck.ok) {
      await setBlocked(cfg, issueNumber, authorCheck.reason, "ready", "needs-human");
      return { advanced: false, status: "blocked", reason: authorCheck.reason };
    }
  }

  console.log(`[pipeline] #${issueNumber}: OpenSpec change \`${changeId}\` drafted`);

  // ---- Validate the change structurally. ----
  const v1 = await openspec.validateItem(wt.path, changeId);
  if (!v1.unavailable && !v1.valid) {
    await setBlocked(cfg, issueNumber, `OpenSpec change \`${changeId}\` is invalid:\n${formatIssues(v1)}`, "planning", "openspec-invalid");
    return { advanced: false, status: "blocked", reason: "openspec change invalid" };
  }

  const proposal = openspec.readChangeFile(wt.path, changeId, "proposal.md")?.trim() || "(proposal.md not found)";

  // ---- ready → planning, post the proposal as the plan. ----
  await transition(cfg, issueNumber, "ready", "planning", `OpenSpec change \`${changeId}\` drafted by ${primary}.`);
  const planComment = `## Implementation Plan\n\n_OpenSpec change \`${changeId}\` — proposal.md_\n\n${proposal}${footer(cfg)}`;
  await postComment(cfg, issueNumber, planComment);
  try {
    await addLabel(cfg, issueNumber, `harness:${primary}`);
  } catch {
    /* idempotent */
  }

  // ---- plan review + revision (skippable via steps.plan_review) ----
  let specContext = openspec.readSpecDeltas(wt.path, changeId);
  let revisedProposal = proposal;
  let preImplStage: Stage = "planning";
  if (cfg.steps.plan_review) {
    await transition(
      cfg,
      issueNumber,
      "planning",
      "plan-review",
      `OpenSpec proposal by ${primary}. ${reviewer} reviewing intent before implementation.`,
    );
    preImplStage = "plan-review";
    // #39: same-harness fallback — see the freeform path above.
    const { result: reviewResult, effectiveReviewer: planReviewer, selfReview: planSelfReview } =
      await invokeReviewer(
        reviewer,
        primary,
        wt.path,
        buildPlanReviewPrompt({ cfg, issueNumber, title, body, plan: proposal, reviewer, implementer: primary, specContext }),
        { timeoutSec: cfg.review_timeout, model: opts.model ?? cfg.models.review },
      );
    if (!reviewResult.success || !reviewResult.stdout.trim()) {
      const reason = reviewResult.timed_out
        ? `timed out after ${reviewResult.duration.toFixed(0)}s`
        : `exit ${reviewResult.exit_code}`;
      const blockMsg = planSelfReview
        ? `Neither the cross-harness reviewer (${reviewer}) nor the implementing harness (${primary}) is installed/spawnable for a plan self-review — ${reason}`
        : `Plan-review harness (${reviewer}) failed: ${reason}`;
      await setBlocked(cfg, issueNumber, blockMsg, "plan-review", "harness-failure");
      return { advanced: false, status: "blocked", reason };
    }
    const planReview = reviewResult.stdout.trim();
    const planReviewBanner = planSelfReview ? `${selfReviewBanner(reviewer, planReviewer)}\n\n` : "";
    await postComment(
      cfg,
      issueNumber,
      `## Plan Review\n\n${planReviewBanner}**Reviewer**: ${planReviewer}\n**Implementer**: ${primary}\n\n${planReview}${footer(cfg)}`,
    );

    // #26: pull in human comments left on the posted plan during the reviewer run.
    const humanComments = extractHumanPlanComments(
      (await getIssueDetail(cfg, issueNumber)).comments,
      planComment,
    );
    const revisionResult = await invoke(
      primary,
      wt.path,
      buildPlanRevisionPrompt({ cfg, issueNumber, title, body, plan: proposal, feedback: planReview, reviewer, implementer: primary, humanFeedback: formatHumanFeedback(humanComments), specContext }),
      { timeoutSec: cfg.implementation_timeout, model: opts.model ?? cfg.models.planning },
    );
    if (!revisionResult.success || !revisionResult.stdout.trim()) {
      const reason = revisionResult.timed_out
        ? `timed out after ${revisionResult.duration.toFixed(0)}s`
        : `exit ${revisionResult.exit_code}`;
      await setBlocked(cfg, issueNumber, `Plan revision by ${primary} failed: ${reason}`, "plan-review", "harness-failure");
      return { advanced: false, status: "blocked", reason };
    }
    // Verify the plan-revision output includes the required acknowledgement section (#68).
    const osAckCheck = verifyPlanRevisionOutput(revisionResult.stdout, planReview);
    if (!osAckCheck.ok) {
      await setBlocked(cfg, issueNumber, osAckCheck.reason, "plan-review", "needs-human");
      return { advanced: false, status: "blocked", reason: osAckCheck.reason };
    }
    if (osAckCheck.warning) {
      console.warn(`[pipeline] #${issueNumber}: plan-revision warning — ${osAckCheck.warning}`);
    }
    const v2 = await openspec.validateItem(wt.path, changeId);
    if (!v2.unavailable && !v2.valid) {
      await setBlocked(cfg, issueNumber, `OpenSpec change \`${changeId}\` invalid after revision:\n${formatIssues(v2)}`, "plan-review", "openspec-invalid");
      return { advanced: false, status: "blocked", reason: "openspec change invalid after revision" };
    }
    revisedProposal = openspec.readChangeFile(wt.path, changeId, "proposal.md")?.trim() || proposal;
    if (!validateHumanFeedbackAck(revisedProposal, humanComments)) {
      const commenters = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
      const reason = `Plan revision by ${primary} is missing the required "${HUMAN_FEEDBACK_ACK_HEADER}" section for human comments from ${commenters}`;
      await setBlocked(cfg, issueNumber, reason, "plan-review", "needs-human");
      return { advanced: false, status: "blocked", reason };
    }
    // Recompute spec deltas: revision may have updated the spec files.
    specContext = openspec.readSpecDeltas(wt.path, changeId);
    await postComment(
      cfg,
      issueNumber,
      `## Revised Implementation Plan\n\n${[...revisedPlanHeader(primary, reviewer, humanComments), `_OpenSpec change \`${changeId}\`_`].join("\n")}\n\n${revisedProposal}${footer(cfg)}`,
    );
  } else {
    console.log(`[pipeline] #${issueNumber}: plan-review step disabled; implementing the drafted change`);
  }

  // ---- → implementing (work the change's task checklist). ----
  await transition(
    cfg,
    issueNumber,
    preImplStage,
    "implementing",
    cfg.steps.plan_review
      ? `OpenSpec proposal reviewed by ${reviewer}, revised by ${primary}. Implementation starting with ${primary}.`
      : `Plan-review step disabled. Implementation starting with ${primary} from the drafted change.`,
  );
  const tasks = openspec.readChangeFile(wt.path, changeId, "tasks.md")?.trim() ?? "";
  const implPlan =
    `Implement OpenSpec change \`${changeId}\`. Work through the checklist in ` +
    `\`openspec/changes/${changeId}/tasks.md\`, keep that change folder committed, and satisfy its spec deltas.\n\n` +
    `${revisedProposal}${tasks ? `\n\n## Tasks\n\n${tasks}` : ""}`;
  const osImplHeadBefore = (
    await gitInWorktree(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  const result = await invoke(
    primary,
    wt.path,
    buildImplementingPrompt({ cfg, issueNumber, title, body, plan: implPlan, pipelineRunId, docsEnabled: cfg.steps.docs, specContext }),
    { timeoutSec: cfg.implementation_timeout, model: opts.model },
  );
  if (!result.success) {
    const reason = result.timed_out ? `timed out after ${result.duration.toFixed(0)}s` : `exit ${result.exit_code}`;
    await setBlocked(cfg, issueNumber, `Implementation harness (${primary}) failed: ${reason}`, "implementing", "harness-failure");
    return { advanced: false, status: "blocked", reason };
  }
  console.log(`[pipeline] #${issueNumber}: implementation done (${result.duration.toFixed(0)}s, harness=${primary})`);

  // #131: salvage uncommitted implementer work before the no-commit checks.
  await salvageIfNoNewCommit(wt.path, issueNumber, pipelineRunId, "implement", osImplHeadBefore);

  // ---- Verify commits, push, open PR, implementing → review-1. ----
  if (!(await hasCommitsAhead(wt.path, cfg.base_branch))) {
    await setBlocked(cfg, issueNumber, `Implementation harness (${primary}) completed but produced no commits.`, "implementing", "no-commits");
    return { advanced: false, status: "blocked", reason: "no commits produced" };
  }

  // ---- Verify implementation commit references the issue (#68) ----
  if (osImplHeadBefore) {
    const osImplCheck = await enforceImplCommitRef(issueNumber, wt.path, osImplHeadBefore);
    if (!osImplCheck.ok) {
      await setBlocked(cfg, issueNumber, osImplCheck.reason, "implementing", "needs-human");
      return { advanced: false, status: "blocked", reason: osImplCheck.reason };
    }
  }
  // ---- test/build gate (#15) — must pass before opening a PR ----
  const gate = await runTestGate(cfg, issueNumber, wt.path, {}, pipelineRunId, "planning", opts.stateDir);
  if (!gate.skipped && !gate.passed) {
    await setBlocked(cfg, issueNumber, testGateBlockReason(gate), "implementing", "test-gate-exhausted");
    return { advanced: false, status: "blocked", reason: "test gate failed" };
  }
  const branch = branchName(issueNumber, slug);
  const push = await gitInWorktree(wt.path, ["push", "-u", "origin", branch], { ignoreFailure: true });
  if (push.code !== 0) {
    await setBlocked(cfg, issueNumber, `Git push failed: ${push.stderr.trim()}`, "implementing", "push-failed");
    return { advanced: false, status: "blocked", reason: "push failed" };
  }
  const planExcerpt =
    revisedProposal.length > 2000 ? revisedProposal.slice(0, 2000) + "\n\n[…proposal truncated]" : revisedProposal;
  const prBody = [
    `Closes #${issueNumber}`,
    "",
    `## Summary`,
    `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
    "",
    `**Implemented by**: ${primary}`,
    `**Plan reviewed by**: ${reviewer}`,
    `**OpenSpec change**: \`${changeId}\``,
    "",
    `## Proposal`,
    planExcerpt,
  ].join("\n") + footer(cfg);
  let prNumber: number;
  try {
    prNumber = await createPr(cfg, { branch, title: `[Pipeline] ${title} (#${issueNumber})`, body: prBody });
  } catch (err) {
    const existing = await getPrForIssue(cfg, issueNumber);
    if (existing) {
      prNumber = existing;
    } else {
      await setBlocked(cfg, issueNumber, `PR creation failed: ${(err as Error).message}`, "implementing", "pr-creation-failed");
      return { advanced: false, status: "blocked", reason: (err as Error).message };
    }
  }
  console.log(`[pipeline] #${issueNumber}: PR #${prNumber} created`);
  await transition(
    cfg,
    issueNumber,
    "implementing",
    "review-1",
    `${cfg.implementation_ready_message} PR #${prNumber} created by ${primary} (OpenSpec change \`${changeId}\`). Plan reviewed by ${reviewer}.`,
  );
  return { advanced: true, from: "ready", to: "review-1", summary: `PR #${prNumber} opened after OpenSpec plan-review` };
}

// ---------------------------------------------------------------------------
// OpenSpec change-directory singularity gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Validates that the OpenSpec authoring harness produced exactly one new change
 * directory. When `fresh` is empty (no new change) the `all` list is checked for
 * a single pre-existing change (fallback for harnesses that modify rather than
 * create). Multiple new changes are always a hard block.
 *
 * Returns `{ ok: true, changeId }` or `{ ok: false, reason }`. Exported for
 * unit testing without mocking the full `advanceOpenspec` chain.
 */
export function enforceOpenspecChangeSingular(
  fresh: string[],
  all: string[],
): { ok: true; changeId: string } | { ok: false; reason: string } {
  if (fresh.length > 1) {
    return {
      ok: false,
      reason: `OpenSpec authoring produced ${fresh.length} new changes (${fresh.join(", ")}) — expected exactly one`,
    };
  }
  const changeId = fresh[0] ?? (all.length === 1 ? all[0] : undefined);
  if (!changeId) {
    return { ok: false, reason: "no openspec change created" };
  }
  return { ok: true, changeId };
}

// ---------------------------------------------------------------------------
// Uncommitted-work salvage pre-pass (#131)
// ---------------------------------------------------------------------------

/**
 * When the harness produced no new commit (`HEAD` still equals `headBefore`),
 * salvage any uncommitted work in the worktree into a commit so the downstream
 * commit-range checks validate it instead of blocking on "no commits". A clean
 * worktree salvages nothing and the caller's existing block path is unchanged.
 */
async function salvageIfNoNewCommit(
  wtPath: string,
  issueNumber: number,
  pipelineRunId: string,
  stageLabel: string,
  headBefore: string,
): Promise<void> {
  if (!headBefore) return;
  const headAfter = (
    await gitInWorktree(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })
  ).stdout.trim();
  if (headAfter && headAfter === headBefore) {
    await trySalvageUncommittedWork(wtPath, issueNumber, pipelineRunId, stageLabel);
  }
}

// ---------------------------------------------------------------------------
// Implementation-commit reference gate — exported for direct unit testing
// ---------------------------------------------------------------------------

/**
 * Verifies that at least one commit in `headBefore..HEAD` references the issue
 * number. Exported so tests can exercise the gate without mocking the full
 * `advance` call chain.
 */
export async function enforceImplCommitRef(
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(wtPath, headBefore, { issueNumber }, deps);
}

function formatIssues(v: { issues: { item?: string; message: string }[]; raw: string }): string {
  return v.issues.length
    ? v.issues.map((i) => `- ${i.item ? `${i.item}: ` : ""}${i.message}`).join("\n")
    : v.raw;
}

// ---------------------------------------------------------------------------
// Pre-planning carry-forward context (optional; last30days)
// ---------------------------------------------------------------------------

const LAST30DAYS_SETUP_URL = "https://github.com/mvanhorn/last30days-skill#setup";

// Character cap for the body portion of the research topic. Bodies at or under
// the cap are appended verbatim; longer bodies are excerpted to the cap, trimmed
// at the last word boundary, and marked with `…`. Keeping the topic bounded
// avoids passing unbounded, noisy markdown to the skill's query builder.
const BODY_TOPIC_CAP = 400;

// Patterns that commonly indicate secrets or private data in issue bodies.
// Replacements use `[REDACTED]` to preserve prose structure while removing
// content that should not cross the pipeline→external-skill boundary.
const REDACT_PATTERNS: ReadonlyArray<RegExp> = [
  // URLs — can embed tokens, internal hostnames, or auth parameters
  /(?:https?|ftp):\/\/[^\s]+/gi,
  // Email addresses
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  // Bearer / Authorization header values
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // JWT-shaped strings: three base64url segments joined by dots
  /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Long hex strings (32+ chars) — API keys, session tokens, hashes
  /\b[0-9a-f]{32,}\b/gi,
  // key/token/secret/password assignments, e.g. `api_key=abc123` or `token: xyz`
  /(?:api[_-]?key|token|secret|password|passwd|auth)\s*[=:]\s*\S+/gi,
];

/**
 * Redact URLs, email addresses, and common secret patterns from `text` before
 * the content is forwarded to the last30days skill's external research runtime.
 * Replacements use the literal `[REDACTED]` so prose structure is preserved.
 */
export function sanitizeBodyForResearch(text: string): string {
  let out = text;
  for (const pattern of REDACT_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Build the research topic string for the last30days skill from the issue's
 * full content (title + description).
 * - body absent/empty/whitespace-only → returns `title` unchanged (no regression).
 * - body ≤ BODY_TOPIC_CAP → appends sanitized body after the title.
 * - body > BODY_TOPIC_CAP → appends a sanitized excerpt capped at BODY_TOPIC_CAP,
 *   trimmed at the last word boundary, with a trailing `…` marking the truncation.
 *
 * The body is passed through `sanitizeBodyForResearch` before use to redact URLs,
 * emails, and common secret patterns before the topic crosses the pipeline boundary.
 */
export function buildResearchTopic(title: string, body?: string): string {
  const b = sanitizeBodyForResearch((body ?? "").trim());
  if (!b) return title;
  if (b.length <= BODY_TOPIC_CAP) return `${title}\n\n${b}`;
  let excerpt = b.slice(0, BODY_TOPIC_CAP).trimEnd();
  const lastSpace = excerpt.lastIndexOf(" ");
  if (lastSpace > 0) excerpt = excerpt.slice(0, lastSpace);
  return `${title}\n\n${excerpt}…`;
}

/** Returns a non-blocking hint for the two empty-brief cases in gatherCarryForward. Exported for unit tests. */
export function buildSetupHint(issueNumber: number, mode: "unavailable" | "no-signal"): string {
  const p = `[pipeline] #${issueNumber}: last30days:`;
  if (mode === "unavailable") {
    return (
      `${p} skill or Python not found; skipping (non-blocking). ` +
      `To install: \`npx skills add mvanhorn/last30days-skill -g\` (Codex/CLI hosts) or ` +
      `\`/plugin marketplace add mvanhorn/last30days-skill\` (Claude Code). ` +
      `Data-source keys (BRAVE_SEARCH_API_KEY, SCRAPECREATORS_API_KEY) are configured in the skill — see ${LAST30DAYS_SETUP_URL}`
    );
  }
  return (
    `${p} skill ran but returned no usable signal; skipping (non-blocking). ` +
    `Add data-source keys in the skill for better coverage: ` +
    `BRAVE_SEARCH_API_KEY (free Brave Search) and SCRAPECREATORS_API_KEY (fuller social/X). ` +
    `See ${LAST30DAYS_SETUP_URL}`
  );
}

/** Seam for unit-testing the two empty-brief branches without the skill installed. */
export interface CarryForwardDeps {
  run: typeof last30days.run;
}

/**
 * When `last30days.enabled`, run the last30days skill against the issue's full
 * content (title + description, bounded for long bodies) and carry the resulting
 * evidence brief forward: post it as an issue comment AND return it for injection
 * into the planning prompt. Always non-blocking — a missing skill, failure, or
 * empty/low-signal brief just returns "".
 *
 * `body` is optional: when absent, empty, or whitespace-only the research topic
 * is the title alone (identical to the pre-change baseline).
 */
export async function gatherCarryForward(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  body?: string,
  deps: CarryForwardDeps = { run: last30days.run },
): Promise<string> {
  if (!last30days.isEnabled(cfg)) return "";
  const researchTopic = buildResearchTopic(title, body);
  console.log(`[pipeline] #${issueNumber}: gathering last30days carry-forward context`);
  const res = await deps.run(researchTopic, { timeoutSec: cfg.last30days.timeout });
  if (res.unavailable) {
    console.log(buildSetupHint(issueNumber, "unavailable"));
    return "";
  }
  if (!res.success || !last30days.hasSignal(res.brief)) {
    console.log(buildSetupHint(issueNumber, "no-signal"));
    return "";
  }
  await postComment(
    cfg,
    issueNumber,
    `## Pre-Planning Context — last30days\n\n_Topic: "${title}"_${res.stats ? `\n\n${res.stats}` : ""}\n\n${res.brief}${footer(cfg)}`,
  );
  console.log(`[pipeline] #${issueNumber}: last30days brief posted + carried into planning`);
  return res.brief;
}

function footer(cfg: PipelineConfig): string {
  return `\n\n---\n${cfg.marker_footer}`;
}

// ---------------------------------------------------------------------------
// Human plan feedback (#26)
// ---------------------------------------------------------------------------

/** Exact section heading the revised plan must contain when human comments are present. */
export const HUMAN_FEEDBACK_ACK_HEADER = "## Human Feedback Acknowledgement";

/**
 * Returns `true` when no acknowledgement is required (no human comments) or when
 * the revised plan contains the required acknowledgement section header.
 * Returns `false` when human comments were present but the section is missing —
 * the caller must block or reject the revision. Exported for tests.
 */
export function validateHumanFeedbackAck(
  revisedPlan: string,
  humanComments: { author: string }[],
): boolean {
  if (humanComments.length === 0) return true;
  return revisedPlan.includes(HUMAN_FEEDBACK_ACK_HEADER);
}

/**
 * Render human comments left on the posted plan as `@login: body` blocks for the
 * revision prompt's human-feedback section, or `undefined` when there are none
 * (so `buildPlanRevisionPrompt` omits the section entirely). Exported for tests.
 */
export function formatHumanFeedback(
  humanComments: { author: string; body: string }[],
): string | undefined {
  if (humanComments.length === 0) return undefined;
  return humanComments.map((c) => `@${c.author}: ${c.body}`).join("\n\n");
}

/**
 * Attribution lines for the `## Revised Implementation Plan` comment. Appends a
 * `**Human feedback from**: @login, …` line (deduped) when human comments were
 * incorporated; returns the base attribution unchanged when there were none, so
 * the comment is byte-for-byte identical to today's on the no-feedback path.
 * Exported for tests.
 */
export function revisedPlanHeader(
  implementer: string,
  reviewer: string,
  humanComments: { author: string }[],
): string[] {
  const lines = [`**Updated by**: ${implementer}`, `**Based on review by**: ${reviewer}`];
  if (humanComments.length > 0) {
    const logins = [...new Set(humanComments.map((c) => `@${c.author}`))].join(", ");
    lines.push(`**Human feedback from**: ${logins}`);
  }
  return lines;
}
