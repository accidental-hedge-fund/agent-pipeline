// Terminal stage. Posts a final summary on the issue, removes the worktree.
// Idempotent — safe to call multiple times.

import { addLabelToPr, getIssueDetail, getPrForIssue, postComment, postPrComment } from "../gh.ts";
import { attestPipelineComment } from "./review-parsing.ts";
import { LABEL_PREFIX } from "../types.ts";
import {
  getOnDiskForIssue,
  removeManagedWorktreeSafely,
  type SafeRemoveDeps,
} from "../worktree.ts";
import type { Outcome, PipelineConfig } from "../types.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  readTrustedSurfaceDecision,
  type RunStoreDeps,
} from "../run-store.ts";
import { allowsReadyToDeploy } from "../trusted-surface.ts";

/** Injectable seams for {@link finalize} unit tests (#759). */
export interface FinalizeDeps {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  removeManagedWorktreeSafely?: typeof removeManagedWorktreeSafely;
  safeRemoveDeps?: SafeRemoveDeps;
}

const FINAL_SUMMARY_MARKER = "## Pipeline Complete";

/** Pure + exported so the PIPELINE_COMMENT_KINDS drift guard exercises the real renderer. */
export function buildPipelineCompleteComment(
  cfg: PipelineConfig,
  issueNumber: number,
  title: string,
  prRef: string,
  advisoryRounds: number,
): string {
  const rawSummary = [
    FINAL_SUMMARY_MARKER,
    "",
    `- **Issue**: #${issueNumber} — ${title}`,
    `- **${prRef}**: ready to merge`,
    `- **Implementer**: ${cfg.harnesses.implementer} (${cfg.harnesses.implementerSource})`,
    `- **Reviewer**: ${cfg.harnesses.reviewer} (${cfg.harnesses.reviewerSource})`,
    `- **CI**: passing`,
    `- **Conflicts**: none`,
    ...(advisoryRounds
      ? [
          "",
          `⚠️ **${advisoryRounds} review round(s) advanced with advisory findings** that were not fixed — ` +
            `review the advisory comments on this PR before merging.`,
        ]
      : []),
    "",
    "Ready to merge. The advance path stops here; use a separately operator-authorized merge command.",
    "",
    "---",
    cfg.marker_footer,
  ].join("\n");
  return attestPipelineComment("pipeline-complete", rawSummary);
}

export async function finalize(
  cfg: PipelineConfig,
  issueNumber: number,
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
  deps: FinalizeDeps = {},
): Promise<Outcome> {
  const storeDeps = runStoreDeps ?? defaultRunStoreDeps;

  // Trusted-surface fail-closed (#691): refuse ready-to-deploy when the run's
  // decision is blocked (or lacks a usable pin after a computed block).
  // Historical runs with no decision record are not invented as passthrough —
  // allowsReadyToDeploy(null) remains true so pre-#691 behavior is preserved.
  if (runDir) {
    const decision = await readTrustedSurfaceDecision(runDir, storeDeps);
    if (!allowsReadyToDeploy(decision)) {
      const reason =
        decision?.reason?.summary ??
        "trusted-surface decision blocked readiness";
      console.log(
        `[pipeline] #${issueNumber}: ready-to-deploy refused — trusted_surface outcome=` +
          `${decision?.outcome ?? "unknown"} (${decision?.reason?.code ?? "blocked"}): ${reason}`,
      );
      return {
        advanced: false,
        status: "blocked",
        reason: `trusted-surface blocked: ${reason}`,
        blockerKind: "needs-human",
      };
    }
  }

  const detail = await getIssueDetail(cfg, issueNumber);
  const prNumber = await getPrForIssue(cfg, issueNumber);
  const getOnDiskFn = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const safeRemoveFn = deps.removeManagedWorktreeSafely ?? removeManagedWorktreeSafely;

  // Idempotency: only post if no existing summary.
  const alreadyPosted = detail.comments.some((c) => c.body.startsWith(FINAL_SUMMARY_MARKER));

  if (!alreadyPosted) {
    const prRef = prNumber ? `PR #${prNumber}` : "(no PR found)";
    // Surface unresolved advisory findings at the merge point. Each advisory
    // advance posts a "advanced under severity policy" comment; if any exist, the
    // merge authority should account for them before merging (they were not fixed).
    const advisoryRounds = detail.comments.filter(
      (c) => c.body.startsWith("## Pipeline: Review") && c.body.includes("advanced under severity policy"),
    ).length;
    const summary = buildPipelineCompleteComment(cfg, issueNumber, detail.title, prRef, advisoryRounds);
    await postComment(cfg, issueNumber, summary);
    console.log(`[pipeline] #${issueNumber}: final summary posted`);
    // Mirror the summary onto the PR — the merge decision happens there, not
    // on the issue. Best-effort; the issue copy is authoritative.
    if (prNumber) {
      try {
        await postPrComment(cfg, prNumber, summary);
      } catch (err) {
        console.log(
          `[pipeline] #${issueNumber}: could not post final summary to PR #${prNumber} ` +
            `(${(err as Error).message}); skipping (non-blocking)`,
        );
      }
    }
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

  // Remove worktree through evaluateRemoveSafety (#759). Terminal ready-to-deploy
  // still refuses local-only commits and (without force) dirty trees so
  // uncommitted operator work is not destroyed.
  const wt = await getOnDiskFn(cfg, issueNumber);
  if (wt) {
    const removed = await safeRemoveFn(cfg, issueNumber, wt.slug, wt.path, {
      force: false,
      ...(deps.safeRemoveDeps ?? {}),
    });
    if (removed.removed) {
      console.log(`[pipeline] #${issueNumber}: worktree removed`);
      if (runDir) {
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "worktree_removed", at, _localPath: wt.path }, storeDeps).catch(() => {});
      }
    } else {
      console.log(
        `[pipeline] #${issueNumber}: worktree retained after ready-to-deploy (${removed.reason})`,
      );
    }
  }

  return {
    advanced: false,
    status: "finalized",
    reason: prNumber ? `PR #${prNumber} ready to merge` : "ready-to-deploy (no PR)",
  };
}
