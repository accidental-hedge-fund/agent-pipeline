// Golden CLI parsing tests (#263).
//
// Each test calls buildCmd().parse(synthetic_argv) and then verifies that
// validateFlags returns the expected result — exercising the full
// Commander → command-registry → validateFlags round-trip without any
// network, git, or subprocess calls.
//
// Covers:
//   5.1  Basic valid invocations for each registered command.
//   5.2  Unsupported global flag on a restricted command → validateFlags returns non-empty.
//   5.3  Regression: merge --detach → ["detach"]   (#217).
//   5.4  Regression: intake --status               → ["status"].
//   5.5  Valid: 123 --dry-run --once               → advance entry, [].
//   5.6  Valid: doctor --json                       → doctor entry, [].
//   5.7  Valid: merge --repo-path /tmp             → merge entry, [].

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceIssueThroughSingle,
  buildCmd,
  normalizeShipCliInput,
  resolveHarvestOutPath,
  resolveHarvestFixturesDir,
  selectPersistedShipFailureStatus,
  validateShipAuthorizationPublicKeyFile,
  validateReleaseMachineOutputMode,
  runTrainCommand,
  type CliOpts,
  type TrainCommandDeps,
} from "../scripts/pipeline.ts";
import { lookupCommand, validateFlags, COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";
import {
  ADVANCE_RUN_HANDOFF_KIND,
  flushAdvanceRunHandoff,
  formatAdvanceRunHandoff,
  nestedAdvanceChildEnv,
  shouldEmitAdvanceRunHandoff,
} from "../scripts/advance-handoff.ts";

function memTrainRunStore(): RunStoreDeps {
  const files = new Map<string, string>();
  const appends = new Map<string, string[]>();
  const enoent = (p: string): NodeJS.ErrnoException => {
    const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    e.code = "ENOENT";
    return e;
  };
  return {
    readFile: async (p) => {
      const base = files.get(p) ?? "";
      const parts = appends.get(p) ?? [];
      if (!files.has(p) && parts.length === 0) throw enoent(p);
      return base + parts.join("");
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    appendFile: async (p, data) => {
      if (!appends.has(p)) appends.set(p, []);
      appends.get(p)!.push(data);
    },
    rename: async () => {
      throw new Error("unused");
    },
    mkdir: async () => {},
    readdir: async () => [],
    stat: async (p) => {
      if (!files.has(p) && !appends.has(p)) throw enoent(p);
      return { mtime: new Date(0) };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a fake argv slice and return { opts, numArg } without running main().
 * Prefixes with process.argv[0..1] so Commander is happy.
 */
function parseCli(args: string[]): { opts: CliOpts; numArg: string | undefined; numArg0: string | undefined } {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", ...args]);
  const opts = cmd.opts<CliOpts>();
  const numArg = cmd.args[0];
  return { opts, numArg, numArg0: cmd.args[0] };
}

/**
 * Full round-trip: parse args, look up entry, run validateFlags, return offending keys.
 * Mirrors the effective-command-key logic from pipeline.ts so flag-only modes
 * (--init, --cleanup, --remove-worktree) resolve to their registry entries when
 * numArg is absent or numeric (i.e., no named subcommand is present).
 */
function roundTrip(args: string[]): string[] {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", ...args]);
  const opts = cmd.opts<CliOpts>();
  const numArg = cmd.args[0];
  const isNumericOrAbsent = !numArg || /^\d+$/.test(numArg);
  const effectiveKey: string | undefined =
    (opts.removeWorktree && isNumericOrAbsent) ? "remove-worktree" :
    (opts.cleanup && isNumericOrAbsent)        ? "cleanup" :
    (opts.init && isNumericOrAbsent)           ? "init" :
    numArg;
  const entry = lookupCommand(effectiveKey);
  if (!entry) return [];
  return validateFlags(entry, cmd);
}

// ---------------------------------------------------------------------------
// 5.1  Basic valid invocations — just verify they parse and validateFlags returns []
// ---------------------------------------------------------------------------

test("pipeline-cli: advance — numeric issue, no extra flags → []", () => {
  assert.deepEqual(roundTrip(["42"]), []);
});

test("pipeline-cli: init — --init flag → []", () => {
  assert.deepEqual(roundTrip(["init"]), []);
});

test("pipeline-cli: doctor — no extra flags → []", () => {
  assert.deepEqual(roundTrip(["doctor"]), []);
});

test("pipeline-cli: doctor --harness-smoke → [] (#780)", () => {
  assert.deepEqual(roundTrip(["doctor", "--harness-smoke"]), []);
});

test("pipeline-cli: doctor --harness-smoke is parsed onto opts.harnessSmoke (#780)", () => {
  const { opts } = parseCli(["doctor", "--harness-smoke"]);
  assert.equal(opts.harnessSmoke, true);
});

test("pipeline-cli: release — version argument → []", () => {
  assert.deepEqual(roundTrip(["release", "1.0.0"]), []);
});

test("pipeline-cli: release machine output rejects the multi-section dry-run preview", () => {
  assert.doesNotThrow(() => validateReleaseMachineOutputMode({ json: true }));
  assert.throws(
    () => validateReleaseMachineOutputMode({ json: true, dryRun: true }),
    /cannot be combined/,
  );
});

test("pipeline-cli: intake — no flags → []", () => {
  assert.deepEqual(roundTrip(["intake"]), []);
});

test("pipeline-cli: intake — --description flag → []", () => {
  assert.deepEqual(roundTrip(["intake", "--description", "new feature"]), []);
});

test("pipeline-cli: triage — --stage ready → []", () => {
  assert.deepEqual(roundTrip(["triage", "42", "--stage", "ready"]), []);
});

test("pipeline-cli: sweep — no flags → []", () => {
  assert.deepEqual(roundTrip(["sweep"]), []);
});

test("pipeline-cli: refine-spec — --title and --body → []", () => {
  assert.deepEqual(roundTrip(["refine-spec", "--title", "T", "--body", "B"]), []);
});

test("pipeline-cli: grill — --issue → []", () => {
  assert.deepEqual(roundTrip(["grill", "--issue", "42"]), []);
});

test("pipeline-cli: grill — --milestone --dry-run → []", () => {
  assert.deepEqual(roundTrip(["grill", "--milestone", "v1.40.1", "--dry-run"]), []);
});

test("pipeline-cli: improve — --apply → []", () => {
  assert.deepEqual(roundTrip(["improve", "--apply"]), []);
});

test("pipeline-cli: scoreboard — --json → []", () => {
  assert.deepEqual(roundTrip(["scoreboard", "--json"]), []);
});

test("pipeline-cli: scoreboard — --bucket day --json → [] (#425)", () => {
  assert.deepEqual(roundTrip(["scoreboard", "--bucket", "day", "--json"]), []);
});

test("pipeline-cli: scoreboard — --by harness --json → [] (#437)", () => {
  assert.deepEqual(roundTrip(["scoreboard", "--by", "harness", "--json"]), []);
});

test("pipeline-cli: scoreboard — --by is collected repeatably, not last-wins (#437)", () => {
  const { opts } = parseCli(["scoreboard", "--by", "harness", "--by", "model", "--json"]);
  assert.deepEqual(opts.by, ["harness", "model"]);
});

test("pipeline-cli: scoreboard — --html <path> → [] (#427)", () => {
  assert.deepEqual(roundTrip(["scoreboard", "--html", "/tmp/report.html"]), []);
});

test("pipeline-cli: scoreboard — --html <path> is parsed onto opts.html (#427)", () => {
  const { opts } = parseCli(["scoreboard", "--html", "/tmp/report.html", "--json"]);
  assert.equal(opts.html, "/tmp/report.html");
});

test("pipeline-cli: roadmap — --apply → []", () => {
  assert.deepEqual(roundTrip(["roadmap", "--apply"]), []);
});

test("pipeline-cli: run — run with issue number, all flags accepted → []", () => {
  assert.deepEqual(roundTrip(["run", "42", "--dry-run"]), []);
});

test("pipeline-cli: single — canonical one-item durable drive accepts host and repo coordinates", () => {
  assert.deepEqual(roundTrip(["single", "42", "--profile", "claude", "--repo-path", "/repo"]), []);
});

test("pipeline-cli: single rejects raw advance-only controls", () => {
  assert.deepEqual(roundTrip(["single", "42", "--once", "--dry-run"]), ["once", "dryRun"]);
});

test("pipeline-cli: train — --milestone and --json are allowed (ship playbook)", () => {
  assert.deepEqual(roundTrip(["train", "--milestone", "v1.33.0", "--json"]), []);
});

test("pipeline-cli: train — --issues --merge --json → []", () => {
  assert.deepEqual(roundTrip(["train", "--issues", "870", "--merge", "--json"]), []);
});

test("pipeline-cli: train — --issues --dry-run is allowlisted (#1275)", () => {
  assert.deepEqual(roundTrip(["train", "--issues", "10,11", "--dry-run"]), []);
});

test("pipeline-cli: train --dry-run parses onto opts.dryRun (#1275)", () => {
  const { opts, numArg } = parseCli(["train", "--issues", "10,11", "--dry-run"]);
  assert.equal(numArg, "train");
  assert.equal(opts.dryRun, true);
  assert.equal(opts.issues, "10,11");
});

test("pipeline-cli: train --json parses onto opts.json", () => {
  const { opts, numArg } = parseCli(["train", "--milestone", "v1.0.0", "--json"]);
  assert.equal(numArg, "train");
  assert.equal(opts.json, true);
  assert.equal(opts.milestone, "v1.0.0");
});

test("pipeline-cli: train --json emits one train_status document after two nested issue runs", async () => {
  const { opts, numArg } = parseCli(["train", "--issues", "10,11", "--json"]);
  assert.equal(numArg, "train");

  const ready = new Set<number>();
  const advanced: number[] = [];
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const waveCalls: number[][] = [];
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ready.has(issue) ? ["pipeline:ready-to-deploy"] : ["pipeline:ready"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("the command must replace the base advanceWave seam");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: memTrainRunStore(),
      writeHandoff: () => {},
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    // #1023: one multi-item wave for the frontier (independent peers 10,11).
    async runAdvanceWave(issues, _opts, getIssue) {
      waveCalls.push([...issues]);
      const out = new Map<number, import("../scripts/stages/train.ts").AdvanceOutcome>();
      for (const issue of issues) {
        advanced.push(issue);
        ready.add(issue);
        const snap = await getIssue(issue);
        out.set(issue, {
          ok: true,
          terminal: "ready-to-deploy",
          labels: snap.labels,
        });
      }
      return out;
    },
  };

  const stdout: string[] = [];
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (...args: unknown[]) => {
    stdout.push(`${args.map(String).join(" ")}\n`);
  };
  process.exitCode = undefined;
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.equal(exitCode, 0);
    assert.deepEqual(waveCalls, [[10, 11]], "one advance-wave call for independent frontier");
    assert.deepEqual(advanced, [10, 11], "both ordered issues must advance inside the wave");

    const emitted = stdout.join("");
    const document = JSON.parse(emitted) as { kind?: string; ordered_issues?: number[]; items?: unknown[] };
    assert.equal(document.kind, "train_status");
    assert.deepEqual(document.ordered_issues, [10, 11]);
    assert.equal(document.items?.length, 2);
    assert.doesNotMatch(emitted, /loop_run_handoff|\"kind\":\"drive\"/);
  } finally {
    console.log = originalLog;
    process.exitCode = priorExitCode;
  }
});

test("pipeline-cli: ship accepts exact authorization coordinates", () => {
  assert.deepEqual(
    roundTrip([
      "ship",
      "--milestone", "v1.34.0",
      "--for", "1.34.0",
      "--authorization", "/run/user/1000/ship.json",
      "--json",
    ]),
    [],
  );
});

test("pipeline-cli: ship status is read-only by shape and needs no authorization flag", () => {
  const { opts, numArg } = parseCli([
    "ship", "status", "--milestone", "v1.34.0",
  ]);
  assert.equal(numArg, "ship");
  assert.equal(opts.authorization, undefined);
  assert.equal(opts.milestone, "v1.34.0");
  assert.deepEqual(
    normalizeShipCliInput(["ship", "status"], { milestone: "v1.34.0" }),
    {
      mode: "status",
      milestone: "v1.34.0",
      version: "1.34.0",
      authorizationPath: null,
    },
  );
  assert.deepEqual(roundTrip([
    "ship", "status", "--milestone", "v1.34.0",
  ]), []);
});

test("pipeline-cli: ship rejects unrelated lifecycle flags", () => {
  assert.deepEqual(
    roundTrip([
      "ship",
      "--milestone", "v1.34.0",
      "--for", "1.34.0",
      "--authorization", "/run/user/1000/ship.json",
      "--json-events",
    ]),
    ["jsonEvents"],
  );
});

test("pipeline-cli: ship input derives version from milestone and does not require a grant", () => {
  assert.throws(
    () => normalizeShipCliInput(["ship"], {
      milestone: "v1.34.0",
      for: "1.34.0",
      authorization: "relative.json",
      json: true,
    }),
    /absolute path/,
  );
  assert.deepEqual(
    normalizeShipCliInput(["ship"], {
      milestone: "v1.34.0",
      json: false,
    }),
    {
      mode: "run",
      milestone: "v1.34.0",
      version: "1.34.0",
      authorizationPath: null,
    },
  );
  assert.deepEqual(
    normalizeShipCliInput(["ship"], {
      milestone: "v1.34.0",
      for: "v1.34.0",
      authorization: "/run/user/1000/ship.json",
      json: true,
    }),
    {
      mode: "run",
      milestone: "v1.34.0",
      version: "1.34.0",
      authorizationPath: "/run/user/1000/ship.json",
    },
  );
  assert.throws(
    () => normalizeShipCliInput(["ship"], {
      milestone: "not-a-semver",
      json: false,
    }),
    /not a semantic version/,
  );
});

test("pipeline-cli: ship status rejects authorization and unstable positionals", () => {
  assert.throws(
    () => normalizeShipCliInput(["ship", "status"], {
      milestone: "v1.34.0",
      for: "1.34.0",
      authorization: "/run/user/1000/ship.json",
      json: true,
    }),
    /does not accept --authorization/,
  );
  assert.throws(
    () => normalizeShipCliInput(["ship", "latest"], {
      milestone: "v1.34.0",
      for: "1.34.0",
      json: true,
    }),
    /expected 'status'/,
  );
});

test("pipeline-cli: nested single failure restores the owning command exit state", async () => {
  const original = process.exitCode;
  process.exitCode = 17;
  try {
    const result = await advanceIssueThroughSingle(
      42,
      { json: true },
      async () => ({ number: 42, title: "", body: "", labels: [], state: "open" }),
      async () => {
        process.exitCode = 1;
        throw new Error("nested failure");
      },
    );
    assert.deepEqual(result, { ok: false, error: "nested failure" });
    assert.equal(process.exitCode, 17);
  } finally {
    process.exitCode = original;
  }
});

test("advanceIssueThroughSingle (#1074): injects loop evidence for non-zero single", async () => {
  const original = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await advanceIssueThroughSingle(
      1010,
      { json: true },
      async () => ({
        number: 1010,
        title: "",
        body: "",
        labels: ["pipeline:implementing"],
        state: "open",
      }),
      async () => {
        process.exitCode = 1;
      },
      { stopReason: "supervisor_no_progress", exitCode: 1 },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /supervisor_no_progress/);
      assert.match(result.error, /1010/);
      assert.doesNotMatch(
        result.error,
        /^(?:advance failed for #\d+: )?pipeline (?:single|advance) exited with code 1$/,
      );
    }
  } finally {
    process.exitCode = original;
  }
});

test("advanceIssueThroughSingle (#1074): evidence reader used after single non-zero", async () => {
  const original = process.exitCode;
  process.exitCode = 0;
  try {
    const result = await advanceIssueThroughSingle(
      55,
      { json: true },
      async () => ({
        number: 55,
        title: "",
        body: "",
        labels: ["pipeline:fix"],
        state: "open",
      }),
      async () => {
        process.exitCode = 1;
      },
      async () => ({ stopReason: "supervisor_no_progress", exitCode: 1 }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /supervisor_no_progress/);
      assert.match(result.error, /55/);
    }
  } finally {
    process.exitCode = original;
  }
});

test("advanceIssueThroughSingle (#1074): production path loads events from single result (no evidence arg)", async () => {
  // Mirrors the legacy adapter wiring: runSingleIssueCommand-shaped return
  // (runId + exit) without an injected fifth evidence argument; events come
  // from the production readLoopEvents seam after the single attempt.
  const original = process.exitCode;
  process.exitCode = 0;
  const readRuns: string[] = [];
  try {
    const result = await advanceIssueThroughSingle(
      1010,
      { json: true },
      async () => ({
        number: 1010,
        title: "",
        body: "",
        labels: ["pipeline:implementing"],
        state: "open",
      }),
      async () => {
        process.exitCode = 1;
        return {
          exitCode: 1,
          runId: "loop-single-prod-1010",
          stopReason: null,
        };
      },
      // evidence omitted — production default must still quote structured class
      undefined,
      async (runId) => {
        readRuns.push(runId);
        return [
          {
            kind: "loop_run_stopped",
            data: { reason: "supervisor_no_progress" },
          },
          {
            kind: "loop_item_blocked",
            data: { item_id: "1010", class: "recovery_exhausted" },
          },
        ];
      },
    );
    assert.deepEqual(readRuns, ["loop-single-prod-1010"]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /supervisor_no_progress/);
      assert.match(result.error, /1010/);
      assert.doesNotMatch(
        result.error,
        /^(?:advance failed for #\d+: )?pipeline (?:single|advance) exited with code 1$/,
      );
    }
  } finally {
    process.exitCode = original;
  }
});

test("advanceIssueThroughSingle (#1074): production path via runSingleIssueCommand return shape", async () => {
  // Full production adapter: real runSingleIssueCommand with injected engine
  // deps — no fifth evidence arg; stop reason from drive result + events.
  const { runSingleIssueCommand } = await import("../scripts/pipeline.ts");
  const original = process.exitCode;
  const originalError = console.error;
  process.exitCode = 0;
  console.error = () => {};
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  try {
    const result = await advanceIssueThroughSingle(
      42,
      { json: true, profile: "codex" },
      async () => ({
        number: 42,
        title: "",
        body: "",
        labels: ["pipeline:fix"],
        state: "open",
      }),
      async (raw, opts, _deps, output) =>
        runSingleIssueCommand(
          raw,
          opts,
          {
            resolveConfig: () => fakeCfg as never,
            resolveIssueNumber: async (_c, n) => n,
            runLoopEngine: async () => ({
              kind: "drive",
              result: {
                runId: "loop-via-single-cmd",
                cycles: 1,
                stop: { reason: "supervisor_no_progress", time: "t" },
                holdOutstanding: false,
                allDone: false,
                resumed: false,
                heldItemIds: [],
                dispatched: 0,
                excludedItemIds: [],
                exclusionReason: null,
                completion: null,
              },
            }),
            writeStdoutLine: () => {},
          },
          output,
        ),
      undefined,
      async (runId) => {
        assert.equal(runId, "loop-via-single-cmd");
        return [
          {
            kind: "loop_run_stopped",
            data: { reason: "supervisor_no_progress" },
          },
        ];
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /supervisor_no_progress/);
      assert.match(result.error, /42/);
      assert.doesNotMatch(
        result.error,
        /^(?:advance failed for #\d+: )?pipeline (?:single|advance) exited with code 1$/,
      );
    }
  } finally {
    process.exitCode = original;
    console.error = originalError;
  }
});

test("advanceIssueThroughSingle (#1074): production path with no runId stays exit-only", async () => {
  const original = process.exitCode;
  process.exitCode = 0;
  let eventsRead = false;
  try {
    const result = await advanceIssueThroughSingle(
      7,
      { json: true },
      async () => ({
        number: 7,
        title: "",
        body: "",
        labels: ["pipeline:ready"],
        state: "open",
      }),
      async () => {
        process.exitCode = 1;
        return { exitCode: 1, engineMessage: "single hard fail" };
      },
      undefined,
      async () => {
        eventsRead = true;
        return [];
      },
    );
    assert.equal(eventsRead, false, "must not read events without a run id");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /single hard fail|exited with code 1|advance failed/);
      assert.doesNotMatch(result.error, /supervisor_no_progress|dependency_deadlock|recovery_exhausted/);
    }
  } finally {
    process.exitCode = original;
  }
});

test("classifyTrainAdvanceLabels (#1074): stop reason beats exit-only", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:implementing"] },
    1,
    { stopReason: "supervisor_no_progress", exitCode: 1 },
    1010,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /supervisor_no_progress/);
    assert.match(out.error, /1010/);
    assert.doesNotMatch(
      out.error,
      /^pipeline advance exited with code 1$/,
    );
  }
});

