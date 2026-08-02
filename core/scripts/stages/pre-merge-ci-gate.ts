// Pre-merge CI-gate domain (#628).
// Owns CI recovery-marker persistence and CI failure / zero-run recovery paths.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  closePr,
  getPrDetail,
  getSuccessfulCheckRunCount,
  reopenPr,
  setBlocked,
  type RerunFailedWorkflowsResult,
} from "../gh.ts";
import {
  classifyCiFailure,
  type CiFailureClass,
} from "../ci-failure-classify.ts";
import { getOnDiskForIssue, gitInWorktree } from "../worktree.ts";
import { makeCommandRecord, recordCommand } from "../evidence-bundle.ts";
import type { CheckRun, Outcome, PipelineConfig } from "../types.ts";
import { preMergeBlocked } from "./pre-merge-shared.ts";
import type { AdvancePreMergeDeps, AdvancePreMergeOpts, PreMergePollingContext } from "./pre-merge-routing.ts";
import {
  REBASE_HEAD_UNVERIFIED_WAIT_REASON,
  markRebaseAttempted,
  resolveRebasePushResult,
  tryRebaseAndPush,
  type RebasePushResult,
} from "./pre-merge-conflict-rebase.ts";
import {
  attemptedShasForAction,
  claimStageAttempt,
  completeStageAttempt,
  hydrateStageAttemptLedger,
  persistStageAttemptLedger,
  projectCiRecoveryFromLedger,
  syncCiProjectionIntoLedger,
  type StageAttemptLedger,
  type StageAttemptLedgerDeps,
} from "../stage-attempt-ledger.ts";

/**
 * Durable on-disk shape for CI recovery markers (#679 / #771).
 * Per-class budgets are stored as SHA sets so previously consumed heads are
 * retained across H1→H2→H1 force-push cycles. Legacy scalar `*ForSha` fields
 * are accepted on read for backward-compatible migration.
 */
export interface CiRecoveryMarkers {
  /**
   * PR head SHA captured before the OpenSpec archive commit. Required after
   * process restart so archive-only + prior-green recovery can still evaluate
   * `preArchiveSha..head` and surface pre-archive green evidence on escalate.
   */
  preArchiveSha?: string;
  /** One-shot rebase recovery SHAs for definitive CI failure (#771). */
  ciRebaseAttemptedShas?: string[];
  ciRerunAttemptedShas?: string[];
  ciArchiveFailRecoveryAttemptedShas?: string[];
  ciAssertionFixAttemptedShas?: string[];
  /** Terminal ci/fail gate_result already emitted for these head SHAs (#771). */
  ciTerminalFailRecordedShas?: string[];
  /** @deprecated scalar form — migrated into `ciRebaseAttemptedShas` on load. */
  ciRebaseAttemptedForSha?: string;
  /** @deprecated scalar form — migrated into `ciRerunAttemptedShas` on load. */
  ciRerunAttemptedForSha?: string;
  /** @deprecated scalar form — migrated into `ciArchiveFailRecoveryAttemptedShas` on load. */
  ciArchiveFailRecoveryAttemptedForSha?: string;
  /** @deprecated scalar form — migrated into `ciAssertionFixAttemptedShas` on load. */
  ciAssertionFixAttemptedForSha?: string;
  /** @deprecated scalar form — migrated into `ciTerminalFailRecordedShas` on load. */
  ciTerminalFailRecordedForSha?: string;
}

const CI_RECOVERY_MARKERS_FILE = "pre-merge-ci-recovery.json";

export function ciRecoveryMarkersPath(runDir: string): string {
  return path.join(runDir, CI_RECOVERY_MARKERS_FILE);
}

/** Result of attempting to persist CI recovery markers (#679 durability). */
export type SaveCiRecoveryMarkersResult =
  | { ok: true }
  | { ok: false; reason: string };

/** True when `sha` is present in a durable per-class SHA set. */
export function ciRecoveryShaSetHas(shas: string[] | undefined, sha: string): boolean {
  return Array.isArray(shas) && shas.includes(sha);
}

/** Return a new set with `sha` added (idempotent, preserves prior entries). */
export function ciRecoveryShaSetAdd(shas: string[] | undefined, sha: string): string[] {
  if (!Array.isArray(shas) || shas.length === 0) return [sha];
  if (shas.includes(sha)) return shas;
  return [...shas, sha];
}

