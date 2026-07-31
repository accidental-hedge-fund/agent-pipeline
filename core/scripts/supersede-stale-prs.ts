// Supersede other open same-repo issue-linked PRs after managed PR create/reuse (#729).
//
// When advance opens or reuses a managed PR for issue N, sibling open PRs for N
// on different heads stay OPEN (often CONFLICTING after later merges). This
// helper lists dual-strategy issue-linked open PRs and either closes them with a
// structured pipeline-superseded comment (default) or comment-flags only.

import {
  closePr as defaultClosePr,
  isDualStrategyLinkedToIssue,
  listOpenPrCandidates as defaultListOpenPrCandidates,
  postPrComment as defaultPostPrComment,
  type PrCandidate,
} from "./gh.ts";
import { attestPipelineComment } from "./stages/review-parsing.ts";
import type { PipelineConfig } from "./types.ts";

export type SupersedeMode = "close" | "comment-only";

export interface ManagedPrIdentity {
  prNumber: number;
  branch: string;
}

/** Injectable I/O for {@link supersedeStaleIssuePrs}. Unit tests inject fakes
 *  — no real network/git/subprocess as the sole pass path. */
export interface SupersedeStaleIssuePrsDeps {
  listOpenPrs?: (cfg: PipelineConfig) => Promise<PrCandidate[]>;
  postPrComment?: (
    cfg: PipelineConfig,
    prNumber: number,
    body: string,
  ) => Promise<void>;
  closePr?: (cfg: PipelineConfig, prNumber: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Structured comment body for a superseded PR. Must include the superseding PR
 * number, issue N, and the reason token `pipeline-superseded` (#729). Pure +
 * exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real
 * renderer; attested as kind `pipeline-superseded`.
 */
export function buildSupersededComment(args: {
  managedPrNumber: number;
  issueNumber: number;
}): string {
  const rendered = [
    "## Pipeline: superseded",
    "",
    `This pull request is **superseded** by #${args.managedPrNumber} for issue #${args.issueNumber}.`,
    "",
    "- reason: `pipeline-superseded`",
    `- superseding PR: #${args.managedPrNumber}`,
    `- issue: #${args.issueNumber}`,
    "",
    "The pipeline opened or reused a different managed head for this issue.",
    "Please use the superseding PR for further review and merge.",
  ].join("\n");
  return attestPipelineComment("pipeline-superseded", rendered);
}

/**
 * Pure candidate filter for supersession (#729). A PR is a candidate when all
 * of: same-repo (not fork); dual-strategy issue-linked to N; head ≠ managed
 * branch; base === integration base; number ≠ managed PR.
 */
export function selectSupersedeCandidates(
  prs: PrCandidate[],
  opts: {
    issueNumber: number;
    managedPrNumber: number;
    managedBranch: string;
    targetRepo: string;
    baseBranch: string;
  },
): PrCandidate[] {
  return prs.filter((pr) => {
    if (pr.number === opts.managedPrNumber) return false;
    if (pr.headRefName === opts.managedBranch) return false;
    // Same-repository only — forks never supersede candidates even when a
    // closing ref would match (design D2 / fork spoof safety).
    if (pr.isCrossRepository) return false;
    if (pr.baseRefName !== opts.baseBranch) return false;
    return isDualStrategyLinkedToIssue(pr, opts.issueNumber, opts.targetRepo);
  });
}

export interface SupersedeStaleIssuePrsResult {
  /** Candidates selected for action (before per-PR try/catch). */
  candidates: number[];
  /** PRs that received a superseded comment. */
  commented: number[];
  /** PRs successfully closed (close mode only). */
  closed: number[];
  /** Per-candidate diagnostic messages for partial failures. */
  errors: string[];
}

/**
 * After the live managed PR for issue N is known (create or exact-head reuse),
 * supersede other open same-repo issue-linked PRs on different heads.
 *
 * Never throws in a way that aborts the managed PR advance path: list failures
 * and per-candidate close/comment errors are logged and returned. Partial
 * failure on one candidate does not skip remaining candidates.
 */
export async function supersedeStaleIssuePrs(
  cfg: PipelineConfig,
  issueNumber: number,
  managed: ManagedPrIdentity,
  deps: SupersedeStaleIssuePrsDeps = {},
): Promise<SupersedeStaleIssuePrsResult> {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const listOpenPrs = deps.listOpenPrs ?? ((c) => defaultListOpenPrCandidates(c));
  const postComment = deps.postPrComment ?? defaultPostPrComment;
  const close = deps.closePr ?? defaultClosePr;
  const mode: SupersedeMode = cfg.supersede_mode ?? "close";

  const empty: SupersedeStaleIssuePrsResult = {
    candidates: [],
    commented: [],
    closed: [],
    errors: [],
  };

  let openPrs: PrCandidate[];
  try {
    openPrs = await listOpenPrs(cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diagnostic =
      `[pipeline] #${issueNumber}: supersede sweep could not list open PRs ` +
      `(non-blocking): ${msg}`;
    log(diagnostic);
    return { ...empty, errors: [diagnostic] };
  }

  const candidates = selectSupersedeCandidates(openPrs, {
    issueNumber,
    managedPrNumber: managed.prNumber,
    managedBranch: managed.branch,
    targetRepo: cfg.repo,
    baseBranch: cfg.base_branch,
  });

  if (candidates.length === 0) {
    return empty;
  }

  const result: SupersedeStaleIssuePrsResult = {
    candidates: candidates.map((c) => c.number),
    commented: [],
    closed: [],
    errors: [],
  };

  const commentBody = buildSupersededComment({
    managedPrNumber: managed.prNumber,
    issueNumber,
  });

  for (const pr of candidates) {
    try {
      await postComment(cfg, pr.number, commentBody);
      result.commented.push(pr.number);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const diagnostic =
        `[pipeline] #${issueNumber}: supersede comment failed on PR #${pr.number} ` +
        `(continuing): ${msg}`;
      log(diagnostic);
      result.errors.push(diagnostic);
      // Design D3: if comment fails, still attempt close under close mode.
    }

    if (mode === "close") {
      try {
        await close(cfg, pr.number);
        result.closed.push(pr.number);
        log(
          `[pipeline] #${issueNumber}: closed superseded PR #${pr.number} ` +
            `(pipeline-superseded by #${managed.prNumber})`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const diagnostic =
          `[pipeline] #${issueNumber}: supersede close failed on PR #${pr.number} ` +
          `(continuing): ${msg}`;
        log(diagnostic);
        result.errors.push(diagnostic);
      }
    } else {
      log(
        `[pipeline] #${issueNumber}: flagged superseded PR #${pr.number} ` +
          `(comment-only; pipeline-superseded by #${managed.prNumber})`,
      );
    }
  }

  return result;
}
