#!/usr/bin/env node
// Host-neutral pipeline launcher — installed as the `pipeline` bin by agent-pipeline.
//
// Provides the stable entry points documented in the Desktop Integration section
// of README.md: `pipeline --version`, `pipeline path --json`, and
// `pipeline run <N> --detach`. Unlike the host-specific shims (entry.template.mjs),
// this launcher does not bake in a profile: callers that need a specific profile
// pass --profile claude or --profile codex explicitly.
//
// Usage after `npm install -g agent-pipeline`:
//   pipeline --version
//   pipeline path --json
//   pipeline run 153 --detach --timeout 3600

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  console.error(
    `pipeline: requires Node >= 24 for native TypeScript execution (found ${process.versions.node}).\n` +
      "         Install Node 24+ (e.g. `nvm install 24 && nvm use 24`) and re-run.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url)); // agent-pipeline/scripts/
const coreDir = resolve(here, "..", "core");           // agent-pipeline/core/
const entry = join(coreDir, "scripts", "pipeline.ts");

const rawArgs = process.argv.slice(2);

// Short-circuit for --version / -V: works before dependency provisioning
// because the version lives in core/package.json which is always present.
if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
  const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

if (!existsSync(entry)) {
  console.error(
    `pipeline: core not found at ${entry}.\n` +
      "         Re-install with: npm install -g agent-pipeline",
  );
  process.exit(1);
}

// First-run dependency provisioning. No-op once core/node_modules exists.
if (!existsSync(join(coreDir, "node_modules"))) {
  console.error("[pipeline] first run: installing dependencies (npm ci)…");
  const ci = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: coreDir,
    stdio: "inherit",
  });
  if ((ci.status ?? 1) !== 0) {
    console.error(`[pipeline] dependency install failed. Run \`npm ci\` in ${coreDir} and retry.`);
    process.exit(1);
  }
}

const args = ["--experimental-strip-types", entry, ...rawArgs];
const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
