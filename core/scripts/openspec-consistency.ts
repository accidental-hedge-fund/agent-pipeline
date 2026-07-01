import { findLatestCommentMatching, getIssueDetail, setBlocked } from "./gh.ts";
import {
  extractSpecDivergenceDirection,
  reviewCommentFlagsSpecDivergence,
  type SpecDivergenceDirection,
} from "./review-policy.ts";
import { gitInWorktree } from "./worktree.ts";
import { DELTA_REVIEW_MARKER_PREFIX, extractReviewedSha } from "./stages/review.ts";
import type { Outcome, PipelineConfig, Stage } from "./types.ts";
import { withTrailers } from "./traceability.ts";
import type { ValidateResult } from "./openspec.ts";
import type { HarnessResult } from "./harness.ts";

/** One branch commit with the repo-relative paths it changed. Ordered: index 0
 * is the earliest commit in the range, last is HEAD. */
export interface FixCommit {
  sha: string;
  paths: string[];
}

/**
 * Result of a bounded spec-delta repair attempt (#356).
 * "cleared"           — repair committed and stale-delta re-check passed; advance.
 * "disallowed-files"  — attempt changed files outside the allowed set; rejected/rolled back.
 * "invalid"           — `openspec validate <id>` failed after repair; not committed.
 * "still-stale"       — repair committed but the stale-delta re-check still shows staleness.
 * "not-verifiable"    — bringing the delta into agreement cannot be verified without
 *                       changing application code; repair not attempted.
 * "already-attempted" — a repair was already attempted in this run; second attempt skipped.
 * "error"             — unexpected failure during the repair orchestration.
 */
export type BoundedRepairResult =
  | "cleared"
  | "disallowed-files"
  | "invalid"
  | "still-stale"
  | "not-verifiable"
  | "already-attempted"
  | "error";

/** Deps for {@link enforceSpecConsistencyGuard} — injectable fakes in tests. */
export interface SpecConsistencyDeps {
  branchDeveloperCommits: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>;
  getIssueDetail: typeof getIssueDetail;
  setBlocked: typeof setBlocked;
  /** Stage to attach to the blocker. Defaults to pre-merge for the archive backstop. */
  blockStage?: Stage;
  /**
   * Optional: attempt one bounded automatic spec-delta repair when the direction is
   * `spec-behind-code`. Called at most once per run; if absent the guard blocks
   * immediately with a spec-delta-alignment reason without attempting repair.
   * Returns the repair outcome which drives the final block decision (#356).
   */
  attemptBoundedRepair?: (
    changeId: string,
    issueNumber: number,
    pipelineRunId: string,
  ) => Promise<BoundedRepairResult>;
  /** Pipeline-run ID for traceability trailers in repair commits. */
  pipelineRunId?: string;
  /**
   * Return the HEAD SHA of the worktree so the guard can correlate the review
   * verdict with the current post-fix state (#356 finding 2). When absent the
   * SHA staleness check is skipped. Production call sites inject this; tests that
   * do not provide it exercise the pre-correlation behaviour.
   */
  getHeadSha?: (wtPath: string) => Promise<string | null>;
}

