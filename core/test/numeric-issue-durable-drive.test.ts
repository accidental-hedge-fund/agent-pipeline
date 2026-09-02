// Lifecycle-parity contract for mutating `pipeline <N>` (#1327).
// Hermetic: injected fakes only. No network, git, or subprocess except
// spawnSync of the CLI for detach-rejection (exit 2 before config/gh).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import {
  consumeOwnedOperation,
  memoryObservationSink,
  reportMechanicalFault,
} from "../scripts/operation-observation.ts";
import {
  admitMutatingNumericDrive,
  dispatchItemChildArgs,
  handleRunSubcommand,
  pickOneItemChildAdvanceInputs,
  pinAdvanceRunIdentity,
  realDispatchItem,
  runSingleIssueCommand,
  toAdvanceOpts,
  type CliOpts,
  type RunLoopEngineInput,
  type RunSubcommandDeps,
  type SingleIssueCommandDeps,
} from "../scripts/pipeline.ts";
import type { AdvanceOpts } from "../scripts/pipeline-run.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PIPELINE_SRC = readFileSync(join(here, "../scripts/pipeline.ts"), "utf8");
const RECOVER_PARKED_SRC = readFileSync(join(here, "../scripts/recover-parked.ts"), "utf8");
const HOST_SKILL_SRC = readFileSync(join(here, "../scripts/host-skill.ts"), "utf8");
const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

function cfg(): PipelineConfig {
  return {
    ...DEFAULT_CONFIG,
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
    domain: "test",
  };
}

function driveResult(runId = "loop-numeric") {
  return {
    kind: "drive" as const,
    result: {
      runId,
      cycles: 1,
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

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `missing export async function ${name}`);
  const from = source.slice(start);
  const headerEnd = from.indexOf("):");
  const brace = from.indexOf("{", headerEnd >= 0 ? headerEnd : 0);
  assert.ok(brace >= 0, `${name} missing body`);
  let depth = 0;
  for (let i = brace; i < from.length; i++) {
    const ch = from[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return from.slice(0, i + 1);
    }
  }
  return from;
}

function numericTail(source: string): string {
  const start = source.indexOf("await runOverride(cfg, issueNumber, opts.override, opts, undefined, number);");
  assert.ok(start >= 0, "missing numeric --override dispatch");
  const end = source.indexOf("// Cleanup mode", start);
  assert.ok(end > start, "missing cleanup-mode marker after numeric tail");
  return source.slice(start, end);
}

function fakeSpawnChild(): ChildProcess {
  const ee = new EventEmitter() as ChildProcess;
  queueMicrotask(() => ee.emit("exit", 0, null));
  return ee;
}

// ---------------------------------------------------------------------------
// 1.1 / 2.2 numeric/single parity
// ---------------------------------------------------------------------------

test("mutating pipeline <N> and pipeline single <N> attach to the same one-item durable run", async () => {
  const seen: RunLoopEngineInput[] = [];
  const handoffs: string[] = [];
  const engine = async (received: RunLoopEngineInput) => {
    seen.push(received);
    await received.onRunReady?.({
      runId: "loop-shared",
      runDir: "/state/loop-shared",
      events: "/state/loop-shared/events.jsonl",
      engine: "claude",
      selector: received.selector ?? null,
      resumed: false,
    });
    return driveResult("loop-shared");
  };
  const singleDeps: SingleIssueCommandDeps = {
    resolveConfig: () => cfg(),
    resolveIssueNumber: async (_c, n) => n,
    runLoopEngine: engine,
    writeStdoutLine: (line) => {
      handoffs.push(line);
    },
  };
  const originalError = console.error;
  const originalLog = console.log;
  const priorExit = process.exitCode;
  console.error = () => {};
  console.log = () => {};
  process.exitCode = undefined;
  try {
    await runSingleIssueCommand("42", { profile: "claude" }, singleDeps);
    await admitMutatingNumericDrive(cfg(), 42, { profile: "claude" }, {
      isNestedAdvanceChild: () => false,
      runNestedWholeItemAdvance: async () => {
        throw new Error("public numeric must not call nested adapter");
      },
      runSingleIssue: (raw, opts) => runSingleIssueCommand(raw, opts, singleDeps),
    });
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0]!.selector, { type: "work-list", value: ["42"] });
    assert.deepEqual(seen[1]!.selector, seen[0]!.selector);
    assert.equal(seen[0]!.autoSupersedeTerminal, true);
    assert.equal(seen[1]!.autoSupersedeTerminal, true);
    assert.equal(handoffs.length, 2);
    assert.equal(JSON.parse(handoffs[0]!).kind, "loop_run_handoff");
    assert.equal(JSON.parse(handoffs[1]!).kind, "loop_run_handoff");
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = priorExit;
  }
});

