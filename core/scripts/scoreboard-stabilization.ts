// Stabilization scoreboard collectors (#763): human-touch, discovery-channel,
// escape-recurrence wiring helpers, FRG release-over-release series, stratified
// rates, and candidate-integrity observability. Pure over pre-scanned runs —
// no network/git. Missing evidence is diagnosed, never silently zeroed into
// success rates.

import {
  AUTO_FILE_DISCOVERY_CHANNEL,
  DISCOVERY_CHANNELS,
  isDiscoveryChannel,
  parseDiscoveryChannelLoose,
  resolveEventAttribution,
  runLevelDiscoveryChannel,
  type DiscoveryChannel,
  type RunEngineAttributionSource,
} from "./engine-attribution.ts";
import {
  computeEscapeRecurrence,
  mapSignalToDefectClassKey,
  resolveFixBoundaries,
  type DefectOccurrence,
  type EscapeRecurrenceResult,
} from "./escape-recurrence.ts";
import type { ControlAttribution } from "./correction.ts";

/** Minimal FRG trend-ledger line shape (#757) — local to avoid loading the
 *  full factory-reliability-gate module (and its config/zod graph) into the
 *  scoreboard import path. */
export interface FrgTrendLedgerEntryLite {
  version: string;
  run_id: string;
  loop_run_id?: string | null;
  pass: boolean;
  pack_id?: string | null;
  created_at: string;
  item_count: number;
  ready_clean_count: number;
  engine_class_count: number;
  engine_class_rate: number | null;
}

// ---------------------------------------------------------------------------
// Shared rate helper
// ---------------------------------------------------------------------------

export interface RateValue {
  numerator: number;
  denominator: number;
  ratio: number | null;
}

export function rateValue(numerator: number, denominator: number): RateValue {
  return {
    numerator,
    denominator,
    ratio: denominator === 0 ? null : numerator / denominator,
  };
}

export interface StabilizationDiagnostic {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
}

// Minimal run shape consumed by these collectors (structurally matches scoreboard IncludedRun).
export interface StabilizationRun {
  runId: string;
  dir: string;
  runJson: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  summary: Record<string, unknown> | null;
  startAt: string;
  issue: number | null;
  pr: number | null;
  finalState: string | null;
}

// ---------------------------------------------------------------------------
// Human-touch accounting
// ---------------------------------------------------------------------------

export const HUMAN_TOUCH_KINDS = [
  "override",
  "unblock",
  "merge",
  "hand_tag",
  "manual_worktree_remove",
] as const;

export type HumanTouchKind = (typeof HUMAN_TOUCH_KINDS)[number];

export interface HumanTouchMetrics {
  total_touches: number;
  by_kind: Record<HumanTouchKind, number>;
  human_touches_per_attempted_issue: RateValue;
  human_touches_per_r2d_issue: RateValue;
  /** Touches attributed to issues that reached R2D (numerator for per-R2D). */
  touches_on_r2d_issues: number;
}

