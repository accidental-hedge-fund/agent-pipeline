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
    // A real-looking path-cli.ts so the `path` fast-path would reach its spawn
    // (and trip ERR_INVALID_PACKAGE_CONFIG) unless the corrupt-install guard runs first.
    writeFileSync(join(tmp, "core", "scripts", "path-cli.ts"), "console.log('{}');\n");
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

    // The `path` fast-path spawns core/scripts/path-cli.ts, which Node refuses to
    // load under a malformed core/package.json (ERR_INVALID_PACKAGE_CONFIG). The
    // corrupt-install guard must run BEFORE the `path` fast-path so desktop
    // discovery gets a coherent diagnostic, not a raw Node stack. Regression for
    // review-2 finding 2fa82126.
    check("malformed core/package.json: `path --json` gives a coherent diagnostic, not a raw Node error", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "path", "--json"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const out = r.stdout.toString() + r.stderr.toString();
      if (out.includes("ERR_INVALID_PACKAGE_CONFIG")) {
        throw new Error(`path fast-path leaked a raw Node config error; got:\n${out.slice(0, 400)}`);
      }
      if (!out.includes("not valid JSON") && !out.includes("npm install")) {
        throw new Error(`expected the corrupt-install diagnostic; got:\n${out.slice(0, 400)}`);
      }
    });

    // The corrupt-install doctor fallback must honor doctor's machine-output
    // contracts, not just the human prose path. Regression for review-2 finding
    // 77015982 (fallback emitted prose for `--json`/`--is-ok` too).
    check("malformed core/package.json: `doctor --json` emits the stable doctor JSON envelope", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "doctor", "--json"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      let json;
      try {
        json = JSON.parse(r.stdout.toString());
      } catch {
        throw new Error(`doctor --json stdout is not valid JSON: ${r.stdout.toString().slice(0, 300)}`);
      }
      if (json.schema_version !== "1") throw new Error(`unexpected schema_version: ${json.schema_version}`);
      if (json.status !== "error") throw new Error(`expected status "error"; got ${json.status}`);
      const vc = (json.checks ?? []).find((c) => c.name === "install:version-coherence");
      if (!vc) throw new Error(`missing install:version-coherence check: ${JSON.stringify(json)}`);
      if (vc.ok !== false) throw new Error("expected install:version-coherence ok=false");
      if (!vc.fix) throw new Error("expected a non-empty reinstall remediation in the `fix` field");
    });

    check("malformed core/package.json: `doctor --is-ok` is silent and exits non-zero", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "doctor", "--is-ok"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const out = r.stdout.toString() + r.stderr.toString();
      if (out.length !== 0) {
        throw new Error(`expected zero output for --is-ok; got: ${JSON.stringify(out.slice(0, 200))}`);
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 6. Malformed core/package.json AND core/node_modules absent: `pipeline doctor`
//    must STILL surface install:version-coherence, not bail at the dependency
//    check with a generic runtime-dependencies error. Regression for review-2
//    finding 6423de8e (the corrupt-install guard ran after the node_modules
//    check, leaving this realistic partial-install path undiagnosed).
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-launcher-badpkg-nodeps-"));
  try {
    const { writeFileSync } = await import("node:fs");
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    copyFileSync(LAUNCHER, join(tmp, "scripts", "pipeline-launcher.mjs"));
    mkdirSync(join(tmp, "core", "scripts"), { recursive: true });
    writeFileSync(join(tmp, "core", "package.json"), "{ this is not valid json }");
    writeFileSync(join(tmp, "core", "scripts", "pipeline.ts"), "// stub\n");
    // deliberately do NOT create core/node_modules

    check("malformed core/package.json + no node_modules: `doctor` surfaces version-coherence, not a deps error", () => {
      const r = spawnSync(NODE, [join(tmp, "scripts", "pipeline-launcher.mjs"), "doctor"], {
        stdio: "pipe",
      });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const out = r.stdout.toString() + r.stderr.toString();
      if (!out.includes("install:version-coherence")) {
        throw new Error(`expected install:version-coherence (not a deps error); got:\n${out.slice(0, 400)}`);
      }
      if (out.includes("runtime dependencies not found")) {
        throw new Error(`corrupt-install guard ran after node_modules check; got deps error:\n${out.slice(0, 400)}`);
      }
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 7. The host shim (hosts/_shared/entry.template.mjs) shares the corrupt-install
//    doctor fallback and must honor the same machine-output contracts. Exercise
//    the template directly by substituting __PROFILE__ (as build.mjs does) into a
//    temp shim. Regression for review-2 finding 77015982 at its primary location.
// ---------------------------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "pipeline-entry-badpkg-"));
  try {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const tmpl = readFileSync(join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs"), "utf8");
    mkdirSync(join(tmp, "scripts"), { recursive: true });
    writeFileSync(join(tmp, "scripts", "pipeline.mjs"), tmpl.replaceAll("__PROFILE__", "claude"));
    mkdirSync(join(tmp, "core", "scripts"), { recursive: true });
    writeFileSync(join(tmp, "core", "package.json"), "{ this is not valid json }");
    writeFileSync(join(tmp, "core", "scripts", "pipeline.ts"), "// stub\n");
    mkdirSync(join(tmp, "core", "node_modules"), { recursive: true });
    const shim = join(tmp, "scripts", "pipeline.mjs");

    check("entry shim, malformed core/package.json: `doctor --json` emits valid envelope", () => {
      const r = spawnSync(NODE, [shim, "doctor", "--json"], { stdio: "pipe" });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      let json;
      try {
        json = JSON.parse(r.stdout.toString());
      } catch {
        throw new Error(`doctor --json stdout is not valid JSON: ${r.stdout.toString().slice(0, 300)}`);
      }
      const vc = (json.checks ?? []).find((c) => c.name === "install:version-coherence");
      if (!vc || vc.ok !== false) throw new Error(`expected failing install:version-coherence: ${JSON.stringify(json)}`);
    });

    check("entry shim, malformed core/package.json: `doctor --is-ok` is silent and exits non-zero", () => {
      const r = spawnSync(NODE, [shim, "doctor", "--is-ok"], { stdio: "pipe" });
      if (r.status === 0) throw new Error("expected non-zero exit when core/package.json is malformed");
      const out = r.stdout.toString() + r.stderr.toString();
      if (out.length !== 0) throw new Error(`expected zero output for --is-ok; got: ${JSON.stringify(out.slice(0, 200))}`);
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
