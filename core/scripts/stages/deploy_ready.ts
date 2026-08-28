// Terminal stage. Posts a final summary on the issue, removes the worktree.
// Idempotent — safe to call multiple times.

import {
  addLabelToPr,
  getIssueDetail,
  getPrDetail,
  getPrForIssue,
  ghRunForTest,
  postComment,
  postPrComment,
  setBlocked,
} from "../gh.ts";
import { attestPipelineComment } from "./review-parsing.ts";
import { LABEL_PREFIX } from "../types.ts";
import {
  getOnDiskForIssue,
  gitProveMergeResultDeps,
  proveMergeResultInBase,
  removeManagedWorktreeSafely,
  type ProveMergeResultDeps,
  type SafeRemoveDeps,
  type VerifiedMergeProof,
} from "../worktree.ts";
import type { Outcome, PipelineConfig } from "../types.ts";
import {
  RUN_SCHEMA_VERSION,
  appendEvent,
  defaultRunStoreDeps,
  readTrustedSurfaceDecision,
  type RunStoreDeps,
} from "../run-store.ts";
import { allowsReadyToDeploy, normalizeFullSha } from "../trusted-surface.ts";
import { isTrustedSurfaceSentinelSha } from "../trusted-surface-candidate.ts";
import {
  disposeCompareResult,
  parkFailClosedRepositoryControlDrift,
  runControlsCheck,
} from "../repository-control-drift.ts";
import {
  stagedPoliciesFromDecls,
  type PolicyLifecycleState,
} from "../stage-policy-lifecycle.ts";

/** Injectable seams for {@link finalize} unit tests (#759 / #1243 / #1274). */
export interface FinalizeDeps {
  getOnDiskForIssue?: typeof getOnDiskForIssue;
  removeManagedWorktreeSafely?: typeof removeManagedWorktreeSafely;
  safeRemoveDeps?: SafeRemoveDeps;
  getIssueDetail?: typeof getIssueDetail;
  getPrForIssue?: typeof getPrForIssue;
  getPrDetail?: typeof getPrDetail;
  addLabelToPr?: typeof addLabelToPr;
  postComment?: typeof postComment;
  postPrComment?: typeof postPrComment;
  setBlocked?: typeof setBlocked;
  proveMergeResultInBase?: typeof proveMergeResultInBase;
  proveMergeDeps?: ProveMergeResultDeps;
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

  // Repository-control drift gate (#695): only when desired state is configured.
  // Observation / fail_open never block; enforcing + fail_closed blocks on non-in_sync.
  // No automatic forge remediation — parks with typed reason via setBlocked.
  if (cfg.repository_control_desired_state) {
    const desired = cfg.repository_control_desired_state;
    // Materialize with lineage; bare enforcing is rejected at config load and here.
    const staged = stagedPoliciesFromDecls(
      (cfg.staged_policies ?? []).map((p) => ({
        policy_id: p.policy_id,
        state: p.state as PolicyLifecycleState,
        acceptance: p.acceptance,
        lineage: p.lineage,
      })),
    );
    const lifecycle =
      desired.policy_id != null
        ? staged.find((p) => p.policy_id === desired.policy_id)?.state ?? null
        : null;
    try {
      const check = await runControlsCheck(
        {
          desired,
          lifecycle_state: lifecycle,
          staged_policies: staged,
        },
        {
          ghRun: (args, runOpts) => ghRunForTest(args, runOpts),
        },
      );
      const result = check.results[0];
      const decision =
        check.decisions[0] ??
        (result
          ? disposeCompareResult({
              result,
              desired,
              lifecycle_state: lifecycle,
            })
          : null);
      if (decision?.blocks_readiness && result) {
        await parkFailClosedRepositoryControlDrift(issueNumber, decision, result, {
          setBlocked: async ({ issueNumber: n, reason }) => {
            await setBlocked(cfg, n, reason, "ready-to-deploy", "needs-human");
          },
        });
        console.log(
          `[pipeline] #${issueNumber}: ready-to-deploy refused — repository-control drift ` +
            `${result.outcome} (${decision.reason_code ?? "unknown"})`,
        );
        return {
          advanced: false,
          status: "blocked",
          reason: `repository-control drift fail-closed: ${decision.reason_code ?? result.outcome}`,
          blockerKind: "needs-human",
        };
      }
    } catch (err) {
      // Fail closed only when risk_class is fail_closed and lifecycle is enforcing;
      // otherwise record and continue (compare errors must not invent in_sync).
      const risk = desired.risk_class ?? "observation";
      if (lifecycle === "enforcing" && risk === "fail_closed") {
        const reason =
          `repository-control drift fail-closed: live compare failed (${(err as Error).message}). ` +
          `Agent Pipeline does not auto-remediate forge settings.`;
        await setBlocked(cfg, issueNumber, reason, "ready-to-deploy", "needs-human");
        return {
          advanced: false,
          status: "blocked",
          reason,
          blockerKind: "needs-human",
        };
      }
      console.log(
        `[pipeline] #${issueNumber}: repository-control drift check error (non-blocking for ` +
          `${lifecycle ?? "unbound"}/${risk}): ${(err as Error).message}`,
      );
    }
  }

