// Tests for the `init` command: ensure-labels path, config scaffold, no-clobber,
// and scaffolded-config validity via round-trip through resolveConfig.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../scripts/types.ts";
import { scaffoldDefaultConfig } from "../scripts/config.ts";
import { runInit } from "../scripts/pipeline.ts";

const PIPELINE_SCRIPT = fileURLToPath(new URL("../scripts/pipeline.ts", import.meta.url));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-init-test-"));

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "repo-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

/** Fake gh that handles label list/create and repo view; fails on issue/PR endpoints. */
function makeFakeGhBin(opts: { repoSlug: string; logFile?: string }): string {
  const binDir = fs.mkdtempSync(path.join(tmpRoot, "bin-"));
  const ghPath = path.join(binDir, "gh");
  const logLine = opts.logFile
    ? `echo "$*" >> "${opts.logFile}"\n`
    : "";
  fs.writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
${logLine}case "$1" in
  label)
    if [[ "$2" == "list" ]]; then echo "[]"; exit 0; fi
    if [[ "$2" == "create" ]]; then exit 0; fi
    echo "unexpected label subcommand: $2" >&2; exit 1;;
  repo)
    echo "${opts.repoSlug}"; exit 0;;
  issue|pr)
    echo "ERROR: init must not touch issue/PR endpoints; got: $*" >&2; exit 1;;
  *)
    echo "unexpected gh subcommand: $*" >&2; exit 1;;
