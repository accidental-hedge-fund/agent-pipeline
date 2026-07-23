// Tests for pipeline:loop selector compilation (#512 review 1, finding
// c3e59739): milestone/label/roadmap-slice selectors must resolve to a
// concrete issue-number work list before routing to the supervisor, the same
// way an explicit issue list already did. All gh/filesystem access is
// injected via SelectorResolveDeps — no real network or filesystem access in
// these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchItemChildArgs,
  extractRoadmapSliceIssues,
  resolveSelectorIssues,
  type SelectorOpenIssue,
  type SelectorResolveDeps,
} from "../scripts/pipeline.ts";
import type { PipelineConfig } from "../scripts/types.ts";

function fakeCfg(): PipelineConfig {
  return { repo: "acme/widget", repo_dir: "/tmp/does-not-exist" } as unknown as PipelineConfig;
}

function fakeSelectorDeps(issues: SelectorOpenIssue[], roadmapText = ""): SelectorResolveDeps {
  return {
    listOpenIssues: async () => issues,
    readRoadmap: async () => roadmapText,
  };
}

// ---------------------------------------------------------------------------
// dispatchItemChildArgs (#512 review 1, finding 57fe63fa).
// ---------------------------------------------------------------------------

test("dispatchItemChildArgs never passes --once: the per-item hand-off must run its advance loop to a terminal outcome, not stop after one stage", () => {
  const args = dispatchItemChildArgs("/path/to/pipeline.ts", 100, "claude", "/repo");
  assert.deepEqual(args, ["/path/to/pipeline.ts", "100", "--profile", "claude", "--repo-path", "/repo"]);
  assert.ok(!args.includes("--once"), "child argv must not contain --once");
});

// ---------------------------------------------------------------------------
// resolveSelectorIssues.
// ---------------------------------------------------------------------------

test("resolveSelectorIssues: work-list selector passes through unchanged", async () => {
  const deps = fakeSelectorDeps([]);
  const issues = await resolveSelectorIssues(fakeCfg(), { type: "work-list", value: ["100", "200"] }, deps);
  assert.deepEqual(issues, ["100", "200"]);
});

test("resolveSelectorIssues: milestone selector resolves to matching open issues, sorted ascending", async () => {
  const deps = fakeSelectorDeps([
    { number: 300, labels: [], milestone: "v2" },
    { number: 100, labels: [], milestone: "v2" },
    { number: 200, labels: [], milestone: "v3" },
  ]);
  const issues = await resolveSelectorIssues(fakeCfg(), { type: "milestone", value: "v2" }, deps);
  assert.deepEqual(issues, ["100", "300"]);
});

test("resolveSelectorIssues: milestone selector with no matches throws", async () => {
  const deps = fakeSelectorDeps([{ number: 100, labels: [], milestone: "v3" }]);
  await assert.rejects(
    () => resolveSelectorIssues(fakeCfg(), { type: "milestone", value: "v2" }, deps),
    /no open issues found for milestone "v2"/,
  );
});

test("resolveSelectorIssues: label selector resolves to matching open issues, sorted ascending", async () => {
  const deps = fakeSelectorDeps([
    { number: 400, labels: ["team:backend"], milestone: null },
    { number: 100, labels: ["team:backend", "risk:low"], milestone: null },
    { number: 200, labels: ["team:frontend"], milestone: null },
  ]);
  const issues = await resolveSelectorIssues(fakeCfg(), { type: "label", value: "team:backend" }, deps);
  assert.deepEqual(issues, ["100", "400"]);
});

test("resolveSelectorIssues: label selector with no matches throws", async () => {
  const deps = fakeSelectorDeps([{ number: 100, labels: ["team:frontend"], milestone: null }]);
  await assert.rejects(
    () => resolveSelectorIssues(fakeCfg(), { type: "label", value: "team:backend" }, deps),
    /no open issues found for label "team:backend"/,
  );
});

test("resolveSelectorIssues: roadmap-slice selector resolves issue numbers from the named unshipped slice's table", async () => {
  const roadmap = [
    "## Forward Roadmap",
    "",
    "**v1.16.0 — Outer-loop evidence + drift control (minor):**",
    "",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #521 | Title one | rationale |",
    "| #522 | Title two | rationale |",
    "",
    "**v1.15.1 — Foundation reliability + release hygiene (patch):**",
    "",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #999 | Should not be included | rationale |",
  ].join("\n");
  const deps = fakeSelectorDeps([], roadmap);
  const issues = await resolveSelectorIssues(fakeCfg(), { type: "roadmap-slice", value: "v1.16.0" }, deps);
  assert.deepEqual(issues, ["521", "522"]);
});

test("resolveSelectorIssues: roadmap-slice never matches a heading marked (shipped ...) — regression for the live ROADMAP.md's reused v1.16.0 version number", () => {
  // Reproduces this repo's actual ROADMAP.md shape: a shipped release and a
  // still-forward slice can share the same version-number heading text. Only
  // the unshipped one may ever be selected for a loop run.
  const roadmap = [
    "**v1.16.0 — Papercut capture: agent-logged friction events + CLI (shipped 2026-07-21, tag `v1.16.0`) — sixteenth minor:**",
    "",
    "| # | What | PR |",
    "|---|------|-----|",
    "| | [Pipeline] Already shipped, must not be selected (#111) | #222 |",
    "",
    "**v1.16.0 — Outer-loop evidence + drift control (minor):**",
    "",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #365 | Still forward, must be selected | rationale |",
  ].join("\n");
  const issues = extractRoadmapSliceIssues(roadmap, "v1.16.0");
  assert.deepEqual(issues, [365]);
});

test("resolveSelectorIssues: roadmap-slice dedupes repeated issue references and sorts ascending", () => {
  const roadmap = [
    "**v9.0.0 — Slice:**",
    "| # | What | Why |",
    "|---|------|-----|",
    "| #522 | B | rationale |",
    "| #521 | A | rationale |",
    "| #521 | A again | rationale |",
  ].join("\n");
  const issues = extractRoadmapSliceIssues(roadmap, "v9.0.0");
  assert.deepEqual(issues, [521, 522]);
});

test("resolveSelectorIssues: roadmap-slice selector not found in ROADMAP.md throws", async () => {
  const deps = fakeSelectorDeps([], "**v1.0.0 — Something:**\n| #1 | Title | rationale |");
  await assert.rejects(
    () => resolveSelectorIssues(fakeCfg(), { type: "roadmap-slice", value: "v9.9.9" }, deps),
    /roadmap slice "v9\.9\.9" was not found/,
  );
});