  // Trusted-surface fail-closed (#691): current runs with a runDir MUST have a
  // durable decision. Missing decision is not treated as historical passthrough
  // on the ready-to-deploy path — only external/historical consumers may opt
  // into `allowsReadyToDeploy(null, { enforcement: "historical" })`.
  const decision = runDir
    ? await readTrustedSurfaceDecision(runDir, storeDeps)
    : null;
  if (runDir) {
    if (!allowsReadyToDeploy(decision)) {
      const reason =
        decision?.reason?.summary ??
        (decision
          ? "trusted-surface decision blocked readiness"
          : "trusted-surface decision missing for current run (fail closed)");
      console.log(
        `[pipeline] #${issueNumber}: ready-to-deploy refused — trusted_surface outcome=` +
          `${decision?.outcome ?? "missing"} (${decision?.reason?.code ?? "missing_decision"}): ${reason}`,
      );
      return {
        advanced: false,
        status: "blocked",
        reason: `trusted-surface blocked: ${reason}`,
        blockerKind: "needs-human",
      };
    }
  }

  const getIssueFn = deps.getIssueDetail ?? getIssueDetail;
  const getPrFn = deps.getPrForIssue ?? getPrForIssue;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const addLabelFn = deps.addLabelToPr ?? addLabelToPr;
  const postCommentFn = deps.postComment ?? postComment;
  const postPrCommentFn = deps.postPrComment ?? postPrComment;
  const detail = await getIssueFn(cfg, issueNumber);
  const prNumber = await getPrFn(cfg, issueNumber);
  const getOnDiskFn = deps.getOnDiskForIssue ?? getOnDiskForIssue;
  const safeRemoveFn = deps.removeManagedWorktreeSafely ?? removeManagedWorktreeSafely;

  // Idempotency: only post if no existing summary.
  const alreadyPosted = detail.comments.some((c) => c.body.startsWith(FINAL_SUMMARY_MARKER));