function stringField(obj: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Map a durable event to a discrete human-touch kind, or null when not a touch.
 * Never converts wall-clock spans into labor minutes.
 */
export function classifyHumanTouch(event: Record<string, unknown>): HumanTouchKind | null {
  const type = stringField(event, "type");
  if (type === "human_intervention") {
    const kind = stringField(event, "kind");
    if (kind === "human-risk-override") return "override";
    // Other intervention kinds are product/engine holds, not operator touches
    // for the discrete touch ledger — override is the audited operator action.
    return null;
  }
  if (type === "blocker_cleared") {
    // Durable clear after human unblock / override path.
    const source = stringField(event, "source") ?? stringField(event, "cleared_by");
    if (source === "engine" || source === "auto") return null;
    return "unblock";
  }
  if (type === "merge_authority" || type === "merge_applied" || type === "operator_merge") {
    return "merge";
  }
  if (type === "hand_stage_tag" || type === "manual_stage_label") {
    return "hand_tag";
  }
  if (type === "worktree_removed") {
    const source = stringField(event, "source") ?? stringField(event, "removed_by");
    if (source === "manual" || source === "operator" || event["manual"] === true) {
      return "manual_worktree_remove";
    }
    // Engine auto-remove is not a human touch.
    return null;
  }
  if (type === "human_touch") {
    const kind = stringField(event, "kind");
    if (kind && (HUMAN_TOUCH_KINDS as readonly string[]).includes(kind)) {
      return kind as HumanTouchKind;
    }
  }
  return null;
}

export function computeHumanTouchMetrics(runs: StabilizationRun[]): HumanTouchMetrics {
  const by_kind = Object.fromEntries(HUMAN_TOUCH_KINDS.map((k) => [k, 0])) as Record<
    HumanTouchKind,
    number
  >;
  let total = 0;
  let touchesOnR2d = 0;

  const attemptedIssues = new Set<number>();
  const r2dIssues = new Set<number>();

  // Group by issue for R2D attribution
  const runsByIssue = new Map<number, StabilizationRun[]>();
  for (const run of runs) {
    if (run.issue != null) {
      attemptedIssues.add(run.issue);
      if (!runsByIssue.has(run.issue)) runsByIssue.set(run.issue, []);
      runsByIssue.get(run.issue)!.push(run);
    }
  }
  for (const [issue, issueRuns] of runsByIssue) {
    if (issueRuns.some((r) => r.finalState === "ready-to-deploy")) {
      r2dIssues.add(issue);
    }
  }

  for (const run of runs) {
    const isR2dIssue = run.issue != null && r2dIssues.has(run.issue);
    for (const event of run.events) {
      const kind = classifyHumanTouch(event);
      if (!kind) continue;
      by_kind[kind]++;
      total++;
      if (isR2dIssue) touchesOnR2d++;
    }
  }

  return {
    total_touches: total,
    by_kind,
    human_touches_per_attempted_issue: rateValue(total, attemptedIssues.size),
    human_touches_per_r2d_issue: rateValue(touchesOnR2d, r2dIssues.size),
    touches_on_r2d_issues: touchesOnR2d,
  };
}

// ---------------------------------------------------------------------------
// Discovery-channel decomposition
// ---------------------------------------------------------------------------

export interface DiscoveryChannelBreakdown {
  total_attributed: number;
  missing_attribution: number;
  by_channel: Record<DiscoveryChannel, number>;
  /** Explicit denominator for attributed share rates. */
  denominator: number;
}

function runEngineFromJson(runJson: Record<string, unknown> | null): RunEngineAttributionSource | null {
  if (!runJson) return null;
  const eng = runJson["engine"];
  if (!eng || typeof eng !== "object") return null;
  const e = eng as Record<string, unknown>;
  return {
    version: typeof e["version"] === "string" ? e["version"] : null,
    commit_sha: typeof e["commit_sha"] === "string" ? e["commit_sha"] : null,
    git_sha: typeof e["git_sha"] === "string" ? e["git_sha"] : null,
  };
}

/**
 * Count issue arrivals / defect observations by discovery-channel.
 * Prefer event-level stamps; inherit run default only when run.json carries an
 * explicit discovery_channel stamp (#763). Auto-file related events without a
 * stamp count as papercut-autofile when type is papercut/auto_file; otherwise
 * missing. Historical items without channel → missing_attribution (never
 * invent live-run from engine.version alone).
 */
export function computeDiscoveryChannelBreakdown(runs: StabilizationRun[]): DiscoveryChannelBreakdown {
  const by_channel = Object.fromEntries(DISCOVERY_CHANNELS.map((c) => [c, 0])) as Record<
    DiscoveryChannel,
    number
  >;
  let missing = 0;
  let attributed = 0;

  for (const run of runs) {
    const engine = runEngineFromJson(run.runJson);
    // Run-level arrival: one count per run (issue attempt). Only an explicit
    // discovery_channel field (post-#763 stamp) attributes the arrival —
    // engine.version alone is pre-attribution history.
    const runChannel = runLevelDiscoveryChannel(run.runJson);
    if (runChannel) {
      by_channel[runChannel]++;
      attributed++;
    } else {
      missing++;
    }

    for (const event of run.events) {
      const type = stringField(event, "type");
      if (
        type !== "papercut" &&
        type !== "correction_event" &&
        type !== "human_intervention" &&
        type !== "blocker_set" &&
        type !== "auto_file" &&
        type !== "candidate_integrity"
      ) {
        continue;
      }
      const inline = parseDiscoveryChannelLoose(event["discovery_channel"]);
      if (inline) {
        by_channel[inline]++;
        attributed++;
        continue;
      }
      // Auto-file category events inherit papercut-autofile when type is auto_file
      if (type === "auto_file" || type === "papercut") {
        by_channel[AUTO_FILE_DISCOVERY_CHANNEL]++;
        attributed++;
        continue;
      }
      // Inheritance for intervention/blocker: only when run.json stamped a channel
      const resolved = resolveEventAttribution(event, engine, runChannel);
      if (resolved.discovery_channel) {
        by_channel[resolved.discovery_channel]++;
        attributed++;
      } else {
        missing++;
      }
    }
  }

  return {
    total_attributed: attributed,
    missing_attribution: missing,
    by_channel,
    denominator: attributed + missing,
  };
}

// ---------------------------------------------------------------------------
// Escape-recurrence from runs + attributions
// ---------------------------------------------------------------------------

export function collectDefectOccurrences(runs: StabilizationRun[]): {
  occurrences: DefectOccurrence[];
  unmapped: number;
} {
  const occurrences: DefectOccurrence[] = [];
  let unmapped = 0;
  for (const run of runs) {
    for (const event of run.events) {
      const type = stringField(event, "type");
      const mapped = mapSignalToDefectClassKey({
        correction_key: stringField(event, "correction_key"),
        failure_class: stringField(event, "failure_class"),
        blocker_kind: stringField(event, "blocker_kind") ?? stringField(event, "blockerKind"),
        offramp_class: stringField(event, "offramp_class"),
        reason_code:
          stringField(event, "reason_code") ??
          (event["diagnostic"] && typeof event["diagnostic"] === "object"
            ? stringField(event["diagnostic"] as Record<string, unknown>, "reason_code")
            : null),
        message: stringField(event, "reason") ?? stringField(event, "message"),
        type,
      });
      if (!mapped) {
        if (
          type === "blocker_set" ||
          type === "correction_event" ||
          type === "human_intervention" ||
          type === "papercut"
        ) {
          unmapped++;
        }
        continue;
      }
      occurrences.push({
        class_key: mapped,
        at: stringField(event, "at") ?? run.startAt,
        producing_release: stringField(event, "producing_release"),
        run_id: run.runId,
      });
    }
  }
  return { occurrences, unmapped };
}

export function computeEscapeRecurrenceFromArtifacts(
  runs: StabilizationRun[],
  attributions: ControlAttribution[],
  releaseObservations: Array<{
    class_key: string;
    effective_release: string;
    effective_at?: string | null;
  }> = [],
): EscapeRecurrenceResult {
  const { occurrences, unmapped } = collectDefectOccurrences(runs);
  const boundaries = resolveFixBoundaries({
    attributions: attributions.map((a) => ({
      correction_key: a.correction_key,
      disposition: a.disposition,
      effective_release: a.effective_release,
      effective_at: a.effective_at,
    })),
    releaseObservations,
  });
  const result = computeEscapeRecurrence({ occurrences, boundaries });
  result.unmapped_occurrence_count += unmapped;
  return result;
}

// ---------------------------------------------------------------------------
// FRG release-over-release engine-class series
// ---------------------------------------------------------------------------

export interface EngineClassReleaseSeriesEntry {
  version: string;
  engine_class_rate: number | null;
  engine_class_count: number | null;
  item_count: number | null;
  ready_clean_count: number | null;
  source: "frg_trend_ledger" | "fallback_run_window";
  pass?: boolean | null;
  created_at?: string | null;
}

export interface EngineClassReleaseSeries {
  entries: EngineClassReleaseSeriesEntry[];
  source: "frg_trend_ledger" | "fallback_run_window" | "empty";
  diagnostics: StabilizationDiagnostic[];
}

export function computeEngineClassReleaseSeries(opts: {
  frgTrendEntries: FrgTrendLedgerEntryLite[] | null;
  /** Fallback rates by release when ledger absent (pre-aggregated). */
  fallbackByVersion?: Array<{
    version: string;
    engine_class_rate: number | null;
    engine_class_count?: number;
    item_count?: number;
  }>;
  path?: string;
}): EngineClassReleaseSeries {
  const diagnostics: StabilizationDiagnostic[] = [];
  const path = opts.path ?? ".agent-pipeline/frg/trend-ledger.jsonl";

  if (opts.frgTrendEntries && opts.frgTrendEntries.length > 0) {
    // Prefer latest entry per version (by created_at).
    const byVersion = new Map<string, FrgTrendLedgerEntryLite>();
    for (const e of opts.frgTrendEntries) {
      const existing = byVersion.get(e.version);
      if (!existing || Date.parse(e.created_at) >= Date.parse(existing.created_at)) {
        byVersion.set(e.version, e);
      }
    }
    const entries: EngineClassReleaseSeriesEntry[] = [...byVersion.values()]
      .sort((a, b) => a.version.localeCompare(b.version))
      .map((e) => ({
        version: e.version,
        engine_class_rate: e.engine_class_rate,
        engine_class_count: e.engine_class_count,
        item_count: e.item_count,
        ready_clean_count: e.ready_clean_count,
        source: "frg_trend_ledger" as const,
        pass: e.pass,
        created_at: e.created_at,
      }));
    return { entries, source: "frg_trend_ledger", diagnostics };
  }

  if (opts.fallbackByVersion && opts.fallbackByVersion.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "frg_trend_ledger_fallback",
      path,
      message:
        "FRG trend ledger absent or empty; engine-class release series uses lower-fidelity run-window fallback",
    });
    return {
      entries: opts.fallbackByVersion.map((e) => ({
        version: e.version,
        engine_class_rate: e.engine_class_rate,
        engine_class_count: e.engine_class_count ?? null,
        item_count: e.item_count ?? null,
        ready_clean_count: null,
        source: "fallback_run_window" as const,
      })),
      source: "fallback_run_window",
      diagnostics,
    };
  }

  diagnostics.push({
    severity: "warning",
    code: "frg_trend_ledger_missing",
    path,
    message: "No FRG trend ledger and no fallback release aggregation available",
  });
  return { entries: [], source: "empty", diagnostics };
}

