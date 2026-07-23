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
import { resolveConfig, scaffoldDefaultConfig } from "../scripts/config.ts";
import { runInit } from "../scripts/pipeline.ts";
import { renderArtifactIgnoreBlock } from "../scripts/artifact-ignore.ts";

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
    assert.equal(cfg.auto_recovery_max_retries, DEFAULT_CONFIG.auto_recovery_max_retries);
    assert.equal(cfg.implementation_timeout, DEFAULT_CONFIG.implementation_timeout);
    assert.equal(cfg.review_timeout, DEFAULT_CONFIG.review_timeout);
    assert.equal(cfg.fix_timeout, DEFAULT_CONFIG.fix_timeout);
    assert.equal(cfg.ci_timeout, DEFAULT_CONFIG.ci_timeout);
    assert.equal(cfg.ci_poll_interval, DEFAULT_CONFIG.ci_poll_interval);

    // Nested objects. `models.review` is absent from the scaffolded config, so
    // reviewWasAuto is true (#441 finding a74ee050) — no explicit override, same
    // as an authored "auto".
    assert.deepEqual(cfg.models, { ...DEFAULT_CONFIG.models, reviewWasAuto: true });
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

test("scaffoldDefaultConfig: scaffolded file emits no inert-models warning on resolve (#116)", async () => {
  // The scaffold leaves `models:` commented out, so a freshly-scaffolded repo
  // does not trip the inert-alias warning under the default codex profile
  // (where planning/fix map to the codex implementer). The warning fires only
  // on user-authored aliases, not on the tool's own default output.
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/scaffold-no-warn" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  const origWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await scaffoldDefaultConfig(repo);
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    cfgMod.resolveConfig({ repoPath: repo });
    assert.deepEqual(
      warnings.filter((w) => w.includes("models.")),
      [],
      `scaffolded config tripped an inert-models warning: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = origWarn;
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

// ---------------------------------------------------------------------------
// 3.6 init tolerates an invalid existing .github/pipeline.yml (regression)
// ---------------------------------------------------------------------------

test("resolveConfig: tolerateInvalidConfig=true warns and falls back to defaults instead of throwing", async () => {
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
  // Write a config that fails strict schema validation (unknown key).
  fs.writeFileSync(path.join(repo, ".github", "pipeline.yml"), "unknown_key: bad-value\n", "utf8");

  const binDir = makeFakeGhBin({ repoSlug: "acme/tolerate-invalid" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;

  try {
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    // Must not throw; must return a valid config using defaults.
    const cfg = cfgMod.resolveConfig({ repoPath: repo, tolerateInvalidConfig: true });
    assert.equal(cfg.base_branch, DEFAULT_CONFIG.base_branch);
    assert.equal(cfg.max_concurrent_worktrees, DEFAULT_CONFIG.max_concurrent_worktrees);
    // Invalid file is preserved on disk.
    const onDisk = fs.readFileSync(path.join(repo, ".github", "pipeline.yml"), "utf8");
    assert.equal(onDisk, "unknown_key: bad-value\n", "invalid config file must not be overwritten");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("CLI: `pipeline init` with invalid pre-existing .github/pipeline.yml ensures labels, preserves file, exits 0", () => {
  const repo = makeTempRepo();
  fs.mkdirSync(path.join(repo, ".github"), { recursive: true });
  const invalidContent = "unknown_key: bad-value\n";
  const configPath = path.join(repo, ".github", "pipeline.yml");
  fs.writeFileSync(configPath, invalidContent, "utf8");

  const logFile = path.join(tmpRoot, `gh-log-invalid-cfg-${Date.now()}.txt`);
  const binDir = makeFakeGhBin({ repoSlug: "acme/invalid-cfg-init", logFile });

  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", PIPELINE_SCRIPT, "init", "--repo-path", repo],
    {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
      encoding: "utf8",
    },
  );

  // Must succeed despite the invalid config.
  assert.equal(result.status, 0, `CLI exited non-zero with invalid config; stderr:\n${result.stderr}\nstdout:\n${result.stdout}`);
  // Must have called label list + create (ensurePipelineLabels ran).
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  assert.ok(log.includes("label list"), `expected label list in gh log; got:\n${log}`);
  assert.ok(log.includes("label create"), `expected label create in gh log; got:\n${log}`);
  // Invalid file must be preserved (not overwritten by scaffold).
  assert.equal(fs.readFileSync(configPath, "utf8"), invalidContent, "invalid config file must be preserved");
});

// ---- repo_map scaffold (#312) ----

test("scaffoldDefaultConfig: scaffolded file includes commented-out repo_map block", async () => {
  const repo = makeTempRepo();
  await scaffoldDefaultConfig(repo);
  const content = fs.readFileSync(path.join(repo, ".github", "pipeline.yml"), "utf8");
  // The scaffold must include a commented-out repo_map block with depends_on and depended_on_by.
  assert.ok(content.includes("repo_map"), "scaffold must mention repo_map");
  assert.ok(content.includes("depends_on"), "scaffold must mention depends_on");
  assert.ok(content.includes("depended_on_by"), "scaffold must mention depended_on_by");
});

// ---- models: comment documents the post-#441 reviewer-alias contract (#454) ----

test("scaffoldDefaultConfig: scaffolded models: comment documents passthrough + parse-time alias rejection, not the pre-#441 'codex ignores it' contract", async () => {
  const repo = makeTempRepo();
  await scaffoldDefaultConfig(repo);
  const content = fs.readFileSync(path.join(repo, ".github", "pipeline.yml"), "utf8");
  const modelsLine = content.split("\n").find((line) => line.includes("Per-phase model alias"));
  assert.ok(modelsLine, "scaffold must include the models: comment line");
  assert.match(modelsLine!, /review is honored by both the claude and codex reviewer harnesses/);
  assert.match(modelsLine!, /config error/, "must state a Claude alias against a codex reviewer is a config error");
  assert.doesNotMatch(
    modelsLine!,
    /codex ignores (it|the reviewer)/,
    "must not claim codex ignores the reviewer alias (that was the pre-#441 contract)",
  );
});

test("scaffoldDefaultConfig: scaffolded file round-trips with repo_map at empty-list defaults", async () => {
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/scaffold-rm" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}:${oldPath}`;
  try {
    await scaffoldDefaultConfig(repo);
    const cfgMod = await import(`../scripts/config.ts?cb=${Date.now()}`);
    const cfg = cfgMod.resolveConfig({ repoPath: repo });
    // The commented-out block must not activate — repo_map resolves to empty-list defaults.
    assert.deepEqual(cfg.repo_map.depends_on, [], "depends_on must be empty when scaffold comments it out");
    assert.deepEqual(cfg.repo_map.depended_on_by, [], "depended_on_by must be empty when scaffold comments it out");
  } finally {
    process.env.PATH = oldPath;
  }
});

// ---------------------------------------------------------------------------
// 3.x runInit ensures the agent-pipeline .gitignore artifact block (#452)
// ---------------------------------------------------------------------------

test("runInit: no .gitignore -> creates one containing the managed artifact block", async () => {
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/init-gitignore-create" });
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
      domain: "test-init-gitignore",
      repo: "acme/init-gitignore-create",
      repo_dir: repo,
    };

    await runInit(cfg);

    const gitignorePath = path.join(repo, ".gitignore");
    assert.ok(fs.existsSync(gitignorePath), ".gitignore should exist after init");
    assert.equal(fs.readFileSync(gitignorePath, "utf8"), renderArtifactIgnoreBlock());
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runInit: existing .gitignore without the block -> appends it, preserving operator lines", async () => {
  const repo = makeTempRepo();
  const gitignorePath = path.join(repo, ".gitignore");
  const operatorLines = "node_modules/\n*.log\n";
  fs.writeFileSync(gitignorePath, operatorLines, "utf8");

  const binDir = makeFakeGhBin({ repoSlug: "acme/init-gitignore-append" });
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
      domain: "test-init-gitignore-append",
      repo: "acme/init-gitignore-append",
      repo_dir: repo,
    };

    await runInit(cfg);

    const content = fs.readFileSync(gitignorePath, "utf8");
    assert.ok(content.startsWith(operatorLines), "operator lines must be preserved byte-identical");
    assert.ok(content.includes(renderArtifactIgnoreBlock()), "the managed block must be appended");
  } finally {
    process.env.PATH = oldPath;
  }
});

test("runInit: second run with an already-current block is a no-op (idempotent)", async () => {
  const repo = makeTempRepo();
  const binDir = makeFakeGhBin({ repoSlug: "acme/init-gitignore-idempotent" });
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
      domain: "test-init-gitignore-idempotent",
      repo: "acme/init-gitignore-idempotent",
      repo_dir: repo,
    };

    await runInit(cfg);
    const gitignorePath = path.join(repo, ".gitignore");
    const afterFirst = fs.readFileSync(gitignorePath, "utf8");

    await runInit(cfg);
    const afterSecond = fs.readFileSync(gitignorePath, "utf8");

    assert.equal(afterSecond, afterFirst, "re-running init must not change an already-current .gitignore");
  } finally {
    process.env.PATH = oldPath;
  }
});
