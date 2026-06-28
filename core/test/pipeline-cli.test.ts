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
import { buildCmd, type CliOpts } from "../scripts/pipeline.ts";
import { lookupCommand, validateFlags, COMMAND_REGISTRY } from "../scripts/command-registry.ts";

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

test("pipeline-cli: release — version argument → []", () => {
  assert.deepEqual(roundTrip(["release", "1.0.0"]), []);
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

test("pipeline-cli: roadmap — --apply → []", () => {
  assert.deepEqual(roundTrip(["roadmap", "--apply"]), []);
});

test("pipeline-cli: run — run with issue number, all flags accepted → []", () => {
  assert.deepEqual(roundTrip(["run", "42", "--dry-run"]), []);
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

test("pipeline-cli 5.8h: 'summary run-123 --dry-run' → summary entry, validateFlags returns ['dryRun']", () => {
  assert.deepEqual(roundTrip(["summary", "run-123", "--dry-run"]), ["dryRun"]);
});
