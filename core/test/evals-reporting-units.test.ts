// Tests for the reporting layer's pure building blocks (pairing, intervals,
// Pareto, grouping, cost) — eval-comparative-reporting. No fs/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pairAgainstBaseline, reduceReplicates } from "../scripts/evals/reporting/pairing.ts";
import { bootstrapEffect, defaultIntervalMethod } from "../scripts/evals/reporting/intervals.ts";
import { paretoFrontier } from "../scripts/evals/reporting/pareto.ts";
import { groupBy, parseTreatmentId } from "../scripts/evals/reporting/grouping.ts";
import { costFromDetail, summarizeCost } from "../scripts/evals/reporting/cost.ts";

test("reduceReplicates: multiple replicates reduce to their mean", () => {
  assert.equal(reduceReplicates([1, 3]), 2);
});

test("pairing: a fixture with both treatment and baseline contributes a delta", () => {
  const treatment = new Map([["f1", [0.9]]]);
  const baseline = new Map([["f1", [0.7]]]);
  const result = pairAgainstBaseline(treatment, baseline);
  assert.equal(result.deltas.length, 1);
  assert.ok(Math.abs(result.deltas[0] - 0.2) < 1e-9);
});

test("pairing: an unpaired fixture is excluded and named", () => {
  const treatment = new Map([
    ["f1", [0.9]],
    ["f2", [0.5]],
  ]);
  const baseline = new Map([["f1", [0.7]]]);
  const result = pairAgainstBaseline(treatment, baseline);
  assert.equal(result.deltas.length, 1);
  assert.deepEqual(result.excludedFixtures, ["f2"]);
});

test("pairing: differing replicate counts leave the aggregate unchanged", () => {
  const treatmentA = new Map([["f1", [0.8, 0.8, 0.8, 0.8]]]); // 4 replicates
  const treatmentB = new Map([["f1", [0.8]]]); // 1 replicate, same mean
  const baseline = new Map([["f1", [0.6]]]);
  const resultA = pairAgainstBaseline(treatmentA, baseline);
  const resultB = pairAgainstBaseline(treatmentB, baseline);
  assert.deepEqual(resultA.deltas, resultB.deltas);
});

test("intervals: every effect carries a mean, interval, and n", () => {
  const method = defaultIntervalMethod(42);
  const effect = bootstrapEffect([0.1, 0.2, 0.15, 0.3, 0.25, 0.05], method, 5);
  assert.ok(typeof effect.mean === "number");
  assert.ok(typeof effect.ci_low === "number");
  assert.ok(typeof effect.ci_high === "number");
  assert.equal(effect.n, 6);
});

test("intervals: repeated computation with the same seed is byte-identical", () => {
  const method = defaultIntervalMethod(7);
  const deltas = [0.1, -0.2, 0.3, 0.05, 0.4];
  const first = bootstrapEffect(deltas, method, 5);
  const second = bootstrapEffect(deltas, method, 5);
  assert.deepEqual(first, second);
});

test("intervals: a small sample is marked underpowered but still reported", () => {
  const method = defaultIntervalMethod(1);
  const effect = bootstrapEffect([0.1, 0.2], method, 5);
  assert.equal(effect.underpowered, true);
  assert.equal(effect.n, 2);
  assert.ok(typeof effect.ci_low === "number");
});

test("pareto: a dominated treatment is excluded from the frontier", () => {
  const frontier = paretoFrontier([
    { treatment_id: "a", quality: 0.9, cost: 10 },
    { treatment_id: "b", quality: 0.9, cost: 20 }, // same quality, more expensive -> dominated by a
    { treatment_id: "c", quality: 0.95, cost: 30 }, // better quality, more expensive -> non-dominated trade-off
  ]);
  assert.deepEqual(frontier, ["a", "c"]);
});

test("pareto: a faster-but-worse treatment shows both axes with no combined score", () => {
  const points = [
    { treatment_id: "baseline", quality: 0.9, cost: 100 },
    { treatment_id: "fast-worse", quality: 0.6, cost: 30 },
  ];
  const frontier = paretoFrontier(points);
  // Both are non-dominated (neither dominates the other): a genuine
  // quality/speed trade-off, not something the frontier collapses away.
  assert.deepEqual(frontier.sort(), ["baseline", "fast-worse"]);
});

test("grouping: parseTreatmentId reverses manifest.ts's treatmentId format", () => {
  assert.deepEqual(parseTreatmentId("harness=claude,model=opus"), { harness: "claude", model: "opus" });
  assert.deepEqual(parseTreatmentId(""), {});
});

test("grouping: one entry per distinct value", () => {
  const entries = [
    { treatment_id: "harness=claude", stage: "review", category: "c", risk: "low", quality: 0.8, completed: true },
    { treatment_id: "harness=codex", stage: "review", category: "c", risk: "low", quality: 0.6, completed: true },
  ];
  const grouped = groupBy(entries, "harness");
  assert.deepEqual(
    grouped.map((g) => g.value),
    ["claude", "codex"],
  );
});

test("grouping: a missing dimension value lands in an explicit unknown group, not dropped", () => {
  const entries = [
    { treatment_id: "effort=high", stage: "review", category: "c", risk: "low", quality: 0.8, completed: true },
  ];
  const grouped = groupBy(entries, "harness");
  assert.deepEqual(grouped, [{ value: "unknown", n: 1, mean_quality: 0.8, completion_rate: 1 }]);
});

test("cost: unknown cost source is excluded rather than zeroed", () => {
  const summary = summarizeCost([
    { cost_source: "actual", cost_usd: 1 },
    { cost_source: "unknown", cost_usd: null },
  ]);
  assert.equal(summary.n_with_cost, 1);
  assert.equal(summary.mean_cost_usd, 1);
  assert.equal(summary.coverage, 0.5);
});

test("cost: coverage reports actual/estimated composition", () => {
  const summary = summarizeCost([
    { cost_source: "actual", cost_usd: 2 },
    { cost_source: "estimated", cost_usd: 4 },
    { cost_source: "unknown", cost_usd: null },
  ]);
  assert.equal(summary.actual_fraction, 1 / 3);
  assert.equal(summary.estimated_fraction, 1 / 3);
  assert.equal(summary.mean_cost_usd, 3);
});

test("cost: missing cost fields on a detail blob read as unknown, not zero", () => {
  const cost = costFromDetail({ stages: [] });
  assert.equal(cost.cost_source, "unknown");
  assert.equal(cost.cost_usd, null);
});
