// Tests for the CLI `--version` / `-V` flag (#117).
//
// Three layers:
//   1. Single-source-of-truth invariant: the VERSION exported by pipeline.ts
//      (resolved at runtime from ../package.json) must equal the `version` field
//      of core/package.json. This is what makes a version bump reflect
//      automatically — and bites if anyone ever hardcodes the string.
//   2. End-to-end CLI behavior: `pipeline --version` and the short alias
//      `pipeline -V` each print the version to stdout and exit 0, without an
//      issue number and without touching GitHub.
//   3. Shim regression: the installed entrypoint (entry.template.mjs) returns
//      the version even when core/node_modules is absent and npm is not on PATH,
//      proving the short-circuit fires before dependency provisioning.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../scripts/pipeline.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));
const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const TEMPLATE_PATH = fileURLToPath(new URL("../../hosts/_shared/entry.template.mjs", import.meta.url));
const CORE_DIR = fileURLToPath(new URL("..", import.meta.url));

function pkgVersion(): string {
  return (JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as { version: string }).version;
}

test("VERSION is single-sourced from core/package.json", () => {
  assert.equal(VERSION, pkgVersion());
});

function runFlag(flag: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PIPELINE_SCRIPT, flag], {
    encoding: "utf8",
    // Deliberately no gh on PATH and no issue number: --version must short-circuit
    // before any config resolution or GitHub interaction.
    env: { ...process.env, PATH: path.dirname(process.execPath) },
  });
}

for (const flag of ["--version", "-V"]) {
  test(`CLI: \`pipeline ${flag}\` prints the version and exits 0`, () => {
    const result = runFlag(flag);
    assert.equal(result.status, 0, `expected exit 0; stderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), pkgVersion());
  });
}

// Shim regression: --version must short-circuit BEFORE npm ci, so it works
// even on a fresh install with no node_modules and no npm available.
for (const flag of ["--version", "-V"]) {
  test(`shim: \`pipeline ${flag}\` works with no node_modules and no npm on PATH`, () => {
    // Build a minimal fake install layout: <tmp>/scripts/pipeline.mjs (the shim),
    // <tmp>/core/package.json (version only), <tmp>/core/scripts/pipeline.ts (empty stub).
    // Critically: no <tmp>/core/node_modules.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-shim-test-"));
    try {
      const shimScriptsDir = path.join(tmpDir, "scripts");
      const coreSrcDir = path.join(tmpDir, "core", "scripts");
      fs.mkdirSync(shimScriptsDir, { recursive: true });
      fs.mkdirSync(coreSrcDir, { recursive: true });

      // Copy template, substituting __PROFILE__ to keep the shim valid JS.
      const shimSrc = fs.readFileSync(TEMPLATE_PATH, "utf8").replaceAll("__PROFILE__", "test");
      const shimPath = path.join(shimScriptsDir, "pipeline.mjs");
      fs.writeFileSync(shimPath, shimSrc);

      // Minimal core/package.json with the real version.
      fs.writeFileSync(
        path.join(tmpDir, "core", "package.json"),
        JSON.stringify({ version: pkgVersion() }),
      );

      // Stub pipeline.ts entry so the entry-exists check passes.
      fs.writeFileSync(path.join(coreSrcDir, "pipeline.ts"), "// stub\n");

      // Run with no npm on PATH — the shim must exit before reaching npm ci.
      const result = spawnSync(process.execPath, [shimPath, flag], {
        encoding: "utf8",
        env: { ...process.env, PATH: path.dirname(process.execPath) },
      });
      assert.equal(
        result.status,
        0,
        `shim exited ${result.status} for ${flag}; stderr:\n${result.stderr}`,
      );
      assert.equal(result.stdout.trim(), pkgVersion());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}
