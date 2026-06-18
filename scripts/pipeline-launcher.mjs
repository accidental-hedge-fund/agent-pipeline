#!/usr/bin/env node
// Host-neutral pipeline launcher — installed as the `pipeline` bin by agent-pipeline.
//
// Provides the stable entry points documented in the Desktop Integration section
// of README.md: `pipeline --version`, `pipeline path --json`, and
// `pipeline run <N> --detach`. Unlike the host-specific shims (entry.template.mjs),
// this launcher does not bake in a profile: callers that need a specific profile
// pass --profile claude or --profile codex explicitly.
//
// Runtime dependencies (core/node_modules) are provisioned by the package's
// postinstall script at install time, not at command time, so this launcher
// never writes to the installed package directory after installation.
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

// Read core/package.json once upfront.  Two reasons:
//   (a) --version short-circuit needs it before dependency provisioning.
//   (b) Node reads core/package.json to determine module type (ESM vs CJS)
//       *before* executing any code in pipeline.ts, so a malformed file causes
//       ERR_INVALID_PACKAGE_CONFIG before any try/catch or `doctor` check can
//       run.  We detect the corrupt-install case here and surface it ourselves.
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

// `pipeline path` discovery only needs Node built-ins (discovery.ts has no
// third-party imports), so it is routed through the dependency-free entry
// UNCONDITIONALLY — before the node_modules check. This keeps the desktop
// discovery contract read-only-safe not just when core/node_modules is absent,
// but also when a failed best-effort postinstall left it present-but-incomplete
// (e.g. missing commander): the full CLI entry would die on its commander import
// with ERR_MODULE_NOT_FOUND, so `path` must never depend on it.
if (rawArgs[0] === "path") {
  const pathCli = join(coreDir, "scripts", "path-cli.ts");
  if (!existsSync(pathCli)) {
    console.error(
      `pipeline: core not found at ${pathCli}.\n` +
        "         Re-install with: npm install -g agent-pipeline",
    );
    process.exit(1);
  }
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", pathCli, ...rawArgs.slice(1)],
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

if (!existsSync(entry)) {
  console.error(
    `pipeline: core not found at ${entry}.\n` +
      "         Re-install with: npm install -g agent-pipeline",
  );
  process.exit(1);
}

// Dependencies are provisioned by the package's best-effort postinstall script
// at install time. They may be absent (or incomplete) if that provisioning could
// not complete (transient registry/cache failure, offline, or a read-only global
// package dir). We must NOT attempt a write here — the installed package directory
// may be root-owned/read-only — so command-time provisioning is never attempted.
// Engine commands (e.g. `run`) genuinely require the dependencies; `path` and
// `--version` were already handled above and never reach this check.
if (!existsSync(join(coreDir, "node_modules"))) {
  console.error(
    `pipeline: runtime dependencies not found at ${join(coreDir, "node_modules")}.\n` +
      "         `pipeline --version` and `pipeline path` still work; for runs, re-install\n" +
      "         the package so the postinstall script can provision them:\n" +
      "           npm install -g agent-pipeline",
  );
  process.exit(1);
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

const args = ["--experimental-strip-types", entry, ...rawArgs];
const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
