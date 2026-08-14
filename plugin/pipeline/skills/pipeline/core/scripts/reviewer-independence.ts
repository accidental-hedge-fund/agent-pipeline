// Reviewer independence and risk-based quorum (#694).
//
// Pure helpers: lineage mapping, independence eligibility / count, coverage
// tallies, aggregation outcome classification, cost coverage rollups, and
// required-independent resolution. No network, git, or subprocess I/O.

// ---------------------------------------------------------------------------
// Closed enums / types
// ---------------------------------------------------------------------------

/** Closed aggregation outcomes for a review round's effective coverage. */
export const AGGREGATION_OUTCOMES = [
  "complete",
  "partial_quorum",
  "same_lineage_fallback",
  "quorum_unmet",
  "no_usable_reviewers",
] as const;
export type AggregationOutcome = (typeof AGGREGATION_OUTCOMES)[number];

/** Risk classes accepted by min_independent_by_risk (open map; common keys). */
export type ReviewRiskClass = "low" | "standard" | "high" | string;

/** Cost coverage dimensions for a round rollup (#694 / stage-cost-accounting). */
export interface ReviewerCostRollup {
  requested: number;
  attempted: number;
  completed: number;
  billable: number;
  /** Sum of known actual/estimated USD only; null when no billable attempt has a number. */
  billable_cost_usd: number | null;
}

/** Explicit coverage counts persisted on every shared-seam review round. */
export interface ReviewerCoverageCounts {
  configured: number;
  attempted: number;
  usable: number;
  independent: number;
  required: number;
}

/** Full coverage summary attached to ensemble meta / single-reviewer coverage. */
export interface ReviewerCoverageSummary {
  counts: ReviewerCoverageCounts;
  aggregation_outcome: AggregationOutcome;
  /** Short machine-readable reason explaining complete / degraded / blocked. */
  aggregation_reason: string;
  cost: ReviewerCostRollup;
  risk_class: string;
}

/**
 * Typed attempt fields used by independence + outcome pure functions.
 * Matches EnsembleAgentIdentity lineage fields without importing the ensemble module.
 */
export interface ReviewerAttemptLineage {
  /** Config order index (0-based). */
  index: number;
  configured_harness: string;
  effective_harness: string;
  provider_family: string;
  model_family: string;
  model?: string;
  self_review: boolean;
  implementer_harness: string;
  status: "usable" | "failed";
  /** Latency in ms when known; null when unknown. */
  latency_ms: number | null;
  /** True when the engine started (or tried to start) this attempt. */
  attempted: boolean;
  /**
   * True when the harness returned a terminal result (success or failed with a
   * process outcome). Never-started attempts are not completed.
   */
  completed: boolean;
  /**
   * True when completed with known actual or estimated cost (non-null USD under
   * cost_source actual|estimated). Unknown cost is never billable.
   */
  billable: boolean;
  /** Known cost USD when billable; otherwise null. */
  cost_usd: number | null;
  failure_reason?: string;
  fallback_reason?: string;
}

export type LineageKey = `${string}:${string}`;

// ---------------------------------------------------------------------------
// Deterministic lineage maps
// ---------------------------------------------------------------------------

/**
 * Map harness + model identifiers to a closed provider family string.
 * Documented deterministic table; unknown when no rule matches.
 * Project Warrant and free text are never consulted.
 */
export function mapProviderFamily(harness: string, model?: string | null): string {
  const h = (harness ?? "").trim().toLowerCase();
  const m = (model ?? "").trim().toLowerCase();

  if (h === "claude" || h.includes("anthropic") || h.includes("claude")) {
    return "anthropic";
  }
  if (h === "codex" || h.includes("openai") || h === "gpt" || h.includes("chatgpt")) {
    return "openai";
  }
  if (h.includes("gemini") || h.includes("google")) {
    return "google";
  }

  if (
    m.includes("claude") ||
    m.includes("anthropic") ||
    m.includes("fable") ||
    m.includes("opus") ||
    m.includes("sonnet") ||
    m.includes("haiku")
  ) {
    return "anthropic";
  }
  if (
    m.includes("gpt") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("codex") ||
    m.includes("openai")
  ) {
    return "openai";
  }
  if (m.includes("gemini") || m.includes("google")) {
    return "google";
  }

  return "unknown";
}

/**
 * Map a model id to a coarse model family. Prefers known families; otherwise
 * a conservative prefix of the model string; empty/missing → unknown.
 */
