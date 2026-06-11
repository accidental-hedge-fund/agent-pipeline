#!/usr/bin/env node
// Wires this clone's pre-commit hook by pointing git at the committed .githooks/
// directory (repo-local only):
//
//   npm run setup-hooks
//
// The hook auto-regenerates and stages the plugin/ mirror whenever a commit
// touches core/ or hosts/claude/, so contributors never have to remember to run
// `node scripts/build.mjs` by hand. It is convenience only — `node scripts/build.mjs
// --check` in `npm run ci` / CI remains the authoritative, clone-independent gate.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync("git", ["config", "--local", "core.hooksPath", ".githooks"], {
  cwd: REPO_ROOT,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error("✗ failed to set core.hooksPath — run this from a git clone of the repo");
  process.exit(result.status ?? 1);
}

console.log(
  "✓ pre-commit hook active — plugin/ mirror auto-regenerates on core/ or hosts/claude/ commits",
);
