// Human approval checkpoint helpers (#23).
//
// Pure helpers (no network/git calls) for building, parsing, and posting
// checkpoint comments. The advance loop in pipeline.ts uses these alongside
// the label helpers in gh.ts to implement the checkpoint gate.

import { AWAITING_APPROVAL_LABEL } from "../types.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

export const CHECKPOINT_COMMENT_HEADER = "## Pipeline: Awaiting Approval";

// A 40-char all-zero SHA used as a sentinel when no real branch HEAD exists
// (e.g. before the implementing stage has run). Comparing null-SHA to null-SHA
// is equal (no re-issue); comparing null-SHA to a real SHA triggers re-issue.
const NULL_SHA = "0000000000000000000000000000000000000000";

type Comment = { author: string; body: string; createdAt: string };

/** Returns the most recent checkpoint comment, or null if none exists. */
export function findCheckpointComment(comments: Comment[]): Comment | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.startsWith(CHECKPOINT_COMMENT_HEADER)) return comments[i];
  }
  return null;
}

/**
 * Extracts the stage name from a `**Stage**: <stage>` line in a checkpoint comment.
 * Returns null when the line is absent or does not contain a recognisable stage name.
 * Used to scope approval detection so a comment posted for stage A is never treated
 * as an approval for a later stage B (Finding 3).
 */
export function extractCheckpointStage(comment: { body: string }): string | null {
  const m = comment.body.match(/\*\*Stage\*\*:\s*([a-z][a-z-]*)/);
  return m ? m[1] : null;
}

/**
 * Extracts the full SHA from a `<!-- checkpoint-sha: <sha> -->` sentinel.
 * Returns null when the sentinel is absent or does not contain a hex SHA.
 */
export function extractCheckpointSha(comment: { body: string }): string | null {
  const m = comment.body.match(/<!--\s*checkpoint-sha:\s*([a-f0-9]{40})\s*-->/);
  return m ? m[1] : null;
}

/**
 * Builds the full checkpoint comment body including the HTML sentinel and
 * "### How to approve" instructions. `headSha` is the full 40-char SHA (or the
 * null-SHA sentinel when no branch exists yet). An optional `notice` line is
 * inserted after the SHA to explain why the comment was re-issued (e.g. branch
 * advanced).
 */
export function buildCheckpointComment(stage: string, headSha: string, notice?: string): string {
  const displaySha = headSha === NULL_SHA ? "(no branch yet)" : headSha.slice(0, 7);
  const lines = [
    CHECKPOINT_COMMENT_HEADER,
    "",
    `The pipeline has paused before dispatching the **${stage}** stage and is awaiting human approval.`,
    "",
    `**Stage**: ${stage}`,
    `**HEAD**: ${displaySha}`,
  ];
  if (notice) {
    lines.push("", `> ${notice}`);
  }
  lines.push(
    "",
    `<!-- checkpoint-sha: ${headSha} -->`,
    "",
    "### How to approve",
    "",
    "1. Remove the `pipeline:awaiting-approval` label from this issue.",
    "2. Re-invoke the pipeline.",
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  );
  return lines.join("\n");
}

/** IO seam for {@link checkApprovalCheckpoint} — no real GH/git calls in tests. */
export interface CheckpointDeps {
  postCheckpointComment: (issueNumber: number, body: string) => Promise<void>;
  applyAwaitingApprovalLabel: (issueNumber: number) => Promise<void>;
}

/**
 * Evaluate the approval checkpoint for `stage` and return a `waiting` Outcome
 * when the loop should pause, or null when the stage may be dispatched normally.
 *
 * Branches:
 *  (a) stage not in approvalCheckpoints → null (dispatch normally)
 *  (b) label absent + no prior checkpoint comment → fire: post comment + apply label + return waiting
 *  (c) label absent + prior checkpoint comment exists → null (human approved, dispatch normally)
 *  (d) label present + SHA matches → return waiting (unchanged, still pending)
 *  (e) label present + SHA stale or no comment found → re-issue comment + return waiting
 */
