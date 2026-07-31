// Human-invoked merge-queue sequential drive (#674 + #675):
// walk an ordered candidate list one PR at a time, revalidate eligibility,
// hold on conflict/red checks (never force-merge), optionally surgical-repair
// within budget, re-gate, then merge via the existing `mergePr` surface.
//
// NEVER called from the autonomous advance loop. Requires explicit --apply on
// the merge-queue command. No auto_merge config; no second gh pr merge path.
//
// gh pr view fields for already-done detection (confirmed 2026-07-30):
//   state: "OPEN" | "MERGED" | "CLOSED"
//   mergedAt: ISO string when merged, null otherwise
//
// gh pr view mergeability (confirmed 2026-06-17 / reuse merge_queue gates):
//   mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
//   mergeStateStatus: "CLEAN" | "DIRTY" | "UNKNOWN" | "BEHIND" | ...
//
// gh pr checks --required --json name,bucket (confirmed 2026-06-17):
//   bucket: "pass" | "fail" | "pending" | "skipping" | "cancel"

import { mergePr, realMergeDeps, type MergeDeps } from "./merge.ts";
import {
  evaluateChecksGate,
  formatMergeQueuePlan,
  planMergeQueue,
  type MergeQueueCandidate,
  type MergeQueueDeps,
} from "./merge_queue.ts";
import {
  buildMergeQueueRepairPrompt,
  canAttemptRepair,
  classifyEligibility,
  classifyMergeErrorToHoldReason,
  createHold,
  createRepairBudget,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  type MergeQueueHold,
  type MergeQueueHoldReason,
  type RepairBudget,
} from "./merge_queue_hold.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal ordered candidate consumed by drive (from #673 selection contract). */
export interface DriveCandidate {
  prNumber: number;
  issueNumber: number;
}

export type DriveRevalidation =
  | { kind: "eligible" }
  | { kind: "already-done"; reason: string }
  | { kind: "ineligible"; reason: string };

/** Full eligibility after open-state revalidation (mergeability + checks + base). */
export type DriveEligibility =
  | { kind: "eligible"; headRefOid: string | null }
  | {
      kind: "hold";
      reason: MergeQueueHoldReason;
      summary: string;
      headRefOid: string | null;
    }
  /**
   * Non-repairable hard ineligibility (e.g. PR retargeted off the queue base).
   * Drive must not merge or attempt surgical repair; treat as failed/held outcome.
   */
  | { kind: "ineligible"; reason: string; headRefOid: string | null }
  | { kind: "error"; reason: string };

export type DriveOutcomeKind =
  | "merged"
  | "skipped-already-done"
  | "held"
  | "failed"
  | "not-attempted";

export interface DriveItemOutcome {
  prNumber: number;
  issueNumber: number;
  outcome: DriveOutcomeKind;
  reason?: string;
  hold?: MergeQueueHold;
}

export interface DriveResult {
  outcomes: DriveItemOutcome[];
  /** Holds recorded this session (also mirrored on held outcomes). */
  holds: MergeQueueHold[];
  /** 0 when no hard fail-stop; held items alone leave exit 1 so operators notice. */
  exitCode: number;
  /** True when a hard (non-hold) failure stopped the batch. */
  stopped: boolean;
}

export interface DriveOptions {
  /** Opt-in surgical repair (default false). */
  repairEnabled?: boolean;
  /** Per-item max automatic repair attempts (default 1). */
  maxRepairAttempts?: number;
  /** Optional wall-clock bound for repair-related work (ms). */
  maxRepairWallClockMs?: number | null;
  /** Clock for budget tests. */
  nowMs?: () => number;
}

/**
 * I/O seam for drive. Unit tests inject fakes; production uses
 * {@link realDriveDeps} which revalidates via gh and merges via `mergePr`.
 */
export interface DriveDeps {
  revalidate(candidate: DriveCandidate): Promise<DriveRevalidation>;
  /**
   * Evaluate mergeability + required checks for an open PR.
   * Must not call mergePr. Used for hold classification and post-repair re-gate.
   */
  evaluateEligibility(candidate: DriveCandidate): Promise<DriveEligibility>;
  /** Must call the existing merge surface (`mergePr`); never a fork. */
  mergePr(pr: number): Promise<void>;
  /**
   * Optional repair path. When repair is disabled or this is omitted, holds
   * are recorded without harness invocation.
   */
  repair?: {
    resolveManagedWorktree(
      candidate: DriveCandidate,
    ): Promise<{ path: string } | null>;
    /**
     * Invoke fix/implementer with surgical-repair prompt. Must push only via
     * normal PR head updates — never force-merge.
     */
    invokeRepair(args: {
      candidate: DriveCandidate;
      holdReason: MergeQueueHoldReason;
      summary: string;
      worktreePath: string;
      lastHeadSha: string | null;
      prompt: string;
    }): Promise<{ ok: boolean; detail?: string }>;
  };
  log(msg: string): void;
}

