// #702: selected planning_depth / risk_class resolution (review findings
// a22d11d8, 30d9ae30). Pure — no network/git.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolvePlanningLeverageSelection } from "../scripts/planning-leverage/selection.ts";
import { emitMaterialRework } from "../scripts/planning-leverage/emit.ts";
import { classifyMateriality } from "../scripts/planning-leverage/materiality.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

test("explicit planning_depth wins over plan_review mapping", () => {
  const sel = resolvePlanningLeverageSelection({
    planning_depth: "minimal",
    plan_review: true,
    planning_effort: "high",
  });
  assert.equal(sel.planning_depth, "minimal");
});

test("plan_review false selects minimal depth", () => {
  const sel = resolvePlanningLeverageSelection({
    plan_review: false,
    planning_effort: "high",
  });
  assert.equal(sel.planning_depth, "minimal");
});

test("plan_review true + high effort selects deep", () => {
  const sel = resolvePlanningLeverageSelection({
    plan_review: true,
    planning_effort: "high",
  });
  assert.equal(sel.planning_depth, "deep");
});

test("plan_review true + medium effort selects standard", () => {
  const sel = resolvePlanningLeverageSelection({
    plan_review: true,
    planning_effort: "medium",
  });
  assert.equal(sel.planning_depth, "standard");
});

test("plan_review true + max effort selects deep", () => {
  const sel = resolvePlanningLeverageSelection({
    plan_review: true,
    planning_effort: "max",
  });
  assert.equal(sel.planning_depth, "deep");
});

test("absent plan_review yields unknown depth (no invented standard)", () => {
  const sel = resolvePlanningLeverageSelection({
    planning_effort: "high",
  });
  assert.equal(sel.planning_depth, "unknown");
});

test("declared risk classes populate risk_class and risk_classes", () => {
  const sel = resolvePlanningLeverageSelection({
    plan_review: true,
    planning_effort: "medium",
    risk_classes: ["auth", "storage", "not-a-class"],
  });
  assert.equal(sel.risk_class, "auth");
  assert.deepEqual(sel.risk_classes, ["auth", "storage"]);
});

test("no risk signals yields unknown risk_class", () => {
  const sel = resolvePlanningLeverageSelection({ plan_review: true });
  assert.equal(sel.risk_class, "unknown");
  assert.equal(sel.risk_classes, undefined);
});

test("lifecycle-only fix evidence is insufficient → materiality unknown", () => {
  // Mirrors pipeline-run fix-stage emission (finding 30d9ae30): no scope /
  // interface / replan / multi-round evidence at the stage boundary.
  const c = classifyMateriality({ evidence_sufficient: false });
  assert.equal(c.materiality, "unknown");
  assert.deepEqual(c.material_criteria, []);
});

test("lifecycle-only emitMaterialRework records unknown not ordinary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pl-sel-"));
  const runDir = path.join(root, ".agent-pipeline", "runs", "702-sel");
  fs.mkdirSync(runDir, { recursive: true });
  const deps: RunStoreDeps = {
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
  };
  await emitMaterialRework(
    runDir,
    {
      run_id: "702-sel",
      evidence: { evidence_sufficient: false },
      fix_round: 1,
    },
    deps,
  );
  const raw = await fsp.readFile(path.join(runDir, "events.jsonl"), "utf8");
  const events = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "material_rework");
  assert.equal(events[0].materiality, "unknown");
  assert.deepEqual(events[0].material_criteria, []);
});

test("pipeline-run does not hard-code planning_depth/risk_class unknown at emit sites", () => {
  // Regression for finding a22d11d8: selected values must come from plSelection.
  const src = fs.readFileSync(
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "../scripts/pipeline-run.ts",
    ),
    "utf8",
  );
  assert.ok(
    src.includes("resolvePlanningLeverageSelection"),
    "pipeline-run must resolve selection once",
  );
  assert.ok(
    src.includes("planning_depth: plSelection.planning_depth"),
    "phase emit must use plSelection.planning_depth",
  );
  assert.ok(
    src.includes("risk_class: plSelection.risk_class"),
    "phase emit must use plSelection.risk_class",
  );
  // The lifecycle fix-stage path must not claim sufficient evidence.
  const fixEmitIdx = src.lastIndexOf("fixRoundFromStage(auditStage)");
  assert.ok(fixEmitIdx > 0, "fix-round emit site must exist");
  const fixSlice = src.slice(fixEmitIdx, fixEmitIdx + 800);
  assert.ok(
    fixSlice.includes("evidence_sufficient: false"),
    "lifecycle fix materiality must pass evidence_sufficient: false",
  );
  assert.ok(
    !fixSlice.includes("evidence_sufficient: true"),
    "lifecycle fix materiality must not claim evidence_sufficient: true",
  );
});
