#!/usr/bin/env node
// Behavior tests for .githooks/pre-commit. Each test builds a throwaway git repo,
// installs the real hook (core.hooksPath = .githooks) alongside a *stub* build.mjs
// (the real one's --check is covered separately), then drives `git commit` and
// asserts on the resulting commit. The stub writes a sentinel marker so a test
// can prove whether build.mjs ran at all.
//
// Run with: node --test scripts/pre-commit-hook.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SRC = join(REPO_ROOT, ".githooks", "pre-commit");

// Stub build.mjs: drops a marker so a test can detect whether it ran, plus a
// minimal mirror under the two generated paths the hook is contracted to stage.
const BUILD_STUB = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("plugin/pipeline", { recursive: true });
mkdirSync(".claude-plugin", { recursive: true });
writeFileSync("build-ran.marker", "ran\\n");
writeFileSync("plugin/pipeline/generated.txt", "generated\\n");
writeFileSync(".claude-plugin/marketplace.json", "{}\\n");
`;

const FAILING_BUILD = `process.exit(1);\n`;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

// Build a temp repo with the real hook wired in. The scaffold commit lands
// *before* core.hooksPath is set, so it never triggers the hook itself.
function setupRepo(buildScript = BUILD_STUB) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-hook-test-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);

  mkdirSync(join(dir, ".githooks"));
  copyFileSync(HOOK_SRC, join(dir, ".githooks", "pre-commit"));
  chmodSync(join(dir, ".githooks", "pre-commit"), 0o755);

  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "build.mjs"), buildScript);

  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "scaffold"]);

  // Activate the hook only now — exactly what `npm run setup-hooks` does.
  git(dir, ["config", "core.hooksPath", ".githooks"]);
  return dir;
}

function stage(dir, relPath, contents) {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  git(dir, ["add", relPath]);
}

function committedFiles(dir) {
  return git(dir, ["show", "--name-only", "--pretty=format:", "HEAD"])
    .split("\n")
    .filter(Boolean);
}

function withRepo(buildScript, fn) {
  const dir = setupRepo(buildScript);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("core/ edit triggers regeneration and stages the mirror in the same commit", () => {
  withRepo(BUILD_STUB, (dir) => {
    stage(dir, "core/foo.ts", "export const x = 1;\n");
    git(dir, ["commit", "-q", "-m", "edit core"]);

    assert.ok(existsSync(join(dir, "build-ran.marker")), "build.mjs should have run");
    const files = committedFiles(dir);
    assert.ok(files.includes("core/foo.ts"), "core edit committed");
    assert.ok(files.includes("plugin/pipeline/generated.txt"), "regenerated mirror staged");
    assert.ok(files.includes(".claude-plugin/marketplace.json"), "marketplace.json staged");
  });
});

test("hosts/claude/ edit also triggers regeneration", () => {
  withRepo(BUILD_STUB, (dir) => {
    stage(dir, "hosts/claude/SKILL.md", "# overlay\n");
    git(dir, ["commit", "-q", "-m", "edit claude overlay"]);

    assert.ok(existsSync(join(dir, "build-ran.marker")), "build.mjs should have run");
    assert.ok(committedFiles(dir).includes("plugin/pipeline/generated.txt"));
  });
});

test("docs-only commit skips regeneration entirely", () => {
  withRepo(BUILD_STUB, (dir) => {
    stage(dir, "README.md", "# docs\n");
    git(dir, ["commit", "-q", "-m", "docs only"]);

    assert.ok(
      !existsSync(join(dir, "build-ran.marker")),
      "build.mjs must not run when no core/ or hosts/claude/ path is staged",
    );
    assert.deepEqual(committedFiles(dir), ["README.md"], "no extra files staged");
  });
});

test("a hosts/ path outside hosts/claude/ does not trigger regeneration", () => {
  withRepo(BUILD_STUB, (dir) => {
    stage(dir, "hosts/codex/SKILL.md", "# codex overlay\n");
    git(dir, ["commit", "-q", "-m", "edit codex overlay"]);

    assert.ok(
      !existsSync(join(dir, "build-ran.marker")),
      "only core/ and hosts/claude/ are mirror sources",
    );
    assert.deepEqual(committedFiles(dir), ["hosts/codex/SKILL.md"]);
  });
});

test("hook stages only the generated paths, never unrelated working-tree changes", () => {
  withRepo(BUILD_STUB, (dir) => {
    stage(dir, "core/foo.ts", "export const x = 1;\n");
    // Unrelated, deliberately-unstaged working-tree file present at commit time.
    writeFileSync(join(dir, "unrelated.txt"), "do not stage me\n");

    git(dir, ["commit", "-q", "-m", "edit core with a dirty working tree"]);

    assert.ok(
      !committedFiles(dir).includes("unrelated.txt"),
      "hook must not stage unrelated working-tree changes",
    );
    assert.match(
      git(dir, ["status", "--porcelain"]),
      /^\?\? unrelated\.txt$/m,
      "unrelated file remains untracked after commit",
    );
  });
});

test("hook failure aborts the commit", () => {
  withRepo(FAILING_BUILD, (dir) => {
    stage(dir, "core/foo.ts", "export const x = 1;\n");
    const r = spawnSync("git", ["commit", "-q", "-m", "should abort"], {
      cwd: dir,
      encoding: "utf8",
    });

    assert.notEqual(r.status, 0, "git commit must fail when build.mjs exits non-zero");
    assert.doesNotMatch(git(dir, ["log", "--oneline"]), /should abort/, "no commit created");
  });
});
