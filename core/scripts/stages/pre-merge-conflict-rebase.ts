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
 * mergeability gate: attempt one auto-rebase, bounded by the per-worktree
 * rebase marker so an unresolvable conflict cannot retry a rebase on every
 * poll iteration. When the rebase cannot resolve the conflict (or was already
 * attempted), blocks with a conflict-specific reason rather than a generic
 * CI-timeout or CI-failure message.
 */
export async function recoverFromMergeConflict(
  cfg: PipelineConfig,
  issueNumber: number,
  stateDir?: string,
  deps: AdvancePreMergeDeps = {},
  /** PR number for authoritative HEAD re-read after rebase (#771). */
  prNumber?: number,
): Promise<Outcome> {
  const getForIssueFn = deps.getForIssue ?? getOnDiskForIssue;
  const getPrDetailFn = deps.getPrDetail ?? getPrDetail;
  const setBlockedFn = deps.setBlocked ?? setBlocked;
  const tryRebaseAndPushFn = deps.tryRebaseAndPush ?? tryRebaseAndPush;
  const rebaseAlreadyAttemptedFn = deps.rebaseAlreadyAttempted ?? rebaseAlreadyAttempted;
  const markRebaseAttemptedFn = deps.markRebaseAttempted ?? markRebaseAttempted;

  const wt = await getForIssueFn(cfg, issueNumber);
  const alreadyRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
  if (!alreadyRebased && wt) {
    let beforeSha: string | undefined;
    if (prNumber !== undefined) {
      try {
        beforeSha = (await getPrDetailFn(cfg, prNumber)).head_sha;
      } catch {
        beforeSha = undefined;
      }
    }

    const gitOk = await tryRebaseAndPushFn(cfg, issueNumber);

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
      markRebaseAttemptedFn(wt.path);
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
      if (claimCiRerunning) {
        markRebaseAttemptedFn(wt.path);
        return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
      }
      // Failed: mark so we do not thrash rebase on the next poll (#771).
      markRebaseAttemptedFn(wt.path);
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

export function rebaseAlreadyAttempted(wtPath: string): boolean {
  return fs.existsSync(path.join(wtPath, REBASE_MARKER_FILE));
}

export function markRebaseAttempted(wtPath: string): void {
  fs.writeFileSync(path.join(wtPath, REBASE_MARKER_FILE), "1");
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

  const push = await gitInWorktree(
    wt.path,
    ["push", "--force-with-lease", "origin", branch],
    { ignoreFailure: true },
  );
  return push.code === 0;
}

