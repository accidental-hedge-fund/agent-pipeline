#!/usr/bin/env node
// Replicates the "Install smoke test" step from .github/workflows/ci.yml.
// Creates an isolated CLAUDE_CONFIG_DIR in a temp directory, installs the
// pipeline shim into it, verifies the shim runs (--help exits 0), exercises
// the documented `update` verb (#385: the install:version-freshness doctor
// check's remediation) twice to prove it is idempotent in place, then
// uninstalls. Cleans up even on failure.

import { mkdtempSync, rmSync } from "node:fs";
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

const configDir = mkdtempSync(join(tmpdir(), "pipeline-smoke-"));
try {
  const installScript = join(REPO_ROOT, "scripts", "install.mjs");
  const shimScript = join(configDir, "skills", "pipeline", "scripts", "pipeline.mjs");
  const env = { CLAUDE_CONFIG_DIR: configDir };

  run([installScript, "install", "--host", "claude"], env);
  run([shimScript, "--help"], env);
  // `update` refreshes the installed skill in place; running it twice must be
  // a net no-op (no error, shim still runs) — the documented remediation for
  // a stale install:version-freshness warning.
  run([installScript, "update", "--host", "claude"], env);
  run([shimScript, "--help"], env);
  run([installScript, "update", "--host", "claude"], env);
  run([shimScript, "--help"], env);
  run([installScript, "uninstall", "--host", "claude"], env);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
