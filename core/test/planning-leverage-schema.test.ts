import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTION_STATUSES,
  DELIVERY_PHASES,
  MATERIAL_CRITERIA,
  MATERIALITIES,
  PLANNING_DEPTHS,
  PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION,
  RISK_CLASSES,
  buildAssumptionPayload,
  buildMaterialReworkPayload,
  buildPhasePayload,
  computeElapsed,
  emptyReviewEffort,
  makeActiveEffort,
  mapStageToPhase,
  observedReviewEffort,
  readPhasePayload,
  redactFreeText,
  unavailableActiveEffort,
  unknownCost,
} from "../scripts/planning-leverage/schema.ts";
import {
  FIXTURE_MATERIAL_INTERFACE,
  FIXTURE_MATERIAL_MULTI_ROUND,
  FIXTURE_ORDINARY_FORMATTING,
  FIXTURE_UNKNOWN_EVIDENCE,
  classifyMateriality,
} from "../scripts/planning-leverage/materiality.ts";

test("closed enums are locked", () => {
  assert.deepEqual([...DELIVERY_PHASES], [
    "alignment",
    "planning",
    "implementation",
    "review",
    "correction",
  ]);
  assert.deepEqual([...PLANNING_DEPTHS], ["minimal", "standard", "deep", "unknown"]);
  assert.ok(RISK_CLASSES.includes("unknown"));
  assert.ok(RISK_CLASSES.includes("auth"));
  assert.deepEqual([...MATERIALITIES], ["material", "ordinary", "unknown"]);
  assert.deepEqual([...MATERIAL_CRITERIA], [
    "scope_expansion",
    "design_interface_change",
    "replan_or_assumption_reopen",
    "multi_round_blocking",
  ]);
  assert.deepEqual([...ASSUMPTION_STATUSES], [
    "open",
    "resolved",
    "invalidated",
    "deferred",
    "unknown",
  ]);
  assert.equal(PLANNING_LEVERAGE_RECORD_SCHEMA_VERSION, 1);
});

test("elapsed is computed only when both timestamps present", () => {
  const both = computeElapsed("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:05.000Z");
  assert.equal(both.elapsed_ms, 5000);
  assert.equal(both.elapsed_availability, "observed");

  const missingEnd = computeElapsed("2026-08-13T12:00:00.000Z", null);
  assert.equal(missingEnd.elapsed_ms, null);
  assert.equal(missingEnd.elapsed_availability, "unavailable");

  const missingStart = computeElapsed(null, "2026-08-13T12:00:05.000Z");
  assert.equal(missingStart.elapsed_ms, null);
  assert.equal(missingStart.elapsed_availability, "unavailable");
});

test("unknown active effort is not zero or elapsed", () => {
  const u = unavailableActiveEffort();
  assert.equal(u.value_ms, null);
  assert.equal(u.availability, "unavailable");
  assert.notEqual(u.value_ms, 0);

  const phase = buildPhasePayload({
    run_id: "702-run",
    phase: "planning",
    phase_instance_id: "702-run:planning:t0",
    boundary: "end",
    started_at: "2026-08-13T12:00:00.000Z",
    ended_at: "2026-08-13T12:01:00.000Z",
    active_effort: unavailableActiveEffort(),
  });
  assert.equal(phase.ok, true);
  assert.equal(phase.value!.elapsed_ms, 60_000);
  assert.equal(phase.value!.active_effort.value_ms, null);
  assert.notEqual(phase.value!.active_effort.value_ms, phase.value!.elapsed_ms);
});

test("unknown cost remains null not zero", () => {
  const c = unknownCost();
  assert.equal(c.cost_usd, null);
  assert.equal(c.cost_source, "unknown");
});

test("rejects placeholder run_id", () => {
  const r = buildPhasePayload({
    run_id: "unknown",
    phase: "planning",
    phase_instance_id: "x",
    boundary: "start",
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "run_id"));
});

test("rejects out-of-enum planning_depth", () => {
  const r = buildPhasePayload({
    run_id: "run-1",
    phase: "planning",
    phase_instance_id: "id",
    boundary: "start",
    planning_depth: "extra" as "deep",
  });
  assert.equal(r.ok, false);
});

