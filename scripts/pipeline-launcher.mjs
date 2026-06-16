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

// Dependencies are provisioned by the package's best-effort postinstall script
// at install time. They may be absent if that provisioning could not complete
// (transient registry/cache failure, offline, or a read-only global package
// dir). We must NOT attempt a write here — the installed package directory may
// be root-owned/read-only — so command-time provisioning is never attempted.
if (!existsSync(join(coreDir, "node_modules"))) {
  // `pipeline path` only needs Node built-ins (discovery.ts has no third-party
  // imports), so the desktop discovery contract stays read-only-safe even when
  // provisioning failed: route it through the dependency-free discovery entry
  // rather than failing with a reinstall hint.
  if (rawArgs[0] === "path") {
    const pathCli = join(coreDir, "scripts", "path-cli.ts");
    const run = spawnSync(
      process.execPath,
      ["--experimental-strip-types", pathCli, ...rawArgs.slice(1)],
      { stdio: "inherit" },
    );
    process.exit(run.status ?? 1);
  }
  // Commands that need the full engine (e.g. `run`) genuinely require the
  // dependencies; direct the user to re-install rather than writing here.
  console.error(
    `pipeline: runtime dependencies not found at ${join(coreDir, "node_modules")}.\n` +
      "         `pipeline --version` and `pipeline path` still work; for runs, re-install\n" +
      "         the package so the postinstall script can provision them:\n" +
      "           npm install -g agent-pipeline",
  );
  process.exit(1);
}

const args = ["--experimental-strip-types", entry, ...rawArgs];
const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
