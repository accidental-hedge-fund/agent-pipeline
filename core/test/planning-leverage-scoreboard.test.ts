import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePlanningLeverageScoreboardSection,
  emptyPlanningLeverageScoreboardSection,
  formatPlanningLeverageScoreboardHuman,
} from "../scripts/planning-leverage/scoreboard-section.ts";
import { buildScoreboardReport, type ScoreboardDeps } from "../scripts/scoreboard.ts";
import { runsDir } from "../scripts/run-store.ts";

test("aggregate depth counts and materiality breakdown", () => {
  const section = aggregatePlanningLeverageScoreboardSection([
    {
      runId: "r1",
      events: [
        {
          record_schema_version: 1,
          type: "planning_leverage_phase",
          run_id: "r1",
          phase: "planning",
          phase_instance_id: "pi1",
          boundary: "end",
          planning_depth: "deep",
          risk_class: "auth",
          started_at: "2026-08-13T12:00:00.000Z",
          ended_at: "2026-08-13T12:05:00.000Z",
          elapsed_ms: 300_000,
          elapsed_availability: "observed",
          active_effort: {
            value_ms: null,
            source: "unknown",
            availability: "unavailable",
          },
        },
        {
          record_schema_version: 1,
          type: "material_rework",
          run_id: "r1",
          materiality: "material",
          material_criteria: ["design_interface_change"],
          fix_round: 1,
          review_effort: {
            findings_blocking: null,
            findings_advisory: null,
            re_review_count: null,
            availability: {
              findings_blocking: "unavailable",
              findings_advisory: "unavailable",
              re_review_count: "unavailable",
            },
          },
        },
      ],
    },
    {
      runId: "r2",
      events: [
        {
          record_schema_version: 1,
          type: "planning_leverage_phase",
          run_id: "r2",
          phase: "planning",
          phase_instance_id: "pi2",
          boundary: "end",
          planning_depth: "minimal",
          risk_class: "unknown",
          started_at: "2026-08-13T13:00:00.000Z",
          ended_at: "2026-08-13T13:01:00.000Z",
          elapsed_ms: 60_000,
          elapsed_availability: "observed",
          active_effort: {
            value_ms: null,
            source: "unknown",
            availability: "unavailable",
          },
        },
        {
          record_schema_version: 1,
          type: "material_rework",
          run_id: "r2",
          materiality: "ordinary",
          material_criteria: [],
          fix_round: 1,
          review_effort: {
            findings_blocking: null,
            findings_advisory: null,
            re_review_count: null,
            availability: {
              findings_blocking: "unavailable",
              findings_advisory: "unavailable",
              re_review_count: "unavailable",
            },
          },
        },
      ],
    },
  ]);

  assert.equal(section.by_planning_depth.deep, 1);
  assert.equal(section.by_planning_depth.minimal, 1);
  assert.equal(section.materiality_counts.material, 1);
  assert.equal(section.materiality_counts.ordinary, 1);
  assert.equal(section.phase_elapsed_availability.planning, "observed");
  assert.equal(section.phase_elapsed_ms.planning, 360_000);
  assert.equal(section.partitions.unavailable.active_effort_ms, null);
  assert.ok(!("productivity_score" in section));
  assert.ok(!("leverage_score" in section));
  assert.ok(!("expected_pain" in section));

  const human = formatPlanningLeverageScoreboardHuman(section).join("\n");
  assert.ok(human.includes("Planning leverage"));
  // Note text mentions the forbidden field names; section object must not carry them.
  assert.ok(human.includes("no productivity_score"));
  assert.ok(human.includes("unavailable is not reported as zero"));
});

test("missing telemetry is empty not fatal", () => {
  const section = aggregatePlanningLeverageScoreboardSection([
    { runId: "old", events: [{ type: "stage_start", stage: "planning" }] },
  ]);
  assert.equal(section.runs_with_telemetry, 0);
  assert.equal(section.by_planning_depth.deep, 0);
  assert.ok(section.diagnostics.some((d) => d.code === "telemetry_absent"));
  assert.doesNotThrow(() => formatPlanningLeverageScoreboardHuman(section));
});

