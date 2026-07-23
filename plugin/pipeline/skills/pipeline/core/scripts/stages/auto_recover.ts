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
import { attestPipelineComment } from "./review-parsing.ts";
import { getOnDiskForIssue, hasCommitsAhead, removeWorktree } from "../worktree.ts";
import { recordRecovery } from "../evidence-bundle.ts";
import { emitCorrectionEvent } from "../correction.ts";
import * as path from "node:path";
import type { RunStoreDeps } from "../run-store.ts";
import type { Outcome, PipelineConfig } from "../types.ts";

const RECOVERY_MARKER = "## Pipeline: Auto-Recovery";
const RECOVERY_LIMIT_MARKER = `${RECOVERY_MARKER} Limit`;

/**
 * Count distinct recovery attempts from issue comments. Deduplicates by the
 * round token `(N/M)` so that a retry which posts the same marker twice
 * (accepted-but-transient network error) still counts as one attempt.
 * Exported for unit tests.
 */
export function countRecoveryAttempts(comments: { body: string }[]): number {
  const rounds = new Set(
    comments
      .filter((c) => c.body.includes(RECOVERY_MARKER) && !c.body.startsWith(RECOVERY_LIMIT_MARKER))
      .map((c) => c.body.match(/\(\d+\/\d+\)/)?.[0] ?? "")
      .filter(Boolean),
  );
  return rounds.size;
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAutoRecoveryLimitComment(cfg: PipelineConfig, recoveryCount: number): string {
  return attestPipelineComment(
    "auto-recovery-limit",
    [
      RECOVERY_LIMIT_MARKER,
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
}

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildAutoRecoveryComment(cfg: PipelineConfig, recoveryCount: number): string {
  return attestPipelineComment(
    "auto-recovery",
    [
      `${RECOVERY_MARKER} (${recoveryCount + 1}/${cfg.auto_recovery_max_retries})`,
      "",
      "Implementation failed with no commits produced. Worktree cleaned up and issue reset to **ready** for retry.",
      "",
      "---",
      "*Automated by Claude Code Pipeline Skill*",
    ].join("\n"),
  );
}

/** IO seam for {@link tryAutoRecover} so unit tests inject fakes — no real gh/git. */
export interface AutoRecoverDeps {
  getOnDiskForIssue: typeof getOnDiskForIssue;
  hasCommitsAhead: typeof hasCommitsAhead;
  getIssueDetail: typeof getIssueDetail;
  removeWorktree: typeof removeWorktree;
  postComment: typeof postComment;
  removeLabel: typeof removeLabel;
  addLabel: typeof addLabel;
}

const defaultAutoRecoverDeps: AutoRecoverDeps = {
  getOnDiskForIssue,
  hasCommitsAhead,
  getIssueDetail,
  removeWorktree,
  postComment,
  removeLabel,
  addLabel,
};

export async function tryAutoRecover(
  cfg: PipelineConfig,
  issueNumber: number,
  // Evidence-bundle run/state dir (#147); when set, each recovery event is
  // recorded. Undefined → recording disabled (no fs side effects in tests).
  stateDir?: string,
  // Run directory for the correction_event ledger (#499); when set, a durably
  // successful recovery emits one `source_kind: "retry"` correction_event.
  // Undefined → emission disabled (no fs side effects in tests).
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
  deps: AutoRecoverDeps = defaultAutoRecoverDeps,
): Promise<Outcome> {
  const wt = await deps.getOnDiskForIssue(cfg, issueNumber);
  if (!wt) {
    return { advanced: false, status: "no-op", reason: "no worktree to recover" };
  }

  // Only auto-recover if HEAD has no commits past origin/{base}.
  if (await deps.hasCommitsAhead(wt.path, cfg.base_branch)) {
    return { advanced: false, status: "no-op", reason: "worktree already has commits" };
  }

  const detail = await deps.getIssueDetail(cfg, issueNumber);
  // Dedupe by round token so a retried marker post doesn't inflate the count.
  const recoveryCount = countRecoveryAttempts(detail.comments);

  // Always remove the failed worktree before retry.
  await deps.removeWorktree(cfg, issueNumber, wt.slug);

  if (recoveryCount >= cfg.auto_recovery_max_retries) {
    await deps.postComment(cfg, issueNumber, buildAutoRecoveryLimitComment(cfg, recoveryCount));
    return {
      advanced: false,
      status: "blocked",
      reason: `auto-recovery limit reached (${recoveryCount}/${cfg.auto_recovery_max_retries})`,
    };
  }

  // Reset labels: remove implementing + blocked, add ready.
  try {
    await deps.removeLabel(cfg, issueNumber, "pipeline:implementing");
  } catch {
    /* ignore */
  }
  try {
    await deps.removeLabel(cfg, issueNumber, "blocked");
  } catch {
    /* ignore */
  }
  await deps.addLabel(cfg, issueNumber, "pipeline:ready");

  await deps.postComment(cfg, issueNumber, buildAutoRecoveryComment(cfg, recoveryCount));

  // Evidence bundle (#147): record the recovery event. Best-effort + gated on
  // stateDir, so unit tests have no filesystem side effects.
  if (stateDir) {
    await recordRecovery(stateDir, issueNumber, {
      trigger: "no-commits",
      round: recoveryCount + 1,
      at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    }).catch(() => {});
  }

  // #499: the reset above just durably succeeded (labels swapped, comment
  // posted) — this IS the accepted correction (another attempt is granted),
  // as distinct from the "blocked" no-further-retry path above (no event) and
  // the earlier no-op/no-worktree returns (no event).
  if (runDir) {
    await emitCorrectionEvent(runDir, {
      issue: issueNumber,
      repo: cfg.repo,
      run_id: path.basename(runDir),
      stage: "implementing",
      source_kind: "retry",
      failure_class: "harness-crash",
      evidence_ref: { kind: "blocker", id: "no-commits" },
      correction: `auto-recovery ${recoveryCount + 1}/${cfg.auto_recovery_max_retries}: reset implementing → ready for another attempt`,
      reusable: "unknown",
    }, runStoreDeps).catch(() => {});
  }

  return {
    advanced: true,
    from: "implementing",
    to: "ready",
    summary: `auto-recovery ${recoveryCount + 1}/${cfg.auto_recovery_max_retries}`,
  };
}
