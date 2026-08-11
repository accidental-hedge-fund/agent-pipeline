// Pre-merge conflict / rebase domain (#628).
// Owns merge-conflict recovery, rebase-attempted markers, and rebase-and-push helpers.

import * as fs from "node:fs";
import * as path from "node:path";
import { getPrDetail, setBlocked } from "../gh.ts";
import {
  branchName,
  getOnDiskForIssue,
  gitInWorktree,
} from "../worktree.ts";
import { PIPELINE_INTERNAL_MARKER_FILES } from "../salvage-harness-work.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { Outcome, PipelineConfig } from "../types.ts";
import { preMergeBlocked } from "./pre-merge-shared.ts";
import type { AdvancePreMergeDeps } from "./pre-merge-routing.ts";
import {
  claimAndPersistStageAttempt,
  completeAndPersistStageAttempt,
  hasAttempted,
  hydrateStageAttemptLedger,
  type StageAttemptLedgerDeps,
} from "../stage-attempt-ledger.ts";
import {
  runCoveredCandidateMutation,
} from "../candidate-integrity.ts";
import { appendEvent, defaultRunStoreDeps } from "../run-store.ts";
import { DEFAULT_GIT_PUSH_AUTH, gitExecForwardingEnv, runConfiguredGitPush } from "../git-push-auth.ts";

/** Residual legacy marker path — salvage exclusion only; engine does not write it (#759). */
export const REBASE_MARKER_FILE = PIPELINE_INTERNAL_MARKER_FILES[0];


/**
 * Outcome of a rebase+push recovery side-effect with authoritative HEAD check (#771).
 * `rebased; CI re-running` is valid only when `ok && verified && headMoved`.
 * When the side-effect reports success but HEAD cannot be re-read, `verified: false`
 * is distinct from a verified no-op — callers must re-evaluate without escalating
 * on the pre-rebase SHA's failed checks.
 */
export type RebasePushResult =
  | { ok: true; verified: true; headMoved: true; beforeSha: string; afterSha: string }
  | { ok: true; verified: true; headMoved: false; beforeSha: string; afterSha: string }
  | { ok: true; verified: false; beforeSha: string }
  | { ok: false; reason: string; beforeSha?: string; afterSha?: string };

/** Wait reason when rebase/push succeeded but post-rebase HEAD could not be verified. */
export const REBASE_HEAD_UNVERIFIED_WAIT_REASON =
  "rebase completed; re-evaluating PR head";



/**
 * After a rebase/push side-effect, compare authoritative PR head SHA before/after
 * so callers can claim `rebased; CI re-running` only when HEAD actually moved (#771).
 * Unreadable post-rebase HEAD after a successful side-effect is **unverified**, not
 * a verified no-op — callers must not escalate on the pre-push failed checks.
 */
export async function resolveRebasePushResult(
  beforeSha: string,
  gitOk: boolean,
  afterSha: string | undefined,
  gitFailReason = "rebase or push failed",
): Promise<RebasePushResult> {
  if (afterSha === undefined || afterSha === "") {
    // Successful side-effect without a readable HEAD is unverified (may have moved).
    // Failed side-effect without HEAD still fails closed without claiming movement.
    return gitOk
      ? { ok: true, verified: false, beforeSha }
      : { ok: false, reason: "could not re-read PR head after rebase", beforeSha };
  }
  if (!gitOk) {
    return { ok: false, reason: gitFailReason, beforeSha, afterSha };
  }
  if (beforeSha !== afterSha) {
    return { ok: true, verified: true, headMoved: true, beforeSha, afterSha };
  }
  return { ok: true, verified: true, headMoved: false, beforeSha, afterSha };
}


// ---------------------------------------------------------------------------
// Rebase tracking
// ---------------------------------------------------------------------------

