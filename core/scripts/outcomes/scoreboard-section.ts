// Additive factory-scoreboard outcomes section (#576).
//
// Counts by kind and observation_state; partitions observed vs inferred
// attribution. Never emits a maintainability_score. Merge without deploy
// is not counted as deploy success.

import {
  OBSERVATION_STATES,
  OUTCOME_KINDS,
  type ObservationState,
  type OutcomeKind,
  type ProductionOutcome,
} from "./schema.ts";
import {
  DEFAULT_OUTCOME_RETENTION_DAYS,
  listOutcomes,
  type OutcomeStoreDeps,
  realOutcomeStoreDeps,
} from "./store.ts";
import { hasOnlyInferredRunAttribution, hasObservedAttribution } from "./linkage.ts";

export interface OutcomeScoreboardSection {
  by_kind: Record<OutcomeKind, number>;
  by_observation_state: Record<ObservationState, number>;
  /** Outcomes with ≥1 observed-authority attribution. */
  with_observed_attribution: number;
  /** Outcomes whose attributions are only inferred (for run links) or have no observed authority. */
  with_inferred_only_attribution: number;
  /**
   * Delivery records with merge_status merged.
   * Separate from deploy success — R2D/merge alone is not production deploy success.
   */
  delivery_merged_count: number;
  /** Delivery records with deploy_status succeeded. */
  delivery_deploy_succeeded_count: number;
  /** Delivery records with deploy_status not_observed or unknown. */
  delivery_deploy_not_observed_count: number;
  /**
   * Observed-authority failure-class outcomes (reversion / escaped_defect)
   * — never includes inferred-only linkage as observed failure.
   */
  observed_failure_outcomes: number;
  /** Inferred-only run linkage on failure-class outcomes (not mixed into observed_failure). */
  inferred_failure_linkages: number;
  total: number;
  diagnostics: Array<{ code: string; message: string; path?: string }>;
}

function emptyKindCounts(): Record<OutcomeKind, number> {
  const out = {} as Record<OutcomeKind, number>;
  for (const k of OUTCOME_KINDS) out[k] = 0;
  return out;
}

function emptyStateCounts(): Record<ObservationState, number> {
  const out = {} as Record<ObservationState, number>;
  for (const s of OBSERVATION_STATES) out[s] = 0;
  return out;
}

export function emptyOutcomeScoreboardSection(
  diagnostics: OutcomeScoreboardSection["diagnostics"] = [],
): OutcomeScoreboardSection {
  return {
    by_kind: emptyKindCounts(),
    by_observation_state: emptyStateCounts(),
    with_observed_attribution: 0,
    with_inferred_only_attribution: 0,
    delivery_merged_count: 0,
    delivery_deploy_succeeded_count: 0,
    delivery_deploy_not_observed_count: 0,
    observed_failure_outcomes: 0,
    inferred_failure_linkages: 0,
    total: 0,
    diagnostics,
  };
}

/** Pure aggregation over already-loaded records (test-friendly). */
export function aggregateOutcomeScoreboardSection(
  records: readonly ProductionOutcome[],
  diagnostics: OutcomeScoreboardSection["diagnostics"] = [],
): OutcomeScoreboardSection {
  const section = emptyOutcomeScoreboardSection(diagnostics);
  section.total = records.length;

  for (const r of records) {
    section.by_kind[r.outcome_kind] = (section.by_kind[r.outcome_kind] ?? 0) + 1;
    section.by_observation_state[r.observation_state] =
      (section.by_observation_state[r.observation_state] ?? 0) + 1;

    if (hasObservedAttribution(r)) section.with_observed_attribution++;
    if (hasOnlyInferredRunAttribution(r) || (!hasObservedAttribution(r) && r.attribution.some((a) => a.authority === "inferred"))) {
      section.with_inferred_only_attribution++;
    }

    if (r.outcome_kind === "delivery" && r.delivery) {
      if (r.delivery.merge_status === "merged") section.delivery_merged_count++;
      if (r.delivery.deploy_status === "succeeded") section.delivery_deploy_succeeded_count++;
      if (
        r.delivery.deploy_status === "not_observed" ||
        r.delivery.deploy_status === "unknown"
      ) {
        section.delivery_deploy_not_observed_count++;
      }
    }

    const failureKind =
      r.outcome_kind === "reversion" || r.outcome_kind === "escaped_defect";
    if (failureKind) {
      if (hasObservedAttribution(r) && !hasOnlyInferredRunAttribution(r)) {
        // Count as observed failure only when there is observed authority
        // that is not solely inferred runs. PR-only observed still counts
        // as observed fact about the outcome, not necessarily run blame.
        section.observed_failure_outcomes++;
      }
      if (hasOnlyInferredRunAttribution(r)) {
        section.inferred_failure_linkages++;
      }
    }
  }

  return section;
}

export interface CollectOutcomeScoreboardOpts {
  repoDir: string;
  since?: string;
  until?: string;
  retentionDays?: number;
  now?: Date;
}

export async function collectOutcomeScoreboardSection(
  opts: CollectOutcomeScoreboardOpts,
  deps: OutcomeStoreDeps = realOutcomeStoreDeps(),
): Promise<OutcomeScoreboardSection> {
  const listed = await listOutcomes(
    opts.repoDir,
    {
      since: opts.since,
      until: opts.until,
      retentionDays: opts.retentionDays ?? DEFAULT_OUTCOME_RETENTION_DAYS,
      now: opts.now,
    },
    deps,
  );
  return aggregateOutcomeScoreboardSection(listed.records, listed.diagnostics);
}

export function formatOutcomeScoreboardHuman(section: OutcomeScoreboardSection): string[] {
  const lines: string[] = [];
  lines.push("Production / rework outcomes:");
  lines.push(`  Total: ${section.total}`);
  lines.push("  By kind:");
  for (const k of OUTCOME_KINDS) {
    lines.push(`    ${k}: ${section.by_kind[k] ?? 0}`);
  }
  lines.push("  By observation_state:");
  for (const s of OBSERVATION_STATES) {
    lines.push(`    ${s}: ${section.by_observation_state[s] ?? 0}`);
  }
  lines.push(`  With observed attribution: ${section.with_observed_attribution}`);
  lines.push(`  With inferred-only attribution: ${section.with_inferred_only_attribution}`);
  lines.push(`  Delivery merged (not auto deploy success): ${section.delivery_merged_count}`);
  lines.push(`  Delivery deploy succeeded: ${section.delivery_deploy_succeeded_count}`);
  lines.push(`  Delivery deploy not_observed/unknown: ${section.delivery_deploy_not_observed_count}`);
  lines.push(`  Observed failure outcomes: ${section.observed_failure_outcomes}`);
  lines.push(`  Inferred-only failure linkages (not observed failures): ${section.inferred_failure_linkages}`);
  lines.push("  Note: no maintainability_score; R2D ≠ production delivery.");
  if (section.diagnostics.length) {
    for (const d of section.diagnostics) {
      if (d.code === "missing_outcome_store" || d.code === "empty_outcome_store") {
        lines.push(`  Diagnostic: ${d.code}: ${d.message}`);
      }
    }
  }
  return lines;
}
