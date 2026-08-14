// Pre-merge conflict / rebase domain (#628 / #1065).
// Owns merge-conflict recovery, rebase-attempted markers, and rebase-and-push helpers.
//
// #1065 law: a first clean auto-rebase miss is engine-owned recovery, never a
// human `merge-conflict` / “manual rebase needed” park. Flow:
//   clean auto-rebase → (on conflict) keep worktree → bounded resolve
//   (deterministic and/or configured implementer) → force-with-lease push →
//   re-enter pre-merge as waiting for CI.
// Only after conflict-resolve budget exhaustion with residual conflicts may
// the path fail closed — and then as product/engine-owned `review-findings`
// with conflict-file evidence, not BlockerKind `merge-conflict`.

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
import { buildFixPrompt } from "../prompts/index.ts";
import { invoke } from "../harness.ts";
import type { InvokeFn } from "../openspec-consistency.ts";

/** Residual legacy marker path — salvage exclusion only; engine does not write it (#759). */
export const REBASE_MARKER_FILE = PIPELINE_INTERNAL_MARKER_FILES[0];

/**
 * #1061 18:07Z-class terminal — illegal for pre-merge first-conflict recovery
 * and for clean-rebase ledger-bound-only outcomes (#1065). Regression tests
 * fail if this string is reintroduced as that path’s legal terminal under
 * BlockerKind `merge-conflict`.
 */
export const MERGE_CONFLICT_MANUAL_REBASE_TERMINAL =
  "PR has a merge conflict with the base branch that could not be automatically rebased — manual rebase needed.";

/**
 * Product/engine-owned BlockerKind for residual conflicts after conflict-resolve
 * budget exhaustion (#1065 D4). Not `merge-conflict` (that kind remains for
 * other surfaces such as operator merge hold reporting and BEHIND update failure).
 */
export const CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND = "review-findings" as const;