test("unavailable active effort is not reported as zero cost fact", () => {
  const section = aggregatePlanningLeverageScoreboardSection([
    {
      runId: "r1",
      events: [
        {
          record_schema_version: 1,
          type: "planning_leverage_phase",
          run_id: "r1",
          phase: "correction",
          phase_instance_id: "c1",
          boundary: "end",
          planning_depth: "unknown",
          risk_class: "unknown",
          started_at: "2026-08-13T12:00:00.000Z",
          ended_at: "2026-08-13T12:02:00.000Z",
          elapsed_ms: 120_000,
          elapsed_availability: "observed",
          active_effort: {
            value_ms: null,
            source: "unknown",
            availability: "unavailable",
          },
        },
      ],
    },
  ]);
  assert.equal(section.partitions.unavailable.active_effort_ms, null);
  assert.notEqual(section.partitions.unavailable.active_effort_ms, 0);
  const human = formatPlanningLeverageScoreboardHuman(section).join("\n");
  assert.ok(human.includes("active effort unavailable is not reported as zero"));
});

test("scoreboard report includes planning_leverage section JSON-safe", async () => {
  const repoDir = "/repo-pl";
  const files = new Map<string, string>();
  const runPath = runsDir(repoDir);
  const runId = "1-2026-06-10T12-00-00-000Z";
  const runDir = `${runPath}/${runId}`;
  files.set(
    `${runDir}/run.json`,
    JSON.stringify({
      schema_version: 1,
      run_id: runId,
      issue: 1,
      repo: "o/r",
      started_at: "2026-06-10T12:00:00.000Z",
    }),
  );
  files.set(
    `${runDir}/events.jsonl`,
    [
      JSON.stringify({
        schema_version: 1,
        type: "run_start",
        at: "2026-06-10T12:00:00.000Z",
        run_id: runId,
        issue: 1,
        repo: "o/r",
      }),
      JSON.stringify({
        schema_version: 1,
        type: "planning_leverage_phase",
        at: "2026-06-10T12:01:00.000Z",
        record_schema_version: 1,
        run_id: runId,
        issue: 1,
        phase: "planning",
        phase_instance_id: "pi",
        boundary: "end",
        planning_depth: "standard",
        risk_class: "storage",
        started_at: "2026-06-10T12:00:00.000Z",
        ended_at: "2026-06-10T12:01:00.000Z",
        elapsed_ms: 60_000,
        elapsed_availability: "observed",
        active_effort: {
          value_ms: null,
          source: "unknown",
          availability: "unavailable",
        },
      }),
      JSON.stringify({
        schema_version: 1,
        type: "run_complete",
        at: "2026-06-10T13:00:00.000Z",
        final_state: "ready-to-deploy",
        elapsed_ms: 3_600_000,
      }),
    ].join("\n") + "\n",
  );

  const deps: ScoreboardDeps = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files.get(p)!;
    },
    readdir: async (p) => {
      if (p === runPath || p.endsWith("/runs")) {
        return [{ name: runId, isDirectory: () => true }];
      }
      return [];
    },
    log: () => {},
    writeFile: async () => {},
    rename: async () => {},
    unlink: async () => {},
  };

  const report = await buildScoreboardReport(
    {
      repoDir,
      since: "2026-06-01T00:00:00.000Z",
      until: "2026-06-30T23:59:59.000Z",
    },
    deps,
  );
  assert.ok(report.planning_leverage);
  assert.equal(report.planning_leverage.by_planning_depth.standard, 1);
  assert.ok(!("productivity_score" in report.planning_leverage));
  assert.ok(!("leverage_score" in report.planning_leverage));
  assert.ok(!("expected_pain" in report.planning_leverage));
});

test("emptyPlanningLeverageScoreboardSection is zeros", () => {
  const e = emptyPlanningLeverageScoreboardSection();
  assert.equal(e.runs_with_telemetry, 0);
  assert.equal(e.materiality_counts.material, 0);
});