export interface DriveRevalidateDeps {
  /** `gh pr view` — at least `state` and `mergedAt` for already-done. */
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
}

export interface DriveEligibilityDeps {
  ghPrView(pr: number, fields: string[]): Promise<Record<string, unknown>>;
  ghPrChecksRequired(pr: number): Promise<{ name: string; bucket: string }[]>;
  ghPrChecksAll(pr: number): Promise<{ name: string; bucket: string }[]>;
  /**
   * When set, each eligibility evaluation (including post-repair re-gate)
   * requires `baseRefName` to match this queue base. Mismatch is non-repairable.
   */
  expectedBaseBranch?: string;
}

// ---------------------------------------------------------------------------
// Revalidation (open / already-done)
// ---------------------------------------------------------------------------

/**
 * Classify a candidate immediately before merge.
 * Already-done (merged/closed) → skip+continue.
 * Open → eligible for further gate evaluation (mergeability/checks).
 * Unexpected non-open terminal states are treated as already-done.
 */
export async function revalidateDriveCandidate(
  candidate: DriveCandidate,
  deps: DriveRevalidateDeps,
): Promise<DriveRevalidation> {
  const prData = await deps.ghPrView(candidate.prNumber, ["state", "mergedAt"]);

  const state = String(prData.state ?? "").toUpperCase();
  const mergedAt = prData.mergedAt;
  const alreadyMerged =
    state === "MERGED" ||
    (mergedAt !== null && mergedAt !== undefined && String(mergedAt).length > 0);

  if (alreadyMerged) {
    return {
      kind: "already-done",
      reason:
        `PR #${candidate.prNumber} already merged` +
        (mergedAt ? ` (mergedAt=${String(mergedAt)})` : ""),
    };
  }

  if (state === "CLOSED") {
    return {
      kind: "already-done",
      reason: `PR #${candidate.prNumber} already closed (not open)`,
    };
  }

  if (state === "OPEN" || state === "") {
    // Empty state is unusual; still attempt further eligibility + mergePr gates.
    return { kind: "eligible" };
  }

  // Any other state: treat as terminal/not mergeable for this queue.
  return {
    kind: "already-done",
    reason: `PR #${candidate.prNumber} not open (state=${state})`,
  };
}

/**
 * Evaluate mergeability + required checks (+ configured base branch) — same
 * contract as merge-queue plan / mergePr gates. Returns hold classification
 * without merging. Base mismatch is non-repairable ineligibility.
 */
export async function evaluateDriveEligibility(
  candidate: DriveCandidate,
  deps: DriveEligibilityDeps,
): Promise<DriveEligibility> {
  try {
    const prData = await deps.ghPrView(candidate.prNumber, [
      "mergeable",
      "mergeStateStatus",
      "headRefOid",
      "baseRefName",
    ]);
    const mergeable = String(prData.mergeable ?? "UNKNOWN");
    const mergeStateStatus = String(prData.mergeStateStatus ?? "UNKNOWN");
    const headRefOid = String(prData.headRefOid ?? "") || null;
    const baseRefName = String(prData.baseRefName ?? "");
    const expectedBase = (deps.expectedBaseBranch ?? "").trim();

    // Re-assert queue base on every eligibility pass (pre-merge and post-repair).
    // A PR retargeted after planning must never reach mergePr.
    if (expectedBase && baseRefName !== expectedBase) {
      return {
        kind: "ineligible",
        reason:
          `wrong base: baseRefName=${baseRefName || "(empty)"} ` +
          `expected=${expectedBase}`,
        headRefOid,
      };
    }

    const checks = await evaluateChecksGate(candidate.prNumber, deps);
    const classified = classifyEligibility({
      mergeable,
      mergeStateStatus,
      checksOk: checks.ok,
      checksSummary: checks.ok ? checks.summary : checks.detail || checks.summary,
      headRefOid,
    });

    if (classified.kind === "eligible") {
      return { kind: "eligible", headRefOid };
    }
    return {
      kind: "hold",
      reason: classified.reason,
      summary: classified.summary,
      headRefOid,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "error", reason: `eligibility evaluation error: ${reason}` };
  }
}