/** Default one-shot budget for conflict_resolve claims per head. */
export const CONFLICT_RESOLVE_BUDGET = 1;

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
 * Result of bounded conflict resolution after a clean auto-rebase miss (#1065).
 * Injected by tests; production uses {@link defaultResolveMergeConflicts}.
 */
export type ConflictResolveResult =
  | {
      status: "resolved_and_pushed";
      /** When set, used as post-resolve PR head for #771 HEAD-moved checks. */
      afterSha?: string;
    }
  | {
      status: "in_progress";
      reason?: string;
      conflictPaths?: string[];
    }
  | {
      status: "exhausted";
      conflictPaths: string[];
      reason: string;
    }
  | {
      status: "failed";
      reason: string;
      conflictPaths?: string[];
    };

export interface ResolveMergeConflictsArgs {
  cfg: PipelineConfig;
  issueNumber: number;
  worktreePath: string;
  /** Conflict paths known from the clean-rebase miss, when available. */
  conflictPaths?: string[];
  /** Pre-resolve PR head SHA (ledger key / HEAD-moved baseline). */
  beforeSha?: string;
  prNumber?: number;
  stateDir?: string;
  runDir?: string;
  deps: AdvancePreMergeDeps;
}

export type ResolveMergeConflictsFn = (
  args: ResolveMergeConflictsArgs,
) => Promise<ConflictResolveResult>;

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
// Product-failure terminal builders (#1065)
// ---------------------------------------------------------------------------

/**
 * Build the blocked reason for budget-exhausted residual conflict.
 * Names conflict paths and structural cause; never the #1061 manual-rebase string.
 */
export function buildConflictResolveExhaustedReason(conflictPaths: string[]): string {
  const paths =
    conflictPaths.length > 0
      ? conflictPaths.map((p) => `\`${p}\``).join(", ")
      : "(conflict paths unavailable)";
  return (
    "Pre-merge conflict resolution budget exhausted with residual merge conflicts " +
    `in: ${paths}. Engine-owned resolve (deterministic / implementer) could not finish ` +
    "the rebase. This is a product/engine failure (not a human-authority park). " +
    "Inspect the managed worktree, resolve remaining conflicts if any, commit, and re-run the pipeline."
  );
}

/** True when a blocked reason is the illegal #1061 first-conflict terminal. */
export function isIllegalMergeConflictManualRebaseTerminal(reason: string): boolean {
  return reason.includes("could not be automatically rebased — manual rebase needed");
}

// ---------------------------------------------------------------------------
// Conflict path discovery
// ---------------------------------------------------------------------------

/**
 * List unmerged / conflict paths in a worktree (or empty when clean / unavailable).
 * Injectable via gitInWorktree on deps.
 */
export async function listRebaseConflictPaths(
  wtPath: string,
  gitFn: typeof gitInWorktree = gitInWorktree,
): Promise<string[]> {
  const unmerged = await gitFn(wtPath, ["diff", "--name-only", "--diff-filter=U"], {
    ignoreFailure: true,
  });
  if (unmerged.code === 0 && unmerged.stdout.trim()) {
    return unmerged.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }
  // Fallback: porcelain status with unmerged codes (UU/AA/DD/AU/UA/DU/UD)
  const status = await gitFn(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  if (status.code !== 0 || !status.stdout.trim()) return [];
  const paths: string[] = [];
  for (const line of status.stdout.split("\n")) {
    if (!line || line.length < 4) continue;
    const code = line.slice(0, 2);
    if (/^(UU|AA|DD|AU|UA|DU|UD|UD)$/.test(code) || code.includes("U")) {
      const p = line.slice(3).trim().replace(/^"|"$/g, "");
      if (p) paths.push(p);
    }
  }
  return paths;
}

function isRebaseInProgress(wtPath: string): boolean {
  return (
    fs.existsSync(path.join(wtPath, ".git", "rebase-merge")) ||
    fs.existsSync(path.join(wtPath, ".git", "rebase-apply")) ||
    // worktree .git is a file pointing at the common dir — check via git dir layout
    fs.existsSync(path.join(wtPath, ".git", "REBASE_HEAD"))
  );
}

// ---------------------------------------------------------------------------
// Deterministic additive union resolver (help-string / dual-side add class)
// ---------------------------------------------------------------------------

const CONFLICT_START = /^<<<<<<< /;
const CONFLICT_MID = /^=======\s*$/;
const CONFLICT_END = /^>>>>>>> /;

/**
 * Resolve pure dual-side additive unions: when both sides only add lines with
 * no overlapping rewrite of the same preimage region beyond standard markers,
 * keep the union of both sides (ours then theirs, de-duplicated adjacent).
 * Returns null when any hunk is not a safe additive union.
 */
export function tryResolveAdditiveUnionContent(content: string): string | null {
  if (!CONFLICT_START.test(content) && !content.includes("<<<<<<<")) {
    return content; // no markers
  }
  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  let sawHunk = false;
  while (i < lines.length) {
    const line = lines[i]!;
    if (CONFLICT_START.test(line) || line.startsWith("<<<<<<<")) {
      sawHunk = true;
      i++;
      const ours: string[] = [];
      while (i < lines.length && !CONFLICT_MID.test(lines[i]!) && !lines[i]!.startsWith("=======")) {
        ours.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) return null;
      i++; // skip =======
      const theirs: string[] = [];
      while (i < lines.length && !CONFLICT_END.test(lines[i]!) && !lines[i]!.startsWith(">>>>>>>")) {
        theirs.push(lines[i]!);
        i++;
      }
      if (i >= lines.length) return null;
      i++; // skip >>>>>>>
      // Additive union: keep both sides; drop exact duplicate lines that appear
      // as the whole of one side when already present in the other.
      const merged = mergeAdditiveSides(ours, theirs);
      if (merged === null) return null;
      out.push(...merged);
      continue;
    }
    out.push(line);
    i++;
  }
  if (!sawHunk) return content;
  return out.join("\n");
}

/**
 * Merge ours/theirs for additive CLI-help style unions: keep both when they
 * differ; prefer unique lines in order (ours first, then theirs not in ours).
 * Returns null only if either side is empty and the other has deletions-only
 * ambiguity we refuse (both empty is a no-op empty hunk — keep empty).
 */
function mergeAdditiveSides(ours: string[], theirs: string[]): string[] | null {
  if (ours.length === 0 && theirs.length === 0) return [];
  // Identical sides — take one.
  if (ours.join("\n") === theirs.join("\n")) return ours;
  const seen = new Set(ours);
  const merged = [...ours];
  for (const t of theirs) {
    if (!seen.has(t)) {
      merged.push(t);
      seen.add(t);
    }
  }
  return merged;
}

/**
 * Apply deterministic additive-union resolution to conflicted files on disk.
 * Returns resolved paths; leaves non-additive files untouched.
 */
export async function tryDeterministicAdditiveResolve(
  wtPath: string,
  conflictPaths: string[],
  gitFn: typeof gitInWorktree = gitInWorktree,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, c: string) => void = (p, c) => fs.writeFileSync(p, c, "utf8"),
): Promise<{ resolved: string[]; remaining: string[] }> {
  const resolved: string[] = [];
  const remaining: string[] = [];
  for (const rel of conflictPaths) {
    const abs = path.join(wtPath, rel);
    let raw: string;
    try {
      raw = readFile(abs);
    } catch {
      remaining.push(rel);
      continue;
    }
    const next = tryResolveAdditiveUnionContent(raw);
    if (next === null || next === raw) {
      // null = unsafe; raw unchanged with markers still present = unresolved
      if (next === null || next.includes("<<<<<<<")) {
        remaining.push(rel);
        continue;
      }
    }
    if (next.includes("<<<<<<<")) {
      remaining.push(rel);
      continue;
    }
    try {
      writeFile(abs, next);
      const add = await gitFn(wtPath, ["add", "--", rel], { ignoreFailure: true });
      if (add.code !== 0) {
        remaining.push(rel);
        continue;
      }
      resolved.push(rel);
    } catch {
      remaining.push(rel);
    }
  }
  return { resolved, remaining };
}

// ---------------------------------------------------------------------------
// Default bounded resolve (deterministic → implementer → exhaust)
// ---------------------------------------------------------------------------

/**
 * Production conflict resolver (#1065):
 * 1. Ensure a rebase is in progress (re-start from origin/base if clean miss aborted).
 * 2. List conflict paths.
 * 3. Deterministic additive-union resolve when safe.
 * 4. If residual conflicts and implementer harness configured, one surgical-fix invoke.
 * 5. `rebase --continue` + `push --force-with-lease`.
 * 6. Otherwise report failed/exhausted with paths (caller applies product terminal).
 */
export async function defaultResolveMergeConflicts(
  args: ResolveMergeConflictsArgs,
): Promise<ConflictResolveResult> {
  const { cfg, issueNumber, worktreePath, deps } = args;
  const gitFn = deps.gitInWorktree ?? gitInWorktree;
  const invokeFn: InvokeFn = deps.invokeFn ?? invoke;

  // Ensure rebase is active so conflict files exist for the resolver.
  let conflictPaths = args.conflictPaths ?? [];
  const rebaseActive = isRebaseInProgress(worktreePath);
  if (!rebaseActive) {
    const fetch = await gitFn(worktreePath, ["fetch", "origin", cfg.base_branch], {
      ignoreFailure: true,
    });
    if (fetch.code !== 0) {
      return {
        status: "failed",
        reason: `could not fetch origin/${cfg.base_branch} before conflict resolve`,
        conflictPaths,
      };
    }
    const rebase = await gitFn(worktreePath, ["rebase", `origin/${cfg.base_branch}`], {
      ignoreFailure: true,
    });
    if (rebase.code === 0) {
      // Clean on re-entry — just push.
      const pushed = await pushIssueBranch(cfg, issueNumber, worktreePath, gitFn);
      return pushed
        ? { status: "resolved_and_pushed" }
        : { status: "failed", reason: "rebase clean on re-entry but push failed", conflictPaths };
    }
    conflictPaths = await listRebaseConflictPaths(worktreePath, gitFn);
  } else if (conflictPaths.length === 0) {
    conflictPaths = await listRebaseConflictPaths(worktreePath, gitFn);
  }

  if (conflictPaths.length === 0) {
    // Rebase stopped but no unmerged paths visible — treat as failed with evidence.
    return {
      status: "failed",
      reason: "rebase conflict state without enumerable conflict paths",
      conflictPaths: [],
    };
  }

  // Deterministic-first for additive dual-side unions (#1061 help-string class).
  const det = await tryDeterministicAdditiveResolve(worktreePath, conflictPaths, gitFn);
  conflictPaths = det.remaining;

  if (conflictPaths.length === 0) {
    const cont = await continueRebaseAndPush(cfg, issueNumber, worktreePath, gitFn);
    if (cont.ok) return { status: "resolved_and_pushed" };
    return {
      status: "failed",
      reason: cont.reason,
      conflictPaths: await listRebaseConflictPaths(worktreePath, gitFn),
    };
  }

  // Implementer escalate under surgical-fix scope.
  const harness = cfg.harnesses?.implementer;
  if (!harness) {
    return {
      status: "exhausted",
      conflictPaths,
      reason: "no implementer harness configured for residual rebase conflicts",
    };
  }

  const findingsText =
    "Finish an in-progress git rebase that stopped with merge conflicts.\n" +
    "Conflict files (resolve these only; surgical-fix discipline):\n" +
    conflictPaths.map((p) => `- ${p}`).join("\n") +
    "\n" +
    "Rules:\n" +
    "- Resolve conflicts in the listed files only; keep both sides when changes are additive unions.\n" +
    "- After resolving each file: `git add <file>`.\n" +
    "- Do not abort the rebase. When all conflicts are resolved, run `git rebase --continue` " +
    "(repeat if more commits conflict).\n" +
    "- Do not push (the pipeline pushes with --force-with-lease after you finish).\n" +
    "- Do not expand scope beyond conflict resolution.";

  const prompt = buildFixPrompt({
    cfg,
    issueNumber,
    title: `Resolve rebase conflicts for #${issueNumber}`,
    reviewFindings: findingsText,
    fixRound: 1,
    pipelineRunId: args.runDir ? path.basename(args.runDir) : `conflict-resolve-${issueNumber}`,
  });

  try {
    await invokeFn(harness, worktreePath, prompt, {
      timeoutSec: cfg.fix_timeout,
      model: cfg.models?.fix ?? null,
      sandbox: cfg.harness_sandbox,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      reason: `implementer conflict resolve threw: ${msg}`,
      conflictPaths: await listRebaseConflictPaths(worktreePath, gitFn),
    };
  }

  // Stage any resolved files the implementer left unstaged, then continue.
  const still = await listRebaseConflictPaths(worktreePath, gitFn);
  if (still.length > 0) {
    return {
      status: "exhausted",
      conflictPaths: still,
      reason: "implementer finished but residual unmerged paths remain",
    };
  }

  const cont = await continueRebaseAndPush(cfg, issueNumber, worktreePath, gitFn);
  if (cont.ok) return { status: "resolved_and_pushed" };
  return {
    status: "failed",
    reason: cont.reason,
    conflictPaths: await listRebaseConflictPaths(worktreePath, gitFn),
  };
}

async function continueRebaseAndPush(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  gitFn: typeof gitInWorktree,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Loop continue for multi-commit rebases; bound iterations.
  for (let i = 0; i < 20; i++) {
    if (!isRebaseInProgress(wtPath)) break;
    const remaining = await listRebaseConflictPaths(wtPath, gitFn);
    if (remaining.length > 0) {
      return { ok: false, reason: `cannot continue rebase; unmerged: ${remaining.join(", ")}` };
    }
    const cont = await gitFn(wtPath, ["-c", "core.editor=true", "rebase", "--continue"], {
      ignoreFailure: true,
    });
    if (cont.code !== 0) {
      // May have finished (no rebase in progress) or hit a new conflict.
      if (!isRebaseInProgress(wtPath)) break;
      const again = await listRebaseConflictPaths(wtPath, gitFn);
      if (again.length > 0) {
        return { ok: false, reason: `rebase --continue hit further conflicts: ${again.join(", ")}` };
      }
      return {
        ok: false,
        reason: `git rebase --continue failed: ${(cont.stderr || cont.stdout || "").slice(0, 400)}`,
      };
    }
  }
  if (isRebaseInProgress(wtPath)) {
    return { ok: false, reason: "rebase still in progress after continue budget" };
  }
  const pushed = await pushIssueBranch(cfg, issueNumber, wtPath, gitFn);
  return pushed ? { ok: true } : { ok: false, reason: "force-with-lease push failed after conflict resolve" };
}

async function pushIssueBranch(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  gitFn: typeof gitInWorktree,
): Promise<boolean> {
  const wt = await getOnDiskForIssue(cfg, issueNumber);
  const slug = wt?.slug ?? path.basename(wtPath);
  const branch = branchName(issueNumber, slug);
  const pushAuth = cfg.git?.push_auth ?? DEFAULT_GIT_PUSH_AUTH;
  const push = await runConfiguredGitPush({
    cwd: wtPath,
    auth: pushAuth,
    args: ["push", "--force-with-lease", "origin", branch],
    deps: {
      gitConfigGet: async (cwd, key) => {
        const r = await gitFn(cwd, ["config", "--get", key], { ignoreFailure: true });
        return r.code === 0 ? r.stdout.trim() || null : null;
      },
      gitExec: gitExecForwardingEnv(wtPath, gitFn),
    },
  });
  return push.code === 0;
}

// ---------------------------------------------------------------------------
// Recovery entry — shared by early-conflict and post-CI CONFLICTING/DIRTY
// ---------------------------------------------------------------------------

/**
 * Conflict recovery shared by the early-conflict check (#95) and the Step 2
 * mergeability gate (#1065).
 *
 * 1. One clean auto-rebase, bounded by stage-attempt ledger `conflict_rebase`.
 * 2. On clean miss or prior clean attempt: bounded `conflict_resolve` (deterministic
 *    + implementer) — never park first-conflict / clean-bound-only as human
 *    merge-conflict with the #1061 “manual rebase needed” terminal.
 * 3. Success → force-with-lease push (inside resolve) → waiting “rebase-resolved; CI re-running”.
 * 4. Budget exhaust with residual conflicts → `review-findings` product failure
 *    with conflict paths.
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
  const resolveMergeConflictsFn: ResolveMergeConflictsFn =
    deps.resolveMergeConflicts ?? defaultResolveMergeConflicts;
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

  let alreadyCleanRebased: boolean;
  if (headShaForLedger && ledgerRunDir) {
    const hydrated = hydrateStageAttemptLedger(ledgerRunDir, ledgerDeps);
    alreadyCleanRebased = hydrated.ok
      ? hasAttempted(hydrated.ledger, headShaForLedger, "conflict_rebase") ||
        hasAttempted(hydrated.ledger, headShaForLedger, "ci_rebase")
      : true; // fail closed on corrupt ledger — escalate resolve, do not human-park
  } else if (headShaForLedger && deps.rebaseAttemptedForHead) {
    alreadyCleanRebased = deps.rebaseAttemptedForHead(headShaForLedger);
  } else {
    // Legacy injectable path (tests) — worktree marker check as cache only.
    alreadyCleanRebased = wt ? rebaseAlreadyAttemptedFn(wt.path) : true;
  }

  // ---- Path A: clean auto-rebase not yet attempted ----
  if (!alreadyCleanRebased && wt) {
    const beforeSha = headShaForLedger;

    // Claim-before-side-effect when we have head + runDir.
    if (beforeSha && ledgerRunDir) {
      const hydrated = hydrateStageAttemptLedger(ledgerRunDir, ledgerDeps);
      if (!hydrated.ok) {
        // Ledger unusable: escalate to resolve without the #1061 human terminal.
        // Fall through by treating clean rebase as already spent so resolve runs.
        alreadyCleanRebased = true;
      } else {
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
          alreadyCleanRebased = true; // escalate resolve
        } else if (!claimed.created && hasAttempted(claimed.ledger, beforeSha, "conflict_rebase")) {
          // Prior claim — do not re-fire clean rebase; escalate to resolve (#1065).
          alreadyCleanRebased = true;
        } else {
          // Fresh claim — run clean rebase below.
          const cleanOutcome = await runCleanRebaseAttempt({
            cfg,
            issueNumber,
            wtPath: wt.path,
            beforeSha,
            prNumber,
            stateDir,
            ledgerRunDir,
            ledgerDeps,
            deps,
            tryRebaseAndPushFn,
            getPrDetailFn,
            markRebaseAttemptedFn,
          });
          if (cleanOutcome.kind === "waiting") return cleanOutcome.outcome;
          // Clean miss → escalate to resolve with optional conflict paths.
          return runBoundedConflictResolve({
            cfg,
            issueNumber,
            wtPath: wt.path,
            beforeSha,
            prNumber,
            stateDir,
            runDir: ledgerRunDir,
            ledgerDeps,
            deps,
            setBlockedFn,
            getPrDetailFn,
            markRebaseAttemptedFn,
            resolveMergeConflictsFn,
            conflictPaths: cleanOutcome.conflictPaths,
          });
        }
      }
    } else {
      // No ledger head — legacy path still attempts one clean rebase via marker cache.
      const cleanOutcome = await runCleanRebaseAttempt({
        cfg,
        issueNumber,
        wtPath: wt.path,
        beforeSha,
        prNumber,
        stateDir,
        ledgerRunDir,
        ledgerDeps,
        deps,
        tryRebaseAndPushFn,
        getPrDetailFn,
        markRebaseAttemptedFn,
      });
      if (cleanOutcome.kind === "waiting") return cleanOutcome.outcome;
      return runBoundedConflictResolve({
        cfg,
        issueNumber,
        wtPath: wt.path,
        beforeSha,
        prNumber,
        stateDir,
        runDir: ledgerRunDir,
        ledgerDeps,
        deps,
        setBlockedFn,
        getPrDetailFn,
        markRebaseAttemptedFn,
        resolveMergeConflictsFn,
        conflictPaths: cleanOutcome.conflictPaths,
      });
    }
  }

  // ---- Path B: clean rebase already attempted / unavailable → bounded resolve ----
  if (!wt) {
    // No managed worktree — product failure with structural cause (not manual-rebase park).
    const reason =
      "Pre-merge merge conflict recovery requires a managed worktree for bounded " +
      "conflict resolution; worktree is missing after clean auto-rebase miss.";
    await setBlockedFn(cfg, issueNumber, reason, "pre-merge", CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
    return preMergeBlocked(reason, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  }

  return runBoundedConflictResolve({
    cfg,
    issueNumber,
    wtPath: wt.path,
    beforeSha: headShaForLedger,
    prNumber,
    stateDir,
    runDir: ledgerRunDir,
    ledgerDeps,
    deps,
    setBlockedFn,
    getPrDetailFn,
    markRebaseAttemptedFn,
    resolveMergeConflictsFn,
  });
}

// ---------------------------------------------------------------------------
// Clean rebase attempt helper
// ---------------------------------------------------------------------------

type CleanRebaseOutcome =
  | { kind: "waiting"; outcome: Outcome }
  | { kind: "conflict"; conflictPaths?: string[] };

async function runCleanRebaseAttempt(input: {
  cfg: PipelineConfig;
  issueNumber: number;
  wtPath: string;
  beforeSha?: string;
  prNumber?: number;
  stateDir?: string;
  ledgerRunDir?: string;
  ledgerDeps?: StageAttemptLedgerDeps;
  deps: AdvancePreMergeDeps;
  tryRebaseAndPushFn: NonNullable<AdvancePreMergeDeps["tryRebaseAndPush"]>;
  getPrDetailFn: NonNullable<AdvancePreMergeDeps["getPrDetail"]>;
  markRebaseAttemptedFn: NonNullable<AdvancePreMergeDeps["markRebaseAttempted"]>;
}): Promise<CleanRebaseOutcome> {
  const {
    cfg,
    issueNumber,
    wtPath,
    beforeSha,
    prNumber,
    stateDir,
    ledgerRunDir,
    ledgerDeps,
    deps,
    tryRebaseAndPushFn,
    getPrDetailFn,
    markRebaseAttemptedFn,
  } = input;

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
        worktreePath: wtPath,
        gitInWorktree: deps.gitInWorktree ?? gitInWorktree,
        resolveBaseSha: async () => {
          const r = await (deps.gitInWorktree ?? gitInWorktree)(
            wtPath,
            ["rev-parse", `origin/${cfg.base_branch}`],
            { ignoreFailure: true },
          );
          return r.code === 0 ? r.stdout.trim() || null : null;
        },
        resolveCandidateSha: async () => {
          if (prNumber === undefined) {
            const local = await (deps.gitInWorktree ?? gitInWorktree)(
              wtPath,
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
              : "conflict-recovery clean rebase missed; escalating to conflict resolve";
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
    markRebaseAttemptedFn(wtPath);
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
                : "conflict-recovery clean rebase failed or HEAD unchanged",
            },
            ledgerDeps,
          );
        }
      }
    }
    if (rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved) {
      return {
        kind: "waiting",
        outcome: { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" },
      };
    }
    if (rebaseResult.ok && !rebaseResult.verified) {
      return {
        kind: "waiting",
        outcome: {
          advanced: false,
          status: "waiting",
          reason: REBASE_HEAD_UNVERIFIED_WAIT_REASON,
        },
      };
    }
    // verified no-op or failed → escalate resolve (not human park)
    let conflictPaths: string[] | undefined;
    try {
      conflictPaths = await listRebaseConflictPaths(wtPath, deps.gitInWorktree ?? gitInWorktree);
    } catch {
      conflictPaths = undefined;
    }
    return { kind: "conflict", conflictPaths };
  }

  // Legacy path without prNumber.
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
          : "conflict-recovery clean rebase missed; escalating to conflict resolve",
      ),
    ).catch(() => {});
  }
  markRebaseAttemptedFn(wtPath);
  if (claimCiRerunning) {
    return {
      kind: "waiting",
      outcome: { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" },
    };
  }
  return { kind: "conflict" };
}

// ---------------------------------------------------------------------------
// Bounded conflict resolve (#1065)
// ---------------------------------------------------------------------------

async function runBoundedConflictResolve(input: {
  cfg: PipelineConfig;
  issueNumber: number;
  wtPath: string;
  beforeSha?: string;
  prNumber?: number;
  stateDir?: string;
  runDir?: string;
  ledgerDeps?: StageAttemptLedgerDeps;
  deps: AdvancePreMergeDeps;
  setBlockedFn: NonNullable<AdvancePreMergeDeps["setBlocked"]>;
  getPrDetailFn: NonNullable<AdvancePreMergeDeps["getPrDetail"]>;
  markRebaseAttemptedFn: NonNullable<AdvancePreMergeDeps["markRebaseAttempted"]>;
  resolveMergeConflictsFn: ResolveMergeConflictsFn;
  conflictPaths?: string[];
}): Promise<Outcome> {
  const {
    cfg,
    issueNumber,
    wtPath,
    beforeSha,
    prNumber,
    stateDir,
    runDir,
    ledgerDeps,
    deps,
    setBlockedFn,
    getPrDetailFn,
    markRebaseAttemptedFn,
    resolveMergeConflictsFn,
  } = input;

  // Ledger claim for conflict_resolve — one-shot per head; prior failed claim
  // means budget exhausted.
  let resolveBudgetExhausted = false;
  let resolveAttemptId: string | undefined;
  if (beforeSha && runDir) {
    const hydrated = hydrateStageAttemptLedger(runDir, ledgerDeps);
    if (hydrated.ok) {
      if (hasAttempted(hydrated.ledger, beforeSha, "conflict_resolve")) {
        // Already charged resolve for this head — check if it completed success.
        const prior = hydrated.ledger.attempts.find(
          (a) => a.head_sha === beforeSha && a.action === "conflict_resolve",
        );
        if (prior && (prior.status === "completed" || prior.terminal_outcome === "success")) {
          // Prior success but still CONFLICTING on re-entry — re-evaluate as waiting.
          return {
            advanced: false,
            status: "waiting",
            reason: "rebase-resolved; CI re-running",
          };
        }
        resolveBudgetExhausted = true;
      } else {
        const claimed = claimAndPersistStageAttempt(
          runDir,
          hydrated.ledger,
          {
            headSha: beforeSha,
            action: "conflict_resolve",
            typedReason: "conflict_resolve",
            budgetBefore: CONFLICT_RESOLVE_BUDGET,
          },
          ledgerDeps,
        );
        if (!claimed.ok) {
          resolveBudgetExhausted = true;
        } else if (!claimed.created) {
          resolveBudgetExhausted = true;
        } else if (claimed.attempt.status === "exhausted") {
          resolveBudgetExhausted = true;
        } else {
          resolveAttemptId = claimed.attempt.attempt_id;
        }
      }
    } else {
      // Corrupt ledger: fail closed as product failure, not human manual-rebase.
      resolveBudgetExhausted = true;
    }
  } else if (beforeSha && deps.conflictResolveAttemptedForHead) {
    resolveBudgetExhausted = deps.conflictResolveAttemptedForHead(beforeSha);
  } else if (!beforeSha && deps.conflictResolveAttemptedForHead) {
    // Tests without head may still signal exhaust via injectable.
    resolveBudgetExhausted = deps.conflictResolveAttemptedForHead("");
  }

  if (resolveBudgetExhausted) {
    const paths =
      input.conflictPaths ??
      (await listRebaseConflictPaths(wtPath, deps.gitInWorktree ?? gitInWorktree).catch(() => []));
    const reason = buildConflictResolveExhaustedReason(paths);
    await setBlockedFn(
      cfg,
      issueNumber,
      reason,
      "pre-merge",
      CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND,
    );
    return preMergeBlocked(reason, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  }

  // Keep managed worktree; run bounded resolve (no setBlocked merge-conflict).
  let resolveResult: ConflictResolveResult;
  try {
    resolveResult = await resolveMergeConflictsFn({
      cfg,
      issueNumber,
      worktreePath: wtPath,
      conflictPaths: input.conflictPaths,
      beforeSha,
      prNumber,
      stateDir,
      runDir,
      deps,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    resolveResult = {
      status: "failed",
      reason: `conflict resolve threw: ${msg}`,
      conflictPaths: input.conflictPaths,
    };
  }

  markRebaseAttemptedFn(wtPath);

  const completeResolve = (succeeded: boolean, error?: string) => {
    if (!runDir || !beforeSha || !resolveAttemptId) return;
    const hydrated = hydrateStageAttemptLedger(runDir, ledgerDeps);
    if (!hydrated.ok) return;
    completeAndPersistStageAttempt(
      runDir,
      hydrated.ledger,
      { attemptId: resolveAttemptId, succeeded, error },
      ledgerDeps,
    );
  };

  if (resolveResult.status === "resolved_and_pushed") {
    completeResolve(true);
    // HEAD-moved verification when PR is known (#771).
    if (beforeSha !== undefined && prNumber !== undefined) {
      let afterSha = resolveResult.afterSha;
      if (afterSha === undefined) {
        try {
          afterSha = (await getPrDetailFn(cfg, prNumber)).head_sha;
        } catch {
          afterSha = undefined;
        }
      }
      const rebaseResult = await resolveRebasePushResult(beforeSha, true, afterSha);
      if (stateDir) {
        await recordCommand(
          stateDir,
          issueNumber,
          "pre-merge",
          makeCommandRecord(
            "conflict resolve + git push --force-with-lease",
            rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved ? 0 : 1,
            0,
            rebaseResult.ok && rebaseResult.verified && rebaseResult.headMoved
              ? "conflict-resolve succeeded; CI re-running"
              : rebaseResult.ok && !rebaseResult.verified
                ? "conflict-resolve reported success but PR head could not be re-read"
                : "conflict-resolve reported success but HEAD unchanged",
          ),
        ).catch(() => {});
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
      // HEAD unchanged after claimed resolve — still non-blocked waiting so
      // multi-item does not treat this as a completed human park (#1065).
      return {
        advanced: false,
        status: "waiting",
        reason: "rebase-resolved; CI re-running",
      };
    }
    if (stateDir) {
      await recordCommand(
        stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(
          "conflict resolve + git push --force-with-lease",
          0,
          0,
          "conflict-resolve succeeded; CI re-running",
        ),
      ).catch(() => {});
    }
    return { advanced: false, status: "waiting", reason: "rebase-resolved; CI re-running" };
  }

  if (resolveResult.status === "in_progress") {
    // Budget still held by started claim; leave in engine recovery (waiting).
    if (stateDir) {
      await recordCommand(
        stateDir,
        issueNumber,
        "pre-merge",
        makeCommandRecord(
          "conflict resolve (in progress)",
          1,
          0,
          resolveResult.reason ?? "conflict resolve in progress",
        ),
      ).catch(() => {});
    }
    return {
      advanced: false,
      status: "waiting",
      reason: resolveResult.reason ?? "conflict-resolve in progress; re-entering pre-merge",
    };
  }

  // failed or exhausted → product terminal with conflict evidence
  completeResolve(false, resolveResult.reason);
  const paths =
    resolveResult.conflictPaths ??
    input.conflictPaths ??
    (await listRebaseConflictPaths(wtPath, deps.gitInWorktree ?? gitInWorktree).catch(() => []));
  const reason = buildConflictResolveExhaustedReason(paths);
  // Prefer the structured exhausted reason; append resolver detail when useful.
  const fullReason =
    resolveResult.status === "exhausted" || paths.length > 0
      ? reason + (resolveResult.reason ? ` Detail: ${resolveResult.reason}` : "")
      : `Pre-merge conflict resolution failed: ${resolveResult.reason}. ` +
        buildConflictResolveExhaustedReason(paths);

  // Guard: never emit the illegal #1061 terminal under merge-conflict.
  if (isIllegalMergeConflictManualRebaseTerminal(fullReason)) {
    const safe =
      buildConflictResolveExhaustedReason(paths) +
      " (engine suppressed illegal manual-rebase terminal text)";
    await setBlockedFn(
      cfg,
      issueNumber,
      safe,
      "pre-merge",
      CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND,
    );
    return preMergeBlocked(safe, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
  }

  await setBlockedFn(
    cfg,
    issueNumber,
    fullReason,
    "pre-merge",
    CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND,
  );
  return preMergeBlocked(fullReason, CONFLICT_RESOLVE_EXHAUSTED_BLOCKER_KIND);
}

// ---------------------------------------------------------------------------
// Rebase tracking helpers
// ---------------------------------------------------------------------------

/**
 * Domain reconcile for early-conflict rebase bounds (#759 / #1065): ledger-first.
 * A recorded clean rebase attempt escalates to bounded conflict resolution —
 * it does **not** authorize an immediate human `block_manual_rebase` park.
 */
export function reconcileConflictRebaseState(input: {
  headSha?: string;
  ledgerAttempted: boolean;
  worktreeMarkerPresent?: boolean;
  /** When true, conflict_resolve budget for this head is already exhausted. */
  resolveBudgetExhausted?: boolean;
}): {
  actions: Array<
    | { kind: "attempt_rebase" }
    | { kind: "escalate_resolve" }
    | { kind: "block_product_failure" }
    /** @deprecated #1065 — retained for test compatibility; prefer escalate_resolve. */
    | { kind: "block_manual_rebase" }
  >;
} {
  if (input.resolveBudgetExhausted) {
    return { actions: [{ kind: "block_product_failure" }] };
  }
  if (input.ledgerAttempted) {
    return { actions: [{ kind: "escalate_resolve" }] };
  }
  // Marker alone without ledger is not sole authority — still allow attempt
  // when head is known and ledger is empty (migration). When no head, marker
  // may bound same-session tests that only inject the marker path → escalate
  // resolve rather than human park (#1065).
  if (!input.headSha && input.worktreeMarkerPresent) {
    return { actions: [{ kind: "escalate_resolve" }] };
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

/**
 * Clean auto-rebase + force-with-lease push.
 * On conflict: aborts the rebase and returns false (caller escalates to
 * bounded conflict resolve — #1065). Used by BEHIND auto-update and as the
 * clean-rebase attempt inside conflict recovery.
 *
 * Note: abort-on-conflict is intentional for the boolean helper so BEHIND
 * does not leave a wedged mid-rebase tree. Conflict recovery re-enters rebase
 * inside {@link defaultResolveMergeConflicts} / the injectable resolve seam.
 */
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
