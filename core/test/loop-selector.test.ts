// Tests for pipeline:loop selector compilation (#512 review 1, finding
// c3e59739): milestone/label/roadmap-slice selectors must resolve to a
// concrete issue-number work list before routing to the supervisor, the same
// way an explicit issue list already did. All gh/filesystem access is
// injected via SelectorResolveDeps — no real network or filesystem access in
// these tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoopEvidencePointer,
  buildStartLinkagePayload,
  buildTerminalLinkagePayload,
  classifyDispatchOutcome,
  dispatchItemChildArgs,
  extractRoadmapSliceIssues,
  isSyntheticLoopEvidencePipelineRunId,
  pinAdvanceRunIdentity,
  realDispatchItem,
  resolveSelectorIssues,
  syntheticLoopEvidencePipelineRunId,
  type SelectorOpenIssue,
  type SelectorResolveDeps,
} from "../scripts/pipeline.ts";
import { BLOCKED_LABEL } from "../scripts/types.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// classifyDispatchOutcome — the per-item advance's label/state → outcome mapping
// (realDispatchItem). Regression for #616: a real `blocked`-labeled item must map to
// `blocked_needs_human`, never `failed`, so the supervisor holds it instead of
// classifying it as workflow-engine-defect and run_fataling the whole run.
// ---------------------------------------------------------------------------

test("classifyDispatchOutcome: a real 'blocked'-labeled item maps to blocked_needs_human, not failed (#616)", () => {
  // The exact live shape observed in #616: the canonical BLOCKED_LABEL co-present with a stage label.
  assert.equal(BLOCKED_LABEL, "blocked");
  assert.equal(classifyDispatchOutcome({ labels: [BLOCKED_LABEL, "pipeline:fix-2"], state: "open" }), "blocked_needs_human");
  assert.equal(classifyDispatchOutcome({ labels: ["blocked"], state: "open" }), "blocked_needs_human");
});

test("classifyDispatchOutcome: the phantom 'pipeline:blocked' label is NOT a blocker — it falls through to failed (#616)", () => {
  // Pre-fix this site checked `${LABEL_PREFIX}blocked` ("pipeline:blocked"), a label the pipeline
  // never writes. A `pipeline:blocked`-only item must NOT be treated as blocked here.
  assert.equal(classifyDispatchOutcome({ labels: ["pipeline:blocked"], state: "open" }), "failed");
});

test("classifyDispatchOutcome: ready-to-deploy, closed, and generic-failure mappings are unchanged", () => {
  assert.equal(classifyDispatchOutcome({ labels: ["pipeline:ready-to-deploy"], state: "open" }), "ready_to_deploy");
  assert.equal(classifyDispatchOutcome({ labels: ["pipeline:fix-1"], state: "closed" }), "abandoned");
  assert.equal(classifyDispatchOutcome({ labels: ["pipeline:review-1"], state: "open" }), "failed");
  // ready-to-deploy wins over a co-present blocked label (checked first).
  assert.equal(classifyDispatchOutcome({ labels: ["pipeline:ready-to-deploy", "blocked"], state: "open" }), "ready_to_deploy");
});

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

test("dispatchItemChildArgs includes pinned --run-id when provided (#667)", () => {
  const args = dispatchItemChildArgs("/path/to/pipeline.ts", 623, "codex", "/repo", {
    runId: "623-2026-07-29T13-49-56-421Z",
  });
  assert.ok(!args.includes("--once"), "child argv must not contain --once");
  const runIdIdx = args.indexOf("--run-id");
  assert.ok(runIdIdx >= 0, "must pass --run-id when pinned");
  assert.equal(args[runIdIdx + 1], "623-2026-07-29T13-49-56-421Z");
});

// ---------------------------------------------------------------------------
// Advance run-store pin + evidence pointer (#667).
// ---------------------------------------------------------------------------

test("pinAdvanceRunIdentity computes real run-store basename and absolute events path", () => {
  const pin = pinAdvanceRunIdentity("/repo/root", 623, new Date("2026-07-29T13:49:56.421Z"));
  assert.equal(pin.pipeline_run_id, "623-2026-07-29T13-49-56-421Z");
  assert.ok(pin.run_dir.endsWith("/.agent-pipeline/runs/623-2026-07-29T13-49-56-421Z"));
  assert.equal(pin.events_path, `${pin.run_dir}/events.jsonl`);
  assert.ok(!isSyntheticLoopEvidencePipelineRunId(pin.pipeline_run_id));
});

test("buildLoopEvidencePointer uses real store id when pin exists — not synthetic-only (#667)", () => {
  const pin = pinAdvanceRunIdentity("/repo", 623, new Date("2026-07-29T13:49:56.421Z"));
  const evidence = buildLoopEvidencePointer({
    pr_number: 42,
    item_id: "623",
    loop_run_id: "loop-run-1",
    pin,
  });
  assert.equal(evidence.pipeline_run_id, pin.pipeline_run_id);
  assert.equal(evidence.events_path, pin.events_path);
  assert.ok(!isSyntheticLoopEvidencePipelineRunId(evidence.pipeline_run_id));
  assert.notEqual(evidence.pipeline_run_id, syntheticLoopEvidencePipelineRunId("loop-run-1", "623"));
});

test("buildLoopEvidencePointer falls back to synthetic only when no pin (#667)", () => {
  const evidence = buildLoopEvidencePointer({
    pr_number: null,
    item_id: "623",
    loop_run_id: "loop-run-1",
    pin: null,
  });
  assert.equal(evidence.pipeline_run_id, "pipeline-loop-loop-run-1-623");
  assert.equal(evidence.events_path, undefined);
  assert.ok(isSyntheticLoopEvidencePipelineRunId(evidence.pipeline_run_id));
});