test("classifyTrainAdvanceLabels (#1074): no evidence keeps exit code, invents no class", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready"] },
    1,
    { exitCode: 1 },
    7,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /exited with code 1/);
    assert.doesNotMatch(out.error, /supervisor_no_progress|dependency_deadlock/);
  }
});

test("classifyTrainAdvanceLabels (#1074): blocked class on needs-human diagnostic", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:needs-human"] },
    0,
    {
      blockedClass: "recovery_exhausted",
      blockedIssue: 839,
      stopReason: undefined,
    },
    839,
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.terminal, "needs-human");
    assert.match(out.diagnostic ?? "", /recovery_exhausted/);
    assert.match(out.diagnostic ?? "", /839/);
  }
});

test("classifyTrainAdvanceLabels (#1074): non-zero exit does not succeed as ready-to-deploy", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy"] },
    1,
    { stopReason: "supervisor_no_progress", exitCode: 1 },
    99,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /supervisor_no_progress/);
    assert.match(out.error, /99/);
  }
});

test("classifyTrainAdvanceLabels (#1074): engine failure does not succeed as ready-to-deploy", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy"] },
    0,
    { engineMessage: "loop engine crashed", exitCode: 1 },
    12,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /loop engine crashed|advance failed/);
    assert.match(out.error, /12/);
  }
});