// ---------------------------------------------------------------------------
// Stratified stabilization metrics
// ---------------------------------------------------------------------------

/** Bound N for "eventual R2D within bounded attempts" (run count per issue). */
export const EVENTUAL_R2D_ATTEMPT_BOUND = 5;

export interface StratifiedStabilizationMetrics {
  intervention_free_first_attempt_r2d: RateValue;
  eventual_r2d_within_bound: RateValue;
  eventual_r2d_attempt_bound: number;
  false_product_judgment_rate: RateValue;
  engine_blockers_per_100_stage_attempts: RateValue;
  /** Raw counts for the per-100 metric. */
  engine_blocker_events: number;
  stage_attempts: number;
  recovery: {
    success: number;
    exhaustion: number;
    attempts: number;
    resumes: number;
    success_rate: RateValue;
    by_reason: Record<
      string,
      { success: number; exhaustion: number; attempts: number; resumes: number; elapsed_ms: number }
    >;
  };
  first_pass_approval_rate: RateValue;
  fix_rounds_total: number;
  recurring_findings_total: number;
  final_green_current_mergeable_r2d: RateValue;
  orphan_followers: number;
  progress_gaps: number;
  stale_worktrees: number;
  false_capacity_waits: number;
  evidence_coverage: RateValue;
  evidence_missing: number;
  evidence_total: number;
}

