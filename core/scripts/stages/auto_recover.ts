// Auto-recovery for items stuck at `pipeline:implementing` + `blocked` with
// no commits ahead of base. Resets the issue back to `pipeline:ready` so the
// orchestrator can take another swing.
//
// Capped at cfg.auto_recovery_max_retries. After the cap, the issue stays
// blocked permanently and a final comment is posted.

import {
  addLabel,
  getIssueDetail,
  postComment,
  removeLabel,
} from "../gh.ts";
import { getForIssue, hasCommitsAhead, removeWorktree } from "../worktree.ts";
import type { Outcome, PipelineConfig } from "../types.ts";

const RECOVERY_MARKER = "## Pipeline: Auto-Recovery";

export async function tryAutoRecover(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<Outcome> {
  const wt = await getForIssue(cfg, issueNumber);
  if (!wt) {
    return { advanced: false, status: "no-op", reason: "no worktree to recover" };
  }

  // Only auto-recover if HEAD has no commits past origin/{base}.
  if (await hasCommitsAhead(wt.path, cfg.base_branch)) {
    return { advanced: false, status: "no-op", reason: "worktree already has commits" };
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const recoveryCount = detail.comments.filter((c) => c.body.includes(RECOVERY_MARKER)).length;

  // Always remove the failed worktree before retry.
  await removeWorktree(cfg, issueNumber, wt.slug);

  if (recoveryCount >= cfg.auto_recovery_max_retries) {
    await postComment(
      cfg,
      issueNumber,
      [
        `## Pipeline: Auto-Recovery Limit`,
        "",
        `Implementation produced no commits after ${recoveryCount} retries. ` +
          `This issue may already be resolved on \`${cfg.base_branch}\`, or it may need manual intervention.`,
        "",
        "@comamitc",
        "",
        "---",
        "*Automated by Claude Code Pipeline Skill*",
      ].join("\n"),
    );
    return {
      advanced: false,
      status: "blocked",
      reason: `auto-recovery limit reached (${recoveryCount}/${cfg.auto_recovery_max_retries})`,
    };
  }

  // Reset labels: remove implementing + blocked, add ready.
  try {
    await removeLabel(cfg, issueNumber, "pipeline:implementing");
  } catch {
    /* ignore */
  }
  try {
    await removeLabel(cfg, issueNumber, "blocked");
  } catch {
    /* ignore */
  }
  await addLabel(cfg, issueNumber, "pipeline:ready");

  await postComment(
    cfg,
    issueNumber,
    [
      `${RECOVERY_MARKER} (${recoveryCount + 1}/${cfg.auto_recovery_max_retries})`,
      "",
      "Implementation failed with no commits produced. Worktree cleaned up and issue reset to **ready** for retry.",
      "",
      "---",
      "*Automated by Claude Code Pipeline Skill*",
    ].join("\n"),
  );

  return {
    advanced: true,
    from: "implementing",
    to: "ready",
    summary: `auto-recovery ${recoveryCount + 1}/${cfg.auto_recovery_max_retries}`,
  };
}
