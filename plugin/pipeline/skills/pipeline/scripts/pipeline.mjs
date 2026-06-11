#!/usr/bin/env node
// GENERATED from hosts/_shared/entry.template.mjs by the agent-pipeline installer/build.
// Do not edit in place — re-run the installer to regenerate.
//
// Thin launcher for the shared pipeline core. Responsibilities:
//   1. Gate on Node >= 24 (the core runs TypeScript directly via native
//      type-stripping; this shim is plain JS so the gate message works on
//      any Node version).
//   2. Provision dependencies on first run (idempotent `npm ci` into core/).
//   3. Exec the shared core with this host's profile baked in.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const PROFILE = "claude";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  console.error(
    `pipeline: requires Node >= 24 for native TypeScript execution (found ${process.versions.node}).\n` +
      "         Install Node 24+ (e.g. `nvm install 24 && nvm use 24`) and re-run.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url)); // <skill>/scripts
const coreDir = resolve(here, "..", "core"); // <skill>/core
const entry = join(coreDir, "scripts", "pipeline.ts");

if (!existsSync(entry)) {
  console.error(`pipeline: core not found at ${entry}. Re-run the installer.`);
  process.exit(1);
}

// Short-circuit for --version / -V: must work before dependency provisioning
// because the version is available in core/package.json which is always present.
const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
  const pkg = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
  process.stdout.write(pkg.version + "\n");
  process.exit(0);
}

// First-run dependency provisioning. Skipped once core/node_modules exists, so
// this is a no-op on every subsequent invocation.
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

const passthrough = process.argv.slice(2);
const args = ["--experimental-strip-types", entry, ...passthrough];
if (!passthrough.includes("--profile")) args.push("--profile", PROFILE);

const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