/**
 * Conflict recovery shared by the early-conflict check (#95) and the Step 2
 * mergeability gate: attempt one auto-rebase, bounded by the stage-attempt
 * ledger (head SHA + conflict_rebase) so an unresolvable conflict cannot retry
 * a rebase on every poll iteration (#759). Legacy worktree marker is no longer
 * sole authority and is not written. When the rebase cannot resolve the
 * conflict (or was already attempted), blocks with a conflict-specific reason
 * rather than a generic CI-timeout or CI-failure message.
 */
export async function recoverFromMergeConflict(
  cfg: PipelineConfig,
  issueNumber: number,
  stateDir?: string,
  deps: AdvancePreMergeDeps = {},
  /** PR number for authoritative HEAD re-read after rebase (#771). */
  prNumber?: number,
  /** Run directory for stage-attempt ledger durability (#759). */
  runDir?: string,
): Promise<Outcome> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;
  const ledgerRunDir = runDir ?? stateDir;
  const ledgerDeps: StageAttemptLedgerDeps | undefined = deps.stageAttemptLedgerDeps;

  const wt = await getForIssueFn(cfg, issueNumber);

  // Resolve head for ledger key; fall back to worktree-path-only deps for tests
  // that inject rebaseAlreadyAttempted without a PR.
  let headShaForLedger: string | undefined;
  if (prNumber !== undefined) {
    try {
      headShaForLedger = (await getPrDetailFn(cfg, prNumber)).head_sha;
    } catch {
      headShaForLedger = undefined;
    }
  }

  let alreadyRebased: boolean;
  if (headShaForLedger && ledgerRunDir) {
    const hydrated = hydrateStageAttemptLedger(ledgerRunDir, ledgerDeps);
    alreadyRebased = hydrated.ok
      ? hasAttempted(hydrated.ledger, headShaForLedger, "conflict_rebase") ||
        hasAttempted(hydrated.ledger, headShaForLedger, "ci_rebase")
      : true; // fail closed on corrupt ledger
  } else if (headShaForLedger && deps.rebaseAttemptedForHead) {
    alreadyRebased = deps.rebaseAttemptedForHead(headShaForLedger);
  } else {
    // Legacy injectable path (tests) — worktree marker check as cache only.
    alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
  }

  if (!alreadyRebased && wt) {
    const beforeSha = headShaForLedger;

    // Claim-before-side-effect when we have head + runDir.
    if (beforeSha && ledgerRunDir) {
      const hydrated = hydrateStageAttemptLedger(ledgerRunDir, ledgerDeps);
      if (!hydrated.ok) {
        await setBlockedFn(
          cfg,
          issueNumber,
          `PR has a merge conflict; stage-attempt ledger unusable (${hydrated.reason}) — manual rebase needed.`,
          "pre-merge",
          "merge-conflict",
        );
        return preMergeBlocked("merge conflict", "merge-conflict");
      }
      const claimed = claimAndPersistStageAttempt(
        ledgerRunDir,
        hydrated.ledger,
        {
          headSha: beforeSha,
          action: "conflict_rebase",
          typedReason: "early_conflict_rebase",
        },
        ledgerDeps,
      );
      if (!claimed.ok) {
        await setBlockedFn(
          cfg,
          issueNumber,
          `PR has a merge conflict; could not durably claim rebase attempt (${claimed.reason}) — manual rebase needed.`,
          "pre-merge",
          "merge-conflict",
        );
        return preMergeBlocked("merge conflict", "merge-conflict");
      }
      if (!claimed.created && hasAttempted(claimed.ledger, beforeSha, "conflict_rebase")) {
        // Prior claim — do not re-fire.
        await setBlockedFn(
          cfg,
          issueNumber,
          "PR has a merge conflict with the base branch that could not be automatically rebased — manual rebase needed.",
          "pre-merge",
          "merge-conflict",
        );
        return preMergeBlocked("merge conflict", "merge-conflict");
      }
    }

    // #857: wrap conflict-recovery head movement in candidate-integrity when runDir known.
    let gitOk: boolean;
    const tryRebase = () => tryRebaseAndPushFn(cfg, issueNumber);
    if (ledgerRunDir && cfg.base_branch && beforeSha) {
      const integrityResult = await runCoveredCandidateMutation(
        {
          storeRoot: ledgerRunDir,
          subject: {
            run_id: path.basename(ledgerRunDir),
            issue: issueNumber,
            pr: prNumber ?? null,
          },
          mutation_method: "rebase",
          base_ref: cfg.base_branch,
          worktreePath: wt.path,
          gitInWorktree: deps.gitInWorktree ?? gitInWorktree,
          resolveBaseSha: async () => {
            const r = await (deps.gitInWorktree ?? gitInWorktree)(
              wt.path,
              ["rev-parse", `origin/${cfg.base_branch}`],
              { ignoreFailure: true },
            );
            return r.code === 0 ? r.stdout.trim() || null : null;
          },
          resolveCandidateSha: async () => {
            if (prNumber === undefined) {
              const local = await (deps.gitInWorktree ?? gitInWorktree)(
                wt.path,
                ["rev-parse", "HEAD"],
                { ignoreFailure: true },
              );
              return local.code === 0 ? local.stdout.trim() || null : null;
            }
            try {
              return (await getPrDetailFn(cfg, prNumber)).head_sha;
            } catch {
              return null;
            }
          },
          emitEvent: async (event) => {
            await appendEvent(ledgerRunDir, event as never, defaultRunStoreDeps).catch(() => {});
          },
        },
        tryRebase,
      );
      // Side-effect success vs integrity disposition are separate: HEAD re-read
      // + resolveRebasePushResult decide "rebased; CI re-running"; integrity
      // store holds invalidation for readiness/review reuse.
      gitOk = integrityResult.aborted
        ? false
        : integrityResult.mutation_result === true;
    } else {
      gitOk = await tryRebase();
    }

    let afterSha: string | undefined;
    if (prNumber !== undefined) {
      try {
        afterSha = (await getPrDetailFn(cfg, prNumber)).head_sha;
      } catch {
        afterSha = undefined;
      }
    }

    // Prefer authoritative HEAD-moved truth when prNumber is available (#771).
    // Without prNumber, fall back to git-ok alone (legacy single-arg call sites).
    // Unverified post-rebase HEAD after success must wait to re-evaluate, not block
    // as if the tip were still the pre-rebase conflicted SHA (#771 review 2).
    if (beforeSha !== undefined && prNumber !== undefined) {
      const rebaseResult = await resolveRebasePushResult(beforeSha, gitOk, afterSha);
      if (stateDir) {
        const summary =
          rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved
            ? "conflict-recovery rebase succeeded; CI re-running"
            : rebaseResult.ok && !rebaseResult.verified
              ? "conflict-recovery rebase reported success but PR head could not be re-read"
              : rebaseResult.ok
                ? "conflict-recovery rebase reported success but HEAD unchanged"
                : "conflict-recovery rebase failed";
        await recordCommand(
          stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved ? 0 : 1,
            0,
            summary,
          ),
        ).catch(() => {});
      }
      // Ledger claim already charged; complete for visibility. Do NOT write
      // worktree `.pipeline-rebase-attempted` (#759).
      markRebaseAttemptedFn(wt.path);
      if (ledgerRunDir && beforeSha) {
        const hydrated = hydrateStageAttemptLedger(ledgerRunDir, ledgerDeps);
        if (hydrated.ok) {
          const attempt = hydrated.ledger.attempts.find(
            (a) => a.head_sha === beforeSha && a.action === "conflict_rebase",
          );
          if (attempt) {
            completeAndPersistStageAttempt(
              ledgerRunDir,
              hydrated.ledger,
              {
                attemptId: attempt.attempt_id,
                succeeded: !!(rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved),
                error: rebaseResult.ok
                  ? undefined
                  : "conflict-recovery rebase failed or HEAD unchanged",
              },
              ledgerDeps,
            );
          }
        }
      }
      if (rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved) {
        return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
      }
      if (rebaseResult.ok && !rebaseResult.verified) {
        return {
          advanced: false,
          status: "waiting",
          reason: REBASE_HEAD_UNVERIFIED_WAIT_REASON,
        };
      }
      // verified no-op or failed → fall through to block
    } else {
      const claimCiRerunning = gitOk;
      if (stateDir) {
        await recordCommand(
          stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            `git rebase origin/${cfg.base_branch} && git push --force-with-lease`,
            claimCiRerunning ? 0 : 1,
            0,
            claimCiRerunning
              ? "conflict-recovery rebase succeeded; CI re-running"
              : "conflict-recovery rebase failed",
          ),
        ).catch(() => {});
      }
      // Informational only — engine does not write the worktree marker (#759).
      markRebaseAttemptedFn(wt.path);
      if (claimCiRerunning) {
        return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
      }
    }
  }
  await setBlockedFn(
    cfg,
    issueNumber,
    "PR has a merge conflict with the base branch that could not be automatically rebased — manual rebase needed.",
    "pre-merge",
    "merge-conflict",
  );
  return preMergeBlocked("merge conflict", "merge-conflict");
}

