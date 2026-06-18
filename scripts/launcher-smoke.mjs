#!/usr/bin/env node
// Smoke tests for scripts/pipeline-launcher.mjs.
//
// Covers:
//   1. --version exits 0 and prints a semver string
//   2. path --json exits 0 and emits valid JSON
//   3. launcher exits non-zero with a diagnostic when core/node_modules is absent
//   4. launcher succeeds when the package directory itself is read-only
//      (proves no writes are attempted at command time after the postinstall fix)

import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const LAUNCHER = join(REPO_ROOT, "scripts", "pipeline-launcher.mjs");

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. --version exits 0 and prints a semver
// ---------------------------------------------------------------------------
check("--version exits 0 and prints semver", () => {
  const r = spawnSync(NODE, [LAUNCHER, "--version"], { stdio: "pipe" });
  if (r.status !== 0) throw new Error(`exit ${r.status ?? "(signal)"}`);
  const out = r.stdout.toString().trim();
  if (!/^\d+\.\d+\.\d+/.test(out)) throw new Error(`unexpected output: ${JSON.stringify(out)}`);
});

// ---------------------------------------------------------------------------
// 2. path --json exits 0 and emits valid JSON with expected shape
// ---------------------------------------------------------------------------
check("path --json exits 0 and emits valid JSON", () => {
  const r = spawnSync(NODE, [LAUNCHER, "path", "--json"], { stdio: "pipe" });
  if (r.status !== 0) {
    throw new Error(
      `exit ${r.status ?? "(signal)"}\nstderr: ${r.stderr.toString().trim()}`,
    );
  }
  let json;
  try {
    json = JSON.parse(r.stdout.toString());
  } catch {
    throw new Error(`stdout is not valid JSON: ${r.stdout.toString().slice(0, 200)}`);
  }
  const valid = ["missing", "claude-only", "codex-only", "both"];
  if (!valid.includes(json.hostCoverage)) {
    throw new Error(`unexpected hostCoverage: ${json.hostCoverage}`);
  }
  if (!("corePath" in json) || !("version" in json) || !("hosts" in json)) {
    throw new Error(`missing required fields in JSON: ${JSON.stringify(json)}`);
  }
});

