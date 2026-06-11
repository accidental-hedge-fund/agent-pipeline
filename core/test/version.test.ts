// Tests for the CLI `--version` / `-V` flag (#117).
//
// Two layers:
//   1. Single-source-of-truth invariant: the VERSION exported by pipeline.ts
//      (resolved at runtime from ../package.json) must equal the `version` field
//      of core/package.json. This is what makes a version bump reflect
//      automatically — and bites if anyone ever hardcodes the string.
//   2. End-to-end CLI behavior: `pipeline --version` and the short alias
//      `pipeline -V` each print the version to stdout and exit 0, without an
//      issue number and without touching GitHub.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../scripts/pipeline.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));
const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

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