export function mapModelFamily(model?: string | null): string {
  if (model === undefined || model === null) return "unknown";
  const raw = String(model).trim();
  if (!raw) return "unknown";
  const m = raw.toLowerCase();

  if (m.includes("opus")) return "claude-opus";
  if (m.includes("sonnet") || m.includes("fable")) return "claude-sonnet";
  if (m.includes("haiku")) return "claude-haiku";
  if (m.includes("gpt-5") || m.includes("gpt5")) return "gpt-5";
  if (m.includes("gpt-4") || m.includes("gpt4")) return "gpt-4";
  if (/\bo4\b/.test(m) || m.includes("o4-")) return "o4";
  if (/\bo3\b/.test(m) || m.includes("o3-")) return "o3";
  if (/\bo1\b/.test(m) || m.includes("o1-")) return "o1";
  if (m.includes("gemini")) return "gemini";
  if (m === "auto") return "auto";

  // Strip vendor path prefixes (openai/gpt-4.1 → gpt-4.1)
  const base = m.split(/[/:@]/).pop() ?? m;
  const parts = base.split(/[-_.]/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  if (parts.length === 1 && parts[0]) return parts[0];
  return "unknown";
}

/** lineage_key = (provider_family, model_family). */
export function lineageKey(providerFamily: string, modelFamily: string): LineageKey {
  return `${providerFamily}:${modelFamily}`;
}

export function lineageKeyOf(attempt: Pick<ReviewerAttemptLineage, "provider_family" | "model_family">): LineageKey {
  return lineageKey(attempt.provider_family, attempt.model_family);
}

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

/**
 * Independently eligible iff usable, not self-review, and effective harness is
 * not the implementer. Policy always forbids self-review / implementer same-
 * harness from counting as independent in v1.
 */
export function isIndependentlyEligible(attempt: ReviewerAttemptLineage): boolean {
  if (attempt.status !== "usable") return false;
  if (attempt.self_review) return false;
  if (
    attempt.effective_harness &&
    attempt.implementer_harness &&
    attempt.effective_harness === attempt.implementer_harness
  ) {
    return false;
  }
  return true;
}

/**
 * Independent count = number of distinct lineage_key values among independently
 * eligible attempts, considered in config order (first agent for a key occupies
 * the slot). Self-review and same-key agents never double-count.
 */
export function countIndependent(attempts: ReadonlyArray<ReviewerAttemptLineage>): number {
  const seen = new Set<LineageKey>();
  // Config order: lower index first.
  const ordered = [...attempts].sort((a, b) => a.index - b.index);
  for (const a of ordered) {
    if (!isIndependentlyEligible(a)) continue;
    seen.add(lineageKeyOf(a));
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Required independent (risk-class map)
// ---------------------------------------------------------------------------

/**
 * Resolve `required` independent count from optional min_independent_by_risk
 * and a structured risk class. Missing map / missing class / zero → 0.
 * Negative values are rejected at config resolve; if seen here, clamp to 0.
 */
export function resolveRequiredIndependent(
  minIndependentByRisk: Readonly<Record<string, number>> | null | undefined,
  riskClass: ReviewRiskClass | null | undefined,
): number {
  if (!minIndependentByRisk || typeof minIndependentByRisk !== "object") return 0;
  const cls = (riskClass && String(riskClass).trim()) || "standard";
  const raw = minIndependentByRisk[cls];
  if (raw === undefined || raw === null) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Cost rollup
// ---------------------------------------------------------------------------

/**
 * Roll up requested / attempted / completed / billable. Never invents billable
 * $0 for unknown cost.
 */
export function rollupReviewerCost(
  attempts: ReadonlyArray<Pick<
    ReviewerAttemptLineage,
    "attempted" | "completed" | "billable" | "cost_usd"
  >>,
  configured: number,
): ReviewerCostRollup {
  let attempted = 0;
  let completed = 0;
  let billable = 0;
  let billableSum = 0;
  let hasBillableUsd = false;
  for (const a of attempts) {
    if (a.attempted) attempted++;
    if (a.completed) completed++;
    if (a.billable) {
      billable++;
      if (typeof a.cost_usd === "number" && Number.isFinite(a.cost_usd)) {
        billableSum += a.cost_usd;
        hasBillableUsd = true;
      }
    }
  }
  return {
    requested: configured,
    attempted,
    completed,
    billable,
    billable_cost_usd: hasBillableUsd ? billableSum : null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation outcome
// ---------------------------------------------------------------------------

export interface ClassifyAggregationInput {
  configured: number;
  attempted: number;
  usable: number;
  independent: number;
  required: number;
  minUsable: number;
  /** True when any usable attempt is self-review. */
  hasSelfReviewAmongUsable: boolean;
  /**
   * True when lineage collapse reduced independent below usable among non-
   * self-review usable agents (two+ usable share one lineage_key).
   */
  hasLineageCollapse: boolean;
  /** Optional failed-agent labels for reason strings. */
  failedLabels?: string[];
}

/**
 * Detect lineage collapse: more than one usable non-self-review agent share the
 * same lineage_key (usable > independent among eligible peers).
 */
export function detectLineageCollapse(attempts: ReadonlyArray<ReviewerAttemptLineage>): boolean {
  const usableNonSelf = attempts.filter(
    (a) => a.status === "usable" && !a.self_review,
  );
  if (usableNonSelf.length < 2) return false;
  const keys = new Set(usableNonSelf.map(lineageKeyOf));
  return keys.size < usableNonSelf.length;
}

/**
 * Assign exactly one closed aggregation outcome with a short reason string.
 *
 * Priority:
 * 1. no_usable_reviewers — usable < min_usable (includes usable === 0)
 * 2. quorum_unmet — independent < required
 * 3. same_lineage_fallback — independence degraded but required still met
 * 4. partial_quorum — usable < configured (some failed) with quorum met
 * 5. complete — all configured usable and quorum met
 */
export function classifyAggregationOutcome(
  input: ClassifyAggregationInput,
): { outcome: AggregationOutcome; reason: string } {
  const {
    configured,
    usable,
    independent,
    required,
    minUsable,
    hasSelfReviewAmongUsable,
    hasLineageCollapse,
    failedLabels,
  } = input;
  const failedNote =
    failedLabels && failedLabels.length > 0
      ? ` failed=[${failedLabels.join(",")}]`
      : "";

  if (usable < minUsable || usable === 0) {
    return {
      outcome: "no_usable_reviewers",
      reason:
        `usable=${usable} < min_usable=${minUsable} (configured=${configured}, independent=${independent}, required=${required})${failedNote}`,
    };
  }

  if (independent < required) {
    return {
      outcome: "quorum_unmet",
      reason:
        `independent=${independent} < required=${required} (usable=${usable}/${configured})${failedNote}`,
    };
  }

  const independenceDegraded = hasSelfReviewAmongUsable || hasLineageCollapse;
  if (independenceDegraded) {
    const causes: string[] = [];
    if (hasSelfReviewAmongUsable) causes.push("self-review");
    if (hasLineageCollapse) causes.push("lineage-collapse");
    return {
      outcome: "same_lineage_fallback",
      reason:
        `independence degraded (${causes.join("+")}): usable=${usable} independent=${independent} required=${required} configured=${configured}${failedNote}`,
    };
  }

  if (usable < configured) {
    return {
      outcome: "partial_quorum",
      reason:
        `usable=${usable} < configured=${configured}; independent=${independent} >= required=${required}${failedNote}`,
    };
  }

  return {
    outcome: "complete",
    reason:
      `usable=${usable}/${configured} independent=${independent} required=${required}`,
  };
}

/**
 * Build a full coverage summary from attempt lineage records.
 */
export function buildCoverageSummary(args: {
  attempts: ReadonlyArray<ReviewerAttemptLineage>;
  configured: number;
  minUsable: number;
  required: number;
  riskClass: string;
}): ReviewerCoverageSummary {
  const { attempts, configured, minUsable, required, riskClass } = args;
  const usable = attempts.filter((a) => a.status === "usable").length;
  const attempted = attempts.filter((a) => a.attempted).length;
  const independent = countIndependent(attempts);
  const hasSelfReviewAmongUsable = attempts.some(
    (a) => a.status === "usable" && a.self_review,
  );
  const hasLineageCollapse = detectLineageCollapse(attempts);
  const failedLabels = attempts
    .filter((a) => a.status === "failed")
    .map(
      (a) =>
        `${a.configured_harness}${a.failure_reason ? `:${a.failure_reason}` : ""}`,
    );
  const { outcome, reason } = classifyAggregationOutcome({
    configured,
    attempted,
    usable,
    independent,
    required,
    minUsable,
    hasSelfReviewAmongUsable,
    hasLineageCollapse,
    failedLabels,
  });
  const cost = rollupReviewerCost(attempts, configured);
  return {
    counts: {
      configured,
      attempted,
      usable,
      independent,
      required,
    },
    aggregation_outcome: outcome,
    aggregation_reason: reason,
    cost,
    risk_class: riskClass,
  };
}

/**
 * Whether coverage is fail-closed for readiness (do not treat as normal
 * coverage-complete approve path). Degrade flag may override quorum_unmet only.
 */
export function isCoverageFailClosed(
  outcome: AggregationOutcome,
  allowQuorumDegrade = false,
): boolean {
  if (outcome === "no_usable_reviewers") return true;
  if (outcome === "quorum_unmet") return !allowQuorumDegrade;
  return false;
}

/** Blocker kind for a fail-closed coverage outcome. */
export function coverageBlockerKind(
  outcome: AggregationOutcome,
): "review-independent-quorum-unmet" | "review-no-usable-reviewers" | null {
  if (outcome === "quorum_unmet") return "review-independent-quorum-unmet";
  if (outcome === "no_usable_reviewers") return "review-no-usable-reviewers";
  return null;
}
