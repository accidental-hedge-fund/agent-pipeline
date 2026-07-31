// Supersede other open same-repo issue-linked PRs after managed PR create/reuse (#729).
//
// When advance opens or reuses a managed PR for issue N, sibling open PRs for N
// on different heads stay OPEN (often CONFLICTING after later merges). This
// helper lists dual-strategy issue-linked open PRs and either closes them with a
// structured pipeline-superseded comment (default) or comment-flags only.
//
// Cross-host safety: before closing, elect a single GitHub-authoritative managed
// winner among open same-base `pipeline/<N>-*` heads (highest PR number). Only
// the winner may supersede; a losing concurrent host does not close peers and
// signals lost election so the post-implement path stops rather than advancing
// while believing a non-winning managed PR is live.

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
 * True when a PR is a same-repo managed pipeline head for issue N on the
 * integration base (`pipeline/<N>-*` non-fork, same base). Used for
 * cross-host winner election (#729 concurrency).
 */
export function isManagedPipelineHead(
  pr: PrCandidate,
  opts: {
    issueNumber: number;
    baseBranch: string;
  },
): boolean {
  if (pr.isCrossRepository) return false;
  if (pr.baseRefName !== undefined && pr.baseRefName !== opts.baseBranch) return false;
  return pr.headRefName.startsWith(`pipeline/${opts.issueNumber}-`);
}

/**
 * Elect the GitHub-authoritative managed PR winner for issue N among open
 * same-base `pipeline/<N>-*` heads. Highest PR number wins (newest open
 * managed head). The caller's managed identity is always included so a
 * truncated/stale list cannot elect a lower peer over an unlisted managed PR.
 * Pure + exported for unit tests.
 */
export function electManagedPrWinner(
  openPrs: PrCandidate[],
  opts: {
    issueNumber: number;
    managedPrNumber: number;
    managedBranch: string;
    baseBranch: string;
  },
): ManagedPrIdentity {
  let winner: ManagedPrIdentity = {
    prNumber: opts.managedPrNumber,
    branch: opts.managedBranch,
  };
  for (const pr of openPrs) {
    if (!isManagedPipelineHead(pr, opts)) continue;
    if (pr.number > winner.prNumber) {
      winner = { prNumber: pr.number, branch: pr.headRefName };
    }
  }
  return winner;
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
  /**
   * Whether this managed PR won the GitHub-authoritative managed-head election.
   * When false, no candidates were acted on; the caller SHALL stop rather than
   * advance treating this managed PR as the live head.
   */
  wonElection: boolean;
  /** Elected managed PR number (equal to managed when won). */
  electedPr: number;
}

function emptyResult(
  managedPrNumber: number,
  overrides: Partial<SupersedeStaleIssuePrsResult> = {},
): SupersedeStaleIssuePrsResult {
  return {
    candidates: [],
    commented: [],
    closed: [],
    errors: [],
    wonElection: true,
    electedPr: managedPrNumber,
    ...overrides,
  };
}

/**
 * List open PRs, elect the managed winner, and select supersede candidates.
 * Shared by the initial plan and the immediate pre-action revalidation so both
 * use the same GitHub-authoritative rules.
 */
async function planSupersession(
  cfg: PipelineConfig,
  issueNumber: number,
  managed: ManagedPrIdentity,
  listOpenPrs: (cfg: PipelineConfig) => Promise<PrCandidate[]>,
  log: (msg: string) => void,
): Promise<
  | { ok: true; candidates: PrCandidate[] }
  | { ok: false; result: SupersedeStaleIssuePrsResult }
> {
  let openPrs: PrCandidate[];
  try {
    openPrs = await listOpenPrs(cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const diagnostic =
      `[pipeline] #${issueNumber}: supersede sweep could not list open PRs ` +
      `(non-blocking): ${msg}`;
    log(diagnostic);
    return {
      ok: false,
      result: emptyResult(managed.prNumber, { errors: [diagnostic] }),
    };
  }

  const elected = electManagedPrWinner(openPrs, {
    issueNumber,
    managedPrNumber: managed.prNumber,
    managedBranch: managed.branch,
    baseBranch: cfg.base_branch,
  });

  if (elected.prNumber !== managed.prNumber) {
    const diagnostic =
      `[pipeline] #${issueNumber}: supersede lost managed-head election to PR ` +
      `#${elected.prNumber} (this managed PR #${managed.prNumber} on ` +
      `${managed.branch}); not closing peers`;
    log(diagnostic);
    return {
      ok: false,
      result: emptyResult(managed.prNumber, {
        wonElection: false,
        electedPr: elected.prNumber,
        errors: [diagnostic],
      }),
    };
  }

  const candidates = selectSupersedeCandidates(openPrs, {
    issueNumber,
    managedPrNumber: managed.prNumber,
    managedBranch: managed.branch,
    targetRepo: cfg.repo,
    baseBranch: cfg.base_branch,
  });

  return { ok: true, candidates };
}

/**
 * After the live managed PR for issue N is known (create or exact-head reuse),
 * supersede other open same-repo issue-linked PRs on different heads.
 *
 * Cross-host safety (#729 review): elects a single managed winner by highest
 * open `pipeline/<N>-*` PR number (GitHub-authoritative). Only the winner acts.
 * Revalidates the election immediately before acting so two concurrent hosts
 * cannot each close the other's managed PR.
 *
 * Never throws in a way that aborts the managed PR advance path for list or
 * per-candidate errors: those are logged and returned. A lost election is also
 * non-throwing but sets `wonElection: false` so the caller can stop advancing.
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

  // Initial election + candidate selection.
  const first = await planSupersession(cfg, issueNumber, managed, listOpenPrs, log);
  if (!first.ok) return first.result;

  // Revalidate immediately before acting: concurrent hosts may have opened
  // another managed head between the first list and close. Same election rules.
  const second = await planSupersession(cfg, issueNumber, managed, listOpenPrs, log);
  if (!second.ok) return second.result;

  const candidates = second.candidates;
  if (candidates.length === 0) {
    return emptyResult(managed.prNumber);
  }

  const result: SupersedeStaleIssuePrsResult = {
    candidates: candidates.map((c) => c.number),
    commented: [],
    closed: [],
    errors: [],
    wonElection: true,
    electedPr: managed.prNumber,
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