test("classifyTrainAdvanceLabels (#1095): recovered implementation-ci then R2D is ok", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const { extractTrainAdvanceLoopEvidence } = await import(
    "../scripts/stages/train-advance-stop-reason.ts"
  );
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "1037", class: "implementation-ci" },
      },
      {
        kind: "loop_item_advance_finished",
        data: { item_id: "1037", outcome: "ready_to_deploy" },
      },
      { kind: "loop_run_complete", data: { outcome: "all_done" } },
    ],
  });
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy"] },
    0,
    evidence,
    1037,
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.terminal, "ready-to-deploy");
  }
});

test("classifyTrainAdvanceLabels (#1095): current blockedClass plus R2D flicker is not ok", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy"] },
    0,
    { blockedClass: "implementation-ci", blockedIssue: 1037, itemTerminal: "blocked" },
    1037,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /implementation-ci/);
  }
});

test("classifyTrainAdvanceLabels (#1095): reasonless loop_run_stopped plus live R2D is not ok", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const { extractTrainAdvanceLoopEvidence } = await import(
    "../scripts/stages/train-advance-stop-reason.ts"
  );
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [{ kind: "loop_run_stopped", data: {} }],
  });
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy"] },
    0,
    evidence,
    1037,
  );
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.match(out.error, /loop_run_stopped/);
  }
});

test("classifyTrainAdvanceLabels (#1095): live blocked label is not a recovered R2D success", async () => {
  const { classifyTrainAdvanceLabels } = await import("../scripts/pipeline.ts");
  const out = classifyTrainAdvanceLabels(
    { labels: ["pipeline:ready-to-deploy", "blocked"] },
    0,
    { blockedClass: "implementation-ci", blockedIssue: 1037 },
    1037,
  );
  assert.equal(out.ok, true);
  if (out.ok) {
    assert.equal(out.terminal, "blocked");
    assert.notEqual(out.terminal, "ready-to-deploy");
  }
});

