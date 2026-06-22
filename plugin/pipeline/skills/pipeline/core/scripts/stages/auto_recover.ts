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
import { getOnDiskForIssue, hasCommitsAhead, removeWorktree } from "../worktree.ts";
import { recordRecovery } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig } from "../types.ts";

const RECOVERY_MARKER = "## Pipeline: Auto-Recovery";

export async function tryAutoRecover(
  cfg: PipelineConfig,
  issueNumber: number,
  // Evidence-bundle run/state dir (#147); when set, each recovery event is
  // recorded. Undefined → recording disabled (no fs side effects in tests).
  stateDir?: string,
): Promise<Outcome> {
  const wt = await getOnDiskForIssue(cfg, issueNumber);
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
    // retries:1 — this comment contains RECOVERY_MARKER; a retry on a transient
    // error would double-count it on the next run and inflate the budget check.
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
      { retries: 1 },
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

  // retries:1 — this comment contains RECOVERY_MARKER; a retry on a transient
  // error would post it twice, inflating the recovery count on the next run.
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
    { retries: 1 },
  );

  // Evidence bundle (#147): record the recovery event. Best-effort + gated on
  // stateDir, so unit tests have no filesystem side effects.
  if (stateDir) {
    await recordRecovery(stateDir, issueNumber, {
      trigger: "no-commits",
      round: recoveryCount + 1,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    }).catch(() => {});
  }

  return {
    advanced: true,
    from: "implementing",
    to: "ready",
    summary: `auto-recovery ${recoveryCount + 1}/${cfg.auto_recovery_max_retries}`,
  };
}
