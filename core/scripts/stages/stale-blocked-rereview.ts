// Stale blocked resume on enter (#1025 / #1028).
//
// When an item already carries `blocked` and advance re-enters pre-merge (or
// fix), compare the blocking reviewed-sha S to PR HEAD H. If H supersedes S with
// at least one non-pipeline-internal commit, clear the leftover block so the
// stage path re-runs delta / full re-review. Does not invent --override.

import {
  clearBlocked,
  getIssueDetail,
  getPrCommits,
  getPrDetail,
  getPrForIssue,
  type IssueDetail,
} from "../gh.ts";
import { extractReviewedSha } from "./review-parsing.ts";
import { resolveReviewedShaCurrency } from "./pre-merge-sha-gate.ts";
import type { PipelineConfig } from "../types.ts";

export type StaleBlockedResumeResult =
  | { kind: "cleared"; reviewedSha: string; headSha: string; reason: string }
  | { kind: "keep"; reason: string }
  | { kind: "no-op"; reason: string };

export interface StaleBlockedResumeDeps {
  getPrForIssue?: typeof getPrForIssue;
  getPrDetail?: typeof getPrDetail;
  getPrCommits?: typeof getPrCommits;
  clearBlocked?: typeof clearBlocked;
  getIssueDetail?: typeof getIssueDetail;
  /** Optional override of reviewed-sha extraction for tests. */
  extractReviewedSha?: typeof extractReviewedSha;
  resolveCurrency?: typeof resolveReviewedShaCurrency;
}

/** Stages where leftover blocked can be stale because HEAD moved past review. */
export function stageEligibleForStaleBlockedResume(stage: string | null | undefined): boolean {
  if (!stage) return false;
  return (
    stage === "pre-merge" ||
    stage === "fix-1" ||
    stage === "fix-2" ||
    stage === "review-1" ||
    stage === "review-2"
  );
}

/**
 * On enter of an already-blocked item: if PR HEAD supersedes the blocking
 * reviewed-sha with a non-pipeline-internal commit, clear `blocked` so advance
 * re-enters review / pre-merge. Pipeline-internal-only ranges keep the block
 * (verdict reuse #98). HEAD still equal to S keeps the block.
 */
export async function tryResumeStaleBlocked(
  cfg: PipelineConfig,
  issueNumber: number,
  detail: Pick<IssueDetail, "comments" | "labels">,
  deps: StaleBlockedResumeDeps = {},
): Promise<StaleBlockedResumeResult> {
  const getPr = deps.getPrForIssue ?? getPrForIssue;
  const getDetailPr = deps.getPrDetail ?? getPrDetail;
  const getCommits = deps.getPrCommits ?? getPrCommits;
  const clear = deps.clearBlocked ?? clearBlocked;
  const extractSha = deps.extractReviewedSha ?? extractReviewedSha;
  const resolveCurrency = deps.resolveCurrency ?? resolveReviewedShaCurrency;

  const reviewed = extractSha(detail.comments);
  if (!reviewed?.sha) {
    return { kind: "no-op", reason: "no reviewed-sha on issue comments" };
  }
  const reviewedSha = reviewed.sha;

  let prNumber: number | null;
  try {
    prNumber = await getPr(cfg, issueNumber);
  } catch (err) {
    return {
      kind: "keep",
      reason: `cannot resolve PR for stale-block resume: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (prNumber == null) {
    return { kind: "keep", reason: "no linked open PR for stale-block resume" };
  }

  let headSha: string;
  try {
    headSha = (await getDetailPr(cfg, prNumber)).head_sha;
  } catch (err) {
    return {
      kind: "keep",
      reason: `cannot read PR head for stale-block resume: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (headSha === reviewedSha) {
    return {
      kind: "keep",
      reason: `PR HEAD still at reviewed-sha ${reviewedSha.slice(0, 7)}; block remains`,
    };
  }

  const currency = await resolveCurrency(cfg, prNumber, reviewedSha, {
    getPrDetail: getDetailPr,
    getPrCommits: getCommits,
  });

  if (currency.status === "current") {
    // Pipeline-internal-only range (#98) — keep verdict / block.
    return {
      kind: "keep",
      reason:
        `PR HEAD ${headSha.slice(0, 7)} supersedes ${reviewedSha.slice(0, 7)} with only pipeline-internal commits; keeping block/verdict`,
    };
  }
  if (currency.status === "unknown") {
    // Fail closed: do not clear without positive non-internal supersession proof.
    return {
      kind: "keep",
      reason: `cannot classify commits between reviewed-sha and HEAD; keeping block`,
    };
  }

  // superseded — at least one non-pipeline-internal commit
  try {
    await clear(cfg, issueNumber);
  } catch (err) {
    return {
      kind: "keep",
      reason: `clearBlocked failed during stale resume: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    kind: "cleared",
    reviewedSha,
    headSha: currency.headSha,
    reason:
      `cleared stale blocked: HEAD ${currency.headSha.slice(0, 7)} supersedes reviewed-sha ` +
      `${reviewedSha.slice(0, 7)} with non-pipeline-internal commit(s); re-review will run`,
  };
}