test("advanceWaveThroughLoop (#1095): recovered block then all_done + live R2D is ok", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const result = await advanceWaveThroughLoop(
    [1037],
    {},
    async () => ({
      number: 1037,
      title: "t",
      body: "",
      labels: ["pipeline:ready-to-deploy"],
      state: "open",
    }),
    async () => ({
      kind: "drive",
      result: {
        runId: "loop-recovered-r2d",
        cycles: 2,
        stop: null,
        holdOutstanding: false,
        allDone: true,
        resumed: false,
        heldItemIds: [],
        dispatched: 1,
        excludedItemIds: [],
        exclusionReason: null,
        completion: "all_done",
      },
    }),
    () => fakeCfg as never,
    async () => [
      {
        kind: "loop_item_blocked",
        data: { item_id: "1037", class: "implementation-ci" },
      },
      {
        kind: "loop_item_advance_finished",
        data: { item_id: "1037", outcome: "ready_to_deploy" },
      },
      { kind: "loop_run_complete", data: { outcome: "all_done" } },
    ],
  );
  const outcome = result.get(1037);
  assert.ok(outcome);
  assert.equal(outcome!.ok, true);
  if (outcome!.ok) {
    assert.equal(outcome!.terminal, "ready-to-deploy");
  }
});

test("advanceWaveThroughLoop (#1074): injects stop reason from drive + events", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const result = await advanceWaveThroughLoop(
    [1010],
    {},
    async () => ({
      number: 1010,
      title: "t",
      body: "",
      labels: ["pipeline:implementing"],
      state: "open",
    }),
    async () => ({
      kind: "drive",
      result: {
        runId: "loop-test-run",
        cycles: 1,
        stop: { reason: "supervisor_no_progress", time: "t" },
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 0,
        excludedItemIds: [],
        exclusionReason: null,
        completion: null,
      },
    }),
    () => fakeCfg as never,
    async () => [
      {
        kind: "loop_run_stopped",
        data: { reason: "supervisor_no_progress" },
      },
    ],
  );
  const outcome = result.get(1010);
  assert.ok(outcome);
  assert.equal(outcome!.ok, false);
  if (!outcome!.ok) {
    assert.match(outcome!.error, /supervisor_no_progress/);
    assert.match(outcome!.error, /1010/);
  }
});

test("advanceWaveThroughLoop (#1074): engine error without events keeps message, no invented class", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const result = await advanceWaveThroughLoop(
    [3],
    {},
    async () => ({
      number: 3,
      title: "t",
      body: "",
      labels: ["pipeline:ready"],
      state: "open",
    }),
    async () => ({ kind: "error", message: "pipeline advance hard fail" }),
    () => fakeCfg as never,
    async () => {
      throw new Error("events must not be required when no run id");
    },
  );
  const outcome = result.get(3);
  assert.ok(outcome);
  assert.equal(outcome!.ok, false);
  if (!outcome!.ok) {
    assert.match(outcome!.error, /hard fail|exited with code|advance failed/);
    assert.doesNotMatch(outcome!.error, /supervisor_no_progress|dependency_deadlock/);
  }
});

test("advanceWaveThroughLoop (#1074): engine fail with ready-to-deploy label stays non-ok", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const result = await advanceWaveThroughLoop(
    [77],
    {},
    async () => ({
      number: 77,
      title: "t",
      body: "",
      // Label advanced to R2D before the wave engine failed — must not mask.
      labels: ["pipeline:ready-to-deploy"],
      state: "open",
    }),
    async () => ({ kind: "error", message: "wave engine failed after label update" }),
    () => fakeCfg as never,
    async () => {
      throw new Error("events must not be required when no run id");
    },
  );
  const outcome = result.get(77);
  assert.ok(outcome);
  assert.equal(outcome!.ok, false, "ready-to-deploy must not mask engine failure");
  if (!outcome!.ok) {
    assert.match(outcome!.error, /wave engine failed|advance failed|exited with code/);
    assert.match(outcome!.error, /77/);
  }
});

test("advanceWaveThroughLoop (#1074): stop reason with ready-to-deploy stays non-ok", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const result = await advanceWaveThroughLoop(
    [88],
    {},
    async () => ({
      number: 88,
      title: "t",
      body: "",
      labels: ["pipeline:ready-to-deploy"],
      state: "open",
    }),
    async () => ({
      kind: "drive",
      result: {
        runId: "loop-r2d-stop",
        cycles: 1,
        stop: { reason: "supervisor_no_progress", time: "t" },
        holdOutstanding: false,
        allDone: false,
        resumed: false,
        heldItemIds: [],
        dispatched: 0,
        excludedItemIds: [],
        exclusionReason: null,
        completion: null,
      },
    }),
    () => fakeCfg as never,
    async () => [
      {
        kind: "loop_run_stopped",
        data: { reason: "supervisor_no_progress" },
      },
    ],
  );
  const outcome = result.get(88);
  assert.ok(outcome);
  assert.equal(outcome!.ok, false);
  if (!outcome!.ok) {
    assert.match(outcome!.error, /supervisor_no_progress/);
    assert.match(outcome!.error, /88/);
  }
});

test("advanceWaveThroughLoop onRunReady emits loop_run_handoff with absolute events on stderr (#1184)", async () => {
  const { advanceWaveThroughLoop } = await import("../scripts/pipeline.ts");
  const pipelineSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/pipeline.ts"),
    "utf8",
  );
  const fnStart = pipelineSrc.indexOf("export async function advanceWaveThroughLoop");
  const fnEnd = pipelineSrc.indexOf("/** Production default: read loop events");
  assert.ok(fnStart >= 0 && fnEnd > fnStart, "advanceWaveThroughLoop source not found");
  const ready = pipelineSrc.slice(fnStart, fnEnd);
  const readyBlock = ready.slice(
    ready.indexOf("onRunReady:"),
    ready.indexOf("if (engineResult.kind === \"error\")"),
  );
  assert.match(readyBlock, /formatLoopRunHandoff/);
  assert.match(readyBlock, /writeStderrLine/);
  assert.match(ready, /process\.stderr/);
  assert.match(readyBlock, /ctx\.events|formatLoopRunHandoff\(ctx\)/);

  const fakeCfg = {
    repo_dir: "/tmp/repo",
    repo: "o/r",
    base_branch: "main",
    domain: "o-r",
  };
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(" "));
  };
  try {
    await advanceWaveThroughLoop(
      [10],
      {},
      async () => ({
        number: 10,
        title: "t",
        body: "",
        labels: ["pipeline:ready-to-deploy"],
        state: "open",
      }),
      async (input) => {
        assert.ok(input.onRunReady, "advance-wave must wire onRunReady");
        await input.onRunReady!({
          runId: "loop-ready-1184",
          runDir: "/abs/state/runs/loop-ready-1184",
          events: "/abs/state/runs/loop-ready-1184/events.jsonl",
          engine: "codex",
          resumed: false,
          selector: { type: "work-list", value: ["10"] },
        });
        return {
          kind: "drive",
          result: {
            runId: "loop-ready-1184",
            cycles: 1,
            stop: null,
            holdOutstanding: false,
            allDone: true,
            resumed: false,
            heldItemIds: [],
            dispatched: 1,
            excludedItemIds: [],
            exclusionReason: null,
            completion: "all_done",
          },
        };
      },
      () => fakeCfg as never,
      async () => [],
      async (line) => {
        stderrLines.push(line.replace(/\n$/, ""));
      },
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(stderrLines.length, 1, "exactly one stderr handoff line");
  const parsed = JSON.parse(stderrLines[0]) as {
    kind?: string;
    events?: string;
  };
  assert.equal(parsed.kind, "loop_run_handoff");
  assert.equal(parsed.events, "/abs/state/runs/loop-ready-1184/events.jsonl");
  assert.ok(parsed.events?.startsWith("/"), "events path must be absolute");
  const stdout = stdoutLines.join("\n");
  assert.doesNotMatch(stdout, /loop_run_handoff/);
});