  // Bind the ready-to-deploy tag (and the terminal completion summary) to the
  // SHA trusted-surface checked. Re-fetch before any completion side effect so
  // a push cannot publish "## Pipeline Complete" and then refuse the tag (#1243).
  if (prNumber && runDir) {
    const expectedSha = normalizeFullSha(decision?.candidate_sha);
    if (!expectedSha || isTrustedSurfaceSentinelSha(expectedSha)) {
      const reason =
        "stale_pr_head: trusted-surface candidate SHA is missing or sentinel; refusing ready-to-deploy tag";
      console.log(`[pipeline] #${issueNumber}: ready-to-deploy refused — ${reason}`);
      return {
        advanced: false,
        status: "blocked",
        reason,
        blockerKind: "needs-human",
      };
    }
    const live = await getPrDetailFn(cfg, prNumber).catch(() => null);
    const liveSha = normalizeFullSha(live?.head_sha);
    if (!liveSha || liveSha !== expectedSha) {
      const reason =
        `stale_pr_head: linked PR #${prNumber} head ` +
        `${liveSha ?? "unresolved"} does not match trusted-surface candidate ${expectedSha}`;
      console.log(`[pipeline] #${issueNumber}: ready-to-deploy refused — ${reason}`);
      return {
        advanced: false,
        status: "blocked",
        reason,
        blockerKind: "needs-human",
      };
    }
  }

  // Mirror the terminal label onto the linked PR. gh pr edit --add-label is
  // idempotent, so re-running finalize is a no-op on the second pass.
  if (prNumber) {
    try {
      await addLabelFn(cfg, prNumber, `${LABEL_PREFIX}ready-to-deploy`);
      console.log(`[pipeline] #${issueNumber}: PR #${prNumber} tagged pipeline:ready-to-deploy`);
    } catch (err) {
      // Best-effort: if the label doesn't exist on the repo or gh is unhappy,
      // don't block finalize. The issue still carries the canonical label.
      console.log(
        `[pipeline] #${issueNumber}: could not tag PR #${prNumber} (${(err as Error).message}); skipping (non-blocking)`,
      );
    }
  }

  if (!alreadyPosted) {
    const prRef = prNumber ? `PR #${prNumber}` : "(no PR found)";
    // Surface unresolved advisory findings at the merge point. Each advisory
    // advance posts a "advanced under severity policy" comment; if any exist, the
    // merge authority should account for them before merging (they were not fixed).
    const advisoryRounds = detail.comments.filter(
      (c) => c.body.startsWith("## Pipeline: Review") && c.body.includes("advanced under severity policy"),
    ).length;
    const summary = buildPipelineCompleteComment(cfg, issueNumber, detail.title, prRef, advisoryRounds);
    await postCommentFn(cfg, issueNumber, summary);
    console.log(`[pipeline] #${issueNumber}: final summary posted`);
    // Mirror the summary onto the PR — the merge decision happens there, not
    // on the issue. Best-effort; the issue copy is authoritative.
    if (prNumber) {
      try {
        await postPrCommentFn(cfg, prNumber, summary);
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

  // Remove worktree through evaluateRemoveSafety (#759). Terminal ready-to-deploy
  // still refuses local-only commits and (without force) dirty trees so
  // uncommitted operator work is not destroyed. After a proven squash merge,
  // mint bound proof and pass it into the shared wrapper (#1274) — never
  // force:true (that would discard dirty work).
  const wt = await getOnDiskFn(cfg, issueNumber);
  if (wt) {
    let verifiedMergeProof: VerifiedMergeProof | undefined;
    if (prNumber) {
      const live = await getPrDetailFn(cfg, prNumber).catch(() => null);
      if (live?.state === "merged" && live.merge_commit_sha) {
        const prove = deps.proveMergeResultInBase ?? proveMergeResultInBase;
        const proveDeps = deps.proveMergeDeps ?? gitProveMergeResultDeps(cfg);
        verifiedMergeProof =
          (await prove(
            {
              issue: issueNumber,
              pr: prNumber,
              base: cfg.base_branch ?? "main",
              mergeResultOid: live.merge_commit_sha,
            },
            proveDeps,
          )) ?? undefined;
      }
    }
    const removed = await safeRemoveFn(cfg, issueNumber, wt.slug, wt.path, {
      force: false,
      ...(deps.safeRemoveDeps ?? {}),
      ...(verifiedMergeProof
        ? {
            verifiedMergeProof,
            prNumber,
            expectedMergeResultOid: verifiedMergeProof.mergeResultOid,
          }
        : {}),
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