function isEngineClassBlocker(event: Record<string, unknown>): boolean {
  const offramp = stringField(event, "offramp_class");
  if (offramp === "engine" || offramp === "workflow-engine-defect") return true;
  const kind = stringField(event, "blocker_kind") ?? stringField(event, "blockerKind");
  if (!kind) return false;
  // Human-authority / product kinds are not engine-class.
  if (
    kind === "needs-human" ||
    kind === "human-decision-required" ||
    kind === "product-judgment-required"
  ) {
    return false;
  }
  // Engine-class projection: worktree, harness, openspec engine, push, capacity, etc.
  const engineKinds = new Set([
    "harness-failure",
    "worktree-missing",
    "worktree-capacity",
    "worktree-creation-failed",
    "push-failed",
    "openspec-stale-delta",
    "head-drift",
    "reviewer-unavailable",
  ]);
  return engineKinds.has(kind);
}

export function computeStratifiedStabilizationMetrics(
  runs: StabilizationRun[],
  opts?: {
    /** Post-#787 terminal offramp classes already filtered (optional external). */
  },
): { metrics: StratifiedStabilizationMetrics; diagnostics: StabilizationDiagnostic[] } {
  const diagnostics: StabilizationDiagnostic[] = [];

  // Group by issue
  const byIssue = new Map<number, StabilizationRun[]>();
  for (const run of runs) {
    if (run.issue == null) continue;
    if (!byIssue.has(run.issue)) byIssue.set(run.issue, []);
    byIssue.get(run.issue)!.push(run);
  }

  let r2dIssues = 0;
  let interventionFreeFirstAttempt = 0;
  let eventualWithinBound = 0;
  let attemptedIssues = 0;

  for (const [, issueRuns] of byIssue) {
    attemptedIssues++;
    const sorted = [...issueRuns].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    const reachedR2d = sorted.some((r) => r.finalState === "ready-to-deploy");
    if (reachedR2d) {
      r2dIssues++;
      const first = sorted[0];
      const interventions = first.events.filter((e) => e["type"] === "human_intervention");
      const overrides = first.events.filter(
        (e) => e["type"] === "human_intervention" && e["kind"] === "human-risk-override",
      );
      // First-attempt path: single run that is R2D with zero interventions
      if (
        sorted.length === 1 &&
        first.finalState === "ready-to-deploy" &&
        interventions.length === 0 &&
        overrides.length === 0
      ) {
        interventionFreeFirstAttempt++;
      }
      if (sorted.length <= EVENTUAL_R2D_ATTEMPT_BOUND) {
        eventualWithinBound++;
      }
    } else if (sorted.length <= EVENTUAL_R2D_ATTEMPT_BOUND && sorted.some((r) => r.finalState === "ready-to-deploy")) {
      eventualWithinBound++;
    }
  }

  // False product-judgment: engine-owned recoverable projected as human_authority
  let falseProductJudgment = 0;
  let productProjections = 0;
  let engineBlockers = 0;
  let stageAttempts = 0;
  let recoverySuccess = 0;
  let recoveryExhaustion = 0;
  let recoveryAttempts = 0;
  let recoveryResumes = 0;
  const recoveryByReason: StratifiedStabilizationMetrics["recovery"]["by_reason"] = {};

  let firstPassApprovals = 0;
  let reviewEntries = 0;
  let fixRounds = 0;
  let recurringFindings = 0;

  let greenR2d = 0;
  let r2dWithCiEvidence = 0;
  let orphanFollowers = 0;
  let progressGaps = 0;
  let staleWorktrees = 0;
  let falseCapacityWaits = 0;

  let evidencePresent = 0;
  let evidenceTotal = 0;

  for (const run of runs) {
    for (const event of run.events) {
      const type = stringField(event, "type");
      if (type === "stage_start") stageAttempts++;

      if (type === "blocker_set") {
        // Terminal-only for engine-blocker rate: recovered same-run blockers
        // are excluded via later recovery success markers (post-#787).
        // We mark recovered when a later stage re-entry succeeds after this block.
      }

      if (type === "loop_recovery_attempt" || type === "recovery_attempt" || type === "recovery_result") {
        recoveryAttempts++;
        const reason =
          stringField(event, "reason") ??
          stringField(event, "blocker_class") ??
          stringField(event, "class") ??
          "unknown";
        if (!recoveryByReason[reason]) {
          recoveryByReason[reason] = {
            success: 0,
            exhaustion: 0,
            attempts: 0,
            resumes: 0,
            elapsed_ms: 0,
          };
        }
        recoveryByReason[reason].attempts++;
        const outcome = stringField(event, "outcome") ?? stringField(event, "result");
        const elapsed =
          typeof event["elapsed_ms"] === "number"
            ? event["elapsed_ms"]
            : typeof event["duration_ms"] === "number"
              ? event["duration_ms"]
              : 0;
        recoveryByReason[reason].elapsed_ms += elapsed;
        if (outcome === "success" || outcome === "recovered" || outcome === "ok") {
          recoverySuccess++;
          recoveryByReason[reason].success++;
        } else if (outcome === "exhaustion" || outcome === "exhausted" || outcome === "failed") {
          recoveryExhaustion++;
          recoveryByReason[reason].exhaustion++;
        } else if (outcome === "resume" || outcome === "resumed" || outcome === "started") {
          recoveryResumes++;
          recoveryByReason[reason].resumes++;
        }
      }

      if (type === "review_verdict") {
        reviewEntries++;
        const verdict = stringField(event, "verdict");
        const round = typeof event["round"] === "number" ? event["round"] : 1;
        if (round === 1 && (verdict === "approve" || verdict === "approved" || verdict === "lgtm")) {
          firstPassApprovals++;
        }
        const counts = event["finding_counts"];
        if (counts && typeof counts === "object") {
          for (const v of Object.values(counts as Record<string, unknown>)) {
            if (typeof v === "number") recurringFindings += 0; // placeholder — recurring needs cross-round
          }
        }
      }
      if (type === "fix_harness_retry" || (type === "stage_complete" && stringField(event, "stage") === "fix")) {
        if (type === "fix_harness_retry") fixRounds++;
      }
      if (type === "reversal_unacknowledged" || type === "settled_alternative_reinstated") {
        recurringFindings++;
      }

      // False product-judgment: stage diagnostic disposition mismatch
      if (type === "blocker_set" || type === "stage_diagnostic") {
        const diag =
          event["diagnostic"] && typeof event["diagnostic"] === "object"
            ? (event["diagnostic"] as Record<string, unknown>)
            : event;
        const disposition = stringField(diag, "disposition") ?? stringField(event, "disposition");
        const reasonCode = stringField(diag, "reason_code") ?? stringField(event, "reason_code");
        const projected = stringField(event, "projected_as") ?? disposition;
        if (projected === "human_authority" || projected === "product") {
          productProjections++;
          // Engine-owned recoverable classes falsely projected
          if (
            reasonCode === "workflow-engine-defect" ||
            reasonCode === "transient-infra" ||
            reasonCode === "harness-timeout" ||
            reasonCode === "harness-contract" ||
            event["engine_owned"] === true
          ) {
            falseProductJudgment++;
          }
        }
      }

      if (
        type === "orphan_follower" ||
        stringField(event, "diagnostic_code") === "orphan_follower"
      ) {
        orphanFollowers++;
      }
      if (type === "progress_gap" || stringField(event, "diagnostic_code") === "progress_gap") {
        progressGaps++;
      }
      if (type === "stale_worktree" || stringField(event, "diagnostic_code") === "stale_worktree") {
        staleWorktrees++;
      }
      if (
        type === "false_capacity_wait" ||
        stringField(event, "diagnostic_code") === "false_capacity_wait"
      ) {
        falseCapacityWaits++;
      }

      // Evidence coverage for attribution fields on defect-classifying events
      if (
        type === "human_intervention" ||
        type === "blocker_set" ||
        type === "correction_event" ||
        type === "recovery_result" ||
        type === "loop_recovery_attempt"
      ) {
        evidenceTotal++;
        const hasVersion =
          typeof event["engine_version"] === "string" ||
          !!(run.runJson && (run.runJson["engine"] as { version?: string } | undefined)?.version);
        // Channel evidence requires an explicit stamp (event or run-level) —
        // engine identity alone is not discovery-channel attribution (#763).
        const hasChannel =
          isDiscoveryChannel(event["discovery_channel"]) ||
          runLevelDiscoveryChannel(run.runJson) !== null;
        if (hasVersion && hasChannel) evidencePresent++;
      }
    }

    // Engine blockers: terminal only (post-#787). A blocker_set is terminal
    // when no later same-run recovery success / stage re-entry clears it before
    // run_complete needs-human, OR when finalState is needs-human without recovery.
    engineBlockers += countTerminalEngineBlockers(run);

    // CI/mergeability evidence for R2D
    if (run.finalState === "ready-to-deploy") {
      const ci = run.events.find(
        (e) =>
          e["type"] === "ci_status" ||
          e["type"] === "mergeability" ||
          e["type"] === "gate_result" && e["gate"] === "ci",
      );
      const summaryCi = run.summary?.["ci"] ?? run.summary?.["mergeable"];
      if (ci || summaryCi !== undefined) {
        r2dWithCiEvidence++;
        const green =
          stringField(ci ?? {}, "status") === "success" ||
          stringField(ci ?? {}, "result") === "pass" ||
          summaryCi === true ||
          (typeof summaryCi === "object" &&
            summaryCi !== null &&
            (summaryCi as { mergeable?: boolean }).mergeable === true);
        if (green) greenR2d++;
      }
    }
  }

  // Fix rounds from ready groups heuristic: count stage_start fix
  for (const run of runs) {
    for (const event of run.events) {
      if (event["type"] === "stage_start" && stringField(event, "stage") === "fix") {
        // already counted retries; count each fix start beyond first as round
      }
    }
  }

  const metrics: StratifiedStabilizationMetrics = {
    intervention_free_first_attempt_r2d: rateValue(interventionFreeFirstAttempt, r2dIssues),
    eventual_r2d_within_bound: rateValue(eventualWithinBound, attemptedIssues),
    eventual_r2d_attempt_bound: EVENTUAL_R2D_ATTEMPT_BOUND,
    false_product_judgment_rate: rateValue(falseProductJudgment, productProjections),
    engine_blockers_per_100_stage_attempts: rateValue(
      engineBlockers * 100,
      stageAttempts,
    ),
    engine_blocker_events: engineBlockers,
    stage_attempts: stageAttempts,
    recovery: {
      success: recoverySuccess,
      exhaustion: recoveryExhaustion,
      attempts: recoveryAttempts,
      resumes: recoveryResumes,
      success_rate: rateValue(recoverySuccess, recoveryAttempts),
      by_reason: recoveryByReason,
    },
    first_pass_approval_rate: rateValue(firstPassApprovals, reviewEntries),
    fix_rounds_total: fixRounds,
    recurring_findings_total: recurringFindings,
    final_green_current_mergeable_r2d: rateValue(greenR2d, r2dWithCiEvidence),
    orphan_followers: orphanFollowers,
    progress_gaps: progressGaps,
    stale_worktrees: staleWorktrees,
    false_capacity_waits: falseCapacityWaits,
    evidence_coverage: rateValue(evidencePresent, evidenceTotal),
    evidence_missing: Math.max(0, evidenceTotal - evidencePresent),
    evidence_total: evidenceTotal,
  };

  void opts;
  return { metrics, diagnostics };
}