// ---------------------------------------------------------------------------
// Drive core
// ---------------------------------------------------------------------------

export function candidatesFromPlan(
  candidates: readonly MergeQueueCandidate[],
): DriveCandidate[] {
  return candidates.map((c) => ({
    prNumber: c.prNumber,
    issueNumber: c.issueNumber,
  }));
}

/**
 * Planning-time skip reasons that map to drive hold/repair vocabulary.
 * These must reach drive under --apply so holds (and optional repair) run;
 * dry-run continues to present them only as plan skips.
 */
const DRIVE_HOLDABLE_SKIP_REASONS = new Set([
  "non-mergeable",
  "checks-not-green",
]);

/**
 * Ordered drive list for --apply: plan candidates plus holdable planning-time
 * skips (`non-mergeable`, `checks-not-green`) so already-conflicted/red R2D
 * PRs still record stable holds and may enter the optional repair/re-gate loop.
 * Permanent hard skips (missing-pr, wrong-base, empty-head-sha) stay plan-only.
 */
export function driveCandidatesFromPlan(plan: {
  candidates: readonly MergeQueueCandidate[];
  skips: readonly {
    issueNumber: number;
    prNumber: number | null;
    reason: string;
  }[];
}): DriveCandidate[] {
  const combined: DriveCandidate[] = candidatesFromPlan(plan.candidates);
  for (const s of plan.skips) {
    if (s.prNumber == null) continue;
    if (!DRIVE_HOLDABLE_SKIP_REASONS.has(s.reason)) continue;
    combined.push({ prNumber: s.prNumber, issueNumber: s.issueNumber });
  }
  combined.sort(
    (a, b) => a.issueNumber - b.issueNumber || a.prNumber - b.prNumber,
  );
  const seen = new Set<number>();
  const out: DriveCandidate[] = [];
  for (const c of combined) {
    if (seen.has(c.prNumber)) continue;
    seen.add(c.prNumber);
    out.push(c);
  }
  return out;
}

function resolveBudget(opts: DriveOptions | undefined): RepairBudget {
  return createRepairBudget({
    maxAttempts: opts?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
    maxWallClockMs: opts?.maxRepairWallClockMs ?? null,
    nowMs: opts?.nowMs?.(),
  });
}

/**
 * Sequential single-flight drive over an ordered candidate list.
 * Awaits revalidation + optional repair + merge for each item before the next.
 *
 * Default policy for merge-conflict / checks-failed: **hold-item-and-continue**.
 * Hard errors (revalidation exception, eligibility I/O error, non-hold merge
 * failure) still fail-stop the batch.
 */