/**
 * Domain reconcile for early-conflict rebase bounds (#759): ledger-first,
 * residual worktree marker is cache/defense-in-depth only.
 */
export function reconcileConflictRebaseState(input: {
  headSha?: string;
  ledgerAttempted: boolean;
  worktreeMarkerPresent?: boolean;
}): {
  actions: Array<{ kind: "attempt_rebase" } | { kind: "block_manual_rebase" }>;
} {
  if (input.ledgerAttempted) {
    return { actions: [{ kind: "block_manual_rebase" }] };
  }
  // Marker alone without ledger is not sole authority — still allow attempt
  // when head is known and ledger is empty (migration). When no head, marker
  // may bound same-session tests that only inject the marker path.
  if (!input.headSha && input.worktreeMarkerPresent) {
    return { actions: [{ kind: "block_manual_rebase" }] };
  }
  return { actions: [{ kind: "attempt_rebase" }] };
}

/**
 * Legacy residual check: presence of leftover `.pipeline-rebase-attempted`.
 * Not production attempt authority (#759). Prefer ledger `hasAttempted`.
 */
export function rebaseAlreadyAttempted(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, REBASE_MARKER_FILE));
}

/**
 * Retired writer (#759): the engine SHALL NOT create `.pipeline-rebase-attempted`
 * as attempt authority. Kept as a no-op (or injectable spy in tests) so call
 * sites and deps remain stable without dual-writing marker authority.
 */
