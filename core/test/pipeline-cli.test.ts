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
      advanceIssue: async () => {
        throw new Error("the command must replace the base advanceIssue seam");
      },
      getPrForIssue: async () => null,
      getPrForIssueAnyState: async () => null,
      mergeIssuePr: async () => {},
      observePr: async () => ({ state: "open", mergeCommitOid: null, headRefOid: null }),
      fetchBase: async () => {},
      baseTip: async () => "base-tip",
      isAncestor: async () => false,
    }),
    async runSingleIssue(rawIssue, _opts, _deps, output) {
      const issue = Number(rawIssue);
      advanced.push(issue);
      if (output?.emitMachineOutput !== false) {
        console.log(JSON.stringify({ schema_version: "1", kind: "loop_run_handoff", issue }));
        console.log(JSON.stringify({ schema_version: "1", kind: "drive", issue }));
      }
      ready.add(issue);
      process.exitCode = 0;
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
    assert.deepEqual(advanced, [10, 11], "both ordered issues must use the nested single command");

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
    "ship", "status", "--milestone", "v1.34.0", "--for", "1.34.0", "--json",
  ]);
  assert.equal(numArg, "ship");
  assert.equal(opts.authorization, undefined);
  assert.equal(opts.milestone, "v1.34.0");
  assert.equal(opts.for, "1.34.0");
  assert.deepEqual(roundTrip([
    "ship", "status", "--milestone", "v1.34.0", "--for", "1.34.0", "--json",
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

test("pipeline-cli: ship input requires JSON and an absolute authorization path", () => {
  assert.throws(
    () => normalizeShipCliInput(["ship"], {
      milestone: "v1.34.0",
      for: "1.34.0",
      authorization: "relative.json",
      json: true,
    }),
    /absolute path/,
  );
  assert.throws(
    () => normalizeShipCliInput(["ship"], {
      milestone: "v1.34.0",
      for: "1.34.0",
      authorization: "/run/user/1000/ship.json",
      json: false,
    }),
    /--json is required/,
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
