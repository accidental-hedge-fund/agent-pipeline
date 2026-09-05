// Later-stage review-currency guard (#1462).
//
// Before dispatch of visual-gate / eval-gate / shipcheck-gate / ready-to-deploy,
// reconcile PR HEAD against the latest review SHA using the shared currency
// surface. A non-pipeline-internal HEAD starts a new candidate epoch and
// returns the issue to review-1 after the managed worktree is bound to that
// HEAD (or fail-closed if it cannot be). Pipeline-internal-only movement stays
// current. Unreadable PR/HEAD fails closed. This is not a second SHA-gate product.

import * as path from "node:path";
import {
  getGhActor,
  getPrCommits,
  getPrDetail,
  getPrForIssue,
} from "../gh.ts";
import {
  reconcileReviewCurrency,
  type ReviewCurrencyObservedState,
} from "../reconcile-and-converge.ts";
import {
  isAncestorOfVerifiedHead,
  resolveVerifiedRemoteHead,
} from "../transient-wrappers.ts";
import type { PipelineConfig } from "../types.ts";
import {
  branchName,
  getOnDiskForIssue,
  gitInWorktree,
  worktreePath,
} from "../worktree.ts";
import { extractReviewedSha } from "./review-parsing.ts";
import {
  resolveReviewedShaCurrency,
  type ReviewedShaCurrency,
} from "./pre-merge-sha-gate.ts";

export const LATER_STAGES_REQUIRING_REVIEW_CURRENCY = [
  "visual-gate",
  "eval-gate",
  "shipcheck-gate",
  "ready-to-deploy",
] as const;

export type LaterStageRequiringReviewCurrency =
  (typeof LATER_STAGES_REQUIRING_REVIEW_CURRENCY)[number];

export function isLaterStageForReviewCurrency(
  stage: string | null | undefined,
): stage is LaterStageRequiringReviewCurrency {
  return (
    stage === "visual-gate" ||
    stage === "eval-gate" ||
    stage === "shipcheck-gate" ||
    stage === "ready-to-deploy"
  );
}

export type LaterStageReviewCurrencyResult =
  | { kind: "not-applicable"; reason: string }
  | { kind: "current"; reviewedSha: string; headSha: string; reason: string }
  | {
      kind: "return-to-review";
      reviewedSha: string;
      headSha: string;
      reviewStage: "review-1" | "review-2";
      reason: string;
    }
  | { kind: "fail-closed"; reason: string };

export interface LaterStageReviewCurrencyDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrDetail?: typeof getPrDetail;
  getPrCommits?: typeof getPrCommits;
  getGhActor?: typeof getGhActor;
  extractReviewedSha?: typeof extractReviewedSha;
  resolveCurrency?: typeof resolveReviewedShaCurrency;
}

function mapReconcileToLaterStageAction(input: {
  cfg: PipelineConfig;
  reviewedSha: string;
  headSha: string;
  currency: ReviewedShaCurrency;
}): LaterStageReviewCurrencyResult {
  const { cfg, reviewedSha, headSha, currency } = input;
  const observed: ReviewCurrencyObservedState = {
    reviewedSha,
    headSha,
    currencyStatus: currency.status,
    pipelineInternalOnly: currency.status === "current" && headSha !== reviewedSha,
    observationFailed: false,
    preferDelta: false,
  };
  const reconciled = reconcileReviewCurrency(observed);
  const reuse = reconciled.actions.some((a) => a.kind === "reuse_verdict");

  if (currency.status === "current" || reuse) {
    return {
      kind: "current",
      reviewedSha,
      headSha,
      reason:
        headSha === reviewedSha
          ? `PR HEAD still at reviewed-sha ${reviewedSha.slice(0, 7)}; later-stage review currency holds`
          : `PR HEAD ${headSha.slice(0, 7)} supersedes ${reviewedSha.slice(0, 7)} with only pipeline-internal commits; later-stage review currency holds`,
    };
  }

  // Design D3: superseded, or unknown with readable H ≠ S, starts a new epoch.
  if (headSha !== reviewedSha) {
    const reviewStage = cfg.steps.standard_review
      ? "review-1"
      : cfg.steps.adversarial_review
        ? "review-2"
        : null;
    if (!reviewStage) {
      return {
        kind: "fail-closed",
        reason:
          `later-stage review currency changed from ${reviewedSha.slice(0, 7)} ` +
          `to ${headSha.slice(0, 7)}, but no exact-SHA review stage is enabled; refusing to dispatch`,
      };
    }
    const reason =
      currency.status === "superseded"
        ? `later-stage review currency superseded: HEAD ${headSha.slice(0, 7)} ` +
          `has non-pipeline-internal commit(s) since reviewed-sha ${reviewedSha.slice(0, 7)}; returning to ${reviewStage}`
        : `later-stage review currency unknown between reviewed-sha ${reviewedSha.slice(0, 7)} ` +
          `and HEAD ${headSha.slice(0, 7)} (rebase/squash or unclassifiable history); returning to ${reviewStage}`;
    return { kind: "return-to-review", reviewedSha, headSha, reviewStage, reason };
  }

  return {
    kind: "fail-closed",
    reason:
      reconciled.actions.find((a) => a.kind === "fail_closed")?.reason ??
      "later-stage review currency could not be proven; refusing to dispatch",
  };
}

