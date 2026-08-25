#!/usr/bin/env node
// GENERATED from hosts/_shared/entry.template.mjs by the agent-pipeline installer/build.
// Do not edit in place — re-run the installer to regenerate.
//
// Thin launcher for the shared pipeline core. Responsibilities:
//   1. Answer --version / -V / --version --json on the invoking Node (Node 18–23
//      introspection; does not load TypeScript).
//   2. Re-exec onto Node >= 24 for every TypeScript-loading route via the
//      shared engines-node resolver. Fail closed if none exists.
//   3. Provision dependencies on first run (idempotent `npm ci` into core/).
//   4. Exec the shared core with this host's profile baked in.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
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
// `install.mjs update` behind them (#567). Nested `loop logs` (#666) and
// `loop --audit` / `loop --audit --follow` (#611) are the same class of
// observation against the durable loop store and must likewise reserve no
// slot, while bare `loop` (start/resume) remains run-mutating.
const READ_ONLY_COMMANDS = new Set(["logs", "status", "summary"]);

/** Pure classifier of command argv (tokens after `pipeline`). Accepts a full
 *  argv array or a single first-token string for back-compat. No filesystem,
 *  process-signal, or subprocess call. */
function isReadOnlyCommand(argv) {
  const tokens = Array.isArray(argv) ? argv : argv === undefined || argv === null ? [] : [argv];
  const cmd = tokens[0];
  if (READ_ONLY_COMMANDS.has(cmd)) return true;
  // Nested: `pipeline loop logs …` — observation only (#666).
  if (cmd === "loop" && tokens[1] === "logs") return true;
  // `pipeline loop --audit` / `--audit --follow` — read-only stage table +
  // stage-progress follow (#611). Mutating resume without --audit stays live.
  if (cmd === "loop" && tokens.includes("--audit")) return true;
  return false;
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

const here = dirname(fileURLToPath(import.meta.url)); // <skill>/scripts (or hosts/_shared in-repo)
const scriptPath = fileURLToPath(import.meta.url);

function resolveCoreDir(fromHere) {
  const installed = resolve(fromHere, "..", "core");
  if (existsSync(join(installed, "package.json"))) return installed;
  const repo = resolve(fromHere, "..", "..", "core");
  if (existsSync(join(repo, "package.json"))) return repo;
  return installed;
}

const coreDir = resolveCoreDir(here);
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

function revParseHead(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (r.status !== 0) return null;
  const sha = String(r.stdout ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

function resolveLauncherCommitSha(engineCoreDir) {
  return revParseHead(engineCoreDir) ?? revParseHead(join(engineCoreDir, ".."));
}

// Short-circuit for --version / -V: works before dependency provisioning.
// Human --version stays the package version. `--version --json` emits
// `{ version, commit_sha }` (commit_sha is exact 40-hex or null; never invented).
if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
  if (!pkgReadable) {
    process.stderr.write(
      `pipeline: core/package.json at ${coreDir} is missing or not valid JSON.\n` +
      "         Reinstall with: npm install -g agent-pipeline\n",
    );
    process.exit(1);
  }
  if (rawArgs.includes("--json")) {
    const commitSha = resolveLauncherCommitSha(coreDir);
    process.stdout.write(JSON.stringify({ version: pkgVersion, commit_sha: commitSha }) + "\n");
    process.exit(0);
  }
  process.stdout.write(pkgVersion + "\n");
  process.exit(0);
}

async function reexecOntoEnginesNodeIfNeeded() {
  const nodeMajor = Number.parseInt(String(process.versions.node).split(".")[0], 10);
  if (Number.isFinite(nodeMajor) && nodeMajor >= 24) return;
  const sibling = join(here, "ensure-engines-node.mjs");
  const fromRepo = join(here, "..", "..", "scripts", "ensure-engines-node.mjs");
  const resolverPath = existsSync(sibling) ? sibling : existsSync(fromRepo) ? fromRepo : null;
  if (!resolverPath) {
    process.stderr.write(
      `pipeline: cannot load ensure-engines-node.mjs (tried ${sibling} and ${fromRepo}).\n` +
        "         Reinstall the pipeline skill: npm install -g agent-pipeline\n",
    );
    process.exit(1);
  }
  const mod = await import(pathToFileURL(resolverPath).href);
  const result = mod.reexecOntoEnginesNode({ scriptPath, argv: rawArgs });
  if (result.action === "continue") return;
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      // ignore
    }
  }
  process.exit(result.status ?? 1);
}

await reexecOntoEnginesNodeIfNeeded();

// Guard: malformed or missing core/package.json causes ERR_INVALID_PACKAGE_CONFIG
// when Node tries to load the TypeScript entry (before any pipeline code runs).
// Surface a coherent failure here rather than a raw Node startup error.
if (!pkgReadable) {
  reportCorruptInstall(rawArgs, coreDir);
  process.exit(1);
}

if (!existsSync(entry)) {
  console.error(`pipeline: core not found at ${entry}. Re-run the installer.`);
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
const readOnly = isReadOnlyCommand(rawArgs);
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

const childEnv = { ...process.env };
if (reserved) {
  // Let a nested engine-promote identify only this launcher's reservation.
  // The installer validates the PID against the exact lock path and contents.
  childEnv.PIPELINE_STARTING_LOCK_PID = String(process.pid);
} else {
  // Do not forward a stale value through read-only or nested launchers.
  delete childEnv.PIPELINE_STARTING_LOCK_PID;
}
const run = spawnSync(process.execPath, args, { stdio: "inherit", env: childEnv });
if (reserved) releaseRunSlot();
process.exit(run.status ?? 1);
