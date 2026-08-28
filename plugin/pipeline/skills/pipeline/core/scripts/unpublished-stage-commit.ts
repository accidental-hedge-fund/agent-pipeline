/**
 * Publishable unpublished stage-commit classifier and recipe (#1272).
 *
 * Class: a pre-PR park that already holds a pipeline-authored salvage or
 * ownership-checkpoint (or implement) commit on the managed issue branch,
 * with no push and no linked open PR. Same recipe for implementing timeout,
 * autonomous recovery, recover-parked, and other pre-PR product-mutating
 * stages — not an implementing-only afterRound mole.
 *
 * This module is I/O-free in the classifier. Inspect/execute go through
 * injectable deps (no module-level gh/git/network in tests).
 */

import { getIssueDetail, getPrForIssue, getPrForIssueAnyState, getPrDetail, createPr, setBlocked, clearBlocked, transition } from "./gh.ts";
import { ISSUE_TRAILER_KEY, RUN_TRAILER_KEY } from "./traceability.ts";
import type { Outcome, PipelineConfig } from "./types.ts";
import { parsePorcelainPaths, productDirtyPaths } from "./worktree-dirt.ts";
import { branchName, getOnDiskForIssue, gitInWorktree, hasCommitsAhead } from "./worktree.ts";

/** Locked recipe id — must stay in {@link RECOVERY_RECIPES} and policy/call sites. */
export const PUBLISH_UNPUBLISHED_STAGE_COMMIT = "publish_unpublished_stage_commit" as const;

/** Salvage / ownership-checkpoint subject prefix (issue number filled in). */
export const SALVAGE_SUBJECT_PREFIX = "salvage: stage harness work (#";

export type UnpublishedTipKind = "salvage" | "checkpoint" | "implement";

export interface PublishableUnpublishedFacts {
  issueNumber: number;
  headBranch: string;
  porcelain: string;
  extraGlobs?: readonly string[];
  commitsAheadOfBase: boolean;
  linkedOpenPr: boolean;
  tipSubject: string;
  tipBody?: string;
  /**
   * Same-process authorship when git log is stubbed or checkpoint already
   * authored the tip. Recover-parked inspect leaves this unset so unmarked
   * operator tips cannot match.
   */
  authorshipHint?: UnpublishedTipKind | null;
}

export type PublishableUnpublishedClassification =
  | { publishable: true; tipKind: UnpublishedTipKind }
  | { publishable: false; reason: string };

/** True when HEAD branch is the managed issue branch `pipeline/<N>-*`. */
export function isManagedIssueBranch(branch: string, issueNumber: number): boolean {
  const trimmed = branch.trim();
  return new RegExp(`^pipeline/${issueNumber}-`).test(trimmed);
}

/**
 * Classify a commit subject/body as pipeline-authored salvage, checkpoint, or
 * implement work. Operator-authored unmarked tips return null.
 */
export function classifyPipelineAuthoredTip(
  issueNumber: number,
  subject: string,
  body = "",
): UnpublishedTipKind | null {
  const headline = subject.trim();
  const salvageSubject = `${SALVAGE_SUBJECT_PREFIX}${issueNumber})`;
  if (headline === salvageSubject || headline.startsWith(salvageSubject)) {
    if (/owned-harness-leftover|checkpointed owned leftover|ownership-checkpoint/i.test(body)) {
      return "checkpoint";
    }
    return "salvage";
  }
  const combined = `${headline}\n${body}`;
  const issueTrailer = `${ISSUE_TRAILER_KEY}: #${issueNumber}`;
  if (combined.includes(issueTrailer) && combined.includes(`${RUN_TRAILER_KEY}:`)) {
    return "implement";
  }
  return null;
}

/** True when porcelain has unknown product dirt (engine scratch is allowed). */
export function hasUnknownProductDirt(
  porcelain: string,
  extraGlobs: readonly string[] = [],
): boolean {
  return productDirtyPaths(parsePorcelainPaths(porcelain), extraGlobs).length > 0;
}

