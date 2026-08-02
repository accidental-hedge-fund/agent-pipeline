/**
 * Stage-agnostic no-new-commit goal-satisfaction contract (#758).
 *
 * When a harness (or equivalent commit-producing) round ends with no new
 * commit after salvage has run (or correctly determined there is nothing to
 * salvage), evaluate whether current HEAD already satisfies the declaring
 * stage's goal. Stages supply deterministic goal checks; this module owns
 * only the shared control skeleton:
 *
 *   clean no-new-commit? → run goal check → advance | escalate
 *   otherwise            → not-applicable (existing stage path continues)
 *
 * Advance requires attested evidence (stage, HEAD SHA, rationale class, note).
 * Escalation is fail-closed. Recovery re-entry (#787) reuses the same API.
 */

import { attestPipelineComment } from "./stages/review-parsing.ts";

/** Closed decision set for the shared evaluation. */
export type NoopAdvanceDecision = "advance" | "escalate" | "not-applicable";

/**
 * Machine-readable rationale classes required by the capability. Stages may
 * use these strings or more specific sub-classes that still map to them.
 */
export const NOOP_RATIONALE_CLASSES = [
  "fix-no-actionable-work",
  "pre-merge-findings-clear",
  "pre-merge-archive-coherent",
  "implement-deliverable-present",
] as const;

export type NoopRationaleClass = (typeof NOOP_RATIONALE_CLASSES)[number] | (string & {});

/** Result of a stage-supplied goal check. */
export type GoalCheckResult =
  | {
      satisfied: true;
      rationaleClass: NoopRationaleClass;
      note: string;
      /** Optional stage-private payload (e.g. covered DNR declarations). */
      payload?: unknown;
    }
  | {
      satisfied: false;
      /** Why the goal is not satisfied — used in escalate evidence/notes. */
      note?: string;
      rationaleClass?: NoopRationaleClass;
    };

export type GoalCheck = () => GoalCheckResult | Promise<GoalCheckResult>;

/** Attested evidence payload required on advance. */
export interface NoopAdvanceEvidence {
  stage: string;
  headSha: string;
  rationaleClass: NoopRationaleClass;
  note: string;
  issueNumber?: number;
  /** ISO-8601 timestamp when the evaluation ran. */
  at: string;
  /** Optional stage-private payload from the goal check. */
  payload?: unknown;
}

export type NoopAdvanceResult =
  | {
      decision: "advance";
      evidence: NoopAdvanceEvidence;
    }
  | {
      decision: "escalate";
      note: string;
      rationaleClass?: NoopRationaleClass;
    }
  | {
      decision: "not-applicable";
      reason: string;
    };