export function markRebaseAttempted(_wtPath: string): void {
  // Intentionally empty — durable authority is the stage-attempt ledger.
  void _wtPath;
}

export async function tryRebaseAndPush(
  cfg: PipelineConfig,
  issueNumber: number,
): Promise<boolean> {
  const wt = await getOnDiskForIssue(cfg, issueNumber);
  if (!wt) return false;
  const branch = branchName(issueNumber, wt.slug);

  const fetch = await gitInWorktree(wt.path, ["fetch", "origin", cfg.base_branch], {
    ignoreFailure: true,
  });
  if (fetch.code !== 0) return false;

  const rebase = await gitInWorktree(wt.path, ["rebase", `origin/${cfg.base_branch}`], {
    ignoreFailure: true,
  });
  if (rebase.code !== 0) {
    await gitInWorktree(wt.path, ["rebase", "--abort"], { ignoreFailure: true });
    return false;
  }

  const pushAuth = cfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH;
  const push = await runConfiguredGitPush({
    cwd: wt.path,
    auth: pushAuth,
    args: ["push", "--force-with-lease", "origin", branch],
    deps: {
      gitConfigGet: async (cwd, key) => {
        const r = await gitInWorktree(cwd, ["config", "--get", key], { ignoreFailure: true });
        return r.code === 0 ? r.stdout.trim() || null : null;
      },
      gitExec: gitExecForwardingEnv(wt.path, gitInWorktree),
    },
  });
  return push.code === 0;
}