test("buildStartLinkagePayload and buildTerminalLinkagePayload carry matching ids + outcome", () => {
  const pin = pinAdvanceRunIdentity("/repo", 623, new Date("2026-07-29T13:49:56.421Z"));
  const start = buildStartLinkagePayload("623", pin);
  assert.deepEqual(start, {
    item_id: "623",
    pipeline_run_id: pin.pipeline_run_id,
    events: pin.events_path,
  });
  const terminal = buildTerminalLinkagePayload("623", "ready_to_deploy", {
    pin,
    loop_run_id: "loop-run-1",
  });
  assert.equal(terminal.item_id, "623");
  assert.equal(terminal.pipeline_run_id, pin.pipeline_run_id);
  assert.equal(terminal.events, pin.events_path);
  assert.equal(terminal.outcome, "ready_to_deploy");
});

test("buildTerminalLinkagePayload without pin omits events and uses synthetic id", () => {
  const terminal = buildTerminalLinkagePayload("623", "failed", {
    pin: null,
    loop_run_id: "loop-run-1",
  });
  assert.equal(terminal.pipeline_run_id, "pipeline-loop-loop-run-1-623");
  assert.equal(terminal.events, undefined);
  assert.equal(terminal.outcome, "failed");
});

// ---------------------------------------------------------------------------
// realDispatchItem with injected spawn/gh seams (#667).
// ---------------------------------------------------------------------------

function fakeSpawnChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  queueMicrotask(() => ee.emit("exit", 0, null));
  return ee;
}

test("realDispatchItem pins --run-id, fires start linkage, returns truthful evidence (#667)", async () => {
  const spawned: { cmd: string; args: string[] }[] = [];
  const linked: { item_id: string; pipeline_run_id: string; events: string }[] = [];
  const fixedNow = new Date("2026-07-29T13:49:56.421Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 623, fixedNow);

  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      spawn: ((cmd: string, args: readonly string[]) => {
        spawned.push({ cmd, args: [...args] });
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () => ({ labels: ["pipeline:ready-to-deploy"], state: "open" }) as never,
      getPrForIssue: async () => 99,
    },
  );

  const response = await dispatch(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "623",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-xyz",
    },
    {
      onAdvanceLinked: async (linkage) => {
        linked.push(linkage);
      },
    },
  );

  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes("--run-id"));
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--run-id") + 1], expectedPin.pipeline_run_id);
  assert.ok(!spawned[0].args.includes("--once"));

  assert.equal(linked.length, 1);
  assert.equal(linked[0].item_id, "623");
  assert.equal(linked[0].pipeline_run_id, expectedPin.pipeline_run_id);
  assert.equal(linked[0].events, expectedPin.events_path);

  assert.equal(response.outcome, "ready_to_deploy");
  assert.equal(response.evidence.pipeline_run_id, expectedPin.pipeline_run_id);
  assert.equal(response.evidence.events_path, expectedPin.events_path);
  assert.equal(response.evidence.pr_number, 99);
  // Regression that bites synthetic-only evidence without the fix:
  assert.notEqual(
    response.evidence.pipeline_run_id,
    syntheticLoopEvidencePipelineRunId("loop-run-xyz", "623"),
    "evidence.pipeline_run_id must be the real store id when a pin exists, not pipeline-loop-…",
  );
  assert.ok(!isSyntheticLoopEvidencePipelineRunId(response.evidence.pipeline_run_id));
});

test("realDispatchItem spawn failure keeps pin id but omits live events_path (#667)", async () => {
  const fixedNow = new Date("2026-07-29T13:49:56.421Z");
  const expectedPin = pinAdvanceRunIdentity("/repo", 623, fixedNow);
  const linked: unknown[] = [];
  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      now: () => fixedNow,
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      spawn: (() => {
        const ee = new EventEmitter() as ChildProcess;
        queueMicrotask(() => ee.emit("error", new Error("spawn ENOENT")));
        return ee;
      }) as typeof import("node:child_process").spawn,
    },
  );
  const response = await dispatch(
    {
      schema: "pipeline/loop-execution@1",
      item_id: "623",
      repo: { name: "acme/w", base_branch: "main" },
      engine: "claude",
      worktree_policy: "default",
      done_definition: "pipeline:ready-to-deploy",
      run_id: "loop-run-xyz",
    },
    {
      onAdvanceLinked: async (linkage) => {
        linked.push(linkage);
      },
    },
  );
  assert.equal(response.outcome, "failed");
  // Intended pin id is useful for traceability; must not advertise a live stream.
  assert.equal(response.evidence.pipeline_run_id, expectedPin.pipeline_run_id);
  assert.equal(response.evidence.events_path, undefined);
  assert.equal(linked.length, 0, "must not publish start linkage that presents a non-existent path as live");
});

test("buildLoopEvidencePointer omits events_path when events_path_known is false (#667)", () => {
  const pin = pinAdvanceRunIdentity("/repo", 623, new Date("2026-07-29T13:49:56.421Z"));
  const evidence = buildLoopEvidencePointer({
    pr_number: null,
    item_id: "623",
    loop_run_id: "loop-run-1",
    pin,
    events_path_known: false,
  });
  assert.equal(evidence.pipeline_run_id, pin.pipeline_run_id);
  assert.equal(evidence.events_path, undefined);
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
