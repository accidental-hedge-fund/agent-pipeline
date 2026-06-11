// Regression tests for .githooks/pre-commit partial-staging guard.
//
// The guard must abort when a contributor stages core/ or hosts/claude/ changes
// while leaving additional unstaged edits in those same directories — otherwise
// build.mjs would generate a plugin/ mirror from the working tree and embed
// uncommitted source changes into the committed mirror.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const hookPath = path.resolve(import.meta.dirname, "../../.githooks/pre-commit");

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-commit-test-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

  // Minimal repo skeleton with tracked files the hook touches.
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "core"));
  fs.mkdirSync(path.join(dir, "hosts/claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"));
  fs.mkdirSync(path.join(dir, "plugin"));

  // Fake build script — just exits 0; we only need to test the guard, not the build.
  fs.writeFileSync(path.join(dir, "scripts/build.mjs"), "process.exit(0);\n");
  fs.writeFileSync(path.join(dir, "core/a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "core/b.ts"), "export const b = 1;\n");
  fs.writeFileSync(path.join(dir, "hosts/claude/SKILL.md"), "skill v1\n");
  // plugin/ and marketplace.json are staged by the hook; they must pre-exist so `git add` succeeds.
  fs.writeFileSync(path.join(dir, "plugin/.gitkeep"), "");
  fs.writeFileSync(path.join(dir, ".claude-plugin/marketplace.json"), "{}\n");

  execSync("git add -A", { cwd: dir });
  execSync('git commit -m "init"', { cwd: dir });
  return dir;
}

function runHook(cwd: string): { status: number; stdout: string } {
  const r = spawnSync("sh", [hookPath], { cwd, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

// ---------------------------------------------------------------------------
// Regression: partial staging (the bug the guard fixes)
// ---------------------------------------------------------------------------

test("pre-commit hook: aborts when tracked core/ file has unstaged modifications", () => {
  const dir = makeRepo();
  try {
    // Stage a change to core/a.ts ...
    fs.writeFileSync(path.join(dir, "core/a.ts"), "export const a = 2;\n");
    execSync("git add core/a.ts", { cwd: dir });
    // ... but leave an unstaged modification to another tracked core/ file.
    fs.writeFileSync(path.join(dir, "core/b.ts"), "export const b = 2;\n");

    const { status, stdout } = runHook(dir);
    assert.equal(status, 1, "hook must exit 1 when unstaged core/ changes exist");
    assert.match(stdout, /unstaged changes/i, "hook must mention unstaged changes");
    assert.match(stdout, /core\/b\.ts/, "hook must name the offending file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook: aborts when tracked hosts/claude/ file has unstaged modifications", () => {
  const dir = makeRepo();
  try {
    // Stage a core/ change so the early-exit doesn't fire, then leave an
    // unstaged modification under hosts/claude/.
    fs.writeFileSync(path.join(dir, "core/a.ts"), "export const a = 2;\n");
    execSync("git add core/a.ts", { cwd: dir });
    fs.writeFileSync(path.join(dir, "hosts/claude/SKILL.md"), "skill v2 — unstaged\n");

    const { status, stdout } = runHook(dir);
    assert.equal(status, 1, "hook must exit 1 when unstaged hosts/claude/ changes exist");
    assert.match(stdout, /unstaged changes/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("pre-commit hook: exits 0 when no core/ or hosts/claude/ paths are staged", () => {
  const dir = makeRepo();
  try {
    // Only stage a README-level change; core/ has unstaged edits (should be irrelevant).
    fs.writeFileSync(path.join(dir, "README.md"), "updated\n");
    fs.writeFileSync(path.join(dir, "core/b.ts"), "export const b = 99;\n"); // unstaged
    execSync("git add README.md", { cwd: dir });

    const { status } = runHook(dir);
    assert.equal(status, 0, "hook must skip (exit 0) when core/ is not staged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook: exits 0 when all core/ changes are staged with no unstaged core/ edits", () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, "core/a.ts"), "export const a = 2;\n");
    execSync("git add core/a.ts", { cwd: dir });
    // Unrelated unstaged change outside mirror sources — must not trigger abort.
    fs.writeFileSync(path.join(dir, "README.md"), "unrelated\n");

    const { status } = runHook(dir);
    assert.equal(status, 0, "hook must proceed (exit 0) when no unstaged core/ changes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 1 regression: untracked source files must not leak into the mirror
// ---------------------------------------------------------------------------

test("pre-commit hook: aborts when untracked file exists under core/", () => {
  const dir = makeRepo();
  try {
    // Stage a change to core/a.ts ...
    fs.writeFileSync(path.join(dir, "core/a.ts"), "export const a = 2;\n");
    execSync("git add core/a.ts", { cwd: dir });
    // ... while an untracked file exists under core/ (build.mjs would copy it into plugin/).
    fs.mkdirSync(path.join(dir, "core", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "core", "scripts", "scratch.ts"), "// scratch\n");

    const { status, stdout } = runHook(dir);
    assert.equal(status, 1, "hook must exit 1 when untracked core/ files exist");
    assert.match(stdout, /untracked files/i, "hook must mention untracked files");
    assert.match(stdout, /core\/scripts\/scratch\.ts/, "hook must name the untracked file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 2: hosts/_shared/ is a build input and must trigger regeneration
// ---------------------------------------------------------------------------

function makeRepoWithShared(): string {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "hosts", "_shared"), { recursive: true });
  fs.writeFileSync(path.join(dir, "hosts", "_shared", "entry.template.mjs"), "template\n");
  execSync("git add hosts/_shared/", { cwd: dir });
  execSync('git commit -m "add hosts/_shared"', { cwd: dir });
  return dir;
}

test("pre-commit hook: triggers regeneration when hosts/_shared/ change is staged", () => {
  const dir = makeRepoWithShared();
  try {
    fs.writeFileSync(path.join(dir, "hosts", "_shared", "entry.template.mjs"), "updated\n");
    execSync("git add hosts/_shared/", { cwd: dir });

    const { status, stdout } = runHook(dir);
    assert.equal(status, 0, "hook must run regeneration for staged hosts/_shared/ changes");
    assert.match(stdout, /regenerating plugin\/ mirror/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pre-commit hook: aborts when tracked hosts/_shared/ file has unstaged modifications", () => {
  const dir = makeRepoWithShared();
  try {
    // Stage a core/ change so the early-exit path does not fire ...
    fs.writeFileSync(path.join(dir, "core", "a.ts"), "export const a = 2;\n");
    execSync("git add core/a.ts", { cwd: dir });
    // ... but leave an unstaged modification to hosts/_shared/.
    fs.writeFileSync(path.join(dir, "hosts", "_shared", "entry.template.mjs"), "modified\n");

    const { status, stdout } = runHook(dir);
    assert.equal(status, 1, "hook must exit 1 when unstaged hosts/_shared/ changes exist");
    assert.match(stdout, /unstaged changes/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
