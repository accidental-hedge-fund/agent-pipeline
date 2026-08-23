#!/usr/bin/env node
// Replicates the "Install smoke test" step from .github/workflows/ci.yml.
// Creates an isolated CLAUDE_CONFIG_DIR in a temp directory, installs the
// pipeline shim into it, verifies the shim runs (--help exits 0), exercises
// the documented `update` verb (#385: the install:version-freshness doctor
// check's remediation) twice to prove it is idempotent in place, then
// uninstalls. Cleans up even on failure.
//
// Also exercises the documented material-filter install path (#742): after
// install, `scripts/material-filter.mjs` must run against fixture JSONL and
// emit material one-liners (the host skill preferred notify command).
//
// TMPDIR is sandboxed under the smoke tree so installer/shim lock paths
// (`.pipeline-installer-update.lock`, `pipeline-starting-<pid>.lock`) never
// collide with concurrent host pipeline runs or sibling CI jobs. Without
// that isolation, a concurrent installer's host-wide update lock makes the
// post-install `shim --help` refuse with "install/update is in progress"
// and flakes the test gate.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

function run(args, env) {
  const result = spawnSync(NODE, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/** Fixture events.jsonl: material kinds mixed with noise the filter must drop. */
const MATERIAL_FILTER_FIXTURE = [
  JSON.stringify({
    schema_version: 1,
    type: "stage_accounting",
    at: "2026-07-31T00:00:00.000Z",
    stage: "planning",
  }),
  JSON.stringify({
    schema_version: 1,
    type: "run_start",
    at: "2026-07-31T00:00:01.000Z",
    run_id: "smoke-r1",
    issue: 742,
  }),
  JSON.stringify({
    schema_version: 1,
    type: "stage_start",
    at: "2026-07-31T00:00:02.000Z",
    stage: "planning",
  }),
  JSON.stringify({
    schema_version: 1,
    type: "gate_result",
    at: "2026-07-31T00:00:03.000Z",
    gate: "ci",
    result: "partial",
  }),
  JSON.stringify({
    schema_version: 1,
    type: "gate_result",
    at: "2026-07-31T00:00:04.000Z",
    gate: "ci",
    result: "partial",
  }),
  JSON.stringify({
    schema_version: 1,
    type: "run_complete",
    at: "2026-07-31T00:00:05.000Z",
    outcome: "advanced",
  }),
].join("\n") + "\n";

function assertInstalledMaterialFilter(filterScript, env) {
  const result = spawnSync(NODE, [filterScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    input: MATERIAL_FILTER_FIXTURE,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("material-filter.mjs smoke failed:", result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  const out = result.stdout ?? "";
  for (const must of ["run_start", "stage_start", "run_complete"]) {
    if (!out.includes(must)) {
      console.error(
        `material-filter.mjs smoke: expected material kind "${must}" in output:\n${out}`,
      );
      process.exit(1);
    }
  }
  // Spam suppression: second identical CI partial must not double-notify.
  const partialHits = (out.match(/partial/g) || []).length;
  if (partialHits > 1) {
    console.error(
      `material-filter.mjs smoke: expected at most one partial gate line, got ${partialHits}:\n${out}`,
    );
    process.exit(1);
  }
  if (out.includes("stage_accounting")) {
    console.error(
      `material-filter.mjs smoke: non-material accounting kind leaked:\n${out}`,
    );
    process.exit(1);
  }
}

const configDir = mkdtempSync(join(tmpdir(), "pipeline-smoke-"));
// Sandbox lock paths under the smoke tree (see file header). Nested so the
// final rmSync of configDir cleans both skill files and locks.
const lockTmpDir = join(configDir, "tmp");
mkdirSync(lockTmpDir, { recursive: true });
try {
  const installScript = join(REPO_ROOT, "scripts", "install.mjs");
  const shimScript = join(configDir, "skills", "pipeline", "scripts", "pipeline.mjs");
  const materialFilterScript = join(
    configDir,
    "skills",
    "pipeline",
    "scripts",
    "material-filter.mjs",
  );
  const env = { CLAUDE_CONFIG_DIR: configDir, TMPDIR: lockTmpDir };

  run([installScript, "install", "--host", "claude"], env);
  const enginesResolver = join(
    configDir,
    "skills",
    "pipeline",
    "scripts",
    "ensure-engines-node.mjs",
  );
  if (!existsSync(enginesResolver)) {
    console.error(
      "ci-install-smoke: scripts/ensure-engines-node.mjs missing next to pipeline.mjs after install",
    );
    process.exit(1);
  }
  const commandsDir = join(configDir, "commands");
  const slashFiles = existsSync(commandsDir)
    ? readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"))
    : [];
  if (slashFiles.length > 0) {
    console.error(`install --host claude wrote pipeline:*.md: ${slashFiles.join(", ")}`);
    process.exit(1);
  }
  run([shimScript, "--help"], env);
  const doctor = spawnSync(NODE, [shimScript, "doctor", "--is-ok"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const doctorOut = `${doctor.stdout ?? ""}${doctor.stderr ?? ""}`;
  if (/unrecognized sub-command/.test(doctorOut)) {
    console.error("installed launcher did not dispatch doctor:\n", doctorOut);
    process.exit(1);
  }
  const status = spawnSync(NODE, [shimScript, "status", "1"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  const statusOut = `${status.stdout ?? ""}${status.stderr ?? ""}`;
  if (/unrecognized sub-command/.test(statusOut)) {
    console.error("installed launcher did not dispatch status:\n", statusOut);
    process.exit(1);
  }
  // Documented host-skill material filter path must work from the installed tree.
  assertInstalledMaterialFilter(materialFilterScript, env);
  // `update` refreshes the installed skill in place; running it twice must be
  // a net no-op (no error, shim still runs) — the documented remediation for
  // a stale install:version-freshness warning. --force remains the documented
  // override when a live-run lock is present; with TMPDIR sandboxed, that scan
  // only sees locks inside this smoke tree (not the host pipeline process).
  run([installScript, "update", "--host", "claude", "--force"], env);
  run([shimScript, "--help"], env);
  assertInstalledMaterialFilter(materialFilterScript, env);
  run([installScript, "update", "--host", "claude", "--force"], env);
  run([shimScript, "--help"], env);
  run([installScript, "uninstall", "--host", "claude"], env);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