/**
 * Count terminal engine-class blockers for a run (post-#787): a pre-merge or
 * stage blocker_set that is not recovered by later same-run re-entry.
 */
export function countTerminalEngineBlockers(run: StabilizationRun): number {
  type Entry = { event: Record<string, unknown>; index: number; recovered: boolean };
  const blocks: Entry[] = [];
  for (let i = 0; i < run.events.length; i++) {
    const event = run.events[i];
    if (event["type"] !== "blocker_set") continue;
    if (!isEngineClassBlocker(event)) continue;
    blocks.push({ event, index: i, recovered: false });
  }
  if (blocks.length === 0) return 0;

  // Mark recovered: later stage_start for same stage after block, or recovery success, or blocker_cleared
  for (const block of blocks) {
    const stage = stringField(block.event, "stage");
    for (let j = block.index + 1; j < run.events.length; j++) {
      const e = run.events[j];
      const t = stringField(e, "type");
      if (t === "blocker_cleared") {
        block.recovered = true;
        break;
      }
      if (
        (t === "loop_recovery_attempt" || t === "recovery_result") &&
        (stringField(e, "outcome") === "success" || stringField(e, "outcome") === "recovered")
      ) {
        block.recovered = true;
        break;
      }
      if (t === "stage_start" && stage && stringField(e, "stage") === stage) {
        // Same-stage re-entry after block = in-process recovery (post-#787)
        block.recovered = true;
        break;
      }
      if (t === "run_complete" && stringField(e, "final_state") === "ready-to-deploy") {
        block.recovered = true;
        break;
      }
    }
    // If run ended ready-to-deploy, all prior blocks were recovered
    if (run.finalState === "ready-to-deploy") block.recovered = true;
  }

  return blocks.filter((b) => !b.recovered).length;
}