test("pipeline-cli: train --json stdout stays one train_status with run_id; handoff is stderr-only (#1277)", async () => {
  const { opts } = parseCli(["train", "--issues", "10,11", "--json"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const handoff: string[] = [];
  let waveStarted = false;
  let handoffBeforeWave = false;
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("the command must replace the base advanceWave seam");
      },
      getPrForIssue: async () => 101,
      getPrForIssueAnyState: async () => 101,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      now: () => new Date("2026-08-28T17:28:03.000Z"),
      runStore: memTrainRunStore(),
      writeHandoff: (line) => {
        if (!waveStarted) handoffBeforeWave = true;
        handoff.push(line);
      },
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave(issues, _opts, getIssue) {
      waveStarted = true;
      const out = new Map<number, import("../scripts/stages/train.ts").AdvanceOutcome>();
      for (const issue of issues) {
        const snap = await getIssue(issue);
        out.set(issue, {
          ok: true,
          terminal: "ready-to-deploy",
          labels: ["pipeline:ready-to-deploy"],
        });
      }
      return out;
    },
  };
  const stdout: string[] = [];
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (...args: unknown[]) => {
    stdout.push(`${args.map(String).join(" ")}\n`);
  };
  process.exitCode = undefined;
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.equal(exitCode, 0);
    const emitted = stdout.join("");
    const document = JSON.parse(emitted) as { kind?: string; run_id?: string; schema_version?: number };
    assert.equal(document.kind, "train_status");
    assert.equal(document.schema_version, 1);
    assert.equal(document.run_id, "train-2026-08-28T17-28-03-000Z");
    assert.doesNotMatch(emitted, /train_run_handoff/);
    assert.doesNotMatch(emitted, /loop_run_handoff/);
    assert.ok(handoffBeforeWave, "handoff must flush before the first wave");
    assert.equal(handoff.length, 1);
    const parsed = JSON.parse(handoff[0]!) as { kind?: string; run_id?: string; events?: string };
    assert.equal(parsed.kind, "train_run_handoff");
    assert.equal(parsed.run_id, document.run_id);
    assert.ok(typeof parsed.events === "string" && parsed.events.endsWith("events.jsonl"));
    assert.ok(parsed.events?.startsWith("/"), "events path must be absolute");
  } finally {
    console.log = originalLog;
    process.exitCode = priorExitCode;
  }
});

test("pipeline-cli: train --json stdout stays one train_status when advance-wave handoff is on stderr (#1184)", async () => {
  const { opts } = parseCli(["train", "--issues", "10", "--json"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready-to-deploy"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("the command must replace the base advanceWave seam");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: memTrainRunStore(),
      writeHandoff: () => {},
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave(issues, _opts, getIssue) {
      const out = new Map<number, import("../scripts/stages/train.ts").AdvanceOutcome>();
      for (const issue of issues) {
        const snap = await getIssue(issue);
        out.set(issue, {
          ok: true,
          terminal: "ready-to-deploy",
          labels: snap.labels,
        });
      }
      return out;
    },
  };
  const stdout: string[] = [];
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (...args: unknown[]) => {
    stdout.push(`${args.map(String).join(" ")}\n`);
  };
  process.exitCode = undefined;
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.equal(exitCode, 0);
    const emitted = stdout.join("");
    const document = JSON.parse(emitted) as { kind?: string };
    assert.equal(document.kind, "train_status");
    assert.doesNotMatch(emitted, /loop_run_handoff/);
  } finally {
    console.log = originalLog;
    process.exitCode = priorExitCode;
  }
});

test("pipeline-cli: a nested advance_run_handoff before train_status is not one JSON document", () => {
  const leaked = `${formatAdvanceRunHandoff({
    runId: "1049-2026-08-30T00-45-58-000Z",
    runDir: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-45-58-000Z",
    events: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-45-58-000Z/events.jsonl",
  })}\n${JSON.stringify({ schema_version: 1, kind: "train_status", complete: true })}\n`;
  assert.throws(() => JSON.parse(leaked));
});

test("pipeline-cli: train --json stdout stays one train_status when nested numeric children inherit stdio (#1049)", async () => {
  const { opts } = parseCli(["train", "--issues", "1049", "--json"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready-to-deploy"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("the command must replace the base advanceWave seam");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: memTrainRunStore(),
      writeHandoff: () => {},
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave(issues, _opts, getIssue) {
      // Production loop dispatch spawns `pipeline N` with inherited stdio and
      // PIPELINE_NESTED_ADVANCE=1. A child that still emitted would write this
      // line to train --json stdout before train_status.
      if (shouldEmitAdvanceRunHandoff({ env: nestedAdvanceChildEnv({}) })) {
        await flushAdvanceRunHandoff({
          runId: "1049-2026-08-30T00-45-58-000Z",
          runDir: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-45-58-000Z",
          events: "/repo/.agent-pipeline/runs/1049-2026-08-30T00-45-58-000Z/events.jsonl",
        });
      }
      const out = new Map<number, import("../scripts/stages/train.ts").AdvanceOutcome>();
      for (const issue of issues) {
        const snap = await getIssue(issue);
        out.set(issue, {
          ok: true,
          terminal: "ready-to-deploy",
          labels: snap.labels,
        });
      }
      return out;
    },
  };
  const chunks: string[] = [];
  const originalLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  const priorExitCode = process.exitCode;
  console.log = (...args: unknown[]) => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  };
  (process.stdout as { write: typeof process.stdout.write }).write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = undefined;
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.equal(exitCode, 0);
    const emitted = chunks.join("");
    const document = JSON.parse(emitted) as { kind?: string };
    assert.equal(document.kind, "train_status");
    assert.doesNotMatch(emitted, new RegExp(ADVANCE_RUN_HANDOFF_KIND));
  } finally {
    console.log = originalLog;
    (process.stdout as { write: typeof process.stdout.write }).write = origWrite;
    process.exitCode = priorExitCode;
  }
});

const UNSUPPORTED_TRAIN_DRY_RUN =
  "pipeline train: --dry-run is not supported for train; omit it.";

test("pipeline-cli: train --dry-run does not reject an allowlisted flag (#1275)", async () => {
  assert.ok(
    COMMAND_REGISTRY.train.allowedFlags instanceof Set &&
      COMMAND_REGISTRY.train.allowedFlags.has("dryRun"),
    "train allowedFlags must still include dryRun",
  );
  const { opts } = parseCli(["train", "--issues", "10,11", "--dry-run"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("dry-run must not call advanceWave");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {
        throw new Error("dry-run must not call mergeIssuePr");
      },
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {
        throw new Error("dry-run must not fetchBase");
      },
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: memTrainRunStore(),
      writeHandoff: () => {
        throw new Error("dry-run must not write train_run_handoff");
      },
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave() {
      throw new Error("dry-run must not call runAdvanceWave");
    },
  };
  const stderr: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(`${args.map(String).join(" ")}`);
  };
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.notEqual(exitCode, 2, "handler must not exit 2 for allowlisted --dry-run");
    assert.equal(exitCode, 0);
    assert.equal(stderr.includes(UNSUPPORTED_TRAIN_DRY_RUN), false);
    assert.doesNotMatch(stderr.join("\n"), /--dry-run is not supported for train/);
  } finally {
    console.error = originalErr;
  }
});

test("pipeline-cli: train --merge --dry-run does not merge or advance (#1275)", async () => {
  const { opts } = parseCli(["train", "--issues", "10", "--merge", "--dry-run"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  let mergeCalls = 0;
  let waveCalls = 0;
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready-to-deploy"],
        state: "open",
      }),
      advanceWave: async () => {
        waveCalls += 1;
        throw new Error("dry-run must not call advanceWave");
      },
      getPrForIssue: async () => 20,
      getPrForIssueAnyState: async () => 20,
      mergeIssuePr: async () => {
        mergeCalls += 1;
      },
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {
        throw new Error("dry-run must not fetchBase");
      },
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: memTrainRunStore(),
      writeHandoff: () => {
        throw new Error("dry-run must not write train_run_handoff");
      },
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave() {
      waveCalls += 1;
      throw new Error("dry-run must not call runAdvanceWave");
    },
  };
  const exitCode = await runTrainCommand(opts, trainCfg, deps);
  assert.equal(exitCode, 0);
  assert.equal(mergeCalls, 0);
  assert.equal(waveCalls, 0);
});