/** Union two SHA sets (order: a then novel entries from b). */
export function ciRecoveryShaSetUnion(
  a: string[] | undefined,
  b: string[] | undefined,
): string[] | undefined {
  if (!a?.length && !b?.length) return undefined;
  const out: string[] = [];
  for (const list of [a, b]) {
    if (!list) continue;
    for (const s of list) {
      if (typeof s === "string" && s.length > 0 && !out.includes(s)) out.push(s);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Normalize disk/in-memory markers: migrate legacy scalar `*ForSha` into sets
 * and drop non-string entries. Pure — does not mutate the input object.
 */
export function normalizeCiRecoveryMarkers(raw: CiRecoveryMarkers): CiRecoveryMarkers {
  const asSet = (set: string[] | undefined, scalar: string | undefined): string[] | undefined => {
    const fromSet = Array.isArray(set)
      ? set.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [];
    const merged = ciRecoveryShaSetUnion(
      fromSet.length > 0 ? fromSet : undefined,
      scalar && typeof scalar === "string" && scalar.length > 0 ? [scalar] : undefined,
    );
    return merged;
  };
  return {
    preArchiveSha:
      typeof raw.preArchiveSha === "string" && raw.preArchiveSha.length > 0
        ? raw.preArchiveSha
        : undefined,
    ciRebaseAttemptedShas: asSet(raw.ciRebaseAttemptedShas, raw.ciRebaseAttemptedForSha),
    ciRerunAttemptedShas: asSet(raw.ciRerunAttemptedShas, raw.ciRerunAttemptedForSha),
    ciArchiveFailRecoveryAttemptedShas: asSet(
      raw.ciArchiveFailRecoveryAttemptedShas,
      raw.ciArchiveFailRecoveryAttemptedForSha,
    ),
    ciAssertionFixAttemptedShas: asSet(
      raw.ciAssertionFixAttemptedShas,
      raw.ciAssertionFixAttemptedForSha,
    ),
    ciTerminalFailRecordedShas: asSet(
      raw.ciTerminalFailRecordedShas,
      raw.ciTerminalFailRecordedForSha,
    ),
  };
}

/** Result of loading CI recovery markers (#771 fail-closed durability). */
export type LoadCiRecoveryMarkersResult =
  | { ok: true; markers: CiRecoveryMarkers }
  | { ok: false; reason: string };

/**
 * Load durable CI recovery markers from the run directory.
 * Missing file (never written) → empty markers. Corrupt / unreadable existing
 * state → ok:false so callers fail closed rather than treating truncated JSON
 * as an empty budget that re-opens already-consumed recovery (#771 r2).
 */
export function loadCiRecoveryMarkers(
  runDir: string | undefined,
): LoadCiRecoveryMarkersResult {
  if (!runDir) return { ok: true, markers: {} };
  const filePath = ciRecoveryMarkersPath(runDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, markers: {} };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `CI recovery markers unreadable: ${msg}` };
  }
  try {
    const parsed = JSON.parse(raw) as CiRecoveryMarkers;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false,
        reason:
          "CI recovery markers file is malformed (not a JSON object); refusing empty budget",
      };
    }
    return { ok: true, markers: normalizeCiRecoveryMarkers(parsed) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `CI recovery markers file is corrupt/unparseable: ${msg}`,
    };
  }
}

/**
 * Persist CI recovery markers to the run directory.
 * Returns ok:false when runDir is missing or the write/read-back fails — callers
 * MUST NOT return `waiting` after consuming recovery budget without ok:true
 * (otherwise a restarted process can re-consume the budget; #679 / #181).
 * Writes atomically (same-dir temp + rename) so a kill mid-write cannot leave a
 * truncated marker file that would erase previously consumed SHA budgets (#771).
 * Writes the set form only (legacy scalars are not re-emitted).
 */
