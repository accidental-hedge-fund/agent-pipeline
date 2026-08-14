// Unit tests for reviewer independence + quorum pure helpers (#694).
// No network, git, or subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCoverageSummary,
  classifyAggregationOutcome,
  countIndependent,
  coverageBlockerKind,
  detectLineageCollapse,
  isCoverageFailClosed,
  isIndependentlyEligible,
  lineageKey,
  mapModelFamily,
  mapProviderFamily,
  resolveRequiredIndependent,
  rollupReviewerCost,
  type ReviewerAttemptLineage,
} from "../scripts/reviewer-independence.ts";

function attempt(
  partial: Partial<ReviewerAttemptLineage> &
    Pick<ReviewerAttemptLineage, "index" | "configured_harness" | "effective_harness">,
): ReviewerAttemptLineage {
  const provider = partial.provider_family ?? mapProviderFamily(partial.configured_harness, partial.model);
  const modelFam = partial.model_family ?? mapModelFamily(partial.model);
  return {
    index: partial.index,
    configured_harness: partial.configured_harness,
    effective_harness: partial.effective_harness,
    provider_family: provider,
    model_family: modelFam,
    model: partial.model,
    self_review: partial.self_review ?? false,
    implementer_harness: partial.implementer_harness ?? "claude",
    status: partial.status ?? "usable",
    latency_ms: partial.latency_ms ?? 100,
    attempted: partial.attempted ?? true,
    completed: partial.completed ?? true,
    billable: partial.billable ?? false,
    cost_usd: partial.cost_usd ?? null,
    failure_reason: partial.failure_reason,
    fallback_reason: partial.fallback_reason,
  };
}

// ---------------------------------------------------------------------------
// Lineage maps
// ---------------------------------------------------------------------------

test("mapProviderFamily: known harnesses", () => {
  assert.equal(mapProviderFamily("claude"), "anthropic");
  assert.equal(mapProviderFamily("codex"), "openai");
  assert.equal(mapProviderFamily("gemini-cli"), "google");
});

test("mapProviderFamily: model hints and unknown fallback", () => {
  assert.equal(mapProviderFamily("custom", "claude-sonnet-4"), "anthropic");
  assert.equal(mapProviderFamily("custom", "gpt-5.1"), "openai");
  assert.equal(mapProviderFamily("mystery-cli", "weird-model"), "unknown");
});