export interface EvaluatePostHarnessNoNewCommitInput {
  /** HEAD captured before the harness (or equivalent) round. */
  headBefore: string;
  /** HEAD after invoke + optional salvage. */
  headAfter: string;
  /**
   * True when salvage created a commit. Successful salvage is
   * not-applicable to clean-noop goal advance.
   */
  salvaged: boolean;
  /**
   * True when salvage ran (or recovery/pre-merge confirmed a clean tree with
   * nothing to salvage) and found nothing — i.e. a confirmed clean / no-salvage
   * round. Required for clean-noop goal advance; false/omitted → not-applicable
   * so callers cannot evaluate after salvage was skipped or failed (#758 R1).
   */
  salvageFoundNothing: boolean;
  /** Stage identity for evidence (e.g. "fix-1", "implementing", "pre-merge"). */
  stage: string;
  issueNumber?: number;
  /**
   * Stage-supplied deterministic check: does HEAD already satisfy this stage's
   * goal? Only invoked when preconditions for clean no-new-commit hold.
   */
  goalCheck: GoalCheck;
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface EvaluatePreHarnessNoWorkInput {
  /** Current HEAD when the pre-harness skip is evaluated. */
  headSha: string;
  stage: string;
  issueNumber?: number;
  goalCheck: GoalCheck;
  now?: () => Date;
}

/** Heading for attested noop-advance evidence comments (#758). */
export const NOOP_ADVANCE_EVIDENCE_HEADING = "## Pipeline: noop-advance evidence";

/**
 * Format a durable, human-readable attested note from an advance evidence
 * payload. Callers post this via trusted comment / event / evidence-bundle
 * channels. Does not invent commits. Body is pipeline-attested.
 */
export function formatNoopAdvanceEvidenceNote(evidence: NoopAdvanceEvidence): string {
  const issuePart =
    typeof evidence.issueNumber === "number" ? ` issue #${evidence.issueNumber}` : "";
  const shaShort =
    evidence.headSha.length > 12 ? evidence.headSha.slice(0, 12) : evidence.headSha;
  const rendered = [
    NOOP_ADVANCE_EVIDENCE_HEADING,
    "",
    `Stage \`${evidence.stage}\`${issuePart}: HEAD already satisfies the stage goal ` +
      `(no new commit required).`,
    "",
    `- **HEAD:** \`${shaShort}\``,
    `- **Rationale class:** \`${evidence.rationaleClass}\``,
    `- **Note:** ${evidence.note}`,
    `- **At:** ${evidence.at}`,
  ].join("\n");
  return attestPipelineComment("noop-advance-evidence", rendered);
}

/**
 * Structured fields suitable for `gate_result` / event sinks without inventing
 * a second marker scheme.
 */
export function noopAdvanceEvidenceFields(
  evidence: NoopAdvanceEvidence,
): Record<string, string | number | boolean> {
  return {
    gate: "noop-advance",
    result: "pass",
    stage: evidence.stage,
    head_sha: evidence.headSha,
    rationale_class: String(evidence.rationaleClass),
    note: evidence.note,
    ...(typeof evidence.issueNumber === "number" ? { issue: evidence.issueNumber } : {}),
  };
}

function isoNow(now?: () => Date): string {
  return (now?.() ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
}

function isCleanNoNewCommit(
  headBefore: string,
  headAfter: string,
  salvaged: boolean,
  salvageFoundNothing: boolean,
): boolean {
  return Boolean(
    headBefore &&
      headAfter &&
      headBefore === headAfter &&
      !salvaged &&
      salvageFoundNothing,
  );
}

/**
 * Post-harness (or post-round) evaluation: only runs the stage goal check when
 * the round is a confirmed clean no-new-commit (HEAD unchanged, salvage did not
 * create a commit, and salvageFoundNothing confirms a clean/no-salvage round).
 * Non-empty commit ranges, successful salvage, and unconfirmed clean status
 * return not-applicable so the stage continues its existing path.
 */
export async function evaluatePostHarnessNoNewCommit(
  input: EvaluatePostHarnessNoNewCommitInput,
): Promise<NoopAdvanceResult> {
  const {
    headBefore,
    headAfter,
    salvaged,
    salvageFoundNothing,
    stage,
    issueNumber,
    goalCheck,
    now,
  } = input;

  if (salvaged) {
    return {
      decision: "not-applicable",
      reason: "salvage created a commit — follow post-salvage verification path",
    };
  }

  if (!salvageFoundNothing) {
    return {
      decision: "not-applicable",
      reason:
        "clean/no-salvage status not confirmed — salvage was skipped, failed, or worktree not proven clean",
    };
  }

  if (!headBefore || !headAfter) {
    return {
      decision: "not-applicable",
      reason: "missing headBefore/headAfter — insufficient inputs for clean no-new-commit evaluation",
    };
  }

  if (headBefore !== headAfter) {
    return {
      decision: "not-applicable",
      reason: "non-empty commit range — continue existing commit-gate path",
    };
  }

  if (!isCleanNoNewCommit(headBefore, headAfter, salvaged, salvageFoundNothing)) {
    return {
      decision: "not-applicable",
      reason: "not a clean no-new-commit path",
    };
  }

  const check = await goalCheck();
  if (check.satisfied) {
    return {
      decision: "advance",
      evidence: {
        stage,
        headSha: headAfter,
        rationaleClass: check.rationaleClass,
        note: check.note,
        issueNumber,
        at: isoNow(now),
        ...(check.payload !== undefined ? { payload: check.payload } : {}),
      },
    };
  }

  return {
    decision: "escalate",
    note:
      check.note ??
      `${stage}: clean no-new-commit at HEAD but stage goal is not satisfied`,
    ...(check.rationaleClass !== undefined
      ? { rationaleClass: check.rationaleClass }
      : {}),
  };
}

/**
 * Pre-harness evaluation for "nothing left to do" skips (e.g. fix override-empty).
 * Always runs the goal check — there is no commit-range precondition. Used when
 * the stage knows work is already dispositioned before invoking a harness.
 */
export async function evaluatePreHarnessNoWork(
  input: EvaluatePreHarnessNoWorkInput,
): Promise<NoopAdvanceResult> {
  const { headSha, stage, issueNumber, goalCheck, now } = input;
  const check = await goalCheck();
  if (check.satisfied) {
    return {
      decision: "advance",
      evidence: {
        stage,
        headSha: headSha || "(unknown)",
        rationaleClass: check.rationaleClass,
        note: check.note,
        issueNumber,
        at: isoNow(now),
        ...(check.payload !== undefined ? { payload: check.payload } : {}),
      },
    };
  }
  return {
    decision: "escalate",
    note: check.note ?? `${stage}: pre-harness goal not satisfied`,
    ...(check.rationaleClass !== undefined
      ? { rationaleClass: check.rationaleClass }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Thin pure goal-check builders (stage adapters compose these)
// ---------------------------------------------------------------------------

/**
 * Fix-stage: every triggering blocking finding already dispositioned
 * (override-empty pre-harness skip).
 */
export function fixOverrideEmptyGoalCheck(opts: {
  triggeringCount: number;
  effectiveCount: number;
}): GoalCheckResult {
  if (opts.triggeringCount > 0 && opts.effectiveCount === 0) {
    return {
      satisfied: true,
      rationaleClass: "fix-no-actionable-work",
      note:
        `All ${opts.triggeringCount} blocking finding(s) already dispositioned ` +
        `by override or non-reproducing disposition — nothing left to fix`,
    };
  }
  return {
    satisfied: false,
    note: "effective blocking set is non-empty — harness work remains",
    rationaleClass: "fix-no-actionable-work",
  };
}

/**
 * Fix-stage: external commit already applied (HEAD past reviewed SHA).
 */
export function fixExternalCommitGoalCheck(opts: {
  advance: boolean;
  reviewSha: string | null;
  headAfter: string;
}): GoalCheckResult {
  if (opts.advance && opts.reviewSha) {
    return {
      satisfied: true,
      rationaleClass: "fix-no-actionable-work",
      note:
        `HEAD (${opts.headAfter.slice(0, 12)}) is past reviewed SHA ` +
        `${opts.reviewSha.slice(0, 12)} — fix already applied externally`,
      payload: { kind: "external-commit", reviewSha: opts.reviewSha },
    };
  }
  return {
    satisfied: false,
    note: opts.reviewSha
      ? "HEAD equals reviewed SHA — no external commit advance"
      : "no trusted reviewed SHA available for external-commit advance",
    rationaleClass: "fix-no-actionable-work",
  };
}

/**
 * Fix-stage: every invoked finding covered by valid does-not-reproduce.
 */
export function fixDoesNotReproduceGoalCheck(opts: {
  advance: boolean;
  coveredCount: number;
  headAfter: string;
  missingCount?: number;
}): GoalCheckResult {
  if (opts.advance && opts.coveredCount > 0) {
    return {
      satisfied: true,
      rationaleClass: "fix-no-actionable-work",
      note:
        `${opts.coveredCount} blocking finding(s) declared non-reproducing at ` +
        `HEAD ${opts.headAfter.slice(0, 12)} — no code change required`,
      payload: { kind: "does-not-reproduce", coveredCount: opts.coveredCount },
    };
  }
  return {
    satisfied: false,
    note:
      opts.missingCount && opts.missingCount > 0
        ? `${opts.missingCount} invoked finding(s) lack a valid does-not-reproduce declaration`
        : "does-not-reproduce coverage incomplete or empty",
    rationaleClass: "fix-no-actionable-work",
  };
}

/**
 * Pre-merge: post-noop re-verify shows findings clear (partition residuals
 * handled by caller before/after this check).
 */
export function preMergeFindingsClearGoalCheck(opts: {
  reverifyBlockingCount: number;
  reverifyUnparseable: boolean;
  headSha: string;
}): GoalCheckResult {
  if (opts.reverifyBlockingCount === 0 && !opts.reverifyUnparseable) {
    return {
      satisfied: true,
      rationaleClass: "pre-merge-findings-clear",
      note:
        `Post-noop re-verify clean at HEAD ${opts.headSha.slice(0, 12)} — ` +
        `no residual blocking findings`,
    };
  }
  return {
    satisfied: false,
    note: opts.reverifyUnparseable
      ? "post-noop re-verify unparseable — fail closed"
      : `post-noop re-verify still has ${opts.reverifyBlockingCount} blocking finding(s)`,
    rationaleClass: "pre-merge-findings-clear",
  };
}

/**
 * Pre-merge archive: empty active set (true no-candidates) or coherent
 * archive completion for the same head evaluation.
 */
export function preMergeArchiveCoherentGoalCheck(opts: {
  activeIds: readonly string[];
  archiveCompleted?: boolean;
}): GoalCheckResult {
  if (opts.activeIds.length === 0) {
    return {
      satisfied: true,
      rationaleClass: "pre-merge-archive-coherent",
      note: "active OpenSpec change set empty — archive goal already met (no-candidates)",
    };
  }
  if (opts.archiveCompleted) {
    return {
      satisfied: true,
      rationaleClass: "pre-merge-archive-coherent",
      note: "archive outcome coherent for this head evaluation",
    };
  }
  return {
    satisfied: false,
    note:
      `active OpenSpec change(s) remain: ${[...opts.activeIds].sort().join(", ")} — ` +
      `not archive-coherent satisfaction`,
    rationaleClass: "pre-merge-archive-coherent",
  };
}

/**
 * Planning implement (#588): declared OpenSpec deliverable already present
 * at HEAD with clean tree relative to implement headBefore.
 */
export function implementDeliverablePresentGoalCheck(opts: {
  deliverablePresent: boolean;
  worktreeClean: boolean;
  gatesGreen?: boolean;
  deliverableDescription?: string;
}): GoalCheckResult {
  const gatesOk = opts.gatesGreen !== false;
  if (opts.deliverablePresent && opts.worktreeClean && gatesOk) {
    return {
      satisfied: true,
      rationaleClass: "implement-deliverable-present",
      note:
        opts.deliverableDescription ??
        "declared planning deliverable already present at HEAD — no empty implementer commit required",
    };
  }
  const reasons: string[] = [];
  if (!opts.deliverablePresent) reasons.push("deliverable absent");
  if (!opts.worktreeClean) reasons.push("worktree dirty");
  if (!gatesOk) reasons.push("gates not green");
  return {
    satisfied: false,
    note: `implement goal not satisfied (${reasons.join(", ")})`,
    rationaleClass: "implement-deliverable-present",
  };
}

/**
 * Compose multiple goal checks with first-satisfied wins (e.g. fix external
 * then DNR). Returns the first satisfied result, or the last unsatisfied.
 */
export function firstSatisfiedGoalCheck(
  checks: Array<() => GoalCheckResult | Promise<GoalCheckResult>>,
): GoalCheck {
  return async () => {
    let last: GoalCheckResult = {
      satisfied: false,
      note: "no goal checks configured",
    };
    for (const check of checks) {
      last = await check();
      if (last.satisfied) return last;
    }
    return last;
  };
}