/**
 * Reconcile later-stage dispatch against the latest authoritative review SHA.
 * Callers MUST skip the later-stage handler on `return-to-review` and
 * `fail-closed`.
 */
export async function reconcileLaterStageReviewCurrency(
  cfg: PipelineConfig,
  issueNumber: number,
  stage: string | null | undefined,
  detail: { comments: { body: string; author?: string | null }[] },
  deps: LaterStageReviewCurrencyDeps = {},
): Promise<LaterStageReviewCurrencyResult> {
  if (!isLaterStageForReviewCurrency(stage)) {
    return {
      kind: "not-applicable",
      reason: `stage ${stage ?? "none"} is not a later gate requiring review-currency reconcile`,
    };
  }

  // Same actor-only trust as the pre-merge SHA gate: any commenter can post a
  // Review-headed body with `reviewed-sha` equal to HEAD. Fail closed when the
  // authenticated pipeline actor cannot be determined.
  const getActor = deps.getGhActor ?? getGhActor;
  let actor: string | null;
  try {
    actor = await getActor();
  } catch (err) {
    return {
      kind: "fail-closed",
      reason: `later-stage review-currency: cannot resolve authenticated gh actor: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (actor === null) {
    return {
      kind: "fail-closed",
      reason:
        "later-stage review-currency: authenticated gh actor unavailable; refusing to dispatch",
    };
  }

  const extractSha = deps.extractReviewedSha ?? extractReviewedSha;
  const trustedComments = detail.comments.filter((c) => c.author === actor);
  const reviewed = extractSha(trustedComments);
  if (!reviewed?.sha) {
    return {
      kind: "fail-closed",
      reason:
        "later-stage review-currency: no reviewed-sha on issue comments; refusing to dispatch",
    };
  }
  const reviewedSha = reviewed.sha;

  const getPr = deps.getPrForIssue ?? getPrForIssue;
  const getDetailPr = deps.getPrDetail ?? getPrDetail;
  const getCommits = deps.getPrCommits ?? getPrCommits;
  const resolveCurrency = deps.resolveCurrency ?? resolveReviewedShaCurrency;

  let prNumber: number | null;
  try {
    prNumber = await getPr(cfg, issueNumber);
  } catch (err) {
    return {
      kind: "fail-closed",
      reason: `later-stage review-currency: cannot resolve PR: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (prNumber == null) {
    return {
      kind: "fail-closed",
      reason: "later-stage review-currency: no linked open PR; refusing to dispatch",
    };
  }

  let headSha: string;
  try {
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
  } catch (err) {
    return {
      kind: "fail-closed",
      reason: `later-stage review-currency: cannot read PR HEAD: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!headSha) {
    return {
      kind: "fail-closed",
      reason: "later-stage review-currency: PR HEAD unreadable; refusing to dispatch",
    };
  }

  // Always re-read via the shared resolver, including after an initial exact-SHA
  // match. A developer push between the first HEAD read and later-stage dispatch
  // must not reuse the first observation as current.
  const currency = await resolveCurrency(cfg, prNumber, reviewedSha, {
    getPrDetail: getDetailPr,
    getPrCommits: getCommits,
  });

  const observedHead =
    currency.status === "superseded" ? currency.headSha : headSha;

  return mapReconcileToLaterStageAction({
    cfg,
    reviewedSha,
    headSha: observedHead,
    currency,
  });
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function normalizeFullSha(raw: string): string {
  const sha = raw.trim().toLowerCase();
  return FULL_SHA_RE.test(sha) ? sha : "";
}

export type EpochRestartWorktreeBindResult =
  | { kind: "bound"; worktreeHead: string | null; reason: string }
  | { kind: "fail-closed"; reason: string };

export interface EpochRestartWorktreeBindDeps {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  gitInWorktree?: typeof gitInWorktree;
}

/**
 * Bind a present managed worktree to the new candidate HEAD before epoch-restarted
 * review. Missing worktrees are not a stale-S reject. Present HEAD mismatch uses
 * the verified-head ancestor recipe (ff-only, then reset --hard) scoped to the
 * managed worktree path, or fails closed so review/test never run on S.
 */
export async function bindEpochRestartWorktreeToHead(
  cfg: PipelineConfig,
  issueNumber: number,
  headSha: string,
  deps: EpochRestartWorktreeBindDeps = {},
): Promise<EpochRestartWorktreeBindResult> {
  const target = normalizeFullSha(headSha);
  if (!target) {
    return {
      kind: "fail-closed",
      reason:
        "later-stage epoch restart: PR HEAD is not a full SHA; refusing to dispatch review",
    };
  }

  const getWt = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const gitWt = deps.gitInWorktree ?? gitInWorktree;

  let wt: { path: string; slug: string } | null;
  try {
    wt = await getWt(cfg, issueNumber);
  } catch (err) {
    return {
      kind: "fail-closed",
      reason: `later-stage epoch restart: cannot resolve managed worktree: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!wt) {
    return {
      kind: "bound",
      worktreeHead: null,
      reason: "later-stage epoch restart: no managed worktree on disk",
    };
  }

  const expectedPath = worktreePath(
    { ...cfg, worktree_root: cfg.worktree_root || ".worktrees" },
    issueNumber,
    wt.slug,
  );
  if (path.resolve(wt.path) !== path.resolve(expectedPath)) {
    return {
      kind: "fail-closed",
      reason:
        `later-stage epoch restart: worktree path ${wt.path} is not the managed root; refusing to dispatch review`,
    };
  }

  const readHead = async (): Promise<string> => {
    try {
      const res = await gitWt(wt.path, ["rev-parse", "HEAD"], { ignoreFailure: true });
      return res.code === 0 ? normalizeFullSha(res.stdout) : "";
    } catch {
      return "";
    }
  };

  const local = await readHead();
  if (!local) {
    return {
      kind: "fail-closed",
      reason:
        "later-stage epoch restart: cannot read managed worktree HEAD; refusing to dispatch review",
    };
  }
  if (local === target) {
    return {
      kind: "bound",
      worktreeHead: local,
      reason: `later-stage epoch restart: managed worktree already at PR HEAD ${target.slice(0, 7)}`,
    };
  }

  const status = await gitWt(
    wt.path,
    ["status", "--porcelain", "--untracked-files=all"],
    { ignoreFailure: true },
  );
  if (status.code !== 0 || status.stdout.trim() !== "") {
    return {
      kind: "fail-closed",
      reason:
        `later-stage epoch restart: managed worktree HEAD ${local.slice(0, 7)} does not match PR HEAD ${target.slice(0, 7)} ` +
        "and the worktree is dirty; refusing to dispatch review",
    };
  }

  const branch = branchName(issueNumber, wt.slug);
  const git = async (args: string[]) => gitWt(wt.path, args, { ignoreFailure: true });
  const verified = await resolveVerifiedRemoteHead(branch, {
    git,
    resolveOpenPrHead: async () => target,
  });
  if (!verified.ok || normalizeFullSha(verified.sha) !== target) {
    return {
      kind: "fail-closed",
      reason:
        `later-stage epoch restart: cannot verify PR HEAD ${target.slice(0, 7)} in the managed worktree; refusing to dispatch review`,
    };
  }

  const ancestor = await isAncestorOfVerifiedHead(git, "HEAD", target);
  if (ancestor !== true) {
    return {
      kind: "fail-closed",
      reason:
        `later-stage epoch restart: managed worktree HEAD ${local.slice(0, 7)} is not an ancestor of PR HEAD ${target.slice(0, 7)}; ` +
        "refusing reset and review dispatch",
    };
  }

  const ff = await git(["merge", "--ff-only", target]);
  if (ff.code !== 0) {
    // Safety scope: `git reset --hard` targets only this managed worktree path,
    // and only after HEAD is a proven ancestor of the verified PR head H.
    const reset = await git(["reset", "--hard", target]);
    if (reset.code !== 0) {
      return {
        kind: "fail-closed",
        reason:
          `later-stage epoch restart: could not move managed worktree from ${local.slice(0, 7)} to PR HEAD ${target.slice(0, 7)}; refusing to dispatch review`,
      };
    }
  }

  const after = await readHead();
  if (after !== target) {
    return {
      kind: "fail-closed",
      reason:
        `later-stage epoch restart: managed worktree HEAD ${after.slice(0, 7) || "unresolved"} still does not match PR HEAD ${target.slice(0, 7)} after sync; refusing to dispatch review`,
    };
  }

  return {
    kind: "bound",
    worktreeHead: after,
    reason: `later-stage epoch restart: synchronized managed worktree to PR HEAD ${target.slice(0, 7)}`,
  };
}