test("mapModelFamily: known families and unknown", () => {
  assert.equal(mapModelFamily("claude-opus-4"), "claude-opus");
  assert.equal(mapModelFamily("claude-fable-5"), "claude-sonnet");
  assert.equal(mapModelFamily("gpt-5.1-codex"), "gpt-5");
  assert.equal(mapModelFamily(""), "unknown");
  assert.equal(mapModelFamily(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

test("self-review is never independently eligible", () => {
  const a = attempt({
    index: 0,
    configured_harness: "codex",
    effective_harness: "claude",
    self_review: true,
    implementer_harness: "claude",
    status: "usable",
  });
  assert.equal(isIndependentlyEligible(a), false);
  assert.equal(countIndependent([a]), 0);
});

test("implementer effective harness is not independent", () => {
  const a = attempt({
    index: 0,
    configured_harness: "claude",
    effective_harness: "claude",
    implementer_harness: "claude",
    self_review: false,
    status: "usable",
  });
  assert.equal(isIndependentlyEligible(a), false);
});

test("same provider+model family share one independent slot", () => {
  const a = attempt({
    index: 0,
    configured_harness: "codex",
    effective_harness: "codex",
    model: "gpt-5.1",
    implementer_harness: "claude",
  });
  const b = attempt({
    index: 1,
    configured_harness: "codex-alt",
    effective_harness: "codex-alt",
    model: "gpt-5.1-mini",
    implementer_harness: "claude",
    // force same lineage
    provider_family: a.provider_family,
    model_family: a.model_family,
  });
  assert.equal(lineageKey(a.provider_family, a.model_family), lineageKey(b.provider_family, b.model_family));
  assert.equal(countIndependent([a, b]), 1);
  assert.equal(detectLineageCollapse([a, b]), true);
});

test("distinct lineage keys count as two independents", () => {
  const a = attempt({
    index: 0,
    configured_harness: "codex",
    effective_harness: "codex",
    model: "gpt-5.1",
    implementer_harness: "claude",
  });
  const b = attempt({
    index: 1,
    configured_harness: "claude",
    effective_harness: "claude",
    model: "claude-sonnet-4",
    implementer_harness: "gemini",
  });
  assert.notEqual(
    lineageKey(a.provider_family, a.model_family),
    lineageKey(b.provider_family, b.model_family),
  );
  assert.equal(countIndependent([a, b]), 2);
});

// ---------------------------------------------------------------------------
// Required independent
// ---------------------------------------------------------------------------

test("resolveRequiredIndependent: absent map → 0", () => {
  assert.equal(resolveRequiredIndependent(undefined, "high"), 0);
  assert.equal(resolveRequiredIndependent({}, "high"), 0);
});

test("resolveRequiredIndependent: high:2", () => {
  assert.equal(resolveRequiredIndependent({ high: 2, standard: 0 }, "high"), 2);
  assert.equal(resolveRequiredIndependent({ high: 2 }, "standard"), 0);
});

// ---------------------------------------------------------------------------
// Aggregation outcomes
// ---------------------------------------------------------------------------

test("classifyAggregationOutcome: complete", () => {
  const { outcome, reason } = classifyAggregationOutcome({
    configured: 2,
    attempted: 2,
    usable: 2,
    independent: 2,
    required: 2,
    minUsable: 1,
    hasSelfReviewAmongUsable: false,
    hasLineageCollapse: false,
  });
  assert.equal(outcome, "complete");
  assert.match(reason, /usable=2\/2/);
});

test("classifyAggregationOutcome: partial_quorum on timeout", () => {
  const { outcome, reason } = classifyAggregationOutcome({
    configured: 3,
    attempted: 3,
    usable: 2,
    independent: 2,
    required: 2,
    minUsable: 1,
    hasSelfReviewAmongUsable: false,
    hasLineageCollapse: false,
    failedLabels: ["codex:timeout"],
  });
  assert.equal(outcome, "partial_quorum");
  assert.match(reason, /timeout|failed=/);
});

test("classifyAggregationOutcome: same_lineage_fallback self-review only", () => {
  const { outcome, reason } = classifyAggregationOutcome({
    configured: 1,
    attempted: 1,
    usable: 1,
    independent: 0,
    required: 0,
    minUsable: 1,
    hasSelfReviewAmongUsable: true,
    hasLineageCollapse: false,
  });
  assert.equal(outcome, "same_lineage_fallback");
  assert.match(reason, /self-review/);
});

test("classifyAggregationOutcome: quorum_unmet", () => {
  const { outcome, reason } = classifyAggregationOutcome({
    configured: 2,
    attempted: 2,
    usable: 1,
    independent: 1,
    required: 2,
    minUsable: 1,
    hasSelfReviewAmongUsable: false,
    hasLineageCollapse: false,
  });
  assert.equal(outcome, "quorum_unmet");
  assert.match(reason, /independent=1 < required=2/);
});

test("classifyAggregationOutcome: no_usable_reviewers", () => {
  const { outcome } = classifyAggregationOutcome({
    configured: 2,
    attempted: 2,
    usable: 0,
    independent: 0,
    required: 0,
    minUsable: 1,
    hasSelfReviewAmongUsable: false,
    hasLineageCollapse: false,
  });
  assert.equal(outcome, "no_usable_reviewers");
});

test("isCoverageFailClosed + coverageBlockerKind", () => {
  assert.equal(isCoverageFailClosed("quorum_unmet", false), true);
  assert.equal(isCoverageFailClosed("quorum_unmet", true), false);
  assert.equal(isCoverageFailClosed("no_usable_reviewers", true), true);
  assert.equal(isCoverageFailClosed("complete", false), false);
  assert.equal(coverageBlockerKind("quorum_unmet"), "review-independent-quorum-unmet");
  assert.equal(coverageBlockerKind("no_usable_reviewers"), "review-no-usable-reviewers");
  assert.equal(coverageBlockerKind("complete"), null);
});

// ---------------------------------------------------------------------------
// Cost rollup
// ---------------------------------------------------------------------------

test("rollupReviewerCost: requested/attempted/completed/billable; unknown not billable zero", () => {
  const rollup = rollupReviewerCost(
    [
      { attempted: true, completed: true, billable: true, cost_usd: 0.12 },
      { attempted: true, completed: true, billable: true, cost_usd: 0.08 },
      { attempted: true, completed: true, billable: false, cost_usd: null }, // timeout unknown
    ],
    3,
  );
  assert.equal(rollup.requested, 3);
  assert.equal(rollup.attempted, 3);
  assert.equal(rollup.completed, 3);
  assert.equal(rollup.billable, 2);
  assert.equal(rollup.billable_cost_usd, 0.2);
});

test("buildCoverageSummary: lineage collapse usable 2 independent 1", () => {
  const a = attempt({
    index: 0,
    configured_harness: "codex",
    effective_harness: "codex",
    model: "gpt-5.1",
    implementer_harness: "claude",
  });
  const b = attempt({
    index: 1,
    configured_harness: "other",
    effective_harness: "other",
    model: "gpt-5.1",
    implementer_harness: "claude",
    provider_family: a.provider_family,
    model_family: a.model_family,
  });
  const summary = buildCoverageSummary({
    attempts: [a, b],
    configured: 2,
    minUsable: 1,
    required: 0,
    riskClass: "standard",
  });
  assert.equal(summary.counts.usable, 2);
  assert.equal(summary.counts.independent, 1);
  assert.equal(summary.aggregation_outcome, "same_lineage_fallback");
});
