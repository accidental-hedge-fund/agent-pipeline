// Terminal stage. Posts a final summary on the issue, removes the worktree.
// Idempotent — safe to call multiple times.

import { addLabelToPr, getIssueDetail, getPrForIssue, postComment, postPrComment } from "../gh.ts";
import { attestPipelineComment } from "./review-parsing.ts";
import { LABEL_PREFIX } from "../types.ts";
import { getOnDiskForIssue, removeWorktree } from "../worktree.ts";
import type { Outcome, PipelineConfig } from "../types.ts";
import { RUN_SCHEMA_VERSION, appendEvent, defaultRunStoreDeps, type RunStoreDeps } from "../run-store.ts";

const FINAL_SUMMARY_MARKER = "## Pipeline Complete";

export async function finalize(
  cfg: PipelineConfig,
  issueNumber: number,
  runDir?: string,
  runStoreDeps?: RunStoreDeps,
): Promise<Outcome> {
  const detail = await getIssueDetail(cfg, issueNumber);
  const prNumber = await getPrForIssue(cfg, issueNumber);

  // Idempotency: only post if no existing summary.
  const alreadyPosted = detail.comments.some((c) => c.body.startsWith(FINAL_SUMMARY_MARKER));

  if (!alreadyPosted) {
    const prRef = prNumber ? `PR #${prNumber}` : "(no PR found)";
    // Surface unresolved advisory findings at the merge point. Each advisory
    // advance posts a "advanced under severity policy" comment; if any exist, the
    // human should weigh them before merging (they were not fixed).
    const advisoryRounds = detail.comments.filter(
      (c) => c.body.startsWith("## Pipeline: Review") && c.body.includes("advanced under severity policy"),
    ).length;
    const rawSummary = [
      FINAL_SUMMARY_MARKER,
      "",
      `- **Issue**: #${issueNumber} — ${detail.title}`,
      `- **${prRef}**: ready to merge`,
      `- **Implementer**: ${cfg.harnesses.implementer}`,
      `- **Reviewer**: ${cfg.harnesses.reviewer}`,
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
      "Ready to merge. The pipeline does NOT auto-merge — push the merge button when you're satisfied.",
      "",
      "---",
      cfg.marker_footer,
    ].join("\n");
    const summary = attestPipelineComment("pipeline-complete", rawSummary);
    await postComment(cfg, issueNumber, summary);
    console.log(`[pipeline] #${issueNumber}: final summary posted`);
    // Mirror the summary onto the PR — the merge decision happens there, not on
    // the issue. Best-effort; the issue copy is authoritative.
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

  // Remove worktree.
  const wt = await getOnDiskForIssue(cfg, issueNumber);
  if (wt) {
    await removeWorktree(cfg, issueNumber, wt.slug);
    console.log(`[pipeline] #${issueNumber}: worktree removed`);
    if (runDir) {
      const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      await appendEvent(runDir, { schema_version: RUN_SCHEMA_VERSION, type: "worktree_removed", at, _localPath: wt.path }, runStoreDeps ?? defaultRunStoreDeps).catch(() => {});
    }
  }

  return {
    advanced: false,
    status: "finalized",
    reason: prNumber ? `PR #${prNumber} ready to merge` : "ready-to-deploy (no PR)",
  };
}
