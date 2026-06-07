// Config loader tests. We mock by writing a fake `.github/pipeline.yml` into
// a temp git-like directory and stubbing PATH so `gh repo view` returns a
// canned value.
//
// Because resolveConfig() shells out to `gh`, we run a small subset of tests
// that don't require gh (parsing config text directly via a parseConfig hook
// would require refactoring config.ts; instead we just validate the merged
// shape after a successful load via a fake gh).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG } from "../scripts/types.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-cfg-test-"));

function makeFakeRepo(content: string | null): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (content !== null) {
    fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".github", "pipeline.yml"), content);
  }
  return dir;
}

function makeFakeGh(repoSlug: string): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  // Tiny shell stub that prints repo slug on `gh repo view` and exits 0.
  fs.writeFileSync(ghPath, `#!/usr/bin/env bash\necho "${repoSlug}"\n`);
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

test("resolveConfig: defaults apply when no .github/pipeline.yml exists", async () => {
  const repo = makeFakeRepo(null);
  const binDir = makeFakeGh("acme/widget");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const { resolveConfig } = await import("../scripts/config.ts");
    const cfg = resolveConfig({ repoPath: repo });
    assert.equal(cfg.repo, "acme/widget");
    // resolveConfig uses path.resolve which doesn't resolve symlinks, but
    // mkdtemp on macOS may return /var/... while realpath gives /private/var.
    // Compare via realpath to normalize.
    assert.equal(fs.realpathSync(cfg.repo_dir), fs.realpathSync(repo));
    assert.equal(cfg.base_branch, DEFAULT_CONFIG.base_branch);
    assert.equal(cfg.worktree_root, DEFAULT_CONFIG.worktree_root);
    assert.equal(cfg.max_concurrent_worktrees, DEFAULT_CONFIG.max_concurrent_worktrees);
    assert.equal(cfg.auto_merge, false);
    assert.deepEqual(cfg.harnesses, { implementer: "codex", reviewer: "claude" });
    assert.deepEqual(cfg.steps, { plan_review: true, standard_review: true, adversarial_review: true, docs: true });
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: merges file overrides over defaults but keeps Codex/Claude harness split", async () => {
  const repo = makeFakeRepo(`base_branch: staging
max_concurrent_worktrees: 7
auto_merge: false
harnesses:
  implementer: claude
  reviewer: codex
models:
  planning: sonnet
  review: opus
  fix: sonnet
`);
  const binDir = makeFakeGh("acme/widget2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    // Re-import so we don't get a cached version (Node caches by URL/path).
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.base_branch, "staging");
    assert.equal(cfg.max_concurrent_worktrees, 7);
    assert.equal(cfg.harnesses.implementer, "codex");
    assert.equal(cfg.harnesses.reviewer, "claude");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: invalid yaml → throws with parse details", async () => {
  // Type error: max_concurrent_worktrees as string
  const repo = makeFakeRepo(`max_concurrent_worktrees: not-a-number\n`);
  const binDir = makeFakeGh("acme/widget3");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(
      () => cfgMod.resolveConfig({ repoPath: repo }),
      /Invalid .*pipeline\.yml/,
    );
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: --base override wins over file value", async () => {
  const repo = makeFakeRepo(`base_branch: staging\n`);
  const binDir = makeFakeGh("acme/widget4");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo, baseBranch: "develop" });
    assert.equal(cfg.base_branch, "develop");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: a configurable step can be disabled, others stay default-on", async () => {
  const repo = makeFakeRepo(`steps:\n  adversarial_review: false\n  docs: false\n`);
  const binDir = makeFakeGh("acme/steps1");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    assert.equal(cfg.steps.adversarial_review, false);
    assert.equal(cfg.steps.docs, false);
    assert.equal(cfg.steps.standard_review, true); // unspecified → default on
    assert.equal(cfg.steps.plan_review, true);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("resolveConfig: disabling a protected step is rejected (strict schema)", async () => {
  // CI / mergeability / planning / implementing are not configurable; an unknown
  // step key is rejected at parse time rather than silently dropping a safety gate.
  const repo = makeFakeRepo(`steps:\n  mergeability: false\n`);
  const binDir = makeFakeGh("acme/steps2");
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    assert.throws(() => cfgMod.resolveConfig({ repoPath: repo }), /Invalid .*pipeline\.yml/);
  } finally {
    process.env.PATH = oldPath;
  }
});
