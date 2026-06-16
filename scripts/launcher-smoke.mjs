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
// 3. launcher exits non-zero with a diagnostic when core/node_modules is absent
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-launcher-no-deps-"));
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(LAUNCHER, join(tmp, "scripts", "pipeline-launcher.mjs"));
    // symlink core WITHOUT node_modules so the check fires
    mkdirSync(join(tmp, "core", "scripts"), { recursive: true });
    // write a minimal core/package.json so the entry-file check doesn't fire first
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(tmp, "core", "package.json"),
      JSON.stringify({ name: "agent-pipeline-core", version: "0.0.0" }),
    );
    // create a stub pipeline.ts so the core-not-found check passes
    writeFileSync(join(tmp, "core", "scripts", "pipeline.ts"), "// stub\n");
    // deliberately do NOT create core/node_modules

    check("missing core/node_modules → exits non-zero with diagnostic", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "path", "--json"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when node_modules absent");
      const stderr = r.stderr.toString();
      if (!stderr.includes("npm install -g agent-pipeline")) {
        throw new Error(`expected re-install hint in stderr; got: ${stderr.slice(0, 300)}`);
      }
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
// Summary
// ---------------------------------------------------------------------------
console.log(`\nlauncher smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