// ---------------------------------------------------------------------------
// Candidate-integrity observability (#857 consumer)
// ---------------------------------------------------------------------------

export const CANDIDATE_INTEGRITY_EVENT_TYPE = "candidate_integrity";

export interface CandidateIntegrityMetrics {
  total_events: number;
  candidate_moving_repairs: number;
  candidate_moving_restacks: number;
  review_invalidations: number;
  readiness_invalidations: number;
  scope_expansion_invalidations: number;
  unverified_comparisons: number;
  post_repair_invariant_failures: number;
  post_merge_invariant_escapes: number;
  by_mutation_method: Record<string, number>;
  by_engine_version: Record<string, number>;
  by_path_class: Record<string, number>;
  mutations_attempted: number;
  invalidation_rate: RateValue;
}

export function computeCandidateIntegrityMetrics(
  runs: StabilizationRun[],
): { metrics: CandidateIntegrityMetrics; diagnostics: StabilizationDiagnostic[] } {
  const diagnostics: StabilizationDiagnostic[] = [];
  const by_mutation_method: Record<string, number> = {};
  const by_engine_version: Record<string, number> = {};
  const by_path_class: Record<string, number> = {};

  let total = 0;
  let repairs = 0;
  let restacks = 0;
  let reviewInvalidations = 0;
  let readinessInvalidations = 0;
  let scopeExpansion = 0;
  let unverified = 0;
  let postRepairFailures = 0;
  let postMergeEscapes = 0;
  let mutations = 0;
  let invalidations = 0;

  for (const run of runs) {
    const engine = runEngineFromJson(run.runJson);
    for (const event of run.events) {
      if (stringField(event, "type") !== CANDIDATE_INTEGRITY_EVENT_TYPE) continue;
      total++;
      const method =
        stringField(event, "mutation_method") ?? stringField(event, "method") ?? "unknown";
      by_mutation_method[method] = (by_mutation_method[method] ?? 0) + 1;

      const version =
        stringField(event, "engine_version") ?? engine?.version ?? "unknown";
      by_engine_version[version] = (by_engine_version[version] ?? 0) + 1;

      const pathClass = stringField(event, "path_class") ?? stringField(event, "affected_path_class");
      if (pathClass) by_path_class[pathClass] = (by_path_class[pathClass] ?? 0) + 1;

      const classification =
        stringField(event, "classification") ??
        stringField(event, "kind") ??
        stringField(event, "invalidation_reason") ??
        "";

      if (method === "repair" || classification.includes("repair")) {
        repairs++;
        mutations++;
      }
      if (method === "restack" || classification.includes("restack")) {
        restacks++;
        mutations++;
      }
      if (classification.includes("scope_expansion") || classification === "scope-expansion") {
        scopeExpansion++;
        invalidations++;
      }
      if (classification.includes("unverified")) {
        unverified++;
        invalidations++;
      }
      if (classification.includes("review_invalidation") || event["invalidated_review"] === true) {
        reviewInvalidations++;
        invalidations++;
      }
      if (
        classification.includes("readiness_invalidation") ||
        event["invalidated_readiness"] === true
      ) {
        readinessInvalidations++;
        invalidations++;
      }
      if (
        classification.includes("post_repair_invariant") ||
        classification.includes("invariant_failure")
      ) {
        postRepairFailures++;
      }
      if (
        classification.includes("post_merge") ||
        classification.includes("invariant_escape")
      ) {
        postMergeEscapes++;
      }
    }
  }

  if (total === 0 && runs.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing_candidate_integrity_events",
      path: runs[0]?.dir ?? ".",
      message:
        "No candidate_integrity events in window; counts are zero (observability only, not a gate)",
    });
  }

  return {
    metrics: {
      total_events: total,
      candidate_moving_repairs: repairs,
      candidate_moving_restacks: restacks,
      review_invalidations: reviewInvalidations,
      readiness_invalidations: readinessInvalidations,
      scope_expansion_invalidations: scopeExpansion,
      unverified_comparisons: unverified,
      post_repair_invariant_failures: postRepairFailures,
      post_merge_invariant_escapes: postMergeEscapes,
      by_mutation_method,
      by_engine_version,
      by_path_class,
      mutations_attempted: mutations,
      invalidation_rate: rateValue(invalidations, mutations),
    },
    diagnostics,
  };
}
