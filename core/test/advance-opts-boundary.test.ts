// #630: AdvanceOpts boundary + pipeline-run ↔ pipeline cycle break.
//
// Runtime-checkable guards (no tsc gate): source scan that pipeline-run.ts
// never imports pipeline.ts; shared marker/helper identity; AdvanceOpts field
// bag excludes kitchen-sink CLI fields. Pure + filesystem only — no network/git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import {
  REVIEW_CEILING_MARKER,
  ceilingRound as sharedCeilingRound,
  evidenceTimestamp,
} from "../scripts/advance-shared.ts";
import {
  ceilingRound as cliCeilingRound,
  REVIEW_CEILING_MARKER as cliMarker,
  toAdvanceOpts,
} from "../scripts/pipeline.ts";
import type { AdvanceOpts } from "../scripts/pipeline-run.ts";

const scriptsDir = path.dirname(fileURLToPath(new URL("../scripts/pipeline-run.ts", import.meta.url)));

test("pipeline-run.ts does not import pipeline.ts (cycle break #630)", () => {
  const source = readFileSync(path.join(scriptsDir, "pipeline-run.ts"), "utf8");
  // Match type or value imports whose specifier resolves to pipeline.ts.
  // Allow commenting about the break in prose without matching live imports.
  const importFromPipeline = /^\s*import\s+(?:type\s+)?[\s\S]*?from\s+["']\.\/pipeline\.ts["']/gm;
  const matches = source.match(importFromPipeline) ?? [];
  assert.deepEqual(
    matches,
    [],
    `pipeline-run.ts must not import from ./pipeline.ts; found:\n${matches.join("\n")}`,
  );
  assert.doesNotMatch(source, /from\s+["']\.\/pipeline["']/);
});

test("REVIEW_CEILING_MARKER is single-sourced (shared === CLI re-export)", () => {
  assert.equal(REVIEW_CEILING_MARKER, "## Pipeline: Review ceiling reached");
  assert.equal(cliMarker, REVIEW_CEILING_MARKER);
});

test("ceilingRound is the same function via CLI re-export and shared module", () => {
  assert.equal(cliCeilingRound, sharedCeilingRound);
  assert.equal(sharedCeilingRound("Review 2 re-ran 3 times\n"), 2);
  assert.equal(sharedCeilingRound("Review 1 re-ran once\n"), 1);
  assert.equal(sharedCeilingRound("## Pipeline: Review ceiling reached\n\nno round line"), null);
  // Reviewer prose after the controlled line must not override (e8b1f0b4).
  const body = "Review 2 re-ran 3 times\n\nfinding mentions Review 1 re-ran\n";
  assert.equal(sharedCeilingRound(body), 2);
});

test("evidenceTimestamp is seconds-precision ISO UTC", () => {
  const ts = evidenceTimestamp();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.doesNotMatch(ts, /\.\d+Z$/);
});

test("toAdvanceOpts picks only advance-relevant fields", () => {
  const mapped = toAdvanceOpts({
    dryRun: true,
    model: "m",
    once: true,
    override: "k: r",
    jsonEvents: true,
    profile: "codex",
    runId: "run-1",
  });

  assert.deepEqual(mapped, {
    dryRun: true,
    model: "m",
    once: true,
    override: "k: r",
    jsonEvents: true,
    profile: "codex",
    runId: "run-1",
  } satisfies AdvanceOpts);

  // Extra kitchen-sink keys on a wider input object must not leak into the bag.
  const wide = {
    dryRun: false,
    model: "x",
    once: false,
    override: undefined,
    jsonEvents: false,
    profile: "claude",
    runId: "r2",
    status: true,
    estimateCost: ["claude=0.01"],
    maxIssues: 5,
  };
  const filtered = toAdvanceOpts(wide);
  assert.deepEqual(Object.keys(filtered).sort(), [
    "dryRun",
    "jsonEvents",
    "model",
    "once",
    "override",
    "profile",
    "runId",
  ]);
  assert.equal("status" in filtered, false);
  assert.equal("estimateCost" in filtered, false);
  assert.equal("maxIssues" in filtered, false);
});

test("toAdvanceOpts maps --sha onto candidateShaOverride", () => {
  const sha = "a".repeat(40);
  const mapped = toAdvanceOpts({
    dryRun: false,
    model: undefined,
    once: false,
    override: undefined,
    jsonEvents: false,
    profile: "codex",
    runId: "r3",
    sha,
  });
  assert.equal(mapped.candidateShaOverride, sha);
  assert.equal("sha" in mapped, false);
});

test("toAdvanceOpts omits candidateShaOverride when --sha is absent", () => {
  const mapped = toAdvanceOpts({
    dryRun: false,
    model: undefined,
    once: false,
    override: undefined,
    jsonEvents: false,
    profile: "codex",
    runId: "r4",
  });
  assert.equal("candidateShaOverride" in mapped, false);
});

test("toAdvanceOpts forwards a malformed --sha so the resolver can fail closed", () => {
  const mapped = toAdvanceOpts({
    dryRun: false,
    model: undefined,
    once: false,
    override: undefined,
    jsonEvents: false,
    profile: "codex",
    runId: "r5",
    sha: "not-a-sha",
  });
  assert.equal(mapped.candidateShaOverride, "not-a-sha");
});

test("AdvanceOpts type is importable from pipeline-run without CliOpts kitchen-sink", () => {
  // Compile-time / structural: a thin bag is enough for the advance contract.
  const opts: AdvanceOpts = { dryRun: true, once: true, runId: "x" };
  assert.equal(opts.dryRun, true);
  // Runtime source pin: AdvanceOpts is defined in pipeline-run.ts, not pipeline.ts.
  const runSource = readFileSync(path.join(scriptsDir, "pipeline-run.ts"), "utf8");
  assert.match(runSource, /export interface AdvanceOpts/);
  const cliSource = readFileSync(path.join(scriptsDir, "pipeline.ts"), "utf8");
  assert.doesNotMatch(cliSource, /export interface AdvanceOpts/);
});