test("public numeric tail does not call runAdvance as the top-level lifecycle owner", () => {
  const tail = numericTail(PIPELINE_SRC);
  assert.match(tail, /admitMutatingNumericDrive/);
  assert.doesNotMatch(tail, /await runAdvance\(/);
  assert.doesNotMatch(tail, /formatAdvanceRunHandoff|flushAdvanceRunHandoff|ADVANCE_RUN_HANDOFF/);
});

test("nested admission returns before runSingleIssueCommand", () => {
  const body = extractFunction(PIPELINE_SRC, "admitMutatingNumericDrive");
  const nestedAt = body.indexOf("isNestedAdvanceChild");
  const singleAt = body.indexOf("runSingleIssue");
  assert.ok(nestedAt >= 0 && singleAt > nestedAt);
  assert.match(body, /if \(deps\.isNestedAdvanceChild\(\)\)/);
  assert.match(body, /return;/);
});

// ---------------------------------------------------------------------------
// 1.2 / 1.7 / 2.1 nested adapter
// ---------------------------------------------------------------------------

test("nested PIPELINE_NESTED_ADVANCE children call runNestedWholeItemAdvance and not runSingleIssueCommand", async () => {
  let nested = 0;
  let single = 0;
  let nestedOpts: AdvanceOpts | undefined;
  await admitMutatingNumericDrive(cfg(), 99, { once: true, dryRun: true }, {
    isNestedAdvanceChild: () => true,
    runSingleIssue: async () => {
      single += 1;
      return { exitCode: 0 };
    },
    runNestedWholeItemAdvance: async (_cfg, issue, opts) => {
      nested += 1;
      assert.equal(issue, 99);
      nestedOpts = opts;
    },
  });
  assert.equal(nested, 1);
  assert.equal(single, 0);
  assert.equal(nestedOpts?.once, true);
  assert.equal(nestedOpts?.dryRun, true);
});

test("runNestedWholeItemAdvance never constructs argv or calls runSingleIssueCommand", () => {
  const body = extractFunction(PIPELINE_SRC, "runNestedWholeItemAdvance");
  assert.match(body, /emitAdvanceHandoff: false/);
  assert.match(body, /runAdvance\(/);
  assert.doesNotMatch(body, /runSingleIssueCommand/);
  assert.doesNotMatch(body, /buildCmd|process\.argv|admitMutatingNumericDrive/);
  assert.doesNotMatch(body, /\["pipeline"/);
});

test("a fixture that re-enters public numeric aliasing from the nested adapter fails the source contract", () => {
  const body = extractFunction(PIPELINE_SRC, "runNestedWholeItemAdvance");
  assert.doesNotMatch(body, /admitMutatingNumericDrive|runSingleIssueCommand/);
});

test("nested child does not emit loop_run_handoff or mint a second supervisor", async () => {
  const body = extractFunction(PIPELINE_SRC, "runNestedWholeItemAdvance");
  assert.doesNotMatch(body, /formatLoopRunHandoff|runLoopEngine|runSingleIssueCommand/);
  const lines: string[] = [];
  await admitMutatingNumericDrive(cfg(), 8, {}, {
    isNestedAdvanceChild: () => true,
    runSingleIssue: async () => {
      throw new Error("nested must not mint a second supervisor");
    },
    runNestedWholeItemAdvance: async () => {
      lines.push("nested");
    },
  });
  assert.deepEqual(lines, ["nested"]);
});

// ---------------------------------------------------------------------------
// 1.3 / 4.1 public numeric handoff
// ---------------------------------------------------------------------------

test("public mutating numeric drive emits one loop_run_handoff and no top-level advance_run_handoff", async () => {
  const lines: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  const priorExit = process.exitCode;
  console.error = () => {};
  console.log = () => {};
  process.exitCode = undefined;
  try {
    await admitMutatingNumericDrive(cfg(), 42, { profile: "claude" }, {
      isNestedAdvanceChild: () => false,
      runNestedWholeItemAdvance: async () => {
        throw new Error("public numeric must not nested-advance");
      },
      runSingleIssue: (raw, opts) =>
        runSingleIssueCommand(raw, opts, {
          resolveConfig: () => cfg(),
          resolveIssueNumber: async (_c, n) => n,
          runLoopEngine: async (received) => {
            await received.onRunReady?.({
              runId: "loop-n",
              runDir: "/state/loop-n",
              events: "/state/loop-n/events.jsonl",
              engine: "claude",
              selector: received.selector ?? null,
              resumed: false,
            });
            return driveResult("loop-n");
          },
          writeStdoutLine: (line) => {
            lines.push(line);
          },
        }),
    });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { kind: string; run_id: string };
    assert.equal(parsed.kind, "loop_run_handoff");
    assert.equal(parsed.run_id, "loop-n");
    assert.equal(lines.filter((l) => JSON.parse(l).kind === "advance_run_handoff").length, 0);
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = priorExit;
  }
});

// ---------------------------------------------------------------------------
// 1.4 host SKILL
// ---------------------------------------------------------------------------

test("generated SKILL prose treats pipeline <N> as the durable one-item drive", () => {
  assert.match(HOST_SKILL_SRC, /`pipeline <N>` yields `loop_run_id`/);
  assert.match(HOST_SKILL_SRC, /Launch default drive: `pipeline <N>` or `pipeline single <N>`/);
  assert.doesNotMatch(HOST_SKILL_SRC, /starts a direct\nadvance/);
  assert.doesNotMatch(HOST_SKILL_SRC, /Direct numeric launch: `pipeline <N>`/);
  assert.doesNotMatch(HOST_SKILL_SRC, /Retain `advance_run_id` from the\n   `advance_run_handoff`/);
  assert.doesNotMatch(HOST_SKILL_SRC, /runNestedWholeItemAdvance|PIPELINE_NESTED_ADVANCE/);
});

// ---------------------------------------------------------------------------
// 1.5 mode selectors dispatch before aliasing
// ---------------------------------------------------------------------------

test("status, summary, unblock, override, and remove-worktree dispatch before numeric aliasing", () => {
  const aliasAt = PIPELINE_SRC.indexOf("await admitMutatingNumericDrive(cfg, issueNumber, opts);");
  assert.ok(aliasAt > 0);
  for (const needle of [
    "if (opts.summary)",
    "if (opts.status)",
    "if (opts.removeWorktree)",
    "if (opts.unblock !== undefined)",
    "if (opts.override !== undefined)",
  ]) {
    const at = PIPELINE_SRC.lastIndexOf(needle, aliasAt);
    assert.ok(at >= 0 && at < aliasAt, `${needle} must dispatch before admitMutatingNumericDrive`);
  }
  const cleanupAt = PIPELINE_SRC.lastIndexOf("opts.cleanup && isNumericOrAbsent", aliasAt);
  const initAt = PIPELINE_SRC.lastIndexOf("opts.init && isNumericOrAbsent", aliasAt);
  assert.ok(cleanupAt >= 0 && cleanupAt < aliasAt);
  assert.ok(initAt >= 0 && initAt < aliasAt);
});

// ---------------------------------------------------------------------------
// 1.6 hidden pipeline run <N>
// ---------------------------------------------------------------------------

test("hidden pipeline run <N> without --detach aliases to runSingleIssueCommand", async () => {
  let called: string | undefined;
  const deps: RunSubcommandDeps = {
    spawnDetached: async () => {
      throw new Error("must not detach");
    },
    findGitRoot: () => "/repo",
    cwd: () => "/repo",
    runSingleIssue: async (raw) => {
      called = raw;
      return { exitCode: 0 };
    },
  };
  const origExit = process.exitCode;
  process.exitCode = undefined;
  try {
    await handleRunSubcommand("42", { profile: "codex" } as CliOpts, deps);
    assert.equal(called, "42");
  } finally {
    process.exitCode = origExit;
  }
});

test("handleRunSubcommand non-detach source does not call runAdvance as owner", () => {
  const body = extractFunction(PIPELINE_SRC, "handleRunSubcommand");
  assert.match(body, /runSingleIssue/);
  assert.doesNotMatch(body, /await runAdvance\(/);
});

// ---------------------------------------------------------------------------
// 1.8 detach rejection lists
// ---------------------------------------------------------------------------

function rejectDetach(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, ...args],
    { encoding: "utf8" },
  );
  return { status: r.status, stderr: r.stderr };
}

test("run --detach rejects status, summary, unblock, override, cleanup, and init", () => {
  for (const flag of ["--status", "--summary", "--cleanup", "--init"]) {
    const r = rejectDetach(["run", "42", flag, "--detach"]);
    assert.equal(r.status, 2, `${flag} status`);
    assert.match(r.stderr, /--detach cannot be combined/);
  }
  const unblock = rejectDetach(["run", "42", "--unblock", "ok", "--detach"]);
  assert.equal(unblock.status, 2);
  assert.match(unblock.stderr, /--detach cannot be combined/);
  const override = rejectDetach(["run", "42", "--override", "k: r", "--detach"]);
  assert.equal(override.status, 2);
  assert.match(override.stderr, /--detach cannot be combined/);
});

test("numeric --detach rejects status, summary, unblock, override, and extra positionals", () => {
  for (const flag of ["--status", "--summary"]) {
    const r = rejectDetach(["42", flag, "--detach"]);
    assert.equal(r.status, 2, `${flag} status`);
    assert.match(r.stderr, /--detach cannot be combined/);
  }
  const extra = rejectDetach(["42", "config", "validate", "--detach"]);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /unexpected argument/i);
  const unblock = rejectDetach(["42", "--unblock", "ok", "--detach"]);
  assert.equal(unblock.status, 2);
  assert.match(unblock.stderr, /--detach cannot be combined/);
  const override = rejectDetach(["42", "--override", "k: r", "--detach"]);
  assert.equal(override.status, 2);
  assert.match(override.stderr, /--detach cannot be combined/);
});

test("--remove-worktree --detach still rejects", () => {
  const r = rejectDetach(["42", "--remove-worktree", "--detach"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--detach/);
});

// ---------------------------------------------------------------------------
// 2.4 recover-parked / override stay on runAdvance
// ---------------------------------------------------------------------------

test("recover-parked re-entry and override resume stay on in-process runAdvance", () => {
  assert.match(PIPELINE_SRC, /await deps\.runAdvance\(cfg, issueNumber, toAdvanceOpts\(opts\)\)/);
  assert.match(PIPELINE_SRC, /runAdvance: runAdvanceForRecover/);
  assert.match(RECOVER_PARKED_SRC, /await deps\.runAdvance\(/);
  assert.match(RECOVER_PARKED_SRC, /emitAdvanceHandoff: false/);
  assert.doesNotMatch(RECOVER_PARKED_SRC, /runSingleIssueCommand|admitMutatingNumericDrive/);
  const overrideFn = extractFunction(PIPELINE_SRC, "runOverride");
  assert.doesNotMatch(overrideFn, /runSingleIssueCommand|admitMutatingNumericDrive/);
});

// ---------------------------------------------------------------------------
// 3.1 / 3.2 child inputs
// ---------------------------------------------------------------------------

test("pipeline <N> --once still enters the supervisor and forwards once as a child input", async () => {
  let input: RunLoopEngineInput | undefined;
  const originalError = console.error;
  const originalLog = console.log;
  const priorExit = process.exitCode;
  console.error = () => {};
  console.log = () => {};
  process.exitCode = undefined;
  try {
    await admitMutatingNumericDrive(cfg(), 42, { once: true, profile: "claude" }, {
      isNestedAdvanceChild: () => false,
      runNestedWholeItemAdvance: async () => {
        throw new Error("--once must not select top-level runAdvance");
      },
      runSingleIssue: (raw, opts) =>
        runSingleIssueCommand(raw, opts, {
          resolveConfig: () => cfg(),
          resolveIssueNumber: async (_c, n) => n,
          runLoopEngine: async (received) => {
            input = received;
            return driveResult();
          },
          writeStdoutLine: () => {},
        }),
    });
    assert.equal(input?.childAdvance?.once, true);
    assert.deepEqual(input?.selector, { type: "work-list", value: ["42"] });
  } finally {
    console.error = originalError;
    console.log = originalLog;
    process.exitCode = priorExit;
  }
});

test("dispatchItemChildArgs omits --once unless one-item childAdvance.once is set", () => {
  const multi = dispatchItemChildArgs("/path/to/pipeline.ts", 100, "claude", "/repo");
  assert.ok(!multi.includes("--once"));
  const oneItem = dispatchItemChildArgs("/path/to/pipeline.ts", 100, "claude", "/repo", {
    once: true,
    dryRun: true,
    model: "m",
    jsonEvents: true,
    candidateShaOverride: "a".repeat(40),
  });
  assert.ok(oneItem.includes("--once"));
  assert.ok(oneItem.includes("--dry-run"));
  assert.ok(oneItem.includes("--model"));
  assert.ok(oneItem.includes("--json-events"));
  assert.ok(oneItem.includes("--sha"));
});

test("toAdvanceOpts and pickOneItemChildAdvanceInputs forward engineTrack and sha", () => {
  const mapped = toAdvanceOpts({
    dryRun: true,
    model: "m",
    once: true,
    jsonEvents: true,
    profile: "codex",
    runId: "pin-1",
    engineTrack: "candidate",
    sha: "b".repeat(40),
  });
  const child = pickOneItemChildAdvanceInputs(mapped);
  assert.equal(child.engineTrack, "candidate");
  assert.equal(child.runId, "pin-1");
  assert.equal(child.candidateShaOverride, "b".repeat(40));
  assert.equal(child.once, true);
  assert.equal("override" in child, false);
});

test("realDispatchItem uses childAdvance.runId as the nested pin", async () => {
  const spawned: string[][] = [];
  const pinId = "42-operator-pin";
  const dispatch = realDispatchItem(
    { repo_dir: "/repo" } as PipelineConfig,
    "claude",
    {
      childAdvance: { runId: pinId, once: true },
      scriptPath: "/path/to/pipeline.ts",
      execPath: "/usr/bin/node",
      eventsPathExists: () => true,
      spawn: ((_cmd: string, args: readonly string[]) => {
        spawned.push([...args]);
        return fakeSpawnChild();
      }) as typeof import("node:child_process").spawn,
      getIssueDetail: async () => ({ labels: ["pipeline:ready-to-deploy"], state: "open" }) as never,
      getPrForIssue: async () => 1,
    },
  );
  await dispatch({
    schema: "pipeline/loop-execution@1",
    item_id: "42",
    repo: { name: "acme/w", base_branch: "main" },
    engine: "claude",
    worktree_policy: "default",
    done_definition: "pipeline:ready-to-deploy",
    run_id: "loop-run",
  });
  assert.equal(spawned.length, 1);
  const idx = spawned[0]!.indexOf("--run-id");
  assert.ok(idx >= 0);
  assert.equal(spawned[0]![idx + 1], pinId);
  assert.ok(spawned[0]!.includes("--once"));
  const minted = pinAdvanceRunIdentity("/repo", 42, new Date("2026-07-29T13:49:56.421Z"));
  assert.notEqual(pinId, minted.pipeline_run_id);
});

// ---------------------------------------------------------------------------
// 3.3 detach inner argv is public numeric (one-item supervisor)
// ---------------------------------------------------------------------------

test("pipeline <N> --detach forwards child options and engine-track; does not rewrite to single", async () => {
  let captured: string[] = [];
  const errors: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (msg: string) => {
    errors.push(String(msg));
  };
  console.log = () => {};
  try {
    await handleRunSubcommand(
      "99",
      {
        detach: true,
        once: true,
        dryRun: true,
        engineTrack: "candidate",
        model: "m",
      } as CliOpts,
      {
        spawnDetached: async (_issue, pipelineArgs) => {
          captured = pipelineArgs;
          return { runDir: "/tmp/fake-run", pid: 1 };
        },
        findGitRoot: () => "/repo",
        cwd: () => "/repo",
      },
    );
    assert.ok(captured.includes("--once"));
    assert.ok(captured.includes("--dry-run"));
    assert.ok(captured.includes("--engine-track"));
    const trackIdx = captured.indexOf("--engine-track");
    assert.equal(captured[trackIdx + 1], "candidate");
    assert.ok(captured.includes("--run-id"));
    assert.ok(!captured.includes("single"));
    assert.ok(!captured.includes("PIPELINE_NESTED_ADVANCE"));
    assert.ok(errors.some((e) => e.includes("loop_run_handoff")));
    assert.ok(errors.some((e) => e.includes("nested advance pin")));
    assert.ok(!errors.some((e) => /follow with: pipeline logs /.test(e)));
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

// ---------------------------------------------------------------------------
// 3.4 mechanical ownership + never merge
// ---------------------------------------------------------------------------

test("mechanical fault through mutating numeric drive stays RecoverySupervisor-owned", async () => {
  const sink = memoryObservationSink();
  await admitMutatingNumericDrive(cfg(), 42, {}, {
    isNestedAdvanceChild: () => false,
    runNestedWholeItemAdvance: async () => {
      throw new Error("must not nested");
    },
    runSingleIssue: async () => {
      reportMechanicalFault(sink.reportObservation, {
        operation: "numeric_issue_drive",
        form_id: "advance",
        message: "timeout",
        fault: "mechanical",
        domain: "test",
        logical_operation_id: "lop-numeric-mech",
        issue: 42,
        repository: "owner/repo",
      });
      return { exitCode: 1, engineMessage: "timeout" };
    },
  });
  assert.equal(sink.observations.length, 1);
  const obs = sink.observations[0]!;
  assert.equal(obs.owned, true);
  assert.equal(obs.complete, false);
  assert.equal(obs.cancelled, false);
  assert.equal(obs.human_owned, false);
  const consumed = consumeOwnedOperation({ ...obs, observation_id: "x", recorded_at: "t" });
  assert.equal(consumed.owned, true);
});

test("numeric, single, and loop still never merge", () => {
  const singleFn = extractFunction(PIPELINE_SRC, "runSingleIssueCommand");
  const admitFn = extractFunction(PIPELINE_SRC, "admitMutatingNumericDrive");
  const nestedFn = extractFunction(PIPELINE_SRC, "runNestedWholeItemAdvance");
  const loopFn = extractFunction(PIPELINE_SRC, "runLoopCommand");
  for (const [name, body] of [
    ["single", singleFn],
    ["admit", admitFn],
    ["nested", nestedFn],
    ["loop", loopFn],
  ] as const) {
    assert.doesNotMatch(body, /mergePr|merge-queue --apply|train --merge/, name);
  }
});

// ---------------------------------------------------------------------------
// 5.3 no public internal-advance verb / second scheduler
// ---------------------------------------------------------------------------

test("COMMAND_REGISTRY has no internal-advance, supervise, grant, or merge-stage keyword", () => {
  const keys = Object.keys(COMMAND_REGISTRY);
  for (const banned of ["internal-advance", "supervise", "grant", "auto_merge", "merge-stage"]) {
    assert.equal(keys.includes(banned), false, banned);
  }
  assert.ok(keys.includes("advance"));
  assert.ok(keys.includes("single"));
  assert.ok(keys.includes("loop"));
  assert.ok(keys.includes("run"));
});
