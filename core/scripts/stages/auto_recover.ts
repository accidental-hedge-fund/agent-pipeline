// Auto-recovery for items stuck at `pipeline:implementing` + `blocked` with
// no commits ahead of base. Resets the issue back to `pipeline:ready` so the
// orchestrator can take another swing.
//
// Capped at cfg.auto_recovery_max_retries. After the cap, the issue stays
// blocked permanently and a final comment is posted.

import {
  getIssueDetail,
  postComment,
  removeLabel,
  transition,
} from "../gh.ts";
import { attestPipelineComment } from "./review-parsing.ts";
import {
  getOnDiskForIssue,
  gitInWorktree,
  hasCommitsAhead,
  removeManagedWorktreeSafely,
  removeWorktree,
  type SafeRemoveDeps,
  type SafeRemoveResult,
} from "../worktree.ts";
import {
  claimOrResumeRecoveryEpisode,
  countRecoveryEpisodeTreatments,
  recordRecoveryEpisodeTreatment,
  stageRecoveryEpisodeKey,
} from "../issue-stage-adapters.ts";
import { emptyStageAttemptLedger, hydrateStageAttemptLedger, type StageAttemptLedger } from "../stage-attempt-ledger.ts";
import {
  defaultRecoverySupervisorReport,
  type ReportOperationObservation,
} from "../operation-observation.ts";
import { recordRecovery } from "../evidence-bundle.ts";
import { emitCorrectionEvent } from "../correction.ts";
import * as path from "node:path";
import type { RunStoreDeps } from "../run-store.ts";
import type { Outcome, PipelineConfig, Stage } from "../types.ts";

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
  /**
   * @deprecated Prefer {@link removeManagedWorktreeSafely} via
   * `removeManagedWorktreeSafely`. Retained for tests that spy on the raw
   * remove after safety has already been evaluated.
   */
  removeWorktree: typeof removeWorktree;
  /** Safety-gated remove (#759). Defaults to {@link removeManagedWorktreeSafely}. */
  removeManagedWorktreeSafely?: (
    cfg: PipelineConfig,
    issueNumber: number,
    slug: string,
    resolvedPath?: string,
    safeDeps?: SafeRemoveDeps,
  ) => Promise<SafeRemoveResult>;
  postComment: typeof postComment;
  removeLabel: typeof removeLabel;
  /** Approved projector owner for implementing → ready. Not a command-local addLabel. */
  transition: (
    cfg: PipelineConfig,
    issueNumber: number,
    fromStage: Stage,
    toStage: Stage,
    summary: string,
  ) => Promise<void>;
  reportObservation?: ReportOperationObservation;
  logicalOperationId?: string | null;
  /** Injected Recovery Episode ledger. Production hydrates from runDir. */
  stageAttemptLedger?: StageAttemptLedger;
  /** Observed candidate HEAD. Tests inject a fake; production uses git. */
  resolveHeadSha?: (worktreePath: string) => Promise<string | null>;
}