test("pipeline-cli: train --json --dry-run emits one train_plan object (#1275)", async () => {
  const { opts } = parseCli(["train", "--issues", "10,11", "--dry-run", "--json"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const store = memTrainRunStore();
  const handoff: string[] = [];
  const deps: TrainCommandDeps = {
    makeTrainDeps: () => ({
      log: () => {},
      listMilestoneIssues: async () => [],
      getIssue: async (issue) => ({
        number: issue,
        title: `Issue ${issue}`,
        body: "",
        labels: ["pipeline:ready"],
        state: "open",
      }),
      advanceWave: async () => {
        throw new Error("dry-run must not call advanceWave");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
      runStore: store,
      writeHandoff: (line) => {
        handoff.push(line);
      },
    }),
    async runSingleIssue() {
      throw new Error("train production path uses advanceWave, not N×single");
    },
    async runAdvanceWave() {
      throw new Error("dry-run must not call runAdvanceWave");
    },
  };
  const stdout: string[] = [];
  const originalLog = console.log;
  const priorExitCode = process.exitCode;
  console.log = (...args: unknown[]) => {
    stdout.push(`${args.map(String).join(" ")}\n`);
  };
  process.exitCode = undefined;
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, deps);
    assert.equal(exitCode, 0);
    const emitted = stdout.join("");
    const document = JSON.parse(emitted) as {
      kind?: string;
      schema_version?: number;
      ordered_issues?: number[];
      merge_mode?: boolean;
      items?: Array<{ issue?: number; stage?: string | null; pr?: number | null; intended_action?: string }>;
    };
    assert.equal(document.kind, "train_plan");
    assert.notEqual(document.kind, "train_status");
    assert.equal(document.schema_version, 1);
    assert.deepEqual(document.ordered_issues, [10, 11]);
    assert.equal(document.merge_mode, false);
    assert.equal(document.items?.length, 2);
    assert.equal(document.items?.[0]?.issue, 10);
    assert.equal(document.items?.[0]?.intended_action, "would-advance");
    assert.doesNotMatch(emitted, /"kind": "train_status"/);
    assert.doesNotMatch(emitted, /train_run_handoff/);
    assert.equal(handoff.length, 0);
  } finally {
    console.log = originalLog;
    process.exitCode = priorExitCode;
  }
});

test("pipeline-cli: train --dry-run without selector still fails before a plan (#1275)", async () => {
  const { opts } = parseCli(["train", "--dry-run"]);
  const trainCfg = {
    repo: "owner/repo",
    repo_dir: "/repo",
    base_branch: "main",
  } as PipelineConfig;
  const stderr: string[] = [];
  const originalErr = console.error;
  console.error = (...args: unknown[]) => {
    stderr.push(`${args.map(String).join(" ")}`);
  };
  try {
    const exitCode = await runTrainCommand(opts, trainCfg, {
      makeTrainDeps: () => {
        throw new Error("missing selector must not build train deps");
      },
      async runSingleIssue() {
        throw new Error("unused");
      },
    });
    assert.equal(exitCode, 2);
    assert.match(stderr.join("\n"), /--issues <n,n> and\/or --milestone/);
    assert.doesNotMatch(stderr.join("\n"), /--dry-run is not supported for train/);
  } finally {
    console.error = originalErr;
  }
});

test("pipeline-cli: ship emits only the failure status persisted by this authorization", () => {
  const status = {
    kind: "ship_status",
    authorization_fingerprint: "a".repeat(64),
    last_error: "FRG evidence missing",
  };
  assert.equal(
    selectPersistedShipFailureStatus(status, "a".repeat(64), "FRG evidence missing"),
    status,
  );
  assert.equal(
    selectPersistedShipFailureStatus(status, "b".repeat(64), "FRG evidence missing"),
    null,
    "an old authorization status must not leak into stdout",
  );
  assert.equal(
    selectPersistedShipFailureStatus(status, "a".repeat(64), "authorization expired"),
    null,
    "a pre-admission error must remain stderr-only",
  );
});

test("pipeline-cli: ship trusts only a root-owned, non-writable regular public-key file", () => {
  const regular = { isFile: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o100644 };
  assert.doesNotThrow(() => validateShipAuthorizationPublicKeyFile("/etc/agent-pipeline/key.pem", regular));
  assert.throws(
    () => validateShipAuthorizationPublicKeyFile("relative.pem", regular),
    /absolute/,
  );
  assert.throws(
    () => validateShipAuthorizationPublicKeyFile("/tmp/key.pem", { ...regular, uid: process.getuid?.() ?? 501 }),
    /root-owned/,
  );
  assert.throws(
    () => validateShipAuthorizationPublicKeyFile("/etc/key.pem", { ...regular, mode: 0o100666 }),
    /not writable/,
  );
  assert.throws(
    () => validateShipAuthorizationPublicKeyFile("/etc/key.pem", { ...regular, isSymbolicLink: () => true }),
    /not a symlink/,
  );
});

// ---------------------------------------------------------------------------
// 5.2  Unsupported global flag on a restricted command
// ---------------------------------------------------------------------------

test("pipeline-cli: doctor with --dry-run → validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["doctor", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli: release with --status → validateFlags returns ['status']", () => {
  assert.deepEqual(roundTrip(["release", "1.0.0", "--status"]), ["status"]);
});

test("pipeline-cli: intake with --override foo:bar → validateFlags returns ['override']", () => {
  assert.deepEqual(roundTrip(["intake", "--override", "key: reason"]), ["override"]);
});

test("pipeline-cli: triage with --dry-run → validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["triage", "42", "--stage", "ready", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli: improve with --once → validateFlags returns ['once']", () => {
  assert.deepEqual(roundTrip(["improve", "--once"]), ["once"]);
});

// ---------------------------------------------------------------------------
// 5.3  Regression: merge --detach → ["detach"]  (#217)
// ---------------------------------------------------------------------------

test("pipeline-cli 5.3: merge with --detach → validateFlags returns ['detach']", () => {
  const offending = roundTrip(["merge", "42", "--detach"]);
  assert.deepEqual(offending, ["detach"]);
});

// ---------------------------------------------------------------------------
// 5.4  Regression: intake --status → ["status"]
// ---------------------------------------------------------------------------

test("pipeline-cli 5.4: intake --status → validateFlags returns ['status']", () => {
  const offending = roundTrip(["intake", "--description", "foo", "--status"]);
  assert.deepEqual(offending, ["status"]);
});

// ---------------------------------------------------------------------------
// 5.5  Valid: 123 --dry-run --once → advance entry, validateFlags returns []
// ---------------------------------------------------------------------------

test("pipeline-cli: advance --sha is parsed onto opts.sha", () => {
  const sha = "a".repeat(40);
  const { opts } = parseCli(["42", "--sha", sha]);
  assert.equal(opts.sha, sha);
  assert.deepEqual(roundTrip(["42", "--sha", sha]), []);
});

test("pipeline-cli: status --sha is rejected", () => {
  const sha = "a".repeat(40);
  assert.ok(roundTrip(["status", "42", "--sha", sha]).includes("sha"));
});

test("pipeline-cli 5.5: '123 --dry-run --once' → advance entry, validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "123", "--dry-run", "--once"]);
  const numArg = cmd.args[0];
  const entry = lookupCommand(numArg);
  assert.ok(entry !== null, "should resolve to advance entry");
  assert.equal(entry, COMMAND_REGISTRY.advance);
  assert.equal(entry.allowedFlags, "all");
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// 5.6  Valid: doctor --json → doctor entry, validateFlags returns []
// ---------------------------------------------------------------------------

test("pipeline-cli 5.6: 'doctor --json' → doctor entry, validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "doctor", "--json"]);
  const numArg = cmd.args[0];
  const entry = lookupCommand(numArg);
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.doctor);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// 5.7  Valid: merge --repo-path /tmp/repo → merge entry, validateFlags returns []
// ---------------------------------------------------------------------------

test("pipeline-cli 5.7: 'merge 42 --repo-path /tmp/repo' → merge entry, validateFlags returns []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "merge", "42", "--repo-path", "/tmp/repo"]);
  const numArg = cmd.args[0];
  const entry = lookupCommand(numArg);
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.merge);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

// ---------------------------------------------------------------------------
// 5.8  Flag-only modes: --init, --cleanup, --remove-worktree resolve to their
//      registry entries (not the advance entry) so unsupported flags are caught.
// ---------------------------------------------------------------------------

test("pipeline-cli 5.8a: '--init' alone → init entry, validateFlags returns []", () => {
  assert.deepEqual(roundTrip(["--init"]), []);
});

test("pipeline-cli 5.8b: '--init --dry-run' → init entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["--init", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli 5.8c: '--cleanup' alone → cleanup entry, validateFlags returns []", () => {
  assert.deepEqual(roundTrip(["--cleanup"]), []);
});

test("pipeline-cli 5.8d: '--cleanup --dry-run' → cleanup entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["--cleanup", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli 5.8e: '42 --remove-worktree' → remove-worktree entry, validateFlags returns []", () => {
  assert.deepEqual(roundTrip(["42", "--remove-worktree"]), []);
});

test("pipeline-cli 5.8f: '42 --remove-worktree --dry-run' → remove-worktree entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["42", "--remove-worktree", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli 5.8g: 'logs --dry-run' → logs entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["logs", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli: logs --events --follow is valid", () => {
  assert.deepEqual(roundTrip(["logs", "42-2026-06-16T00-00-00Z", "--events", "--follow"]), []);
});

test("pipeline-cli: logs --events --follow --no-until-terminal is valid (#725)", () => {
  assert.deepEqual(
    roundTrip(["logs", "42-2026-06-16T00-00-00Z", "--events", "--follow", "--no-until-terminal"]),
    [],
  );
});

test("pipeline-cli: logs --no-until-terminal sets untilTerminal false (#725)", () => {
  const cmd = buildCmd();
  cmd.parse([
    "node",
    "pipeline",
    "logs",
    "42-2026-06-16T00-00-00Z",
    "--events",
    "--follow",
    "--no-until-terminal",
  ]);
  assert.equal(cmd.opts().events, true);
  assert.equal(cmd.opts().follow, true);
  assert.equal(cmd.opts().untilTerminal, false);
});

test("pipeline-cli: logs --events --follow defaults untilTerminal true (#725)", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "logs", "42-2026-06-16T00-00-00Z", "--events", "--follow"]);
  assert.equal(cmd.opts().untilTerminal, true);
});