/**
 * Pure classifier: a local HEAD is a publishable unpublished stage commit
 * when the managed-branch, clean-unknown-dirt, ahead-of-base, no-open-PR, and
 * pipeline-authored-tip predicates all hold.
 */
export function classifyPublishableUnpublishedStageCommit(
  facts: PublishableUnpublishedFacts,
): PublishableUnpublishedClassification {
  if (!isManagedIssueBranch(facts.headBranch, facts.issueNumber)) {
    return { publishable: false, reason: "HEAD is not the managed issue branch" };
  }
  const unknown = productDirtyPaths(parsePorcelainPaths(facts.porcelain), facts.extraGlobs ?? []);
  if (unknown.length > 0) {
    return {
      publishable: false,
      reason: `unknown product dirt: ${unknown.slice(0, 5).join(", ")}`,
    };
  }
  if (!facts.commitsAheadOfBase) {
    return { publishable: false, reason: "no commits ahead of base" };
  }
  if (facts.linkedOpenPr) {
    return { publishable: false, reason: "linked open PR already exists" };
  }
  const fromTip = classifyPipelineAuthoredTip(
    facts.issueNumber,
    facts.tipSubject,
    facts.tipBody ?? "",
  );
  const tipKind = fromTip ?? facts.authorshipHint ?? null;
  if (!tipKind) {
    return {
      publishable: false,
      reason: "unpublished tip is not pipeline-authored salvage/checkpoint/implement work",
    };
  }
  return { publishable: true, tipKind };
}

export function recoveredWorkPresent(ctx: {
  salvaged: boolean;
  ownershipCheckpointed: boolean;
}): boolean {
  return ctx.salvaged || ctx.ownershipCheckpointed;
}

export function authorshipHintFromRound(ctx: {
  salvaged: boolean;
  ownershipCheckpointed: boolean;
}): UnpublishedTipKind | null {
  if (ctx.ownershipCheckpointed) return "checkpoint";
  if (ctx.salvaged) return "salvage";
  return null;
}

/**
 * Same-process timeout park consult. Call before `setBlocked` on harness
 * timeout so a publishable unpublished commit is not parked solely as
 * `timed out after <N>s`.
 */
export function resolveTimeoutParkForUnpublishedCommit(
  facts: PublishableUnpublishedFacts,
  ctx: {
    salvaged: boolean;
    ownershipCheckpointed: boolean;
    ownershipCheckpointFailed: boolean;
  },
): { action: "publish" | "block"; classification: PublishableUnpublishedClassification } {
  if (ctx.ownershipCheckpointFailed) {
    return {
      action: "block",
      classification: { publishable: false, reason: "ownership checkpoint failed" },
    };
  }
  const classification = classifyPublishableUnpublishedStageCommit({
    ...facts,
    authorshipHint: facts.authorshipHint ?? authorshipHintFromRound(ctx),
  });
  if (classification.publishable && recoveredWorkPresent(ctx)) {
    return { action: "publish", classification };
  }
  return { action: "block", classification };
}

// ---------------------------------------------------------------------------
// Inspect (injectable I/O)
// ---------------------------------------------------------------------------

export interface InspectUnpublishedDeps {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  gitInWorktree?: typeof gitInWorktree;
  hasCommitsAhead?: typeof hasCommitsAhead;
  getPrForIssue?: typeof getPrForIssue;
  getPrForBranch?: (
    cfg: PipelineConfig,
    branch: string,
  ) => Promise<number | null>;
  extraGlobs?: readonly string[];
}

export interface InspectUnpublishedResult {
  facts: PublishableUnpublishedFacts | null;
  classification: PublishableUnpublishedClassification;
  worktree: { path: string; slug: string; branch: string } | null;
}

