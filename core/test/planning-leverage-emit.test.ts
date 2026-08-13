import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  emitAssumptionLineage,
  emitMaterialRework,
  emitPlanningLeveragePhase,
  emitPlanningLeverageSnapshot,
} from "../scripts/planning-leverage/emit.ts";
import {
  buildSnapshotFromEvents,
  filterPlanningLeverageEvents,
} from "../scripts/planning-leverage/snapshot.ts";
import { isStageTimelineEventType } from "../scripts/planning-leverage/scoreboard-section.ts";
import { appendEvent, type RunStoreDeps } from "../scripts/run-store.ts";
import {
  createOpenAssumption,
  projectAssumptionCurrentState,
  countUnresolved,
} from "../scripts/planning-leverage/assumptions.ts";
import { unavailableActiveEffort } from "../scripts/planning-leverage/schema.ts";

function makeRunDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pl-emit-"));
  const runDir = path.join(root, ".agent-pipeline", "runs", "702-test-run");
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function baseDeps(extra: Partial<RunStoreDeps> = {}): RunStoreDeps {
  return {
    appendFile: (p, data) => fsp.appendFile(p, data, "utf8"),
    writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
    readFile: (p) => fsp.readFile(p, "utf8"),
    rename: (from, to) => fsp.rename(from, to),
    mkdir: async (p, opts) => {
      await fsp.mkdir(p, opts);
    },
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries as Array<{ name: string; isDirectory(): boolean }>;
    },
    stat: (p) => fsp.stat(p),
    ...extra,
  };
}

async function readEvents(runDir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("phase boundary appends planning_leverage_phase with schema_version 1", async () => {
  const runDir = makeRunDir();
  const ok = await emitPlanningLeveragePhase(
    runDir,
    {
      run_id: "702-test-run",
      issue: 702,
      phase: "planning",
      boundary: "start",
      planning_depth: "deep",
      risk_class: "auth",
      started_at: "2026-08-13T12:00:00.000Z",
    },
    baseDeps(),
  );
  assert.equal(ok, true);
  const events = await readEvents(runDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].schema_version, 1);
  assert.equal(events[0].type, "planning_leverage_phase");
  assert.equal(events[0].phase, "planning");
  assert.equal(events[0].boundary, "start");
  assert.equal(events[0].planning_depth, "deep");
});