test("pipeline-cli: loop logs --events --follow is valid on the loop allowlist (#666)", () => {
  assert.deepEqual(roundTrip(["loop", "logs", "loop-abc", "--events", "--follow"]), []);
});

test("pipeline-cli: loop logs --follow --no-until-terminal is valid (#699)", () => {
  assert.deepEqual(
    roundTrip(["loop", "logs", "loop-abc", "--events", "--follow", "--no-until-terminal"]),
    [],
  );
});

test("pipeline-cli: loop logs parses nested logs sub-verb before issue args", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "loop", "logs", "loop-abc", "--events", "--follow"]);
  assert.equal(cmd.args[0], "loop");
  assert.equal(cmd.args[1], "logs");
  assert.equal(cmd.args[2], "loop-abc");
  assert.equal(cmd.opts().events, true);
  assert.equal(cmd.opts().follow, true);
  // until-terminal defaults on (#699)
  assert.equal(cmd.opts().untilTerminal, true);
});

test("pipeline-cli: loop logs --no-until-terminal sets untilTerminal false (#699)", () => {
  const cmd = buildCmd();
  cmd.parse([
    "node",
    "pipeline",
    "loop",
    "logs",
    "loop-abc",
    "--follow",
    "--no-until-terminal",
  ]);
  assert.equal(cmd.opts().follow, true);
  assert.equal(cmd.opts().untilTerminal, false);
});

test("pipeline-cli 5.8h: 'summary run-123 --dry-run' → summary entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["summary", "run-123", "--dry-run"]), ["dryRun"]);
});

test("pipeline-cli: numeric summary accepts repo and legacy-fallback domain selectors", () => {
  assert.deepEqual(
    roundTrip(["summary", "42", "--repo-path", "/tmp/repo", "--domain", "offline-test"]),
    [],
  );
});

// ---------------------------------------------------------------------------
// 7.1  New positional keywords: status, unblock, override, cleanup
// ---------------------------------------------------------------------------

test("pipeline-cli 7.1a: 'status 42' → numArg=status, args[1]=42, routes to status entry", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "status", "42"]);
  assert.equal(cmd.args[0], "status");
  assert.equal(cmd.args[1], "42");
  const entry = lookupCommand("status");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.status);
});

test("pipeline-cli 7.1b: 'unblock 42 <answer>' → numArg=unblock, args[1]=42, args[2]=answer", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "unblock", "42", "the answer"]);
  assert.equal(cmd.args[0], "unblock");
  assert.equal(cmd.args[1], "42");
  assert.equal(cmd.args[2], "the answer");
  const entry = lookupCommand("unblock");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.unblock);
});

test("pipeline-cli 7.1c: 'override 42 <key>: <reason>' → numArg=override, args[1]=42, args[2]=disposition", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "override", "42", "perf: not in scope"]);
  assert.equal(cmd.args[0], "override");
  assert.equal(cmd.args[1], "42");
  assert.equal(cmd.args[2], "perf: not in scope");
  const entry = lookupCommand("override");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.override);
  assert.equal(entry.allowedFlags, "all");
});

test("pipeline-cli 7.1d: 'cleanup' → numArg=cleanup, routes to cleanup entry", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "cleanup"]);
  assert.equal(cmd.args[0], "cleanup");
  const entry = lookupCommand("cleanup");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.cleanup);
});

test("pipeline-cli 7.1e: advance loop unaffected — '42' still routes to advance entry", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42"]);
  assert.equal(cmd.args[0], "42");
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.advance);
});

// ---------------------------------------------------------------------------
// 7.3  Deprecated flag-form compatibility
//      Each legacy flag form is still accepted by the CLI parser and resolves
//      to the advance entry (allowedFlags:"all"), so validateFlags returns [].
//      The stderr deprecation notice and actual handler execution are behavioral
//      concerns verified by integration/smoke tests.
// ---------------------------------------------------------------------------

test("pipeline-cli 7.3a: '42 --status' is accepted → advance entry, validateFlags []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--status"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.status, true);
  assert.equal(cmd.args[0], "42");
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.advance);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("pipeline-cli 7.3b: '42 --status --json' preserves json flag (stdout contract unchanged)", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--status", "--json"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.status, true);
  assert.equal(opts.json, true);
  assert.equal(cmd.args[0], "42");
  // Both flags land on advance entry and pass validation
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("pipeline-cli 7.3c: '42 --unblock <answer>' is accepted → advance entry, validateFlags []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--unblock", "the unblock answer"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.unblock, "the unblock answer");
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.advance);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("pipeline-cli 7.3d: '42 --override <spec>' is accepted → advance entry, validateFlags []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--override", "key: reason"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.override, "key: reason");
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("pipeline-cli 7.3e: '42 --summary' is accepted → advance entry, validateFlags []", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--summary"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.summary, true);
  const entry = lookupCommand(cmd.args[0]);
  assert.ok(entry !== null);
  assert.deepEqual(validateFlags(entry, cmd), []);
});

test("pipeline-cli 7.3f: '--init' is accepted → init entry via roundTrip, validateFlags []", () => {
  assert.deepEqual(roundTrip(["--init"]), []);
});