export async function inspectPublishableUnpublishedStageCommit(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: InspectUnpublishedDeps = {},
): Promise<InspectUnpublishedResult> {
  const getWt = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const git = deps.gitInWorktree ?? gitInWorktree;
  const aheadFn = deps.hasCommitsAhead ?? hasCommitsAhead;
  const wt = await getWt(cfg, issueNumber);
  if (!wt) {
    return {
      facts: null,
      classification: { publishable: false, reason: "no managed worktree" },
      worktree: null,
    };
  }
  const branch = branchName(issueNumber, wt.slug);
  const status = await git(
    wt.path,
    ["status", "--porcelain", "--untracked-files=all"],
    { ignoreFailure: true },
  );
  if (status.code !== 0) {
    return {
      facts: null,
      classification: { publishable: false, reason: `git status failed (exit ${status.code})` },
      worktree: { path: wt.path, slug: wt.slug, branch },
    };
  }
  const headBranchR = await git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"], { ignoreFailure: true });
  const headBranch = (headBranchR.stdout.trim() || branch).replace(/^heads\//, "");
  const logR = await git(wt.path, ["log", "-1", "--format=%s%n%n%b"], { ignoreFailure: true });
  const logText = logR.code === 0 ? logR.stdout : "";
  const nl = logText.indexOf("\n");
  const tipSubject = (nl === -1 ? logText : logText.slice(0, nl)).trim();
  const tipBody = nl === -1 ? "" : logText.slice(nl + 1);
  const ahead = await aheadFn(wt.path, cfg.base_branch);
  let linkedOpenPr = false;
  try {
    const getPr = deps.getPrForIssue ?? getPrForIssue;
    const pr = await getPr(cfg, issueNumber);
    linkedOpenPr = pr != null;
  } catch {
    if (deps.getPrForBranch) {
      const pr = await deps.getPrForBranch(cfg, branch);
      linkedOpenPr = pr != null;
    }
  }
  const facts: PublishableUnpublishedFacts = {
    issueNumber,
    headBranch,
    porcelain: status.stdout,
    extraGlobs: deps.extraGlobs ?? cfg.test_gate?.non_product_dirty_globs ?? [],
    commitsAheadOfBase: ahead,
    linkedOpenPr,
    tipSubject,
    tipBody,
  };
  return {
    facts,
    classification: classifyPublishableUnpublishedStageCommit(facts),
    worktree: { path: wt.path, slug: wt.slug, branch },
  };
}

// ---------------------------------------------------------------------------
// Executor (thin wrap over existing post-implement sequence)
// ---------------------------------------------------------------------------

export interface PublishUnpublishedExecutorDeps {
  inspect?: typeof inspectPublishableUnpublishedStageCommit;
  inspectDeps?: InspectUnpublishedDeps;
  resumeFromImplementing?: (
    cfg: PipelineConfig,
    issueNumber: number,
    wt: { path: string; branch: string },
    opts: {
      prTitle: string;
      prBody: string;
      transitionMessage: (prNumber: number) => string;
      pipelineRunId: string;
    },
    resumeDeps?: Record<string, unknown>,
  ) => Promise<Outcome>;
  resumeDeps?: Record<string, unknown>;
  getIssueDetail?: typeof getIssueDetail;
  createPr?: typeof createPr;
  setBlocked?: typeof setBlocked;
  clearBlocked?: typeof clearBlocked;
  transition?: typeof transition;
  probeImplementDeliverable?: (
    wtPath: string,
    issueNumber: number,
  ) => Promise<{ present: boolean; description?: string }>;
  pipelineRunId?: string;
}

function failedPublish(error: string): { succeeded: false; evidence: string; error: string } {
  return { succeeded: false, evidence: error, error };
}

function remapPublishBlockKind(kind: string): string {
  if (kind === "push-failed" || kind === "pr-creation-failed") return "harness-failure";
  return kind;
}

/**
 * Thin executor over the existing post-implement helper. Does not force-push.
 * Does not write mid-flight labels through triage or raw issue-edit.
 */
export async function executePublishUnpublishedStageCommit(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: PublishUnpublishedExecutorDeps = {},
): Promise<{ succeeded: boolean; evidence: string; error?: string; outcome?: Outcome }> {
  const inspectFn = deps.inspect ?? inspectPublishableUnpublishedStageCommit;
  const inspected = await inspectFn(cfg, issueNumber, deps.inspectDeps ?? {});
  if (!inspected.classification.publishable || !inspected.worktree) {
    return failedPublish(
      `publish_unpublished_stage_commit: not applicable (${inspected.classification.publishable === false ? inspected.classification.reason : "no worktree"}) — trying next recipe`,
    );
  }
  if (deps.probeImplementDeliverable) {
    const deliverable = await deps.probeImplementDeliverable(inspected.worktree.path, issueNumber);
    if (!deliverable.present) {
      return failedPublish(
        "publish_unpublished_stage_commit: implement deliverable unsatisfied — completeness/re-invoke, not review-1",
      );
    }
  }
  const resume =
    deps.resumeFromImplementing ??
    (await import("./stages/planning.ts")).resumeFromImplementing;
  const getDetail = deps.getIssueDetail ?? getIssueDetail;
  let title = `issue ${issueNumber}`;
  try {
    title = (await getDetail(cfg, issueNumber)).title;
  } catch {
    // Title is best-effort for PR text; inspect already proved the commit.
  }
  const prBody = [
    `Closes #${issueNumber}`,
    "",
    "## Summary",
    `Automated implementation of [${title}](https://github.com/${cfg.repo}/issues/${issueNumber}).`,
    "",
    "Published from a pipeline-authored unpublished stage commit after timeout/harness recovery.",
  ].join("\n");
  const pipelineRunId = deps.pipelineRunId ?? `${issueNumber}/unpublished-publish`;
  const blocker = deps.setBlocked ?? setBlocked;
  const mappedBlocker: typeof setBlocked = async (c, n, reason, stage, kind, extra) => {
    const mapped = remapPublishBlockKind(kind) as typeof kind;
    return blocker(c, n, reason, stage, mapped, extra);
  };
  const resumeDeps = {
    createPr: deps.createPr ?? createPr,
    transition: deps.transition ?? transition,
    ...(deps.resumeDeps ?? {}),
    setBlocked: mappedBlocker,
  };
  const outcome = await resume(
    cfg,
    issueNumber,
    { path: inspected.worktree.path, branch: inspected.worktree.branch },
    {
      prTitle: `[Pipeline] ${title} (#${issueNumber})`,
      prBody,
      transitionMessage: (prNumber) =>
        `PR #${prNumber} published from unpublished stage commit for #${issueNumber}.`,
      pipelineRunId,
    },
    resumeDeps,
  );
  if (outcome.advanced) {
    try {
      await (deps.clearBlocked ?? clearBlocked)(cfg, issueNumber);
    } catch {
      // Transition already moved implementing → design-gate/review-1; a missing
      // blocked label is not a publish failure.
    }
    return {
      succeeded: true,
      evidence:
        `publish_unpublished_stage_commit: pushed and opened/reused PR; ` +
        `engine-owned transition ${outcome.from ?? "implementing"} → ${outcome.to ?? "review-1"}`,
      outcome,
    };
  }
  if (!outcome.advanced && outcome.status === "blocked") {
    const reason = outcome.reason ?? "publish blocked";
    const kind = remapPublishBlockKind(outcome.blockerKind ?? "harness-failure");
    return {
      succeeded: false,
      evidence: `publish_unpublished_stage_commit: ${reason}`,
      error: `publish_unpublished_stage_commit: ${kind}: ${reason}`,
      outcome,
    };
  }
  return {
    succeeded: false,
    evidence: `publish_unpublished_stage_commit: ${outcome.reason ?? "did not advance"}`,
    error: `publish_unpublished_stage_commit: ${outcome.reason ?? "did not advance"}`,
    outcome,
  };
}

// ---------------------------------------------------------------------------
// Park-release: never-pushed unpublished commits are local-only
// ---------------------------------------------------------------------------

/**
 * Reclassify the git observation for park-release. Empty ls-remote +
 * unreachable-from-base is local-only unless bound merge-result proof or a
 * linked merged PR shows the head was published then deleted after merge.
 */
export function classifyNeverPushedLocalOnly(input: {
  localOnly: boolean | "unverifiable" | null;
  boundProofMatches: boolean;
  linkedMergedPr: boolean;
}): boolean | "unverifiable" | null {
  if (input.localOnly !== "unverifiable") return input.localOnly;
  if (input.boundProofMatches || input.linkedMergedPr) return "unverifiable";
  return true;
}

export async function defaultHasLinkedMergedPr(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: {
    getPrForIssueAnyState?: typeof getPrForIssueAnyState;
    getPrDetail?: typeof getPrDetail;
  } = {},
): Promise<boolean> {
  const anyState = deps.getPrForIssueAnyState ?? getPrForIssueAnyState;
  const detailFn = deps.getPrDetail ?? getPrDetail;
  try {
    const pr = await anyState(cfg, issueNumber);
    if (pr == null) return false;
    const detail = await detailFn(cfg, pr);
    return detail.state === "merged";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pre-PR engine park (recover-parked)
// ---------------------------------------------------------------------------

const PRE_PR_STAGES = new Set([
  "planning",
  "plan-review",
  "pre-code-attestation",
  "implementing",
]);

const POST_PR_RESIDUAL_STAGES = new Set([
  "design-gate",
  "review-1",
  "fix-1",
  "review-2",
  "fix-2",
  "pre-merge",
  "visual-gate",
  "eval-gate",
  "shipcheck-gate",
]);

export function isPrePrStage(stage: string | null | undefined): boolean {
  return typeof stage === "string" && PRE_PR_STAGES.has(stage);
}

export function isPostPrResidualReviewStage(stage: string | null | undefined): boolean {
  return typeof stage === "string" && POST_PR_RESIDUAL_STAGES.has(stage);
}

const ENGINE_DEFECT_BLOCKER_KINDS = new Set([
  "harness-failure",
  "environment-auth",
  "workflow-engine-defect",
  "push-failed",
  "pr-creation-failed",
]);

export function isPrePrEngineDefectPark(input: {
  stage: string | null | undefined;
  blockerKind?: string | null;
  needsHumanLabel?: boolean;
}): boolean {
  if (input.needsHumanLabel) return false;
  if (!isPrePrStage(input.stage)) return false;
  if (!input.blockerKind) return true;
  return ENGINE_DEFECT_BLOCKER_KINDS.has(input.blockerKind);
}

/** Extract `pipeline-blocker-kind` from the latest blocked comment body (loose). */
export function blockerKindFromComments(comments: readonly { body?: string }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.body ?? "";
    const m = body.match(/<!--\s*pipeline-blocker-kind:\s*([a-z0-9-]+)\s*-->/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Drift guard: timeout park sites must consult the classifier
// ---------------------------------------------------------------------------

const CONSULT_SYMBOLS = [
  "classifyPublishableUnpublishedStageCommit",
  "resolveTimeoutParkForUnpublishedCommit",
  "inspectPublishableUnpublishedStageCommit",
];

export interface TimeoutParkSite {
  module: string;
  absPath: string;
  hasTimedOutPark: boolean;
  consultsClassifier: boolean;
}

export function timeoutParkSiteConsultsClassifier(source: string): boolean {
  return CONSULT_SYMBOLS.some((sym) => source.includes(sym));
}

/**
 * True when source can `setBlocked` a harness timeout (`timed out after`)
 * without consulting the unpublished-commit classifier.
 */
export function isUnguardedTimeoutParkSource(source: string): boolean {
  const hasTimeoutPark =
    /timed out after/.test(source) &&
    (/setBlocked\s*\(/.test(source) || /doSetBlocked\s*\(/.test(source) || /blocker\s*\(/.test(source));
  if (!hasTimeoutPark) return false;
  return !timeoutParkSiteConsultsClassifier(source);
}