export async function checkApprovalCheckpoint(
  stage: Stage,
  cfg: Pick<PipelineConfig, "approvalCheckpoints">,
  issueLabels: string[],
  issueNumber: number,
  headSha: string,
  comments: Comment[],
  deps: CheckpointDeps,
): Promise<Outcome | null> {
  // (a) Not a checkpoint stage — dispatch normally.
  if (!cfg.approvalCheckpoints.includes(stage)) return null;

  const hasAwaitingLabel = issueLabels.includes(AWAITING_APPROVAL_LABEL);
  const checkpointComment = findCheckpointComment(comments);

  if (!hasAwaitingLabel) {
    if (checkpointComment !== null) {
      const commentStage = extractCheckpointStage(checkpointComment);
      if (commentStage === stage) {
        // (c) Human removed the label for THIS stage.
        // Guard against a SHA mismatch: if the branch advanced after the human removed
        // the label (but before the pipeline re-ran), the old approval is for a
        // different commit. Re-issue the checkpoint so the human reviews the new state
        // (#23, Finding 6).
        const storedSha = extractCheckpointSha(checkpointComment);
        if (storedSha !== null && storedSha !== headSha) {
          const oldShort = storedSha.slice(0, 7);
          const newShort = headSha === NULL_SHA ? "(no branch)" : headSha.slice(0, 7);
          const notice = `Branch advanced from ${oldShort} to ${newShort} after label removal; re-issuing checkpoint.`;
          const body = buildCheckpointComment(stage, headSha, notice);
          await deps.applyAwaitingApprovalLabel(issueNumber);
          await deps.postCheckpointComment(issueNumber, body);
          return { advanced: false, status: "waiting", reason: `checkpoint re-issued at stage ${stage} after head advanced` };
        }
        // SHA unchanged (or no sentinel on a hand-crafted comment) — dispatch normally.
        return null;
      }
      // Comment belongs to a different stage — not an approval for this stage.
      // Fall through to (b) and fire the checkpoint for the current stage.
    }
    // (b) First encounter (or comment is for a different stage) — fire the checkpoint.
    // Apply the label BEFORE posting the comment so a partial failure (comment posted
    // but label application throws) leaves the system in a "still pending" state rather
    // than looking approved on the next run.
    const body = buildCheckpointComment(stage, headSha);
    await deps.applyAwaitingApprovalLabel(issueNumber);
    await deps.postCheckpointComment(issueNumber, body);
    return { advanced: false, status: "waiting", reason: `checkpoint awaiting approval at stage ${stage}` };
  }

  // Label is present: still waiting. Check if SHA changed.
  if (checkpointComment === null) {
    // (e) Label present but comment was deleted — re-issue.
    const body = buildCheckpointComment(stage, headSha);
    await deps.postCheckpointComment(issueNumber, body);
    return { advanced: false, status: "waiting", reason: `checkpoint awaiting approval at stage ${stage}` };
  }

  const storedSha = extractCheckpointSha(checkpointComment);
  if (storedSha !== null && storedSha === headSha) {
    // (d) SHA unchanged — still waiting, don't re-post.
    return { advanced: false, status: "waiting", reason: `checkpoint awaiting approval at stage ${stage}` };
  }

  // (e) SHA changed (or sentinel could not be parsed) — re-issue with notice.
  const oldShort = storedSha ? storedSha.slice(0, 7) : "unknown";
  const newShort = headSha === NULL_SHA ? "(no branch)" : headSha.slice(0, 7);
  const notice = `Branch advanced from ${oldShort} to ${newShort}; checkpoint re-issued.`;
  const body = buildCheckpointComment(stage, headSha, notice);
  await deps.postCheckpointComment(issueNumber, body);
  return { advanced: false, status: "waiting", reason: `checkpoint awaiting approval at stage ${stage}` };
}

export { NULL_SHA };