test("pipeline-cli 7.3g: '--cleanup' is accepted → cleanup entry via roundTrip, validateFlags []", () => {
  assert.deepEqual(roundTrip(["--cleanup"]), []);
});

test("pipeline-cli 7.3h: 'doctor' keyword resolves directly — no deprecated shim needed", () => {
  // 'doctor' is dispatched as a positional keyword; --doctor is a separate advance-gate flag
  // (run preflight before advancing). The keyword form is NOT deprecated.
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "doctor"]);
  assert.equal(cmd.args[0], "doctor");
  const entry = lookupCommand("doctor");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.doctor);
  // --doctor (the advance-gate flag) is a separate concern and not deprecated
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.doctor, undefined);
});

// ---------------------------------------------------------------------------
// 7.4  Detach routing: 'pipeline N --detach' is equivalent to 'pipeline run N --detach'
// ---------------------------------------------------------------------------

test("pipeline-cli 7.4a: 'N --detach' → opts.detach=true and numArg is numeric (routes via detach path)", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "42", "--detach"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.detach, true);
  assert.ok(/^\d+$/.test(cmd.args[0]), "numArg should be numeric");
  assert.equal(cmd.args[0], "42");
});

test("pipeline-cli 7.4b: 'run N --detach' → opts.detach=true and numArg='run', args[1]=N", () => {
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "run", "42", "--detach"]);
  const opts = cmd.opts<CliOpts>();
  assert.equal(opts.detach, true);
  assert.equal(cmd.args[0], "run");
  assert.equal(cmd.args[1], "42");
});

test("pipeline-cli 7.4c: 'run' keyword maps to run entry (allowedFlags:all), not advance", () => {
  const entry = lookupCommand("run");
  assert.ok(entry !== null);
  assert.equal(entry, COMMAND_REGISTRY.run);
  assert.equal(entry.allowedFlags, "all");
  assert.notEqual(entry, COMMAND_REGISTRY.advance);
});

// ---------------------------------------------------------------------------
// papercut (#419) — agent-facing sub-command, hidden from --help
// ---------------------------------------------------------------------------

test("pipeline-cli: 'papercut --run <id> -m <msg>' parses run/message and routes to papercut entry, validateFlags []", () => {
  const { opts, numArg } = parseCli(["papercut", "--run", "419-2026-01-01T00-00-00-000Z", "-m", "npm ci flaked"]);
  assert.equal(numArg, "papercut");
  assert.equal(opts.run, "419-2026-01-01T00-00-00-000Z");
  assert.equal(opts.message, "npm ci flaked");
  assert.deepEqual(roundTrip(["papercut", "--run", "419-x", "-m", "note"]), []);
});

test("pipeline-cli: 'papercut report --since <date> --until <date> --json' parses correctly", () => {
  const { opts, numArg, numArg0 } = parseCli([
    "papercut", "report", "--since", "2026-01-01", "--until", "2026-01-31", "--json",
  ]);
  assert.equal(numArg, "papercut");
  assert.equal(numArg0, "papercut");
  assert.equal(opts.since, "2026-01-01");
  assert.equal(opts.until, "2026-01-31");
  assert.equal(opts.json, true);
});

test("pipeline-cli: lookupCommand('papercut') resolves to the registry entry", () => {
  const entry = lookupCommand("papercut");
  assert.equal(entry, COMMAND_REGISTRY.papercut);
});

test("pipeline-cli: papercut with an unsupported flag → validateFlags returns the offending key", () => {
  assert.deepEqual(roundTrip(["papercut", "--run", "419-x", "-m", "note", "--dry-run"]), ["dryRun"]);
});

// --- evals harvest (#535): 'evals <subcommand> <path>' is 3 positionals ---

test("pipeline-cli: 'evals harvest request.json' parses all three positionals (evals, harvest, path)", () => {
  const { numArg, numArg0 } = parseCli(["evals", "harvest", "request.json"]);
  assert.equal(numArg, "evals");
  assert.equal(numArg0, "evals");
  const cmd = buildCmd();
  cmd.parse(["node", "pipeline", "evals", "harvest", "request.json"]);
  assert.deepEqual(cmd.args, ["evals", "harvest", "request.json"]);
});

test("pipeline-cli: 'evals harvest request.json --apply --plan-only --out draft.json' parses options", () => {
  const { opts } = parseCli(["evals", "harvest", "request.json", "--apply", "--plan-only", "--out", "draft.json"]);
  assert.equal(opts.apply, true);
  assert.equal((opts as unknown as { planOnly?: boolean }).planOnly, true);
  assert.equal((opts as unknown as { out?: string }).out, "draft.json");
});

// --- resolveHarvestOutPath (#535 review 1 finding a97dc21a): --out is a
// repository write and must require the explicit --apply approval action ---

test("resolveHarvestOutPath: no --out prints to stdout regardless of --apply", () => {
  assert.deepEqual(resolveHarvestOutPath("/repo", undefined, false), { ok: true });
  assert.deepEqual(resolveHarvestOutPath("/repo", undefined, true), { ok: true });
});

test("resolveHarvestOutPath: --out without --apply is refused — never writes without approval", () => {
  const result = resolveHarvestOutPath("/repo", "draft.json", false);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /--apply/);
});

test("resolveHarvestOutPath: --out with --apply resolves within the repository", () => {
  const result = resolveHarvestOutPath("/repo", "draft.json", true);
  assert.deepEqual(result, { ok: true, path: "/repo/draft.json" });
});

test("resolveHarvestOutPath: an absolute --out path escaping the repository is refused even with --apply", () => {
  const result = resolveHarvestOutPath("/repo", "/etc/passwd", true);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /within the repository/);
});

test("resolveHarvestOutPath: a '..'-escaping --out path is refused even with --apply", () => {
  const result = resolveHarvestOutPath("/repo", "../../etc/passwd", true);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /within the repository/);
});

// --- symlink-escape containment (#535 review 2 finding aa79c7b7): a
// lexically-inside path can still real-resolve outside the repository via a
// repository-local symlink. Uses a real temp directory tree so realpathSync
// actually has something to resolve. ---

function makeRepoWithEscapingSymlink(): { repoDir: string; outsideDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-harvest-symlink-"));
  const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(root, "repo-")));
  const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(root, "outside-")));
  fs.symlinkSync(outsideDir, path.join(repoDir, "escape-link"));
  return { repoDir, outsideDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("resolveHarvestOutPath: a repository-local symlink escaping the repository is refused even with --apply", () => {
  const { repoDir, cleanup } = makeRepoWithEscapingSymlink();
  try {
    const result = resolveHarvestOutPath(repoDir, "escape-link/draft.json", true);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /within the repository/);
  } finally {
    cleanup();
  }
});

test("resolveHarvestOutPath: a non-symlinked path within a real repository directory is still accepted", () => {
  const { repoDir, cleanup } = makeRepoWithEscapingSymlink();
  try {
    const result = resolveHarvestOutPath(repoDir, "draft.json", true);
    assert.deepEqual(result, { ok: true, path: path.join(repoDir, "draft.json") });
  } finally {
    cleanup();
  }
});

// --- resolveHarvestFixturesDir (#535 review 2 finding aa79c7b7): harvest
// promotion's write destination must be constrained the same way --out is —
// an absolute/escaping/symlink-escaping --fixtures must never be a valid
// promotion target. ---

test("resolveHarvestFixturesDir: a fixtures dir within the repository is accepted", () => {
  const result = resolveHarvestFixturesDir("/repo", "/repo/core/evals/fixtures");
  assert.deepEqual(result, { ok: true });
});

test("resolveHarvestFixturesDir: an absolute fixtures dir outside the repository is refused", () => {
  const result = resolveHarvestFixturesDir("/repo", "/etc/fixtures");
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /within the repository/);
});

test("resolveHarvestFixturesDir: a repository-local symlink escaping the repository is refused", () => {
  const { repoDir, cleanup } = makeRepoWithEscapingSymlink();
  try {
    const result = resolveHarvestFixturesDir(repoDir, path.join(repoDir, "escape-link", "fixtures"));
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /within the repository/);
  } finally {
    cleanup();
  }
});