async function defaultResolveHeadSha(worktreePath: string): Promise<string | null> {
  const res = await gitInWorktree(worktreePath, ["rev-parse", "HEAD"], {
    ignoreFailure: true,
    timeoutMs: 5_000,
  });
  const sha = res.stdout.trim().toLowerCase();
  if (res.code !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
  return sha;
}

const defaultAutoRecoverDeps: AutoRecoverDeps = {
  getOnDiskForIssue,
  hasCommitsAhead,
  getIssueDetail,
  removeWorktree,
  removeManagedWorktreeSafely,
  postComment,
  removeLabel,
  transition,
  resolveHeadSha: defaultResolveHeadSha,
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
  const report = deps.reportObservation ?? defaultRecoverySupervisorReport;
  const resolveHeadSha = deps.resolveHeadSha ?? defaultResolveHeadSha;
  const claimEpisode = (candidateEpoch: string, evidence: string, message: string) =>
    claimOrResumeRecoveryEpisode({
      domain: cfg.domain ?? "unknown",
      logical_operation_id: deps.logicalOperationId,
      repository: cfg.repo,
      issue: issueNumber,
      message,
      reportObservation: report,
      episodeKey: stageRecoveryEpisodeKey({
        issue: issueNumber,
        candidateEpoch,
        evidence,
      }),
    });

  const wt = await deps.getOnDiskForIssue(cfg, issueNumber);
  if (!wt) {
    claimEpisode("unresolved", `auto_recover:#${issueNumber}:no-worktree`, `auto_recover unresolved wait for #${issueNumber}: no worktree`);
    return { advanced: false, status: "no-op", reason: "no worktree to recover" };
  }

  const commitsAhead = await deps.hasCommitsAhead(wt.path, cfg.base_branch);
  const observedHead = (await resolveHeadSha(wt.path))?.trim() ?? "";
  if (!observedHead) {
    claimEpisode("unresolved", `auto_recover:#${issueNumber}:unresolved-head`, `auto_recover unresolved wait for #${issueNumber}: candidate HEAD unreadable`);
    return { advanced: false, status: "no-op", reason: "candidate HEAD unreadable" };
  }

  if (commitsAhead) {
    claimEpisode(observedHead, "auto_recover:commits-ahead", `auto_recover observed commits-ahead for #${issueNumber}`);
    return { advanced: false, status: "no-op", reason: "worktree already has commits" };
  }

  const episodeKey = stageRecoveryEpisodeKey({
    issue: issueNumber,
    candidateEpoch: observedHead,
    evidence: "auto_recover:no-commits",
  });
  const episode = claimOrResumeRecoveryEpisode({
    domain: cfg.domain ?? "unknown",
    logical_operation_id: deps.logicalOperationId,
    repository: cfg.repo,
    issue: issueNumber,
    message: `auto_recover claims Recovery Episode for #${issueNumber} at ${observedHead.slice(0, 7)}`,
    reportObservation: report,
    episodeKey,
  });

  const detail = await deps.getIssueDetail(cfg, issueNumber);
  // Dedupe by round token so a retried marker post doesn't inflate the count.
  const commentCount = countRecoveryAttempts(detail.comments);
  const hydrated = hydrateStageAttemptLedger(runDir);
  let ledger = deps.stageAttemptLedger ?? (hydrated.ok ? hydrated.ledger : emptyStageAttemptLedger());
  const ledgerCount = countRecoveryEpisodeTreatments(ledger, String(issueNumber));
  // Ledger is production authority when it has treatments. Comments are
  // compatibility fallback only — never the sole cap authority (#1328).
  const recoveryCount = ledgerCount > 0 ? ledgerCount : commentCount;

  if (recoveryCount >= cfg.auto_recovery_max_retries) {
    // Compatibility observation only. Comment-counted cap cannot terminalize
    // or end RecoverySupervisor ownership (#1328).
    report(episode);
    recordRecoveryEpisodeTreatment({
      ledger,
      headSha: observedHead,
      action: "no_run_recovery",
      itemId: String(issueNumber),
      evidenceFingerprint: `auto-recover-cap-${recoveryCount}`,
      typedReason: "auto-recovery-cap-cooling",
      runDir: deps.stageAttemptLedger ? undefined : runDir,
      episodeKey,
      strategyBound: cfg.auto_recovery_max_retries,
    });
    return {
      advanced: false,
      status: "blocked",
      reason: `auto-recovery limit reached (${recoveryCount}/${cfg.auto_recovery_max_retries}) — Cooling, ownership retained`,
    };
  }

  // RecoverySupervisor treatment: reset-to-ready when no commits ahead.
  // Shared remove-safety ladder (#759 / #622). Dirty or local-only trees are
  // retained rather than force-destroyed.
  const safeRemove =
    deps.removeManagedWorktreeSafely ?? removeManagedWorktreeSafely;
  const removed = await safeRemove(cfg, issueNumber, wt.slug, wt.path, {
    // Wire the dep remove so unit tests that spy on removeWorktree still see the call
    // after safety passes.
    removeWorktree: deps.removeWorktree,
    force: false,
  });
  if (!removed.removed) {
    return {
      advanced: false,
      status: "no-op",
      reason: `auto-recover refused unsafe worktree remove: ${removed.reason}`,
    };
  }

  // Clear `blocked` first: if it fails, the issue stays blocked and neither
  // the projector-ready reset nor the recovery comment/correction event may
  // be recorded as if the reset succeeded (#499 finding c41e8715). The
  // implementing → ready swap goes through `transition`, the approved
  // projector owner — not a command-local addLabel.
  try {
    await deps.removeLabel(cfg, issueNumber, "blocked");
  } catch (err) {
    return {
      advanced: false,
      status: "blocked",
      reason: `auto-recovery failed to clear the blocked label: ${(err as Error).message}`,
    };
  }
  await deps.transition(
    cfg,
    issueNumber,
    "implementing",
    "ready",
    `auto-recovery ${recoveryCount + 1}/${cfg.auto_recovery_max_retries}: reset implementing → ready for another attempt`,
  );

  await deps.postComment(cfg, issueNumber, buildAutoRecoveryComment(cfg, recoveryCount));

  recordRecoveryEpisodeTreatment({
    ledger,
    headSha: observedHead,
    action: "no_run_recovery",
    itemId: String(issueNumber),
    evidenceFingerprint: `auto-recover-${recoveryCount + 1}`,
    typedReason: "auto-recover-reset-to-ready",
    runDir: deps.stageAttemptLedger ? undefined : runDir,
    episodeKey,
    strategyBound: cfg.auto_recovery_max_retries,
  });

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
