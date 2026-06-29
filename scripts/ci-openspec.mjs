#!/usr/bin/env node
// CI guard: run `openspec validate --all` when this repo has an openspec/ workspace.
// Exits 0 (no-op) when no openspec/ directory is present, so repos and contexts
// that do not use OpenSpec (including the install smoke test) are unaffected.
//
// CLI resolution: tries the preinstalled binary first; falls back to
// `npx @fission-ai/openspec` so the step works on a fresh CI runner without
// a preinstalled `openspec` CLI.
//
// Called via `npm run ci:openspec` as part of the `npm run ci` gate.
// Override the root directory with CI_OPENSPEC_ROOT for test isolation.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.env.CI_OPENSPEC_ROOT ?? process.cwd();

if (!existsSync(join(REPO_ROOT, "openspec"))) {
  // No openspec/ workspace — no-op so non-OpenSpec repos are unaffected.
  process.exit(0);
}

function runValidate(cmd, args) {
  return spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: "inherit", shell: false });
}

let result = runValidate("openspec", ["validate", "--all"]);

if (result.error?.code === "ENOENT") {
  // openspec not on PATH — fall back to npx (works on fresh CI runners).
  result = runValidate("npx", [
    "--yes",
    "@fission-ai/openspec@latest",
    "validate",
    "--all",
  ]);
}

if (result.error) {
  process.stderr.write(`ci-openspec: failed to spawn openspec: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
