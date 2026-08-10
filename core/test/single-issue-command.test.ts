import assert from "node:assert/strict";
import test from "node:test";
import {
  runSingleIssueCommand,
  type RunLoopEngineInput,
  type SingleIssueCommandDeps,
} from "../scripts/pipeline.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

function cfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  };
}

function driveResult(runId = "loop-single") {
  return {
    kind: "drive" as const,
    result: {
      runId,
      cycles: 3,
      stop: null,
      holdOutstanding: false,
      allDone: true,
      resumed: false,
      heldItemIds: [],
      dispatched: 1,
      excludedItemIds: [],
      exclusionReason: null,
      completion: "all_items_done" as const,
    },
  };
}

test("single issue command routes the resolved issue through the durable one-item controller", async () => {
  let input: RunLoopEngineInput | undefined;
  const handoffs: string[] = [];
  const output: string[] = [];
  const deps: SingleIssueCommandDeps = {
    resolveConfig: () => cfg(),
    resolveIssueNumber: async (_cfg, number) => {
      assert.equal(number, 42);
      return 99;
    },
    runLoopEngine: async (received) => {
      input = received;
      await received.onRunReady?.({
        runId: "loop-single",
        runDir: "/state/loop-single",
        events: "/state/loop-single/events.jsonl",
        engine: "claude",
        selector: received.selector ?? null,
        resumed: false,
      });
      return driveResult();
    },
    writeStdoutLine: (line) => {
      handoffs.push(line);
    },
  };
  const originalLog = console.log;
  const originalError = console.error;
  const priorExitCode = process.exitCode;
  console.log = (line) => output.push(String(line));
  console.error = () => {};
  process.exitCode = undefined;
  try {
    await runSingleIssueCommand("42", { profile: "claude" }, deps);
    assert.deepEqual(input?.selector, { type: "work-list", value: ["99"] });
    assert.equal(input?.autoSupersedeTerminal, true);
    assert.equal(input?.audit, false);
    assert.equal(input?.engine, "claude");
    assert.equal(input?.repoDir, "/repo");
    assert.equal(handoffs.length, 1);
    assert.deepEqual(JSON.parse(handoffs[0]!), {
      schema_version: "1",
      kind: "loop_run_handoff",
      run_id: "loop-single",
      run_dir: "/state/loop-single",
      events: "/state/loop-single/events.jsonl",
      engine: "claude",
      selector: { type: "work-list", value: ["99"] },
      resumed: false,
    });
    assert.equal(output.length, 1);
    assert.equal(JSON.parse(output[0]!).run_id, "loop-single");
    assert.equal(process.exitCode, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = priorExitCode;
  }
});

test("nested single issue command can suppress machine stdout for train --json", async () => {
  const handoffs: string[] = [];
  const output: string[] = [];
  let readyCallbackRan = false;
  const deps: SingleIssueCommandDeps = {
    resolveConfig: () => cfg(),
    resolveIssueNumber: async () => 42,
    runLoopEngine: async (received) => {
      await received.onRunReady?.({
        runId: "loop-nested",
        runDir: "/state/loop-nested",
        events: "/state/loop-nested/events.jsonl",
        engine: "codex",
        selector: received.selector ?? null,
        resumed: false,
      });
      readyCallbackRan = true;
      return driveResult("loop-nested");
    },
    writeStdoutLine: (line) => {
      handoffs.push(line);
    },
  };
  const originalLog = console.log;
  const originalError = console.error;
  const priorExitCode = process.exitCode;
  console.log = (line) => output.push(String(line));
  console.error = () => {};
  process.exitCode = undefined;
  try {
    await runSingleIssueCommand("42", { profile: "codex" }, deps, {
      emitMachineOutput: false,
    });
    assert.equal(readyCallbackRan, true, "suppression must not skip the durable-run handoff callback");
    assert.deepEqual(handoffs, [], "nested handoff must not leak to stdout");
    assert.deepEqual(output, [], "nested terminal result must not leak to stdout");
    assert.equal(process.exitCode, 0);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = priorExitCode;
  }
});

test("single issue command rejects an invalid issue before config or GitHub access", async () => {
  let called = false;
  const deps: SingleIssueCommandDeps = {
    resolveConfig: () => {
      called = true;
      return cfg();
    },
    resolveIssueNumber: async () => 1,
    runLoopEngine: async () => driveResult(),
    writeStdoutLine: () => {},
  };
  const originalError = console.error;
  const priorExitCode = process.exitCode;
  console.error = () => {};
  process.exitCode = undefined;
  try {
    await runSingleIssueCommand("42x", { profile: "codex" }, deps);
    assert.equal(called, false);
    assert.equal(process.exitCode, 2);
  } finally {
    console.error = originalError;
    process.exitCode = priorExitCode;
  }
});