/**
 * Disambiguating backstop for OpenSpec changes (#356). Classifies any
 * `spec-divergence` finding by direction — `code-behind-spec` (the active spec
 * already requires the target behavior; the implementation must change) or
 * `spec-behind-code` (the accepted implementation moved past the delta; the spec
 * delta must be updated) — and acts accordingly:
 *
 *   - `code-behind-spec` or unclassified → return null (advance); a fix round is
 *     expected to change implementation; the guard does not block on file-order alone.
 *   - `spec-behind-code` → attempt one bounded automatic spec-delta repair (if
 *     deps.attemptBoundedRepair is provided), then block if the repair did not
 *     clear the stale-delta condition.
 *
 * "Stale" is still gated by the structural file-order check (`specDeltaIsStale`)
 * AND a `category: spec-divergence` marker in the latest review comment. Direction
 * is read from the structured `direction: <token>` marker that `formatReviewComment`
 * emits, never from reviewer prose. See #106 for the prior design; #356 for why
 * the direction disambiguation is necessary.
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

  // Classify direction from the structured marker — never from prose (#356).
  const direction = extractSpecDivergenceDirection(reviewBody);

  // code-behind-spec: the spec already requires the behavior; the fix round is
  // expected to change implementation to align with it. Do not block.
  // Unclassified: insufficient positive evidence of spec staleness. Do not block.
  if (direction !== "spec-behind-code") return null;

  // Correlate the review SHA with the current HEAD (#356 finding 2): a direction
  // marker from a review verdict that predates the latest developer commit is stale
  // relative to the post-fix state. Without a current-head signal, treat the
  // direction as unclassified — do not drive the stale-delta decision from a
  // pre-fix marker alone.
  if (deps.getHeadSha) {
    const headSha = await deps.getHeadSha(wtPath);
    const reviewShaResult = extractReviewedSha([{ body: reviewBody }]);
    const reviewedSha = reviewShaResult?.sha ?? null;
    if (reviewedSha && headSha && reviewedSha !== headSha) {
      // The review was done on a different commit than the current HEAD.
      // The direction marker does not correspond to the post-fix state.
      return null;
    }
  }

  // spec-behind-code: the active delta is stale relative to accepted behavior.
  // Attempt one bounded automatic repair before blocking (when the dep is wired).
  if (deps.attemptBoundedRepair) {
    const repairResult = await deps.attemptBoundedRepair(
      stale,
      issueNumber,
      deps.pipelineRunId ?? "",
    );
    if (repairResult === "cleared") return null;

    const reason = specDeltaAlignmentBlockReason(stale, repairResult);
    await deps.setBlocked(
      cfg,
      issueNumber,
      reason,
      deps.blockStage ?? "pre-merge",
      "openspec-stale-delta",
    );
    return { advanced: false, status: "blocked", reason, blockerKind: "openspec-stale-delta" };
  }

  // No repair capability: block with spec-delta-alignment reason.
  const reason = specDeltaAlignmentBlockReason(stale, null);
  await deps.setBlocked(
    cfg,
    issueNumber,
    reason,
    deps.blockStage ?? "pre-merge",
    "openspec-stale-delta",
  );
  return { advanced: false, status: "blocked", reason, blockerKind: "openspec-stale-delta" };
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

/**
 * Direction-specific block reason for the `spec-behind-code` case (#356).
 * States that spec-delta alignment is required, with guidance on whether automatic
 * repair was attempted and why it did not converge.
 */
export function specDeltaAlignmentBlockReason(
  id: string,
  repairResult: BoundedRepairResult | null,
): string {
  const intro = [
    `OpenSpec change \`${id}\` has a **spec-delta alignment** issue: the active spec delta is stale`,
    `relative to the accepted current implementation (\`direction: spec-behind-code\`). Archiving now`,
    `would fold a delta into the living \`openspec/specs/\` that no longer describes the merged behavior.`,
  ].join("\n");

  let detail = "";
  if (repairResult === "disallowed-files") {
    detail = [
      "",
      `An automatic spec-delta repair was attempted but changed files outside the allowed set`,
      `(\`openspec/changes/${id}/specs/**\` and \`tasks.md\`). The attempt was rejected and not committed.`,
    ].join("\n");
  } else if (repairResult === "invalid") {
    detail = [
      "",
      `An automatic spec-delta repair was attempted but produced an invalid OpenSpec change`,
      `(\`openspec validate ${id}\` failed). The attempt was not committed.`,
    ].join("\n");
  } else if (repairResult === "still-stale") {
    detail = [
      "",
      `An automatic spec-delta repair was committed but the stale-delta guard still shows the delta`,
      `as stale. Manual spec-delta alignment is required.`,
    ].join("\n");
  } else if (repairResult === "not-verifiable") {
    detail = [
      "",
      `Bringing the spec delta into agreement cannot be verified without also changing application code,`,
      `so automatic repair was not attempted.`,
    ].join("\n");
  } else if (repairResult === "already-attempted") {
    detail = [
      "",
      `A bounded spec-delta repair was already attempted in this run and did not converge.`,
      `A second automatic attempt is not allowed.`,
    ].join("\n");
  } else if (repairResult === "error") {
    detail = [
      "",
      `An automatic spec-delta repair attempt encountered an unexpected error. Manual intervention is required.`,
    ].join("\n");
  }

  const resolution = [
    "",
    `To resolve, update \`openspec/changes/${id}/specs/**\` (and \`tasks.md\`) so the spec delta matches`,
    `the accepted implementation behavior, then run \`openspec validate ${id}\` and push.`,
    `Any commit that brings the spec delta into agreement clears this guard.`,
  ].join("\n");

  return intro + detail + resolution;
}