// ---------------------------------------------------------------------------
// 3. core/node_modules absent (e.g. best-effort postinstall failed):
//    `pipeline path --json` MUST still return machine-readable discovery JSON
//    (dep-free entry), while commands that need the engine (`run`) error with a
//    re-install hint. Regression for the "successful-but-unusable install" finding.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-launcher-no-deps-"));
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(LAUNCHER, join(tmp, "scripts", "pipeline-launcher.mjs"));
    mkdirSync(join(tmp, "core", "scripts"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(tmp, "core", "package.json"),
      JSON.stringify({ name: "agent-pipeline-core", version: "0.0.0" }),
    );
    // stub the full entry (it needs commander, which is absent), but copy the REAL
    // dependency-free discovery modules so `path` resolves without node_modules.
    writeFileSync(join(tmp, "core", "scripts", "pipeline.ts"), "// stub\n");
    copyFileSync(join(REPO_ROOT, "core", "scripts", "discovery.ts"), join(tmp, "core", "scripts", "discovery.ts"));
    copyFileSync(join(REPO_ROOT, "core", "scripts", "path-cli.ts"), join(tmp, "core", "scripts", "path-cli.ts"));
    // deliberately do NOT create core/node_modules

    check("no node_modules: path --json still exits 0 with valid discovery JSON", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "path", "--json"], {
        stdio: "pipe",
      });
      if (r.status !== 0) {
        throw new Error(
          `expected exit 0 for path --json without deps; got ${r.status}\nstderr: ${r.stderr.toString().slice(0, 300)}`,
        );
      }
      const json = JSON.parse(r.stdout.toString());
      if (!["missing", "claude-only", "codex-only", "both"].includes(json.hostCoverage)) {
        throw new Error(`unexpected hostCoverage: ${json.hostCoverage}`);
      }
    });

    check("no node_modules: a run command still errors with a re-install hint", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "run", "1", "--detach"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit for `run` when node_modules absent");
      if (!r.stderr.toString().includes("npm install -g agent-pipeline")) {
        throw new Error(`expected re-install hint in stderr; got: ${r.stderr.toString().slice(0, 300)}`);
      }
    });

    // Partial provisioning: node_modules EXISTS but is incomplete (a failed
    // best-effort npm ci). `path` must still bypass the full CLI (which would die
    // on its commander import) and return discovery JSON. Regression for the
    // round-4 finding that the fallback only fired when node_modules was absent.
    check("partial node_modules (present but incomplete): path --json still exits 0", () => {
      mkdirSync(join(tmp, "core", "node_modules", ".partial-junk"), { recursive: true });
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "path", "--json"], {
        stdio: "pipe",
      });
      if (r.status !== 0) {
        throw new Error(
          `expected exit 0 for path --json with partial node_modules; got ${r.status}\nstderr: ${r.stderr.toString().slice(0, 300)}`,
        );
      }
      JSON.parse(r.stdout.toString()); // must be valid discovery JSON
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. launcher succeeds when the scripts dir is read-only (no writes at cmd time)
//
// Setup: copy the launcher into a temp "package", symlink core/ from the repo
// root (which already has node_modules from ci:core), then chmod the scripts
// dir and the temp root to read-only before running.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-launcher-readonly-"));
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(LAUNCHER, join(tmp, "scripts", "pipeline-launcher.mjs"));
    // symlink core from repo root (node_modules already populated by ci:core)
    symlinkSync(join(REPO_ROOT, "core"), join(tmp, "core"));

    // make the temp package directory hierarchy read-only
    chmodSync(join(tmp, "scripts", "pipeline-launcher.mjs"), 0o444);
    chmodSync(join(tmp, "scripts"), 0o555);
    chmodSync(tmp, 0o555);

    check("read-only package dir: path --json still exits 0 (no writes at command time)", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "path", "--json"], {
        stdio: "pipe",
      });
      if (r.status !== 0) {
        throw new Error(
          `exit ${r.status ?? "(signal)"}\nstderr: ${r.stderr.toString().trim()}\n` +
            "(launcher must not write to the package dir at command time)",
        );
      }
    });
  } finally {
    // restore write permission before cleanup
    try { chmodSync(tmp, 0o755); } catch { /* ignore */ }
    try { chmodSync(join(tmp, "scripts"), 0o755); } catch { /* ignore */ }
    try { chmodSync(join(tmp, "scripts", "pipeline-launcher.mjs"), 0o644); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5. Malformed core/package.json: `pipeline doctor` must surface
//    install:version-coherence failure instead of crashing with
//    ERR_INVALID_PACKAGE_CONFIG.  Regression for review-2 finding 265eae52.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-launcher-badpkg-"));
  try {
    const { writeFileSync } = await import("node:fs");
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(LAUNCHER, join(tmp, "scripts", "pipeline-launcher.mjs"));
    mkdirSync(join(tmp, "core", "scripts"), { recursive: true });
    // Deliberately write malformed JSON to core/package.json.
    writeFileSync(join(tmp, "core", "package.json"), "{ this is not valid json }");
    writeFileSync(join(tmp, "core", "scripts", "pipeline.ts"), "// stub\n");
    mkdirSync(join(tmp, "core", "node_modules"), { recursive: true });

    check("malformed core/package.json: `doctor` exits non-zero with install:version-coherence failure", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "doctor"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const out = r.stdout.toString() + r.stderr.toString();
      if (!out.includes("install:version-coherence")) {
        throw new Error(
          `expected install:version-coherence in output; got:\n${out.slice(0, 400)}`,
        );
      }
      if (!out.includes("Reinstall")) {
        throw new Error(
          `expected reinstall remediation in output; got:\n${out.slice(0, 400)}`,
        );
      }
    });

    check("malformed core/package.json: non-doctor commands exit non-zero with error message", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "run", "1"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const err = r.stderr.toString();
      if (!err.includes("not valid JSON") && !err.includes("npm install")) {
        throw new Error(`expected reinstall hint in stderr; got:\n${err.slice(0, 400)}`);
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nlauncher smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
