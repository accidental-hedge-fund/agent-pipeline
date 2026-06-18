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

// Read core/package.json once upfront.  Two reasons:
//   (a) --version short-circuit needs it before dependency provisioning.
//   (b) Node reads core/package.json to determine module type (ESM vs CJS)
//       *before* executing any code in pipeline.ts, so a malformed file causes
//       ERR_INVALID_PACKAGE_CONFIG before any try/catch or `doctor` check can
//       run.  We detect the corrupt-install case here and surface it ourselves.
const rawArgs = process.argv.slice(2);
const pkgPath = join(coreDir, "package.json");
let pkgVersion = "";
let pkgReadable = true;
try {
  const text = readFileSync(pkgPath, "utf8");
  pkgVersion = (JSON.parse(text)).version ?? "";
} catch {
  pkgReadable = false;
}

// Short-circuit for --version / -V: works before dependency provisioning.
if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
  if (!pkgReadable) {
    process.stderr.write(
      `pipeline: core/package.json at ${coreDir} is missing or not valid JSON.\n` +
      "         Reinstall with: npm install -g agent-pipeline\n",
    );
    process.exit(1);
  }
  process.stdout.write(pkgVersion + "\n");
  process.exit(0);
}

// Guard: malformed or missing core/package.json causes ERR_INVALID_PACKAGE_CONFIG
// when Node tries to load the TypeScript entry (before any pipeline code runs).
// Surface a coherent failure here rather than a raw Node startup error.
if (!pkgReadable) {
  if (rawArgs[0] === "doctor") {
    process.stdout.write(
      `Pipeline doctor — 1 check (0 passed, 1 failed, 0 skipped)\n\n` +
      `  ✗ install:version-coherence — core/package.json at ${coreDir} is missing or not valid JSON\n` +
      `      → Reinstall the pipeline skill to restore a valid core/package.json at ${coreDir}.\n\n` +
      `Result: FAIL\n`,
    );
  } else {
    process.stderr.write(
      `pipeline: core/package.json at ${coreDir} is missing or not valid JSON.\n` +
      "         Reinstall the pipeline skill: npm install -g agent-pipeline\n",
    );
  }
  process.exit(1);
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
