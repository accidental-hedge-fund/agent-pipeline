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
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const PROFILE = "claude";

// Update-lock reservation (#450 round 2) — mirrors scripts/install.mjs's
// acquireUpdateLock()/findLiveRunLocks(). Filed under the same pipeline-*.lock
// naming the installer's live-run scan already matches, so no scan-side change
// is needed. Held for the full lifetime of the engine subprocess (this shim
// process stays alive across the blocking spawnSync below), so an installer
// that starts anytime during the run observes it.
const UPDATE_LOCK_PATH = join(tmpdir(), ".pipeline-installer-update.lock");
const STARTING_LOCK_PATH = join(tmpdir(), `pipeline-starting-${process.pid}.lock`);

// Read-only commands are explicitly allowlisted (fail-safe default: anything
// not listed here is treated as run-mutating and reserves a slot). `logs`
// (list form and `--follow`), `status`, and `summary` only read run artifacts
// — a file swap during an install can't corrupt a process that just tails
// terminal.log/events.jsonl — so they must not hold a run-liveness lock for
// their (potentially hours-long, `--follow`) lifetime, or they block every
// `install.mjs update` behind them (#567).
const READ_ONLY_COMMANDS = new Set(["logs", "status", "summary"]);

function isReadOnlyCommand(argv0) {
  return READ_ONLY_COMMANDS.has(argv0);
}

function updateInProgress() {
  return existsSync(UPDATE_LOCK_PATH);
}

// Reserve a run slot, then re-check the update lock. This closes the window
// where an installer's live-run scan runs before our reservation is on disk:
// if the installer had already acquired its update lock (which it holds
// across its own scan and the whole copy) by the time we recheck, we back off
// here instead of loading a possibly mixed old/new engine tree.
function reserveRunSlot() {
  if (updateInProgress()) return false;
  try {
    const fd = openSync(STARTING_LOCK_PATH, "wx");
    try {
      writeFileSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  if (updateInProgress()) {
    releaseRunSlot();
    return false;
  }
  return true;
}

function releaseRunSlot() {
  try {
    unlinkSync(STARTING_LOCK_PATH);
  } catch {
    // already gone
  }
}

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
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  // Accept only a shape that lets Node load this ESM-only package's TypeScript
  // entry. A file that is valid JSON but an invalid/incompatible package config —
  // a non-object (e.g. `[]`), a non-string `version`, or an explicit `type` other
  // than "module" (`type: 123` → ERR_INVALID_PACKAGE_CONFIG; `type: "commonjs"` →
  // the ESM `import` entry fails to load as CommonJS) — does NOT throw here, yet
  // crashes Node when it loads pipeline.ts, leaking a raw stack before the guard
  // below can report a coherent diagnostic. Treat any such config as corrupt.
  // `type` absent is fine (the .ts entry loads as ESM).
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

// Guard: malformed or missing core/package.json causes ERR_INVALID_PACKAGE_CONFIG
// when Node tries to load the TypeScript entry (before any pipeline code runs).
// Surface a coherent failure here rather than a raw Node startup error.
if (!pkgReadable) {
  reportCorruptInstall(rawArgs, coreDir);
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

// Read-only commands never reserve or hold the run-liveness slot (#567) — they
// only need the cheap, non-held courtesy check so they can decline to start
// into an update that's already in progress.
const readOnly = isReadOnlyCommand(rawArgs[0]);
let reserved = false;
if (readOnly) {
  if (updateInProgress()) {
    console.error(
      "pipeline: an install/update is in progress — starting now risks loading a mixed " +
        "old/new engine. Retry in a moment.",
    );
    process.exit(1);
  }
} else if (!reserveRunSlot()) {
  console.error(
    "pipeline: an install/update is in progress — starting now risks loading a mixed " +
      "old/new engine. Retry in a moment.",
  );
  process.exit(1);
} else {
  reserved = true;
}

const passthrough = process.argv.slice(2);
const args = ["--experimental-strip-types", entry, ...passthrough];
if (!passthrough.includes("--profile")) args.push("--profile", PROFILE);

const run = spawnSync(process.execPath, args, { stdio: "inherit" });
if (reserved) releaseRunSlot();
process.exit(run.status ?? 1);