esac
`,
  );
  fs.chmodSync(ghPath, 0o755);
  return binDir;
}

// ---------------------------------------------------------------------------
// 3.1 ensurePipelineLabels path
// ---------------------------------------------------------------------------

test("runInit: calls ensurePipelineLabels (label list + label create) without touching issue/PR endpoints", async () => {
  const repo = makeTempRepo();
  const logFile = path.join(tmpRoot, `gh-log-${Date.now()}.txt`);
  const binDir = makeFakeGhBin({ repoSlug: "acme/test-init", logFile });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  try {
    const cfg = {
      ...DEFAULT_CONFIG,
      profile_name: "test",
      invocation: "$pipeline",
      review_mode: "prompt-harness" as const,
      marker_footer: "",
      implementation_ready_message: "",
      conventions_default: "CLAUDE.md",
      domain: "test-init",
      repo: "acme/test-init",
      repo_dir: repo,
    };

    await runInit(cfg);

    // Label list must have been called (fake gh logs all args).
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    assert.ok(log.includes("label list"), `expected label list in gh log; got:\n${log}`);
    assert.ok(log.includes("label create"), `expected label create in gh log; got:\n${log}`);
    // No issue or pr calls.
    assert.ok(!log.includes("issue"), `runInit must not call gh issue; log:\n${log}`);
    assert.ok(!log.includes(" pr "), `runInit must not call gh pr; log:\n${log}`);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// 3.2 scaffold-config-when-absent
// ---------------------------------------------------------------------------

test("scaffoldDefaultConfig: creates .github/pipeline.yml when absent and returns { created: true }", async () => {
  const repo = makeTempRepo();
  const result = await scaffoldDefaultConfig(repo);

  assert.equal(result.created, true);

  const configPath = path.join(repo, ".github", "pipeline.yml");
  assert.ok(fs.existsSync(configPath), ".github/pipeline.yml should exist after scaffold");

  const content = fs.readFileSync(configPath, "utf8");
  assert.ok(content.length > 0, "scaffolded file should not be empty");
  // Sanity: file looks like YAML (has a non-comment line with a colon).
  const yamlLines = content.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  assert.ok(yamlLines.length > 0, "scaffolded file should have non-comment YAML lines");
});

// ---------------------------------------------------------------------------
// 3.3 no-clobber-when-present
// ---------------------------------------------------------------------------

test("scaffoldDefaultConfig: does not overwrite an existing .github/pipeline.yml and returns { created: false }", async () => {
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, ".github"), { recursive: true });

  const sentinel = "# sentinel: do not overwrite\nbase_branch: sentinel\n";
  const configPath = path.join(repo, ".github", "pipeline.yml");
  fs.writeFileSync(configPath, sentinel, "utf8");

  const result = await scaffoldDefaultConfig(repo);

  assert.equal(result.created, false);
  assert.equal(fs.readFileSync(configPath, "utf8"), sentinel, "existing file must be unchanged");
});

// ---------------------------------------------------------------------------
// 3.4 scaffolded-config validity
// ---------------------------------------------------------------------------

test("scaffoldDefaultConfig: scaffolded file round-trips through resolveConfig with DEFAULT_CONFIG values", async () => {
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/scaffold-validity" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  try {
    await scaffoldDefaultConfig(repo);

    // Dynamic import to avoid module-cache issues with PATH-sensitive resolveConfig.
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });

    // Core scalar defaults.
    assert.equal(cfg.base_branch, DEFAULT_CONFIG.base_branch);
    assert.equal(cfg.worktree_root, DEFAULT_CONFIG.worktree_root);
    assert.equal(cfg.max_concurrent_worktrees, DEFAULT_CONFIG.max_concurrent_worktrees);
    assert.equal(cfg.auto_merge, DEFAULT_CONFIG.auto_merge);
    assert.equal(cfg.auto_recovery_max_retries, DEFAULT_CONFIG.auto_recovery_max_retries);
    assert.equal(cfg.implementation_timeout, DEFAULT_CONFIG.implementation_timeout);
    assert.equal(cfg.review_timeout, DEFAULT_CONFIG.review_timeout);
    assert.equal(cfg.fix_timeout, DEFAULT_CONFIG.fix_timeout);
    assert.equal(cfg.ci_timeout, DEFAULT_CONFIG.ci_timeout);
    assert.equal(cfg.ci_poll_interval, DEFAULT_CONFIG.ci_poll_interval);

    // Nested objects.
    assert.deepEqual(cfg.models, DEFAULT_CONFIG.models);
    assert.deepEqual(cfg.openspec, DEFAULT_CONFIG.openspec);
    assert.deepEqual(cfg.last30days, DEFAULT_CONFIG.last30days);
    assert.deepEqual(cfg.steps, DEFAULT_CONFIG.steps);

    // test_gate: enabled + numeric fields; command stays undefined (commented out).
    assert.equal(cfg.test_gate.enabled, DEFAULT_CONFIG.test_gate.enabled);
    assert.equal(cfg.test_gate.max_attempts, DEFAULT_CONFIG.test_gate.max_attempts);
    assert.equal(cfg.test_gate.timeout, DEFAULT_CONFIG.test_gate.timeout);
    assert.equal(cfg.test_gate.command, undefined);

    // eval_gate: same pattern.
    assert.equal(cfg.eval_gate.enabled, DEFAULT_CONFIG.eval_gate.enabled);
    assert.equal(cfg.eval_gate.mode, DEFAULT_CONFIG.eval_gate.mode);
    assert.equal(cfg.eval_gate.timeout, DEFAULT_CONFIG.eval_gate.timeout);
    assert.equal(cfg.eval_gate.max_attempts, DEFAULT_CONFIG.eval_gate.max_attempts);
    assert.equal(cfg.eval_gate.command, undefined);
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// 3.5 CLI-level: `pipeline init` positional arg routes to init, not numeric error
// ---------------------------------------------------------------------------

test("CLI: `pipeline init` (positional arg) runs init and does not emit the numeric-arg error", () => {
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/cli-init-test" });

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "init", "--repo-path", repo],
    {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );

  // Must not emit the "argument <number> is required" fallback message.
  assert.ok(
    !result.stderr.includes("argument <number> is required"),
    `CLI emitted numeric-arg error when given 'init'; stderr:\n${result.stderr}`,
  );
  // Process must not exit with code 2 (the parse-error exit).
  assert.notEqual(result.status, 2, `CLI exited with code 2; stderr:\n${result.stderr}`);
});
