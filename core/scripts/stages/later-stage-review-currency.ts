// Later-stage review-currency guard (#1462).
//
// Before dispatch of visual-gate / eval-gate / shipcheck-gate / ready-to-deploy,
// reconcile PR HEAD against the latest review SHA using the shared currency
// surface. A non-pipeline-internal HEAD starts a new candidate epoch and
// returns the issue to review-1. Pipeline-internal-only movement stays current.
// Unreadable PR/HEAD fails closed. This is not a second SHA-gate product.

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
import type { PipelineConfig } from "../types.ts";
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
