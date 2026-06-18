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

// Report a corrupt install (core/package.json missing or malformed) for the
// pre-dispatch guard below. `doctor` has machine-output contracts that automated
// consumers depend on, so honor them even on this error path — otherwise a
// `doctor --json` / `doctor --is-ok` poller gets prose where it asked for a JSON
// envelope / a silent 0-1 gate:
//   • `doctor --is-ok` → zero output (the exit code carries the verdict)
//   • `doctor --json`  → the stable doctor JSON envelope (schema_version "1")
//   • `doctor`         → human-readable prose
//   • any other command → a stderr reinstall hint
// Mirrors formatDoctorJson() and the prose formatter in core/scripts/stages/doctor.ts.
function reportCorruptInstall(rawArgs, coreDir) {
  if (rawArgs[0] !== "doctor") {
    process.stderr.write(
      `pipeline: core/package.json at ${coreDir} is missing or not valid JSON.\n` +
      "         Reinstall the pipeline skill: npm install -g agent-pipeline\n",
    );
    return;
  }
  if (rawArgs.includes("--is-ok")) return; // silent 0/1 gate: exit code only
  const reason = `core/package.json at ${coreDir} is missing or not valid JSON`;
  const fix = `Reinstall the pipeline skill to restore a valid core/package.json at ${coreDir}.`;
  if (rawArgs.includes("--json")) {
    process.stdout.write(
      JSON.stringify({
        schema_version: "1",
        status: "error",
        checks: [{ name: "install:version-coherence", ok: false, reason, fix }],
      }) + "\n",
    );
    return;
  }
  process.stdout.write(
    `Pipeline doctor — 1 check (0 passed, 1 failed, 0 skipped)\n\n` +
    `  ✗ install:version-coherence — ${reason}\n` +
    `      → ${fix}\n\n` +
    `Result: FAIL\n`,
  );
}

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
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Accept only a shape that lets Node load this ESM-only package's TypeScript
  // entries. A file that is valid JSON but an invalid/incompatible package config
  // — a non-object (e.g. `[]`), a non-string `version`, or an explicit `type`
  // other than "module" (`type: 123` → ERR_INVALID_PACKAGE_CONFIG; `type:
  // "commonjs"` → the ESM `import` entries fail to load as CommonJS) — does NOT
  // throw here, yet crashes Node when it loads pipeline.ts/path-cli.ts, leaking a
  // raw stack before the guard below can report a coherent diagnostic. Treat any
  // such config as corrupt. `type` absent is fine (the .ts entries load as ESM).
  const isObject = pkg !== null && typeof pkg === "object" && !Array.isArray(pkg);
  const validType = isObject && (pkg.type === undefined || pkg.type === "module");
  if (isObject && typeof pkg.version === "string" && validType) {
    pkgVersion = pkg.version;
  } else {
    pkgReadable = false;
  }
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

// Corrupt install: a missing/malformed core/package.json makes Node throw
// ERR_INVALID_PACKAGE_CONFIG when it loads ANY TypeScript entry (path-cli.ts or
// pipeline.ts), before that code can run. Surface a coherent diagnostic here —
// ahead of the `path` fast-path, the entry check, AND the node_modules check —
// so every command (including the desktop `path --json` discovery contract, and a
// corrupt install that also lacks node_modules) reports the version-coherence
// failure instead of a raw Node stack trace. `--version` is handled above with
// its own pkgReadable branch and never reaches here.
if (!pkgReadable) {
  reportCorruptInstall(rawArgs, coreDir);
  process.exit(1);
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

const args = ["--experimental-strip-types", entry, ...rawArgs];
const run = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(run.status ?? 1);