test("assumption update appends assumption_lineage with stable id", async () => {
  const runDir = makeRunDir();
  await emitAssumptionLineage(
    runDir,
    {
      run_id: "702-test-run",
      assumption_id: "A1",
      kind: "assumption",
      statement: "stable API",
      introduced_phase: "planning",
      status: "open",
    },
    baseDeps(),
  );
  const prior = createOpenAssumption({
    run_id: "702-test-run",
    assumption_id: "A1",
    kind: "assumption",
    statement: "stable API",
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  await emitAssumptionLineage(
    runDir,
    {
      run_id: "702-test-run",
      prior,
      status: "resolved",
      resolution: { note: "done", resolved_in_phase: "implementation" },
    },
    baseDeps(),
  );
  const events = await readEvents(runDir);
  const lineage = events.filter((e) => e.type === "assumption_lineage");
  assert.equal(lineage.length, 2);
  assert.equal(lineage[0].assumption_id, "A1");
  assert.equal(lineage[1].assumption_id, "A1");
  assert.equal(lineage[1].status, "resolved");
});

test("fix-round materiality appends material_rework", async () => {
  const runDir = makeRunDir();
  await emitMaterialRework(
    runDir,
    {
      run_id: "702-test-run",
      materiality: "material",
      material_criteria: ["design_interface_change"],
      fix_round: 2,
    },
    baseDeps(),
  );
  const events = await readEvents(runDir);
  assert.equal(events[0].type, "material_rework");
  assert.equal(events[0].materiality, "material");
  assert.deepEqual(events[0].material_criteria, ["design_interface_change"]);
  assert.equal(events[0].schema_version, 1);
});

test("stage timeline filters still ignore leverage events", async () => {
  const runDir = makeRunDir();
  const deps = baseDeps();
  await appendEvent(
    runDir,
    { schema_version: 1, type: "stage_start", at: "t0", stage: "planning" },
    deps,
  );
  await emitPlanningLeveragePhase(
    runDir,
    {
      run_id: "702-test-run",
      phase: "planning",
      boundary: "start",
      started_at: "t0",
    },
    deps,
  );
  await appendEvent(
    runDir,
    {
      schema_version: 1,
      type: "stage_complete",
      at: "t1",
      stage: "planning",
      outcome: "success",
    },
    deps,
  );
  const events = await readEvents(runDir);
  const timeline = events.filter((e) => isStageTimelineEventType(String(e.type)));
  assert.equal(timeline.length, 2);
  assert.ok(timeline.every((e) => e.type === "stage_start" || e.type === "stage_complete"));
  assert.ok(events.some((e) => e.type === "planning_leverage_phase"));
});

test("sink receives material_rework line byte-identical to events.jsonl", async () => {
  const runDir = makeRunDir();
  const sinkLines: string[] = [];
  const deps = baseDeps({
    eventSink: async (line: string) => {
      sinkLines.push(line);
    },
    eventSinkMode: "additive",
  });
  await emitMaterialRework(
    runDir,
    {
      run_id: "702-test-run",
      materiality: "ordinary",
      material_criteria: [],
      fix_round: 1,
    },
    deps,
  );
  const disk = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  assert.equal(sinkLines.length, 1);
  assert.equal(sinkLines[0], disk);
});

test("secret redaction applies before assumption append", async () => {
  const runDir = makeRunDir();
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWX";
  await emitAssumptionLineage(
    runDir,
    {
      run_id: "702-test-run",
      kind: "assumption",
      statement: `need ${secret}`,
      introduced_phase: "planning",
    },
    baseDeps(),
  );
  const disk = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  assert.ok(!disk.includes(secret));
});

test("two identical statements get distinct assumption_ids; status updates retain ids", async () => {
  // Regression for #702 review-2 eae15cbf: default allocateAssumptionId used
  // ordinal 0 for every emit without an explicit id, collapsing same-text items.
  const runDir = makeRunDir();
  const deps = baseDeps();
  const runId = "702-test-run";
  const statement = "API remains stable";

  await emitAssumptionLineage(
    runDir,
    {
      run_id: runId,
      kind: "assumption",
      statement,
      introduced_phase: "planning",
      status: "open",
    },
    deps,
  );
  await emitAssumptionLineage(
    runDir,
    {
      run_id: runId,
      kind: "assumption",
      statement,
      introduced_phase: "planning",
      status: "open",
    },
    deps,
  );

  const events = await readEvents(runDir);
  const creates = events.filter((e) => e.type === "assumption_lineage");
  assert.equal(creates.length, 2);
  const id0 = String(creates[0].assumption_id);
  const id1 = String(creates[1].assumption_id);
  assert.notEqual(id0, id1, "identical statements must not share assumption_id");
  assert.ok(id0.length > 0);
  assert.ok(id1.length > 0);

  // Resolve only the first logical item; second stays open with its own id.
  const prior0 = createOpenAssumption({
    run_id: runId,
    assumption_id: id0,
    kind: "assumption",
    statement,
    introduced_phase: "planning",
    status_updated_at: "2026-08-13T12:00:00Z",
  });
  await emitAssumptionLineage(
    runDir,
    {
      run_id: runId,
      prior: prior0,
      status: "resolved",
      resolution: { note: "confirmed", resolved_in_phase: "implementation" },
    },
    deps,
  );

  const after = await readEvents(runDir);
  const lineage = after.filter((e) => e.type === "assumption_lineage");
  assert.equal(lineage.length, 3);
  const resolveEvent = lineage[2];
  assert.equal(resolveEvent.assumption_id, id0);
  assert.equal(resolveEvent.status, "resolved");

  const current = projectAssumptionCurrentState(lineage, runId);
  assert.equal(current.size, 2);
  assert.equal(current.get(id0)?.status, "resolved");
  assert.equal(current.get(id1)?.status, "open");
  assert.equal(countUnresolved(current), 1);
});

test("implicit emit after sparse producer ordinal does not reuse that id", async () => {
  // Regression #702 9d6443b4: producer ordinal 1 then default allocate.
  const runDir = makeRunDir();
  const deps = baseDeps();
  const runId = "702-test-run";
  const statement = "shared sparse text";

  await emitAssumptionLineage(
    runDir,
    {
      run_id: runId,
      kind: "assumption",
      statement,
      introduced_phase: "planning",
      ordinal: 1,
      status: "open",
    },
    deps,
  );
  await emitAssumptionLineage(
    runDir,
    {
      run_id: runId,
      kind: "assumption",
      statement,
      introduced_phase: "planning",
      status: "open",
    },
    deps,
  );

  const events = await readEvents(runDir);
  const creates = events.filter((e) => e.type === "assumption_lineage");
  assert.equal(creates.length, 2);
  const ids = new Set(creates.map((e) => String(e.assumption_id)));
  assert.equal(ids.size, 2, "sparse ordinal must not collide with default allocate");
  const current = projectAssumptionCurrentState(creates, runId);
  assert.equal(current.size, 2);
  assert.equal(countUnresolved(current), 2);
});

test("two concurrent implicit emits get distinct assumption_ids", async () => {
  // Regression #702 9d6443b4: concurrent default allocate must serialize
  // select+append so both do not claim ordinal 0.
  const runDir = makeRunDir();
  const deps = baseDeps();
  const runId = "702-test-run";
  const statement = "concurrent same text";

  const results = await Promise.all([
    emitAssumptionLineage(
      runDir,
      {
        run_id: runId,
        kind: "assumption",
        statement,
        introduced_phase: "planning",
        status: "open",
      },
      deps,
    ),
    emitAssumptionLineage(
      runDir,
      {
        run_id: runId,
        kind: "assumption",
        statement,
        introduced_phase: "planning",
        status: "open",
      },
      deps,
    ),
  ]);
  assert.deepEqual(results, [true, true]);

  const events = await readEvents(runDir);
  const creates = events.filter((e) => e.type === "assumption_lineage");
  assert.equal(creates.length, 2);
  const ids = creates.map((e) => String(e.assumption_id));
  assert.notEqual(ids[0], ids[1], "concurrent implicit emits must not share assumption_id");
  const current = projectAssumptionCurrentState(creates, runId);
  assert.equal(current.size, 2);
  assert.equal(countUnresolved(current), 2);
});

test("representative lifecycle plan → implement → review → fix", async () => {
  const runDir = makeRunDir();
  const deps = baseDeps();
  const runId = "702-test-run";
  const phases = [
    { phase: "planning" as const, start: "t0", end: "t1" },
    { phase: "implementation" as const, start: "t2", end: "t3" },
    { phase: "review" as const, start: "t4", end: "t5" },
    { phase: "correction" as const, start: "t6", end: "t7" },
  ];
  for (const p of phases) {
    await emitPlanningLeveragePhase(
      runDir,
      {
        run_id: runId,
        phase: p.phase,
        boundary: "start",
        started_at: p.start,
        phase_instance_id: `${runId}:${p.phase}:${p.start}`,
        planning_depth: "standard",
        risk_class: "unknown",
      },
      deps,
    );
    await emitPlanningLeveragePhase(
      runDir,
      {
        run_id: runId,
        phase: p.phase,
        boundary: "end",
        started_at: p.start,
        ended_at: p.end,
        phase_instance_id: `${runId}:${p.phase}:${p.start}`,
        planning_depth: "standard",
        active_effort: unavailableActiveEffort(),
      },
      deps,
    );
  }
  const open = createOpenAssumption({
    run_id: runId,
    assumption_id: "A-lifecycle",
    kind: "assumption",
    statement: "scope fixed",
    introduced_phase: "planning",
    status_updated_at: "t0",
  });
  await emitAssumptionLineage(runDir, { run_id: runId, prior: open, status: "open" }, deps);
  await emitMaterialRework(
    runDir,
    {
      run_id: runId,
      evidence: {
        evidence_sufficient: true,
        design_interface_change: false,
        scope_expansion: false,
        replan_or_assumption_reopen: false,
        blocking_fix_rounds: 1,
      },
      fix_round: 1,
    },
    deps,
  );

  const events = await readEvents(runDir);
  assert.ok(events.filter((e) => e.type === "planning_leverage_phase").length >= 8);
  assert.ok(events.some((e) => e.type === "assumption_lineage"));
  assert.ok(events.some((e) => e.type === "material_rework" && e.materiality === "ordinary"));
  assert.ok(events.every((e) => e.schema_version === 1));

  const snap = buildSnapshotFromEvents({ run_id: runId, events });
  assert.equal(snap.planning_depth, "standard");
  assert.ok(!("leverage_score" in snap));
  assert.ok(!("productivity_score" in snap));
  assert.ok(!("expected_pain" in snap));
  assert.equal(
    snap.derived.correction_elapsed_over_planning_elapsed.availability,
    "unavailable",
  ); // timestamps not ISO-parseable "t0" style

  await emitPlanningLeverageSnapshot(runDir, snap, deps);
  const after = await readEvents(runDir);
  assert.ok(after.some((e) => e.type === "planning_leverage_snapshot"));
  assert.equal(filterPlanningLeverageEvents(after).length, after.length);
});