test("assumption status enum rejects free-form", () => {
  const r = buildAssumptionPayload({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: "x",
    introduced_phase: "planning",
    status: "maybe" as "open",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "status"));
});

test("materiality positive and negative fixtures", () => {
  const ordinary = classifyMateriality(FIXTURE_ORDINARY_FORMATTING);
  assert.equal(ordinary.materiality, "ordinary");
  assert.deepEqual(ordinary.material_criteria, []);

  const iface = classifyMateriality(FIXTURE_MATERIAL_INTERFACE);
  assert.equal(iface.materiality, "material");
  assert.ok(iface.material_criteria.includes("design_interface_change"));

  const multi = classifyMateriality(FIXTURE_MATERIAL_MULTI_ROUND);
  assert.equal(multi.materiality, "material");
  assert.ok(multi.material_criteria.includes("multi_round_blocking"));

  const unknown = classifyMateriality(FIXTURE_UNKNOWN_EVIDENCE);
  assert.equal(unknown.materiality, "unknown");
  assert.notEqual(unknown.materiality, "material");
});

test("unknown review effort is not zero-filled as fact", () => {
  const empty = emptyReviewEffort();
  assert.equal(empty.findings_blocking, null);
  assert.equal(empty.availability.findings_blocking, "unavailable");

  const built = buildMaterialReworkPayload({
    run_id: "run-1",
    materiality: "ordinary",
    material_criteria: [],
    review_effort: empty,
  });
  assert.equal(built.ok, true);
  assert.equal(built.value!.review_effort.findings_blocking, null);

  const known = observedReviewEffort({
    findings_blocking: 3,
    findings_advisory: 1,
    re_review_count: 1,
  });
  const m = buildMaterialReworkPayload({
    run_id: "run-1",
    materiality: "material",
    material_criteria: ["scope_expansion"],
    fix_round: 2,
    review_effort: known,
  });
  assert.equal(m.ok, true);
  assert.equal(m.value!.review_effort.findings_blocking, 3);
  assert.equal(m.value!.fix_round, 2);
});

test("unknown fields ignored by phase reader", () => {
  const raw = {
    record_schema_version: 1,
    type: "planning_leverage_phase",
    run_id: "run-1",
    issue: 702,
    phase: "planning",
    phase_instance_id: "pi",
    boundary: "end",
    planning_depth: "deep",
    risk_class: "auth",
    started_at: "2026-08-13T12:00:00.000Z",
    ended_at: "2026-08-13T12:00:10.000Z",
    elapsed_ms: 10000,
    elapsed_availability: "observed",
    active_effort: unavailableActiveEffort(),
    future_field: { nested: true },
    leverage_score: 99,
  };
  const read = readPhasePayload(raw);
  assert.ok(read);
  assert.equal(read.planning_depth, "deep");
  assert.equal((read as { leverage_score?: unknown }).leverage_score, undefined);
  assert.equal((read as { future_field?: unknown }).future_field, undefined);
});

test("free-text redaction before serialize", () => {
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
  const redacted = redactFreeText(`token ${secret} end`);
  assert.ok(!redacted.includes(secret));

  const built = buildAssumptionPayload({
    run_id: "run-1",
    assumption_id: "A1",
    kind: "assumption",
    statement: `We need ${secret} for deploy`,
    introduced_phase: "planning",
    status: "open",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  assert.equal(built.ok, true);
  assert.ok(!built.value!.statement.includes(secret));
});

test("mapStageToPhase covers delivery stages", () => {
  assert.equal(mapStageToPhase("planning"), "planning");
  assert.equal(mapStageToPhase("implementing"), "implementation");
  assert.equal(mapStageToPhase("review-1"), "review");
  assert.equal(mapStageToPhase("fix-2"), "correction");
  assert.equal(mapStageToPhase("ready-to-deploy"), null);
});

test("makeActiveEffort observed path", () => {
  const a = makeActiveEffort({ value_ms: 100, source: "harness_accounted", availability: "observed" });
  assert.equal(a.value_ms, 100);
  assert.equal(a.availability, "observed");
});
