import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferProductionOutcomeFromTemporal,
  joinProductionOutcomesForRun,
  productionOutcomeAttribution,
} from "../scripts/planning-leverage/linkage.ts";
import { buildSnapshotFromEvents } from "../scripts/planning-leverage/snapshot.ts";
import { unavailableActiveEffort } from "../scripts/planning-leverage/schema.ts";

test("observed production_outcome attribution from run match", () => {
  const joined = joinProductionOutcomesForRun({
    run_id: "R1",
    outcomes: [
      {
        outcome_id: "out-1",
        attribution: [
          { target_type: "run", target_id: "R1", authority: "observed" },
        ],
      },
    ],
  });
  assert.equal(joined.attribution.length, 1);
  assert.equal(joined.attribution[0].target_type, "production_outcome");
  assert.equal(joined.attribution[0].target_id, "out-1");
  assert.equal(joined.attribution[0].authority, "observed");
});

test("missing outcome id is not fabricated", () => {
  const joined = joinProductionOutcomesForRun({
    run_id: "R1",
    outcomes: [],
  });
  assert.equal(joined.attribution.length, 0);
  assert.ok(joined.diagnostics.includes("unresolved_production_outcome"));

  assert.equal(productionOutcomeAttribution({ outcome_id: null, authority: "observed" }), null);
  assert.equal(
    productionOutcomeAttribution({ outcome_id: "unknown", authority: "observed" }),
    null,
  );
  assert.equal(
    productionOutcomeAttribution({ outcome_id: "placeholder-x", authority: "observed" }),
    null,
  );
});

test("temporal co-occurrence alone is inferred", () => {
  const a = inferProductionOutcomeFromTemporal({
    outcome_id: "out-2",
    same_day_same_repo: true,
    shared_run_or_sha_or_trailer: false,
  });
  assert.ok(a);
  assert.equal(a.authority, "inferred");
  assert.equal(a.target_type, "production_outcome");
});

test("unresolved outcome does not throw", () => {
  assert.doesNotThrow(() => {
    joinProductionOutcomesForRun({ run_id: "R-missing", outcomes: [{ outcome_id: "out-x" }] });
  });
});

test("snapshot derived unavailable when active effort inputs missing", () => {
  const snap = buildSnapshotFromEvents({
    run_id: "R1",
    events: [
      {
        record_schema_version: 1,
        type: "planning_leverage_phase",
        run_id: "R1",
        issue: 1,
        phase: "planning",
        phase_instance_id: "pi",
        boundary: "end",
        planning_depth: "minimal",
        risk_class: "unknown",
        started_at: "2026-08-13T12:00:00.000Z",
        ended_at: "2026-08-13T12:10:00.000Z",
        elapsed_ms: 600_000,
        elapsed_availability: "observed",
        active_effort: unavailableActiveEffort(),
      },
    ],
    outcomes: [],
  });
  assert.equal(snap.derived.active_correction_effort_ratio.availability, "unavailable");
  assert.equal(snap.derived.active_correction_effort_ratio.value, null);
  assert.ok(snap.attribution.some((a) => a.target_type === "run" && a.authority === "observed"));
  assert.ok(!snap.attribution.some((a) => a.target_type === "production_outcome"));
  assert.ok(snap.linkage_diagnostics.includes("unresolved_production_outcome"));
});

test("snapshot joins production outcome when evidence exists", () => {
  const snap = buildSnapshotFromEvents({
    run_id: "R1",
    events: [],
    outcomes: [
      {
        outcome_id: "out-1",
        attribution: [{ target_type: "run", target_id: "R1", authority: "observed" }],
      },
    ],
  });
  assert.ok(
    snap.attribution.some(
      (a) =>
        a.target_type === "production_outcome" &&
        a.target_id === "out-1" &&
        a.authority === "observed",
    ),
  );
});
