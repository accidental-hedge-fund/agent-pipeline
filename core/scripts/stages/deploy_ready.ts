// Terminal stage. Posts a final summary on the issue, removes the worktree.
// Idempotent — safe to call multiple times.

import { addLabelToPr, getIssueDetail, getPrForIssue, postComment } from "../gh.ts";
import { LABEL_PREFIX } from "../types.ts";
import { getForIssue, removeWorktree } from "../worktree.ts";
import type { Outcome, PipelineConfig } from "../types.ts";

const FINAL_SUMMARY_MARKER = "## Pipeline Complete";

export async function finalize(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<Outcome> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const prNumber = await getPrForIssue(cfg, issueNumber);

  // Idempotency: only post if no existing summary.
  const alreadyPosted = detail.comments.some((c) => c.body.startsWith(FINAL_SUMMARY_MARKER));

  if (!alreadyPosted) {
    const prRef = prNumber ? `PR #${prNumber}` : "(no PR found)";
    const summary = [
      FINAL_SUMMARY_MARKER,
      "",
      `- **Issue**: #${issueNumber} — ${detail.title}`,
      `- **${prRef}**: ready to merge`,
      `- **Implementer**: ${cfg.harnesses.implementer}`,
      `- **Reviewer**: ${cfg.harnesses.reviewer}`,
      `- **CI**: passing`,
      `- **Conflicts**: none`,
      "",
      "Ready to merge. The pipeline does NOT auto-merge — push the merge button when you're satisfied.",
      "",
      "---",
      cfg.marker_footer,
    ].join("\n");
    await postComment(cfg, issueNumber, summary);
    console.log(`[pipeline] #${issueNumber}: final summary posted`);
  } else {
    console.log(`[pipeline] #${issueNumber}: final summary already exists`);
  }

  // Mirror the terminal label onto the linked PR. gh pr edit --add-label is
  // idempotent, so re-running finalize is a no-op on the second pass.
  if (prNumber) {
    try {
      await addLabelToPr(cfg, prNumber, `${LABEL_PREFIX}ready-to-deploy`);
      console.log(`[pipeline] #${issueNumber}: PR #${prNumber} tagged pipeline:ready-to-deploy`);
    } catch (err) {
      // Best-effort: if the label doesn't exist on the repo or gh is unhappy,
      // don't block finalize. The issue still carries the canonical label.
      console.log(
        `[pipeline] #${issueNumber}: could not tag PR #${prNumber} (${(err as Error).message}); skipping (non-blocking)`,
      );
    }
  }

  // Remove worktree.
  const wt = await getForIssue(cfg, issueNumber);
  if (wt) {
    await removeWorktree(cfg, issueNumber, wt.slug);
    console.log(`[pipeline] #${issueNumber}: worktree removed`);
  }

  return {
    advanced: false,
    status: "finalized",
    reason: prNumber ? `PR #${prNumber} ready to merge` : "ready-to-deploy (no PR)",
  };
}