/**
 * Block reason for the `code-behind-spec` case (#356): the active spec delta
 * already requires the target behavior but the implementation does not yet satisfy it.
 * This reason is exported for callers that block when a `code-behind-spec` divergence
 * persists beyond the run's fix-round limits; the consistency guard itself returns null
 * (no block) for this direction so fix rounds can proceed.
 */
export function codeAlignmentBlockReason(id: string): string {
  return [
    `OpenSpec change \`${id}\` has a **code alignment** issue: the active spec delta already requires`,
    `the target behavior, but the most recent review verdict flags the implementation for violating it`,
    `(\`direction: code-behind-spec\`). The implementation must be changed to satisfy the spec.`,
    ``,
    `Update the implementation so it matches the requirement in \`openspec/changes/${id}/specs/**\`,`,
    `then re-run the pipeline so the fix round can verify the alignment.`,
  ].join("\n");
}

/**
 * Legacy stale-delta block reason (kept for backward compatibility with callers
 * that do not yet pass a direction-aware path). Prefer `specDeltaAlignmentBlockReason`
 * or `codeAlignmentBlockReason` for new call sites.
 * @deprecated Use the direction-specific reason functions instead.
 */
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

// Re-export SpecDivergenceDirection so guard callers can read direction from outcomes.
export type { SpecDivergenceDirection };

// ---------------------------------------------------------------------------
// Bounded spec-delta repair (#356)
// ---------------------------------------------------------------------------

/**
 * Build the harness prompt for a bounded spec-delta repair attempt.
 * Instructs the harness to update only the change's spec and tasks files.
 */
function buildSpecRepairPrompt(changeId: string, issueNumber: number, pipelineRunId: string): string {
  return [
    `## OpenSpec Spec-Delta Repair`,
    ``,
    `The OpenSpec change \`${changeId}\` for issue #${issueNumber} has a stale spec delta.`,
    `The accepted implementation has moved past what the active spec delta describes,`,
    `but the spec delta has not been updated to reflect the accepted behavior.`,
    ``,
    `**Your task**: Update the spec delta files to accurately describe the current`,
    `accepted implementation behavior.`,
    ``,
    `**Critical constraints**:`,
    `- You MUST ONLY modify files under \`openspec/changes/${changeId}/specs/**\` and`,
    `  \`openspec/changes/${changeId}/tasks.md\``,
    `- You MUST NOT modify any application source code, test files, or any other files.`,
    `- If bringing the spec delta into agreement with the accepted implementation`,
    `  requires changing application code, make NO changes and do nothing.`,
    ``,
    `**After updating**:`,
    `1. Run \`openspec validate ${changeId}\` to confirm the delta is structurally valid.`,
    `2. Commit all changes. The commit message must include these git trailers:`,
    ``,
    `   Issue: #${issueNumber}`,
    `   Pipeline-Run: ${pipelineRunId}`,
  ].join("\n");
}

/** Inject type — matches the real `invoke` from harness.ts. */
export type InvokeFn = (
  harness: string,
  wtPath: string,
  prompt: string,
  opts?: { timeoutSec?: number; model?: string | null; sandbox?: boolean },
) => Promise<HarnessResult>;

/** Inject type — matches `openspec.validateItem` from openspec.ts. */
export type ValidateFn = (dir: string, name: string) => Promise<ValidateResult>;

