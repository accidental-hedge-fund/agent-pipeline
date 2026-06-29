#!/usr/bin/env node
// Tests for scripts/ci-openspec.mjs.
// Run with: node --test scripts/ci-openspec.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const GUARD = join(REPO_ROOT, "scripts", "ci-openspec.mjs");

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "ci-openspec-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function runGuard(cwd, env = {}) {
  return spawnSync(NODE, [GUARD], {
    cwd,
    env: { ...process.env, ...env },
    stdio: "pipe",
    encoding: "utf8",
  });
}

// ---------------------------------------------------------------------------
// 2.1 Drift-guard: the `ci` npm script must include the OpenSpec step
// ---------------------------------------------------------------------------

test("ci npm script includes ci:openspec step", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(
    pkg.scripts?.ci?.includes("ci:openspec"),
    `package.json 'ci' script must include 'ci:openspec'; got: ${pkg.scripts?.ci}`,
  );
  assert.ok(
    typeof pkg.scripts?.["ci:openspec"] === "string",
    "package.json must define a 'ci:openspec' script",
  );
});

// ---------------------------------------------------------------------------
// 2.2 No-op: exits 0 when no openspec/ directory is present
// ---------------------------------------------------------------------------

test("exits 0 (no-op) when no openspec/ directory is present", () => {
  const tmp = makeTmp();
  // tmp has no openspec/ subdirectory
  try {
    const result = runGuard(tmp);
    assert.equal(
      result.status,
      0,
      `guard must exit 0 (no-op) without openspec/; got exit ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    // Must not attempt validation (openspec outputs "Validating..." on stdout)
    assert.ok(
      !result.stdout.includes("Validating"),
      "guard must not invoke openspec validate when no openspec/ dir exists",
    );
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 2.3 Regression: exits non-zero when the workspace is structurally invalid
// ---------------------------------------------------------------------------

test("exits non-zero when openspec workspace is structurally invalid", () => {
  const tmp = makeTmp();
  try {
    // Minimal openspec workspace with an invalid spec (requirement missing Scenario:)
    mkdirSync(join(tmp, "openspec", "specs", "test-cap"), { recursive: true });
    writeFileSync(
      join(tmp, "openspec", "project.md"),
      "# test project\n",
    );
    writeFileSync(
      join(tmp, "openspec", "specs", "test-cap", "spec.md"),
      [
        "# test-cap spec",
        "",
        "### Requirement: A requirement without a Scenario",
        "",
        "This requirement SHALL do something but is missing a Scenario block.",
        "This makes the workspace structurally invalid.",
        "",
      ].join("\n"),
    );

    const result = runGuard(tmp);
    assert.notEqual(
      result.status,
      0,
      "guard must exit non-zero when the openspec workspace is invalid",
    );
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 2.2 (also via env override): CI_OPENSPEC_ROOT env var controls the root
// ---------------------------------------------------------------------------

test("CI_OPENSPEC_ROOT env var overrides root directory check", () => {
  const tmp = makeTmp();
  // tmp has no openspec/; run from REPO_ROOT but point guard at tmp via env var
  try {
    const result = runGuard(REPO_ROOT, { CI_OPENSPEC_ROOT: tmp });
    assert.equal(
      result.status,
      0,
      "guard must exit 0 when CI_OPENSPEC_ROOT points to a dir with no openspec/",
    );
  } finally {
    cleanup(tmp);
  }
});
