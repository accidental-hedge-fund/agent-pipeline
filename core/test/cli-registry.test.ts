// Tests for COMMAND_REGISTRY and the generic CLI flag guard (#263).
//
// Coverage:
//   4.1  Table-driven disallowed-flag tests: for each command × denied-flag pair
//        that the previous hand-written guards blocked, assert that the registry
//        guard now exits with code 2 and prints a "does not support" error.
//   4.2  Registry-coverage: every CliOpts key appears in at least one entry's
//        allowedFlags set (ensures future flag additions are explicitly triaged).
//   3.3  Import-direction guard: pipeline-run.ts contains no
//        `import … from.*commander` or `import … from.*pipeline` statement
//        (the one-way dependency CLI → service is enforced at the module level).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { COMMAND_REGISTRY } from "../scripts/command-registry.ts";
import type { CliOpts } from "../scripts/cli-types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_RUN_TS = path.join(__dirname, "..", "scripts", "pipeline-run.ts");
const PIPELINE_SCRIPT = path.join(__dirname, "..", "scripts", "pipeline.ts");

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, ...args],
    { encoding: "utf8", env: { ...process.env, PATH: process.env.PATH ?? "" } },
  );
}

// ---------------------------------------------------------------------------
// 4.1 Table-driven disallowed-flag tests
// ---------------------------------------------------------------------------
// One row per command × denied-flag pair, drawn from the complement sets that
// were previously enforced by per-command guard blocks (merge was already
// tested exhaustively in merge.test.ts; these rows cover the five additional
// guards removed in #263: doctor, release, intake, triage, init).
//
// Format: [argv (from the subcommand onwards), expectedFlagInError]
type Row = { argv: string[]; flag: string; label: string };

const DENIED_FLAG_ROWS: Row[] = [
  // doctor: cleanup and init are denied
  { label: "doctor --cleanup", argv: ["doctor", "--cleanup"],  flag: "--cleanup" },
  { label: "doctor --init",    argv: ["doctor", "--init"],     flag: "--init" },
  // release: cleanup, init, status are denied  (include required version arg)
  { label: "release --cleanup", argv: ["release", "1.0.0", "--cleanup"], flag: "--cleanup" },
  { label: "release --init",    argv: ["release", "1.0.0", "--init"],    flag: "--init" },
  { label: "release --status",  argv: ["release", "1.0.0", "--status"],  flag: "--status" },
  // intake: status, cleanup are denied
  { label: "intake --status",  argv: ["intake", "--status", "--description", "x"], flag: "--status" },
  { label: "intake --cleanup", argv: ["intake", "--cleanup"],                      flag: "--cleanup" },
  // triage: dryRun, status, summary, detach are denied (include required issue arg)
  { label: "triage --dry-run", argv: ["triage", "123", "--stage", "ready", "--dry-run"],  flag: "--dry-run" },
  { label: "triage --status",  argv: ["triage", "123", "--stage", "ready", "--status"],   flag: "--status" },
  { label: "triage --summary", argv: ["triage", "123", "--stage", "ready", "--summary"],  flag: "--summary" },
  { label: "triage --detach",  argv: ["triage", "123", "--stage", "ready", "--detach"],   flag: "--detach" },
  // merge: a representative pair not already in merge.test.ts
  { label: "merge --dry-run",  argv: ["merge", "42", "--dry-run"],   flag: "--dry-run" },
  { label: "merge --domain",   argv: ["merge", "42", "--domain", "x"], flag: "--domain" },
];

for (const { label, argv, flag } of DENIED_FLAG_ROWS) {
  test(`cli-registry: '${label}' exits 2 (denied by registry)`, () => {
    const result = runCli(argv);
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}; stderr: ${result.stderr}`);
    const combined = (result.stdout ?? "") + (result.stderr ?? "");
    assert.ok(
      combined.includes("does not support"),
      `expected "does not support" in error; got: ${combined}`,
    );
    assert.ok(
      combined.includes(flag),
      `expected flag '${flag}' named in error; got: ${combined}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 4.2 Registry-coverage: every CliOpts key appears in at least one entry
// ---------------------------------------------------------------------------

test("cli-registry: every CliOpts key is covered by at least one COMMAND_REGISTRY entry", () => {
  const covered = new Set<string>();
  for (const entry of Object.values(COMMAND_REGISTRY)) {
    for (const k of entry.allowedFlags) {
      covered.add(k);
    }
  }

  // Enumerate keys at runtime via a representative Required<CliOpts> object.
  const sample: Required<CliOpts> = {
    status: false,
    summary: false,
    unblock: "",
    override: "",
    once: false,
    dryRun: false,
    domain: "",
    repoPath: "",
    base: "",
    model: "",
    profile: "",
    cleanup: false,
    init: false,
    doctor: false,
    failFast: false,
    jsonEvents: false,
    follow: false,
    detach: false,
    timeout: 0,
    flockTimeout: 0,
    runId: "",
    json: false,
    isOk: false,
    edit: false,
    description: "",
    release: "",
    apply: false,
    next: 0,
    repo: "",
    stage: "",
  };

  const missing = Object.keys(sample).filter(k => !covered.has(k));
  assert.deepEqual(
    missing,
    [],
    `CliOpts keys not covered by any COMMAND_REGISTRY entry: ${missing.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// 3.3 Import-direction guard: pipeline-run.ts must not import from pipeline.ts
//     or from commander.
// ---------------------------------------------------------------------------

test("cli-registry: pipeline-run.ts has no import from commander or pipeline.ts", () => {
  const content = fs.readFileSync(PIPELINE_RUN_TS, "utf8");

  // Strip comment lines to avoid false positives from documentation.
  const codeLines = content
    .split("\n")
    .filter(l => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"));
  const codeBlock = codeLines.join("\n");

  const importFromCommander = /import\s.*from\s+["'].*commander/.test(codeBlock);
  const importFromPipeline  = /import\s.*from\s+["'].*pipeline['".]/.test(codeBlock);

  assert.ok(
    !importFromCommander,
    "pipeline-run.ts must not import from commander (one-way CLI → service dependency)",
  );
  assert.ok(
    !importFromPipeline,
    "pipeline-run.ts must not import from pipeline.ts (one-way CLI → service dependency)",
  );
});