/**
 * Perform one bounded automatic spec-delta repair attempt (#356).
 *
 * Invokes the implementer harness with a constrained prompt, validates that
 * only the active change's spec and tasks files were modified, runs
 * `openspec validate <changeId>`, commits any remaining staged changes
 * with traceability trailers, and re-runs the stale-delta structural check.
 *
 * Returns a {@link BoundedRepairResult} that the caller uses to determine
 * whether to advance or block. All git mutations are rolled back on failure.
 *
 * @param gitFn - Injectable git wrapper (defaults to `gitInWorktree` in prod).
 * @param invokeFn - Injectable harness invoker (defaults to `invoke` in prod).
 * @param validateFn - Injectable spec validator (defaults to `openspec.validateItem`).
 */
export async function performBoundedSpecRepair(
  cfg: PipelineConfig,
  changeId: string,
  issueNumber: number,
  pipelineRunId: string,
  wtPath: string,
  gitFn: typeof gitInWorktree,
  branchDeveloperCommitsFn: (wtPath: string, baseBranch: string) => Promise<FixCommit[]>,
  invokeFn: InvokeFn,
  validateFn: ValidateFn,
): Promise<BoundedRepairResult> {
  const harness = cfg.harnesses?.implementer;
  if (!harness) return "error";

  const headBefore = (await gitFn(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();

  const prompt = buildSpecRepairPrompt(changeId, issueNumber, pipelineRunId);
  const result = await invokeFn(harness, wtPath, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: cfg.models?.fix ?? null,
    sandbox: cfg.harness_sandbox,
  });

  if (!result.success) return "error";

  // Determine the HEAD after the harness ran (it may have committed).
  const headAfter = (await gitFn(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true })).stdout.trim();

  const allowedFile = (p: string) =>
    p.startsWith(`openspec/changes/${changeId}/specs/`) ||
    p === `openspec/changes/${changeId}/tasks.md`;

  // Collect all files changed since headBefore (committed + uncommitted).
  const allChangedFiles = new Set<string>();

  if (headBefore && headAfter && headBefore !== headAfter) {
    const diffOut = await gitFn(wtPath, ["diff", "--name-only", headBefore, headAfter], { ignoreFailure: true });
    for (const f of diffOut.stdout.split("\n").map((s) => s.trim().replace(/\\/g, "/")).filter(Boolean)) {
      allChangedFiles.add(f);
    }
  }

  const statusOut = await gitFn(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  for (const line of statusOut.stdout.split("\n").filter(Boolean)) {
    const f = line.slice(3).trim().replace(/\\/g, "/");
    if (f) allChangedFiles.add(f);
  }

  // No changes at all — harness could not determine how to repair the spec
  // without touching application code.
  if (allChangedFiles.size === 0) return "not-verifiable";

  // Check the allow-list.
  const disallowed = [...allChangedFiles].filter((f) => !allowedFile(f));
  if (disallowed.length > 0) {
    // Roll back ALL changes to headBefore to leave the worktree clean.
    if (headBefore) {
      await gitFn(wtPath, ["reset", "--hard", headBefore], { ignoreFailure: true });
      await gitFn(wtPath, ["clean", "-fd", `openspec/changes/${changeId}/`], { ignoreFailure: true });
    }
    return "disallowed-files";
  }

  // Commit any uncommitted allowed changes left by the harness.
  if (statusOut.stdout.trim()) {
    await gitFn(wtPath, ["add", "-A"], { ignoreFailure: true });
    const commitResult = await gitFn(
      wtPath,
      ["commit", "-m", withTrailers(`spec-delta repair: ${changeId}`, issueNumber, pipelineRunId)],
      { ignoreFailure: true },
    );
    if (commitResult.code !== 0) return "error";
  }

  // Validate the openspec change in its post-repair state.
  const validation = await validateFn(wtPath, changeId);
  if (!validation.valid) {
    // Roll back to headBefore.
    if (headBefore) {
      await gitFn(wtPath, ["reset", "--hard", headBefore], { ignoreFailure: true });
    }
    return "invalid";
  }

  // Re-check the structural staleness after repair.
  const freshCommits = await branchDeveloperCommitsFn(wtPath, cfg.base_branch);
  return specDeltaIsStale(changeId, freshCommits) ? "still-stale" : "cleared";
}