export async function driveMergeQueue(
  candidates: readonly DriveCandidate[],
  deps: DriveDeps,
  opts: DriveOptions = {},
): Promise<DriveResult> {
  const outcomes: DriveItemOutcome[] = [];
  const holds: MergeQueueHold[] = [];
  let stopped = false;
  let stopReason: string | undefined;
  const repairEnabled = opts.repairEnabled === true;
  const budget = resolveBudget(opts);
  const nowMs = () => (opts.nowMs ? opts.nowMs() : Date.now());

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    if (stopped) {
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "not-attempted",
        reason: stopReason ?? "prior item failed",
      });
      continue;
    }

    deps.log(
      `[merge-queue drive] (${i + 1}/${candidates.length}) issue #${c.issueNumber} PR #${c.prNumber}: revalidating...`,
    );

    let reval: DriveRevalidation;
    try {
      reval = await deps.revalidate(c);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: revalidation error — fail-stop: ${reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason: `revalidation error: ${reason}`,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
      continue;
    }

    if (reval.kind === "already-done") {
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: skipped already-done — ${reval.reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "skipped-already-done",
        reason: reval.reason,
      });
      continue;
    }

    if (reval.kind === "ineligible") {
      // Generic hard ineligibility (not conflict/checks hold vocabulary).
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: ineligible — fail-stop: ${reval.reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason: reval.reason,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
      continue;
    }

    // Open (reval eligible) — evaluate mergeability + checks + base; may hold/repair.
    let eligibility = await deps.evaluateEligibility(c);
    if (eligibility.kind === "error") {
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: eligibility error — fail-stop: ${eligibility.reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason: eligibility.reason,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
      continue;
    }

    if (eligibility.kind === "ineligible") {
      // Non-repairable (e.g. retargeted off queue base). Fail this item and
      // stop the batch — never merge into an unexpected base branch.
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: ineligible — fail-stop: ${eligibility.reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason: eligibility.reason,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
      continue;
    }

    let repairAttempts = 0;

    // Optional repair loop while hold condition remains and budget allows.
    while (eligibility.kind === "hold") {
      if (
        !repairEnabled ||
        !deps.repair ||
        !canAttemptRepair(repairAttempts, budget, nowMs())
      ) {
        break;
      }

      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: hold ${eligibility.reason} — attempting surgical repair ` +
          `(attempt ${repairAttempts + 1}/${budget.maxAttempts})...`,
      );

      // Catch resolver/harness rejections so we still record a durable hold and
      // continue later candidates under hold-and-continue (never drop evidence).
      try {
        const wt = await deps.repair.resolveManagedWorktree(c);
        if (!wt) {
          deps.log(
            `[merge-queue drive] PR #${c.prNumber}: no managed worktree — cannot repair; holding`,
          );
          // Count as a spent attempt so we do not spin on missing worktree.
          repairAttempts++;
          break;
        }

        const prompt = buildMergeQueueRepairPrompt({
          prNumber: c.prNumber,
          issueNumber: c.issueNumber,
          reason: eligibility.reason,
          summary: eligibility.summary,
          worktreePath: wt.path,
          lastHeadSha: eligibility.headRefOid,
        });

        const repairResult = await deps.repair.invokeRepair({
          candidate: c,
          holdReason: eligibility.reason,
          summary: eligibility.summary,
          worktreePath: wt.path,
          lastHeadSha: eligibility.headRefOid,
          prompt,
        });
        repairAttempts++;

        if (!repairResult.ok) {
          deps.log(
            `[merge-queue drive] PR #${c.prNumber}: repair attempt failed` +
              (repairResult.detail ? ` — ${repairResult.detail}` : ""),
          );
        } else {
          deps.log(
            `[merge-queue drive] PR #${c.prNumber}: repair push completed — re-gating eligibility...`,
          );
        }
      } catch (err) {
        const infraReason = err instanceof Error ? err.message : String(err);
        repairAttempts++;
        deps.log(
          `[merge-queue drive] PR #${c.prNumber}: repair infrastructure error — holding: ${infraReason}`,
        );
        // Keep hold reason; fold infra failure into evidence for the operator.
        eligibility = {
          kind: "hold",
          reason: eligibility.reason,
          summary: `${eligibility.summary}; repair-infra-error: ${infraReason}`,
          headRefOid: eligibility.headRefOid,
        };
        break;
      }

      // Always re-gate after a repair attempt (success or claimed success).
      eligibility = await deps.evaluateEligibility(c);
      if (eligibility.kind === "error") {
        deps.log(
          `[merge-queue drive] PR #${c.prNumber}: re-gate error — fail-stop: ${eligibility.reason}`,
        );
        outcomes.push({
          prNumber: c.prNumber,
          issueNumber: c.issueNumber,
          outcome: "failed",
          reason: eligibility.reason,
        });
        stopped = true;
        stopReason = `stopped after PR #${c.prNumber}`;
        break;
      }
      if (eligibility.kind === "ineligible") {
        deps.log(
          `[merge-queue drive] PR #${c.prNumber}: re-gate ineligible — fail-stop: ${eligibility.reason}`,
        );
        outcomes.push({
          prNumber: c.prNumber,
          issueNumber: c.issueNumber,
          outcome: "failed",
          reason: eligibility.reason,
        });
        stopped = true;
        stopReason = `stopped after PR #${c.prNumber}`;
        break;
      }
    }

    if (stopped) continue;

    if (eligibility.kind === "hold") {
      const hold = createHold({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        reason: eligibility.reason,
        summary: eligibility.summary,
        lastHeadSha: eligibility.headRefOid,
        repairAttempts,
      });
      holds.push(hold);
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: held (${hold.reason}) — continue remaining candidates. ` +
          hold.remediation,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "held",
        reason: hold.reason,
        hold,
      });
      // Hold-and-continue: do not stop the batch.
      continue;
    }

    if (eligibility.kind !== "eligible") {
      // Defensive: any non-eligible, non-hold outcome that escaped above.
      const reason =
        "reason" in eligibility
          ? String((eligibility as { reason: string }).reason)
          : `unexpected eligibility kind`;
      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: not eligible — fail-stop: ${reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
      continue;
    }

    // eligible — only path that calls mergePr
    deps.log(`[merge-queue drive] PR #${c.prNumber}: eligible — calling mergePr...`);
    try {
      await deps.mergePr(c.prNumber);
      deps.log(`[merge-queue drive] PR #${c.prNumber}: merged`);
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "merged",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const holdReason = classifyMergeErrorToHoldReason(reason);
      if (holdReason) {
        // Belt-and-suspenders: mergePr refused for conflict/checks after our
        // pre-check (TOCTOU). Hold-and-continue; never force-merge.
        const hold = createHold({
          prNumber: c.prNumber,
          issueNumber: c.issueNumber,
          reason: holdReason,
          summary: reason,
          lastHeadSha: eligibility.headRefOid,
          repairAttempts,
        });
        holds.push(hold);
        deps.log(
          `[merge-queue drive] PR #${c.prNumber}: merge refused (${holdReason}) — hold and continue. ` +
            hold.remediation,
        );
        outcomes.push({
          prNumber: c.prNumber,
          issueNumber: c.issueNumber,
          outcome: "held",
          reason: hold.reason,
          hold,
        });
        continue;
      }

      deps.log(
        `[merge-queue drive] PR #${c.prNumber}: merge failed — fail-stop: ${reason}`,
      );
      outcomes.push({
        prNumber: c.prNumber,
        issueNumber: c.issueNumber,
        outcome: "failed",
        reason,
      });
      stopped = true;
      stopReason = `stopped after PR #${c.prNumber}`;
    }
  }

  const hasHardFail = stopped || outcomes.some((o) => o.outcome === "failed");
  const hasHolds = holds.length > 0 || outcomes.some((o) => o.outcome === "held");
  // Non-zero when anything needs operator attention (hard fail or holds).
  const exitCode = hasHardFail || hasHolds ? 1 : 0;
  return { outcomes, holds, exitCode, stopped };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function formatDriveSummary(
  result: DriveResult,
  opts?: { milestone?: string; repo?: string },
): string {
  const lines: string[] = [];
  lines.push("pipeline merge-queue — drive summary");
  if (opts?.milestone) lines.push(`  selector: milestone="${opts.milestone}"`);
  if (opts?.repo) lines.push(`  repo: ${opts.repo}`);
  lines.push(`  mode: apply`);
  lines.push("");

  const counts = {
    merged: 0,
    "skipped-already-done": 0,
    held: 0,
    failed: 0,
    "not-attempted": 0,
  };
  for (const o of result.outcomes) {
    counts[o.outcome]++;
    const reason = o.reason ? `  (${o.reason})` : "";
    lines.push(
      `  - issue #${o.issueNumber}  PR #${o.prNumber}  → ${o.outcome}${reason}`,
    );
    if (o.hold) {
      lines.push(`      remediation: ${o.hold.remediation}`);
      if (o.hold.summary) {
        lines.push(
          `      evidence: summary=${o.hold.summary}` +
            (o.hold.lastHeadSha ? ` head=${o.hold.lastHeadSha}` : "") +
            ` repair_attempts=${o.hold.repairAttempts}`,
        );
      }
    }
  }

  if (result.outcomes.length === 0) {
    lines.push("  (no candidates)");
  }

  if (result.holds.length > 0) {
    lines.push("");
    lines.push(`Outstanding holds (${result.holds.length}):`);
    for (const h of result.holds) {
      lines.push(
        `  - PR #${h.prNumber} issue #${h.issueNumber} reason=${h.reason} ` +
          `attempts=${h.repairAttempts}: ${h.summary}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `Summary: ${counts.merged} merged, ${counts["skipped-already-done"]} skipped-already-done, ` +
      `${counts.held} held, ${counts.failed} failed, ${counts["not-attempted"]} not-attempted.` +
      (result.stopped
        ? " Drive stopped on hard failure."
        : result.holds.length > 0
          ? " Drive completed with holds (hold-and-continue)."
          : " Drive completed."),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Production deps + CLI entry
// ---------------------------------------------------------------------------

/**
 * Production drive deps: already-done via ghPrView; eligibility via the same
 * mergeability + checks + base gates as the plan; merge only via exported
 * `mergePr`. Repair hooks are optional and off unless the caller wires `repair`.
 */
export function realDriveDeps(
  repo: string,
  mergeDeps: MergeDeps = realMergeDeps(repo),
  repair?: DriveDeps["repair"],
  opts?: { expectedBaseBranch?: string },
): DriveDeps {
  const eligibilityDeps: DriveEligibilityDeps = {
    ghPrView: (pr, fields) => mergeDeps.ghPrView(pr, fields),
    ghPrChecksRequired: (pr) => mergeDeps.ghPrChecksRequired(pr),
    ghPrChecksAll: (pr) => mergeDeps.ghPrChecksAll(pr),
    expectedBaseBranch: opts?.expectedBaseBranch,
  };

  return {
    revalidate: (candidate) =>
      revalidateDriveCandidate(candidate, {
        ghPrView: (pr, fields) => mergeDeps.ghPrView(pr, fields),
      }),
    evaluateEligibility: (candidate) =>
      evaluateDriveEligibility(candidate, eligibilityDeps),
    mergePr: (pr) => mergePr(pr, mergeDeps),
    repair,
    log: (msg) => mergeDeps.log(msg),
  };
}

/**
 * Unified merge-queue CLI entry: dry-run plan (default) or sequential drive
 * with `--apply`. Optional `--repair` enables surgical repair on holds.
 * Returns process exit codes: 0 ok, 1 drive fail-stop or holds, 2 usage.
 */
export async function runMergeQueueCommand(
  opts: {
    milestone: string | undefined;
    dryRun?: boolean;
    apply?: boolean;
    baseBranch?: string;
    /** Opt-in surgical repair for merge-conflict / checks-failed holds (#675). */
    repair?: boolean;
    maxRepairAttempts?: number;
    maxRepairWallClockMs?: number | null;
  },
  planDeps: MergeQueueDeps,
  driveDeps: DriveDeps | undefined,
  print: (msg: string) => void = console.log,
  repo?: string,
): Promise<number> {
  if (opts.apply && opts.dryRun) {
    print(
      "pipeline merge-queue: cannot combine --apply and --dry-run.\n" +
        "  Use --apply to drive merges, or omit both flags (default dry-run plan).",
    );
    return 2;
  }

  if (opts.repair && !opts.apply) {
    print(
      "pipeline merge-queue: --repair requires --apply.\n" +
        "  Surgical repair only runs during drive (not dry-run plan).",
    );
    return 2;
  }

  if (!opts.milestone || !opts.milestone.trim()) {
    print(
      "pipeline merge-queue: --milestone is required.\n" +
        '  Usage: pipeline merge-queue --milestone "<title>" [--dry-run | --apply] [--repair]\n' +
        '  Example: pipeline merge-queue --milestone "v1.28.2"\n' +
        "  Default mode is dry-run (no merges). Pass --apply to merge sequentially.\n" +
        "  Pass --repair with --apply to attempt surgical conflict/CI repair (budget-bounded).",
    );
    return 2;
  }

  // Dry-run (default): plan only, zero merges.
  if (!opts.apply) {
    const plan = await planMergeQueue(
      { milestone: opts.milestone, dryRun: true, baseBranch: opts.baseBranch },
      planDeps,
    );
    print(formatMergeQueuePlan(plan, repo));
    return 0;
  }

  // Apply requires drive deps (injected fakes in tests; realDriveDeps in CLI).
  if (!driveDeps) {
    print(
      "pipeline merge-queue: --apply requires drive wiring (internal error).\n" +
        "  CLI must pass realDriveDeps; tests must inject DriveDeps.",
    );
    return 1;
  }

  const plan = await planMergeQueue(
    { milestone: opts.milestone, dryRun: false, baseBranch: opts.baseBranch },
    planDeps,
  );
  print(formatMergeQueuePlan(plan, repo));
  print("");

  // Include planning-time non-mergeable / checks-not-green skips so drive can
  // record holds and optionally repair — do not drop them before the drive path.
  const driveCandidates = driveCandidatesFromPlan(plan);
  if (driveCandidates.length === 0) {
    print(
      formatDriveSummary(
        { outcomes: [], holds: [], exitCode: 0, stopped: false },
        { milestone: plan.milestone, repo },
      ),
    );
    print("No eligible candidates to merge; drive performed zero merges.");
    return 0;
  }

  const result = await driveMergeQueue(driveCandidates, driveDeps, {
    repairEnabled: opts.repair === true,
    maxRepairAttempts: opts.maxRepairAttempts,
    maxRepairWallClockMs: opts.maxRepairWallClockMs,
  });
  print(formatDriveSummary(result, { milestone: plan.milestone, repo }));
  return result.exitCode;
}