export function saveCiRecoveryMarkers(
  runDir: string | undefined,
  markers: CiRecoveryMarkers,
): SaveCiRecoveryMarkersResult {
  if (!runDir) {
    return {
      ok: false,
      reason: "runDir unavailable; cannot persist CI recovery markers",
    };
  }
  const filePath = ciRecoveryMarkersPath(runDir);
  const tmpPath = path.join(
    runDir,
    `.${CI_RECOVERY_MARKERS_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.mkdirSync(runDir, { recursive: true });
    const normalized = normalizeCiRecoveryMarkers(markers);
    const content = JSON.stringify(normalized, null, 2) + "\n";
    fs.writeFileSync(tmpPath, content, "utf8");
    // Best-effort fsync of the temp file before rename so a crash cannot leave
    // a zero-length target after rename on filesystems that reorder metadata.
    try {
      const fd = fs.openSync(tmpPath, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* fsync optional; rename + read-back still apply */
    }
    fs.renameSync(tmpPath, filePath);
    // Read-back so a write that appears to succeed but is not durable fails closed.
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as CiRecoveryMarkers;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "CI recovery marker read-back was not an object" };
    }
    return { ok: true };
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup; original error is what matters */
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `failed to persist CI recovery markers: ${msg}` };
  }
}

/**
 * Merge durable stage-attempt ledger state into a polling context (#759).
 * Authority is the stage-attempt ledger (recovery-attempt family); legacy
 * `pre-merge-ci-recovery.json` is migration input only via hydrate.
 * Per-class SHA sets on `ctx` are a process-local cache projected from the
 * ledger so the recovery ladder keeps its existing shape (behavior freeze).
 * Returns ok:false when existing on-disk state is corrupt/unreadable — callers
 * must fail closed before recovery side-effects (#771 r2).
 */
export function hydrateCiRecoveryMarkers(
  ctx: PreMergePollingContext,
  runDir: string | undefined,
  ledgerDeps?: StageAttemptLedgerDeps,
): SaveCiRecoveryMarkersResult {
  const hydrated = hydrateStageAttemptLedger(runDir, ledgerDeps);
  if (!hydrated.ok) return hydrated;
  const projection = projectCiRecoveryFromLedger(hydrated.ledger);
  // Restore preArchiveSha before any capture path can overwrite it with the
  // current (post-archive) head after a process restart (#679 review 2).
  if (!ctx.preArchiveSha && projection.preArchiveSha) {
    ctx.preArchiveSha = projection.preArchiveSha;
  }
  ctx.ciRebaseAttemptedShas = ciRecoveryShaSetUnion(
    ctx.ciRebaseAttemptedShas,
    projection.ciRebaseAttemptedShas,
  );
  ctx.ciRerunAttemptedShas = ciRecoveryShaSetUnion(
    ctx.ciRerunAttemptedShas,
    projection.ciRerunAttemptedShas,
  );
  ctx.ciArchiveFailRecoveryAttemptedShas = ciRecoveryShaSetUnion(
    ctx.ciArchiveFailRecoveryAttemptedShas,
    projection.ciArchiveFailRecoveryAttemptedShas,
  );
  ctx.ciAssertionFixAttemptedShas = ciRecoveryShaSetUnion(
    ctx.ciAssertionFixAttemptedShas,
    projection.ciAssertionFixAttemptedShas,
  );
  ctx.ciTerminalFailRecordedShas = ciRecoveryShaSetUnion(
    ctx.ciTerminalFailRecordedShas,
    projection.ciTerminalFailRecordedShas,
  );
  // no-run recovery: in-memory flag becomes a cache of ledger no_run_recovery.
  if (
    !ctx.noRunRecoveryAttemptedForSha &&
    projection.noRunRecoveryAttemptedShas?.length
  ) {
    // Prefer the most recent charged SHA; single-shot path sets one at a time.
    ctx.noRunRecoveryAttemptedForSha =
      projection.noRunRecoveryAttemptedShas[projection.noRunRecoveryAttemptedShas.length - 1];
  }
  // When migration produced a ledger and runDir is present, persist once so
  // subsequent resumes do not re-read legacy as sole authority.
  if (hydrated.migratedFromLegacy && runDir) {
    persistStageAttemptLedger(runDir, hydrated.ledger, ledgerDeps);
  }
  return { ok: true };
}

/**
 * Persist CI recovery authority through the stage-attempt ledger (#759).
 * Session SHA-set cache is synced into ledger claims then written to
 * `stage-attempt-ledger.json`. Production correctness does not depend on
 * writing `pre-merge-ci-recovery.json` (legacy dual-write is intentionally
 * omitted after ledger write succeeds).
 */
export function persistCtxCiMarkers(
  ctx: PreMergePollingContext,
  runDir: string | undefined,
  ledgerDeps?: StageAttemptLedgerDeps,
): SaveCiRecoveryMarkersResult {
  const hydrated = hydrateStageAttemptLedger(runDir, ledgerDeps);
  if (!hydrated.ok) return hydrated;
  const nowIso = (ledgerDeps?.now ?? (() => new Date()))().toISOString();
  const ledger = syncCiProjectionIntoLedger(
    hydrated.ledger,
    {
      preArchiveSha: ctx.preArchiveSha,
      ciRebaseAttemptedShas: ctx.ciRebaseAttemptedShas,
      ciRerunAttemptedShas: ctx.ciRerunAttemptedShas,
      ciArchiveFailRecoveryAttemptedShas: ctx.ciArchiveFailRecoveryAttemptedShas,
      ciAssertionFixAttemptedShas: ctx.ciAssertionFixAttemptedShas,
      ciTerminalFailRecordedShas: ctx.ciTerminalFailRecordedShas,
      noRunRecoveryAttemptedForSha: ctx.noRunRecoveryAttemptedForSha,
    },
    nowIso,
  );
  const result = persistStageAttemptLedger(runDir, ledger, ledgerDeps);
  if (result.ok) {
    const projection = projectCiRecoveryFromLedger(ledger);
    if (projection.preArchiveSha) ctx.preArchiveSha = projection.preArchiveSha;
    ctx.ciRebaseAttemptedShas = projection.ciRebaseAttemptedShas;
    ctx.ciRerunAttemptedShas = projection.ciRerunAttemptedShas;
    ctx.ciArchiveFailRecoveryAttemptedShas = projection.ciArchiveFailRecoveryAttemptedShas;
    ctx.ciAssertionFixAttemptedShas = projection.ciAssertionFixAttemptedShas;
    ctx.ciTerminalFailRecordedShas = projection.ciTerminalFailRecordedShas;
  }
  return result;
}

/**
 * Domain reconcile surface for CI recovery (#759 / #628): derive attempt-aware
 * actions from observed definitive-red state + ledger projection without a
 * private marker file as sole authority.
 */
export function reconcileCiRecoveryState(input: {
  headSha: string;
  ledger: StageAttemptLedger;
  definitiveRed: boolean;
}): {
  actions: Array<
    | { kind: "ci_rebase" }
    | { kind: "ci_rerun" }
    | { kind: "ci_archive_fail_recovery" }
    | { kind: "ci_assertion_fix" }
    | { kind: "escalate" }
  >;
  attempted: {
    rebase: boolean;
    rerun: boolean;
    archive_fail: boolean;
    assertion_fix: boolean;
  };
} {
  const attempted = {
    rebase: attemptedShasForAction(input.ledger, "ci_rebase").includes(input.headSha),
    rerun: attemptedShasForAction(input.ledger, "ci_rerun").includes(input.headSha),
    archive_fail: attemptedShasForAction(input.ledger, "ci_archive_fail_recovery").includes(
      input.headSha,
    ),
    assertion_fix: attemptedShasForAction(input.ledger, "ci_assertion_fix").includes(
      input.headSha,
    ),
  };
  if (!input.definitiveRed) {
    return { actions: [], attempted };
  }
  const actions: Array<
    | { kind: "ci_rebase" }
    | { kind: "ci_rerun" }
    | { kind: "ci_archive_fail_recovery" }
    | { kind: "ci_assertion_fix" }
    | { kind: "escalate" }
  > = [];
  if (!attempted.rebase) actions.push({ kind: "ci_rebase" });
  if (!attempted.rerun) actions.push({ kind: "ci_rerun" });
  if (!attempted.archive_fail) actions.push({ kind: "ci_archive_fail_recovery" });
  if (!attempted.assertion_fix) actions.push({ kind: "ci_assertion_fix" });
  if (actions.length === 0) actions.push({ kind: "escalate" });
  return { actions, attempted };
}

/** @internal re-export for tests that claim CI actions through the ledger API. */
export {
  claimStageAttempt,
  completeStageAttempt,
  hydrateStageAttemptLedger,
  persistStageAttemptLedger,
};

// ---------------------------------------------------------------------------
// Definitive CI failure recovery ladder (#679)
// ---------------------------------------------------------------------------

interface DefinitiveCiFailureFns {
  getForIssueFn: typeof getOnDiskForIssue;
  getPrDetailFn: typeof getPrDetail;
  setBlockedFn: typeof setBlocked;
  tryRebaseAndPushFn: typeof tryRebaseAndPush;
  markRebaseAttemptedFn: typeof markRebaseAttempted;
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount;
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>;
  closePrFn: typeof closePr;
  reopenPrFn: typeof reopenPr;
  rerunFailedWorkflowsFn: (
    cfg: PipelineConfig,
    failedChecks: CheckRun[],
  ) => Promise<RerunFailedWorkflowsResult>;
  fetchCheckLogExcerptFn: (
    cfg: PipelineConfig,
    check: CheckRun,
  ) => Promise<string | null>;
  runCiAssertionFixFn?: AdvancePreMergeDeps["runCiAssertionFix"];
  stateDir?: string;
}

/**
 * Recovery ladder for definitive red CI (not pending) — one attempt **per class
 * per head SHA**, finite ordered steps (#679 / #771):
 *
 * | Order | Class          | Budget key (SHA set)                    | On success side-effect                                      |
 * |------:|----------------|-----------------------------------------|-------------------------------------------------------------|
 * | 1     | rebase         | `ciRebaseAttemptedShas` (durable)       | verified HEAD moved → `waiting` `rebased; CI re-running`; unverified → re-eval wait; else continue |
 * | 2     | classify       | n/a (pure)                              | drives steps 3–5                                            |
 * | 3     | rerun          | `ciRerunAttemptedShas`                  | re-request → `waiting` `CI re-triggered (…)`                  |
 * | 4     | archive_fail   | `ciArchiveFailRecoveryAttemptedShas`    | close+reopen → archive waiting reason                    |
 * | 5     | assertion_fix | `ciAssertionFixAttemptedShas`           | fix ok → assertion waiting reason                           |
 * | 6     | escalate       | n/a                                     | `setBlocked` `ci-exhausted` + offramp `ci-failed`           |
 *
 * Budget is durable per head SHA via the stage-attempt ledger (#759), projected
 * onto pollingCtx SHA sets as a process-local cache (#679). Rebase budget is
 * durable (not worktree-only) so worktree recreation cannot re-open unlimited
 * rebase thrash (#771 / dogfood #597). Sets retain all previously consumed
 * heads (H1→H2→H1 cannot re-open H1's budget).
 * Does NOT reintroduce #181 infinite wait/archive spin.
 */
export async function handleDefinitiveCiFailure(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  failedChecks: CheckRun[],
  opts: AdvancePreMergeOpts,
  fns: DefinitiveCiFailureFns,
): Promise<Outcome> {
  // Ensure a recovery context even on single-shot advance() (no polling loop).
  // When pollingCtx is omitted, ephemeral ctx still hydrates from runDir so
  // durable budgets and terminal-fail markers survive process restart (#771 r2).
  const ctx: PreMergePollingContext = opts.pollingCtx ?? {};
  /** Set when a recovery side-effect could not be paired with durable markers. */
  let durablePersistFailure: string | undefined;
  const hydrate = hydrateCiRecoveryMarkers(ctx, opts.runDir);
  if (!hydrate.ok) {
    // Corrupt/unreadable marker store: fail closed — do not treat as empty budget
    // that would re-open already-consumed recovery classes (#771 r2).
    durablePersistFailure = hydrate.reason;
    ctx.ciRebaseAttemptedShas = ciRecoveryShaSetAdd(ctx.ciRebaseAttemptedShas, headSha);
    ctx.ciRerunAttemptedShas = ciRecoveryShaSetAdd(ctx.ciRerunAttemptedShas, headSha);
    ctx.ciArchiveFailRecoveryAttemptedShas = ciRecoveryShaSetAdd(
      ctx.ciArchiveFailRecoveryAttemptedShas,
      headSha,
    );
    ctx.ciAssertionFixAttemptedShas = ciRecoveryShaSetAdd(
      ctx.ciAssertionFixAttemptedShas,
      headSha,
    );
    console.log(
      `[pipeline] #${issueNumber}: CI recovery markers unusable — ${hydrate.reason}; escalating without recovery side-effects`,
    );
  }

  // 1. One-shot rebase — durable per head SHA (#771), not worktree-only.
  // Authorization is durable-only: an unkeyed worktree marker left by H1 must not
  // suppress H2's one-shot in the same worktree. After durable persist succeeds we
  // still write the worktree marker so BEHIND/conflict same-session paths share awareness.
  const wt = await fns.getForIssueFn(cfg, issueNumber);
  const durableRebaseDone = ciRecoveryShaSetHas(ctx.ciRebaseAttemptedShas, headSha);
  if (!durableRebaseDone && wt) {
    // Persist-before-side-effect: refuse rebase if markers cannot be durably stored.
    const prevRebaseShas = ctx.ciRebaseAttemptedShas;
    ctx.ciRebaseAttemptedShas = ciRecoveryShaSetAdd(ctx.ciRebaseAttemptedShas, headSha);
    const persist = persistCtxCiMarkers(ctx, opts.runDir);
    if (!persist.ok) {
      ctx.ciRebaseAttemptedShas = prevRebaseShas;
      durablePersistFailure = persist.reason;
      console.log(
        `[pipeline] #${issueNumber}: refusing CI rebase for ${headSha.slice(0, 7)} — ${persist.reason}`,
      );
      // Fall through to remaining ladder / escalate (fail-closed, no thrash wait).
    } else {
      // #759: worktree marker writer is a no-op; durable authority is the ledger
      // via persistCtxCiMarkers above. Call retained for injectable test spies.
      fns.markRebaseAttemptedFn(wt.path);

      const beforeSha = headSha;
      let gitOk = false;
      try {
        gitOk = await fns.tryRebaseAndPushFn(cfg, issueNumber);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        gitOk = false;
        console.log(
          `[pipeline] #${issueNumber}: CI rebase side-effect threw for ${headSha.slice(0, 7)}: ${msg}`,
        );
      }

      let afterSha: string | undefined;
      try {
        afterSha = (await fns.getPrDetailFn(cfg, prNumber)).head_sha;
      } catch {
        afterSha = undefined;
      }
      const rebaseResult = await resolveRebasePushResult(beforeSha, gitOk, afterSha);

      if (fns.stateDir) {
        const summary =
          rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved
            ? "rebase and push succeeded; HEAD moved; CI re-running"
            : rebaseResult.ok && !rebaseResult.verified
              ? "rebase and push reported success but PR head could not be re-read"
              : rebaseResult.ok
                ? "rebase and push reported success but HEAD unchanged"
                : rebaseResult.reason;
        await recordCommand(
          fns.stateDir,
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

      if (rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved) {
        return { advanced: false, status: "waiting", reason: "rebased; CI re-running" };
      }
      // Successful side-effect with unverified HEAD: budget for beforeSha is
      // already consumed; re-evaluate next poll without escalating on old checks.
      if (rebaseResult.ok && !rebaseResult.verified) {
        console.log(
          `[pipeline] #${issueNumber}: CI rebase side-effect succeeded but PR head could not be re-read after ${beforeSha.slice(0, 7)}; re-evaluating on next poll`,
        );
        return {
          advanced: false,
          status: "waiting",
          reason: REBASE_HEAD_UNVERIFIED_WAIT_REASON,
        };
      }
      // External head advance without attributing success to a failed local rebase:
      // durable budget for beforeSha is already consumed; next poll evaluates afterSha.
      if (
        !rebaseResult.ok &&
        rebaseResult.afterSha &&
        rebaseResult.afterSha !== beforeSha
      ) {
        console.log(
          `[pipeline] #${issueNumber}: PR head advanced externally during rebase ` +
            `(${beforeSha.slice(0, 7)} → ${rebaseResult.afterSha.slice(0, 7)}); re-evaluating on next poll`,
        );
        return {
          advanced: false,
          status: "waiting",
          reason: "PR head advanced; waiting for checks",
        };
      }
      // No-op success or failed rebase without external head move → continue ladder.
    }
  }

  // Best-effort log excerpt from the first failed check that has a link.
  // Log fetch failure must not prevent escalation or add recovery waits (#771).
  let logExcerpt: string | null = null;
  for (const check of failedChecks) {
    try {
      logExcerpt = await fns.fetchCheckLogExcerptFn(cfg, check);
    } catch {
      logExcerpt = null;
    }
    if (logExcerpt) break;
  }

  // 2. Classify.
  const classification = classifyCiFailure({ failed: failedChecks, logExcerpt });
  if (opts.stateDir) {
    await recordCommand(
      opts.stateDir,
      issueNumber,
      "pre-merge",
      makeCommandRecord(
        `ci-classify head=${headSha.slice(0, 7)}`,
        0,
        0,
        `classification=${classification}; failed=${failedChecks.map((c) => c.name).join(",")}`,
      ),
    ).catch(() => {});
  }

  const rerunEnabled = cfg.pre_merge_ci_rerun_enabled !== false;
  const assertionFixEnabled = cfg.pre_merge_ci_assertion_fix === true;
  let rerunAttempted = ciRecoveryShaSetHas(ctx.ciRerunAttemptedShas, headSha);
  let archiveFailRecoveryAttempted = ciRecoveryShaSetHas(
    ctx.ciArchiveFailRecoveryAttemptedShas,
    headSha,
  );
  let assertionFixAttempted = ciRecoveryShaSetHas(ctx.ciAssertionFixAttemptedShas, headSha);
  /** Set when archive close succeeded but reopen did not — operator must reopen. */
  let prLeftClosed: { prNumber: number } | undefined;
  let closeReopenError: string | undefined;

  // 3. Infra / unknown → one automatic re-run.
  // Persist the per-head marker BEFORE the re-run side-effect so a restart cannot
  // re-consume the budget when the write fails (#679 durability / #181).
  if (
    (classification === "infra" || classification === "unknown") &&
    rerunEnabled &&
    !rerunAttempted
  ) {
    const prevRerunShas = ctx.ciRerunAttemptedShas;
    ctx.ciRerunAttemptedShas = ciRecoveryShaSetAdd(ctx.ciRerunAttemptedShas, headSha);
    const persist = persistCtxCiMarkers(ctx, opts.runDir);
    if (!persist.ok) {
      // Roll back in-memory so a later run can retry once durability is restored.
      ctx.ciRerunAttemptedShas = prevRerunShas;
      durablePersistFailure = persist.reason;
      console.log(
        `[pipeline] #${issueNumber}: refusing CI re-run for ${headSha.slice(0, 7)} — ${persist.reason}`,
      );
    } else {
      rerunAttempted = true;
      let result: RerunFailedWorkflowsResult;
      try {
        result = await fns.rerunFailedWorkflowsFn(cfg, failedChecks);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { attempted: false, runIds: [], reason: msg };
      }
      if (result.attempted) {
        console.log(
          `[pipeline] #${issueNumber}: CI ${classification} failure; re-ran workflow(s) ${result.runIds.join(", ")} for head ${headSha.slice(0, 7)}`,
        );
        return {
          advanced: false,
          status: "waiting",
          reason: `CI re-triggered (${classification}); waiting for checks`,
        };
      }
      // Re-run unavailable → fall through to remaining budget steps.
      console.log(
        `[pipeline] #${issueNumber}: CI re-run unavailable for ${headSha.slice(0, 7)}: ${result.reason ?? "unknown"}`,
      );
    }
  }

  // 4. Archive-only + prior green + infra/unknown → one close+reopen after re-run exhausted/unavailable.
  if (
    (classification === "infra" || classification === "unknown") &&
    !archiveFailRecoveryAttempted
  ) {
    const archiveInfo = await evaluateArchiveOnlyPriorGreen(
      cfg,
      headSha,
      ctx,
      fns.getSuccessfulCheckRunCountFn,
      fns.getDiffFilePathsFn,
    );
    if (archiveInfo.isArchiveOnly && archiveInfo.priorGreen) {
      // Prefer re-run first: only close+reopen when re-run budget is already consumed
      // (or re-run disabled). When re-run just marked attempted but was unavailable,
      // this path still applies on the same tick.
      if (rerunAttempted || !rerunEnabled) {
        // Persist one-shot marker before close so restart cannot re-close thrash.
        // If persist fails, skip the side-effect and escalate (do not leave PR closed).
        const prevArchiveShas = ctx.ciArchiveFailRecoveryAttemptedShas;
        ctx.ciArchiveFailRecoveryAttemptedShas = ciRecoveryShaSetAdd(
          ctx.ciArchiveFailRecoveryAttemptedShas,
          headSha,
        );
        const persistBefore = persistCtxCiMarkers(ctx, opts.runDir);
        if (!persistBefore.ok) {
          ctx.ciArchiveFailRecoveryAttemptedShas = prevArchiveShas;
          durablePersistFailure = durablePersistFailure ?? persistBefore.reason;
          console.log(
            `[pipeline] #${issueNumber}: refusing archive close+reopen for ${headSha.slice(0, 7)} — ${persistBefore.reason}`,
          );
        } else {
          archiveFailRecoveryAttempted = true;

          let closed = false;
          let reopened = false;
          try {
            await fns.closePrFn(cfg, prNumber);
            closed = true;
            await fns.reopenPrFn(cfg, prNumber);
            reopened = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            closeReopenError = msg;
            // If close succeeded but reopen failed, retry reopen once so we do not
            // strand the PR closed (#679 close+reopen safety).
            if (closed && !reopened) {
              try {
                await fns.reopenPrFn(cfg, prNumber);
                reopened = true;
                closeReopenError = undefined;
                console.log(
                  `[pipeline] #${issueNumber}: archive-only reopen recovered on retry for PR #${prNumber}`,
                );
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                closeReopenError = `close succeeded; reopen failed (initial: ${msg}; retry: ${retryMsg})`;
                prLeftClosed = { prNumber };
                console.log(
                  `[pipeline] #${issueNumber}: archive-only close+reopen left PR #${prNumber} CLOSED: ${closeReopenError}`,
                );
              }
            } else {
              console.log(
                `[pipeline] #${issueNumber}: archive-only close+reopen failed: ${msg}`,
              );
            }
          }

          if (reopened) {
            console.log(
              `[pipeline] #${issueNumber}: archive-only CI ${classification} failure; closed+reopened PR #${prNumber} for head ${headSha.slice(0, 7)}`,
            );
            return {
              advanced: false,
              status: "waiting",
              reason: "archive-only CI red; closed and reopened PR to re-fire CI",
            };
          }
          // Partial or total failure → fall through to escalate with evidence.
        }
      }
    }
  }

  // 5. Optional assertion auto-fix (config-capped, one shot).
  // Persist marker before dispatch so restart cannot re-invoke the fix loop.
  if (classification === "assertion" && assertionFixEnabled && !assertionFixAttempted) {
    const prevFixShas = ctx.ciAssertionFixAttemptedShas;
    ctx.ciAssertionFixAttemptedShas = ciRecoveryShaSetAdd(
      ctx.ciAssertionFixAttemptedShas,
      headSha,
    );
    const persist = persistCtxCiMarkers(ctx, opts.runDir);
    if (!persist.ok) {
      ctx.ciAssertionFixAttemptedShas = prevFixShas;
      durablePersistFailure = durablePersistFailure ?? persist.reason;
      console.log(
        `[pipeline] #${issueNumber}: refusing CI assertion auto-fix for ${headSha.slice(0, 7)} — ${persist.reason}`,
      );
    } else {
      assertionFixAttempted = true;
      if (fns.runCiAssertionFixFn) {
        let fixResult: { ok: boolean; reason?: string };
        try {
          fixResult = await fns.runCiAssertionFixFn(cfg, issueNumber, {
            prNumber,
            headSha,
            failedChecks,
            classification,
            logExcerpt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          fixResult = { ok: false, reason: msg };
        }
        if (fixResult.ok) {
          console.log(
            `[pipeline] #${issueNumber}: CI assertion auto-fix dispatched for head ${headSha.slice(0, 7)}`,
          );
          return {
            advanced: false,
            status: "waiting",
            reason: "CI assertion auto-fix attempted; waiting for checks",
          };
        }
        console.log(
          `[pipeline] #${issueNumber}: CI assertion auto-fix failed: ${fixResult.reason ?? "unknown"}`,
        );
        // Fall through to escalate on same tick when dispatch failed.
      }
    }
  }

  // 6. Budget exhausted → escalate with ci-exhausted + rich reason.
  const archiveInfo = await evaluateArchiveOnlyPriorGreen(
    cfg,
    headSha,
    ctx,
    fns.getSuccessfulCheckRunCountFn,
    fns.getDiffFilePathsFn,
  );
  const reason = buildCiExhaustedBlockReason({
    failedChecks,
    headSha,
    classification,
    logExcerpt,
    preArchiveGreenSha:
      archiveInfo.isArchiveOnly && archiveInfo.priorGreen ? ctx.preArchiveSha : undefined,
    rerunAttempted,
    archiveFailRecoveryAttempted,
    assertionFixAttempted,
    assertionFixEnabled,
    rerunEnabled,
    prLeftClosed,
    closeReopenError,
    durablePersistFailure,
  });
  await fns.setBlockedFn(cfg, issueNumber, reason, "pre-merge", "ci-exhausted");
  // #683: attach offramp path tag so scoreboard maps permanent CI failure to ci-failed
  // (blockerKind alone is the durable label; pathTag is the finer metric class).
  return preMergeBlocked("CI failed", "ci-exhausted", "ci-failed");
}

export async function evaluateArchiveOnlyPriorGreen(
  cfg: PipelineConfig,
  headSha: string,
  ctx: PreMergePollingContext,
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount,
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>,
): Promise<{ isArchiveOnly: boolean; priorGreen: boolean }> {
  const preArchiveSha = ctx.preArchiveSha;
  if (!preArchiveSha || preArchiveSha === headSha) {
    return { isArchiveOnly: false, priorGreen: false };
  }
  try {
    const diffPaths = await getDiffFilePathsFn(cfg, preArchiveSha, headSha);
    const isArchiveOnly =
      diffPaths.length > 0 && diffPaths.every((p) => p.startsWith("openspec/"));
    if (!isArchiveOnly) return { isArchiveOnly: false, priorGreen: false };
    const successCount = await getSuccessfulCheckRunCountFn(cfg, preArchiveSha);
    return { isArchiveOnly: true, priorGreen: successCount > 0 };
  } catch {
    return { isArchiveOnly: false, priorGreen: false };
  }
}

/** Build operator-facing block reason for CI budget exhaustion (#679). */
export function buildCiExhaustedBlockReason(input: {
  failedChecks: CheckRun[];
  headSha: string;
  classification: CiFailureClass;
  logExcerpt: string | null;
  preArchiveGreenSha?: string;
  rerunAttempted: boolean;
  archiveFailRecoveryAttempted: boolean;
  assertionFixAttempted: boolean;
  assertionFixEnabled: boolean;
  rerunEnabled: boolean;
  /** When archive close+reopen left the PR closed after reopen failure. */
  prLeftClosed?: { prNumber: number };
  /** Detail from close+reopen failure (including reopen retry). */
  closeReopenError?: string;
  /** When durable marker persistence blocked or failed recovery. */
  durablePersistFailure?: string;
}): string {
  const lines: string[] = [
    `CI checks failed after recovery budget exhausted (classification: ${input.classification}).`,
    "",
    `Head SHA: ${input.headSha}`,
  ];
  if (input.preArchiveGreenSha) {
    lines.push(`Pre-archive green SHA: ${input.preArchiveGreenSha}`);
  }
  lines.push("", "Failing checks:");
  for (const c of input.failedChecks) {
    const bucket = c.bucket || c.state || "fail";
    lines.push(`- ${c.name}: ${bucket}`);
    if (c.link) lines.push(`  ${c.link}`);
  }
  if (input.logExcerpt) {
    lines.push("", "Log excerpt:", "```", input.logExcerpt, "```");
  }
  if (input.prLeftClosed) {
    lines.push(
      "",
      `CRITICAL: PR #${input.prLeftClosed.prNumber} is still CLOSED after archive close+reopen recovery failed.`,
      `Reopen it first: \`gh pr reopen ${input.prLeftClosed.prNumber}\` (or the GitHub UI), then re-fire CI if needed.`,
    );
    if (input.closeReopenError) {
      lines.push(`Close+reopen error: ${input.closeReopenError}`);
    }
  } else if (input.closeReopenError) {
    lines.push("", `Archive close+reopen error: ${input.closeReopenError}`);
  }
  if (input.durablePersistFailure) {
    lines.push(
      "",
      `Durable recovery marker persistence failed: ${input.durablePersistFailure}`,
      "Automatic recovery was not safely consumable without durable state; fix run-store writability if this persists.",
    );
  }
  lines.push(
    "",
    "Recovery already attempted:",
    `- automatic re-run: ${input.rerunEnabled ? (input.rerunAttempted ? "yes" : "no") : "disabled"}`,
    `- archive failed-run close+reopen: ${input.archiveFailRecoveryAttempted ? "yes" : "no"}`,
    `- assertion auto-fix: ${input.assertionFixEnabled ? (input.assertionFixAttempted ? "yes" : "no") : "disabled"}`,
    "",
    "Next steps: " +
      (input.prLeftClosed
        ? `reopen PR #${input.prLeftClosed.prNumber}; `
        : "") +
      "inspect the check URL(s) and classification above; fix product " +
      "test/build failures or remaining infrastructure issues; push any code fix " +
      "to the PR head; remove the `blocked` label; re-run the pipeline. " +
      (input.rerunAttempted
        ? "Automatic re-run budget for this head was already consumed."
        : "If this looks like a flake, re-run the failed workflow manually once before re-running the pipeline."),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// No-run recovery (#281)
// ---------------------------------------------------------------------------

/**
 * Called when `getPrChecks` shows pending CI but the check-runs API reports
 * zero runs for the head SHA — GitHub Actions never fired, typically after an
 * archive-only commit that did not re-trigger the `pull_request` event.
 *
 * Decision tree:
 *  1. Already attempted recovery for this SHA → block (needs-human).
 *  2. Diff from preArchiveSha to headSha is openspec-only AND preArchiveSha had
 *     ≥1 successful check-run (prior green) → close+reopen PR to re-fire CI → waiting.
 *  3. close+reopen throws → block (needs-human).
 *  4. Non-archive diff or preArchiveSha unavailable → block (needs-human) with
 *     actionable manual close+reopen suggestion.
 */
export async function handleZeroRunRecovery(
  cfg: PipelineConfig,
  issueNumber: number,
  prNumber: number,
  headSha: string,
  ctx: PreMergePollingContext,
  setBlockedFn: typeof setBlocked,
  closePrFn: typeof closePr,
  reopenPrFn: typeof reopenPr,
  getSuccessfulCheckRunCountFn: typeof getSuccessfulCheckRunCount,
  getDiffFilePathsFn: (cfg: PipelineConfig, baseSha: string, headSha: string) => Promise<string[]>,
): Promise<Outcome> {
  // One-shot-per-SHA guard: prevents repeated PR state churn on consecutive polls.
  if (ctx.noRunRecoveryAttemptedForSha === headSha) {
    await setBlockedFn(
      cfg,
      issueNumber,
      `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery was already attempted for this SHA. ` +
        `Investigate why GitHub Actions is not triggering and manually re-fire CI, then remove the \`blocked\` label and re-run the pipeline.`,
      "pre-merge",
      "needs-human",
    );
    return preMergeBlocked(`no CI run after recovery for ${headSha.slice(0, 7)}`, "needs-human", "ci-failed");
  }

  const preArchiveSha = ctx.preArchiveSha;
  let isArchiveOnly = false;
  let priorGreen = false;

  if (preArchiveSha && preArchiveSha !== headSha) {
    try {
      const diffPaths = await getDiffFilePathsFn(cfg, preArchiveSha, headSha);
      isArchiveOnly = diffPaths.length > 0 && diffPaths.every((p) => p.startsWith("openspec/"));
      if (isArchiveOnly) {
        const successCount = await getSuccessfulCheckRunCountFn(cfg, preArchiveSha);
        priorGreen = successCount > 0;
      }
    } catch {
      // Treat as non-archive-only on error (conservative-open: no auto-recover).
    }
  }

  if (isArchiveOnly && priorGreen) {
    try {
      await closePrFn(cfg, prNumber);
      await reopenPrFn(cfg, prNumber);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await setBlockedFn(
        cfg,
        issueNumber,
        `No CI run detected for head SHA ${headSha.slice(0, 7)}; close+reopen recovery failed: ${msg}`,
        "pre-merge",
        "needs-human",
      );
      return preMergeBlocked(`no CI run; close+reopen failed: ${msg}`, "needs-human", "ci-failed");
    }
    ctx.noRunRecoveryAttemptedForSha = headSha;
    console.log(
      `[pipeline] #${issueNumber}: no CI run for SHA ${headSha.slice(0, 7)}; closed and reopened PR #${prNumber} to re-fire CI`,
    );
    return {
      advanced: false,
      status: "waiting",
      reason: "no CI run detected; closed and reopened PR to re-fire CI",
    };
  }

  // Non-archive diff or pre-archive SHA unavailable or prior SHA had no runs.
  await setBlockedFn(
    cfg,
    issueNumber,
    `No CI run detected for head SHA ${headSha.slice(0, 7)}; try closing and reopening the PR to re-fire GitHub Actions.`,
    "pre-merge",
    "needs-human",
  );
  return preMergeBlocked(`no CI run detected for head SHA ${headSha.slice(0, 7)}`, "needs-human", "ci-failed");
}

/** Default implementation of the `getDiffFilePaths` seam. */
export async function defaultGetDiffFilePaths(
  cfg: PipelineConfig,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const result = await gitInWorktree(
    cfg.repo_dir,
    ["diff", "--name-only", `${baseSha}...${headSha}`],
    { ignoreFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(`git diff --name-only ${baseSha.slice(0, 7)}...${headSha.slice(0, 7)} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

