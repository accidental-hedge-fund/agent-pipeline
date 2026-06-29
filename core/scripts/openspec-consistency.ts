import { findLatestCommentMatching, getIssueDetail, setBlocked } from "./gh.ts";
import { reviewCommentFlagsSpecDivergence } from "./review-policy.ts";
import { gitInWorktree } from "./worktree.ts";
import { DELTA_REVIEW_MARKER_PREFIX } from "./stages/review.ts";
import type { Outcome, PipelineConfig, Stage } from "./types.ts";

/** One branch commit with the repo-relative paths it changed. Ordered: index 0
 * is the earliest commit in the range, last is HEAD. */
export interface FixCommit {
  sha: string;
  paths: string[];
}

/** Deps for {@link enforceSpecConsistencyGuard} — injectable fakes in tests. */
export interface SpecConsistencyDeps {
  branchDeveloperCommits: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
  getIssueDetail: typeof getIssueDetail;
  setBlocked: typeof setBlocked;
  /** Stage to attach to the blocker. Defaults to pre-merge for the archive backstop. */
  blockStage?: Stage;
}

/**
 * Backstop for OpenSpec changes whose implementation outgrew their spec delta.
 * Returns a blocked Outcome when a change's spec delta is stale relative to the
 * implementation, or null to proceed. "Stale" requires ALL of:
 *   1. developer/fix commits on the branch changed implementation files,
 *   2. the change's `specs/**` were NOT updated after the last implementation
 *      change (order-aware), and
 *   3. the most recent review verdict tagged a finding `category: spec-divergence`.
 *
 * Condition 3 is read from the STRUCTURED category marker that
 * `formatReviewComment` emits (`reviewCommentFlagsSpecDivergence`), never by
 * keyword-matching the reviewer's prose.
 */
export async function enforceSpecConsistencyGuard(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  changeIds: string[],
  deps: SpecConsistencyDeps,
): Promise<Outcome | null> {
  const devCommits = await deps.branchDeveloperCommits(wtPath, cfg.base_branch);
  if (devCommits.length === 0) return null;

  const stale = changeIds.find((id) => specDeltaIsStale(id, devCommits));
  if (!stale) return null;

  const detail = await deps.getIssueDetail(cfg, issueNumber);
  const reviewBody = latestReviewBody(detail.comments);
  if (!reviewBody || !reviewCommentFlagsSpecDivergence(reviewBody)) return null;

  const staleMsg = staleSpecDeltaBlockReason(stale);
  await deps.setBlocked(cfg, issueNumber, staleMsg, deps.blockStage ?? "pre-merge", "openspec-stale-delta");
  return { advanced: false, status: "blocked", reason: staleMsg, blockerKind: "openspec-stale-delta" };
}

/**
 * Per-commit paths for all non-pipeline-internal commits on the branch, oldest
 * first. Per-commit, not a collapsed range, so stale detection can compare the
 * order of the last impl-changing commit against the last spec-delta-changing
 * commit.
 */
export async function computeBranchDeveloperCommits(
  gitFn: typeof gitInWorktree,
  wtPath: string,
  baseBranch: string,
  opts: { skipSubjectsStartingWith?: string[] } = {},
): Promise<FixCommit[]> {
  const log = await gitFn(
    wtPath,
    ["log", "--reverse", "--format=%H%x1f%s", `origin/${baseBranch}..HEAD`],
    { ignoreFailure: true },
  );
  const result: FixCommit[] = [];
  for (const line of log.stdout.split("\n")) {
    const sep = line.indexOf("\x1f");
    if (sep === -1) continue;
    const sha = line.slice(0, sep).trim();
    if (!sha) continue;
    const subj = line.slice(sep + 1).trim();
    if ((opts.skipSubjectsStartingWith ?? []).some((prefix) => subj.startsWith(prefix))) continue;
    const d = await gitFn(wtPath, ["diff", "--name-only", `${sha}^`, sha], { ignoreFailure: true });
    const paths = d.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    result.push({ sha, paths });
  }
  return result;
}

/**
 * Structural half of the guard: did developer/fix commits change implementation
 * files (anything outside `openspec/`) in a commit that came AFTER the last
 * spec-delta update?
 */
export function specDeltaIsStale(id: string, commits: FixCommit[]): boolean {
  if (commits.length === 0) return false;
  const specPrefix = `openspec/changes/${id}/specs/`;
  let lastSpecIdx = -1;
  let lastImplIdx = -1;
  for (let i = 0; i < commits.length; i++) {
    const paths = commits[i].paths.map((p) => p.replace(/\\/g, "/").trim()).filter(Boolean);
    if (paths.some((p) => p.startsWith(specPrefix))) lastSpecIdx = i;
    if (paths.some((p) => !p.startsWith("openspec/"))) lastImplIdx = i;
  }
  return lastImplIdx !== -1 && lastImplIdx > lastSpecIdx;
}

function latestReviewBody(
  comments: { author: string; body: string; createdAt: string }[],
): string | null {
  const m = findLatestCommentMatching(
    comments,
    (b) =>
      b.startsWith("## Review 1") ||
      b.startsWith("## Review 2") ||
      b.startsWith(DELTA_REVIEW_MARKER_PREFIX),
  );
  return m?.body ?? null;
}

/** Operator-facing block reason naming the stale-delta condition and the fix. */
export function staleSpecDeltaBlockReason(id: string): string {
  return [
    `OpenSpec change \`${id}\` has a stale spec delta: fix rounds changed implementation files but did`,
    `not update the change's \`specs/**\`, and the most recent review verdict tagged a finding`,
    `\`category: spec-divergence\`. Archiving now would fold a delta into the living \`openspec/specs/\``,
    `that does not describe the merged implementation.`,
    ``,
    `To resolve, update \`openspec/changes/${id}/specs/**\` (and \`tasks.md\`) so the spec matches the`,
    `implemented behavior, then re-run \`openspec validate ${id}\` and push. Any commit that brings the`,
    `spec delta into agreement clears this guard. If the divergence finding is a false positive, the`,
    `correct resolution is still to update the delta so the living spec states the actual behavior.`,
  ].join("\n");
}
