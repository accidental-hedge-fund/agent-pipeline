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

// ---------------------------------------------------------------------------
// Default-branch active-change hygiene guard
// ---------------------------------------------------------------------------

function makeMinimalOpenspecWorkspace(tmp) {
  mkdirSync(join(tmp, "openspec"), { recursive: true });
  writeFileSync(join(tmp, "openspec", "project.md"), "# test project\n");
}

function makeActiveChange(tmp, id) {
  const dir = join(tmp, "openspec", "changes", id);
  const specDir = join(dir, "specs", "test-cap");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    join(dir, "proposal.md"),
    [
      `# ${id}`,
      "",
      "## Why",
      "Test fixture.",
      "",
      "## What Changes",
      "- Nothing real.",
      "",
      "## Impact",
      "- None.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(specDir, "spec.md"),
    [
      "## ADDED Requirements",
      "",
      `### Requirement: The ${id} fixture`,
      "",
      "This fixture SHALL exist for test purposes.",
      "",
      "#### Scenario: Fixture exists",
      "- **WHEN** the fixture is loaded",
      "- **THEN** it SHALL validate",
      "",
    ].join("\n"),
  );
}

function makeArchive(tmp) {
  mkdirSync(join(tmp, "openspec", "changes", "archive"), { recursive: true });
}

function writeAllowlist(tmp, lines) {
  writeFileSync(join(tmp, "openspec", "active-allowlist.txt"), lines.join("\n") + "\n");
}

test("default-branch mode: unallowlisted active change fails and names the id", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "legacy-thing");

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.notEqual(result.status, 0, "guard must fail on an unallowlisted active change");
    assert.ok(result.stderr.includes("legacy-thing"), "output must name the offending id");
    assert.ok(
      result.stderr.includes("openspec archive"),
      "output must name the expected cleanup path",
    );
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: several unallowlisted active changes are all reported", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "one");
    makeActiveChange(tmp, "two");
    makeActiveChange(tmp, "three");

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.notEqual(result.status, 0);
    for (const id of ["one", "two", "three"]) {
      assert.ok(result.stderr.includes(id), `output must list ${id}`);
    }
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: clean default branch (only archive/) passes", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test("pr mode: active change present does not fail", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "in-flight-change");

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "pr" });
    assert.equal(result.status, 0, `expected exit 0 in pr mode; stderr: ${result.stderr}`);
    assert.ok(!result.stderr.includes("in-flight-change"));
  } finally {
    cleanup(tmp);
  }
});

test("undetermined mode (no env, no GitHub Actions, non-default local branch) is inert", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "whatever");

    // tmp is not a git repo at all, so local-branch resolution cannot determine
    // the checked-out branch — this must fail open (inert), not fail closed.
    const result = runGuard(tmp, {
      OPENSPEC_HYGIENE_MODE: undefined,
      GITHUB_EVENT_NAME: undefined,
      GITHUB_REF: undefined,
    });
    assert.equal(result.status, 0, `expected inert exit 0; stderr: ${result.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: allowlisted active change passes", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "long-lived-change");
    writeAllowlist(tmp, ["long-lived-change"]);

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: allowlist comments and blank lines are ignored", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "long-lived-change");
    writeAllowlist(tmp, [
      "# this is a comment",
      "",
      "long-lived-change",
      "",
      "# trailing comment",
    ]);

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.equal(result.status, 0, `expected exit 0; stderr: ${result.stderr}`);
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: stale allowlist entry is an error", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    writeAllowlist(tmp, ["no-longer-active"]);

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.notEqual(result.status, 0, "guard must fail on a stale allowlist entry");
    assert.ok(result.stderr.includes("no-longer-active"), "output must name the stale entry");
  } finally {
    cleanup(tmp);
  }
});

test("default-branch mode: missing allowlist file means strict (zero exemptions)", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "legacy-thing");
    // No active-allowlist.txt written at all.

    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.notEqual(result.status, 0, "missing allowlist file must not exempt anything");
  } finally {
    cleanup(tmp);
  }
});

test("no openspec/ directory is a no-op regardless of hygiene mode", () => {
  const tmp = makeTmp();
  try {
    const result = runGuard(tmp, { OPENSPEC_HYGIENE_MODE: "default-branch" });
    assert.equal(result.status, 0);
  } finally {
    cleanup(tmp);
  }
});

test("explicit OPENSPEC_HYGIENE_MODE=default-branch overrides GitHub Actions pull_request signal", () => {
  const tmp = makeTmp();
  try {
    makeMinimalOpenspecWorkspace(tmp);
    makeArchive(tmp);
    makeActiveChange(tmp, "legacy-thing");

    const result = runGuard(tmp, {
      OPENSPEC_HYGIENE_MODE: "default-branch",
      GITHUB_EVENT_NAME: "pull_request",
    });
    assert.notEqual(
      result.status,
      0,
      "explicit env override must win over the GitHub Actions environment",
    );
  } finally {
    cleanup(tmp);
  }
});
