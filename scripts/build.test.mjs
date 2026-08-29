#!/usr/bin/env node
// Tests for scripts/build.mjs packaging law (#1048): no vendored core, no slash
// pack, --check is SKILL overlay + marketplace catalog only.
// Run with: node --test scripts/build.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  OPERATION_SURFACE,
  SKILL_HOST_IDS,
  SKILL_OVERLAY_REL,
  MARKETPLACE_CATALOG_REL,
  buildInto,
  compare,
  hostSkillWriteTargets,
  skillAndCatalogTargets,
  renderHostSkill,
} from "./build.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "pipeline-build-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function listRelFiles(dir, prefix = "") {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) out.push(...listRelFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

test("generate does not vendor core/scripts/pipeline.ts into plugin/ (#1048)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const hits = listRelFiles(join(tmp, "plugin")).filter((rel) =>
      /(?:^|\/)core\/scripts\/pipeline\.ts$/.test(rel),
    );
    assert.deepEqual(
      hits,
      [],
      `generator must not write plugin/**/core/scripts/pipeline.ts; found: ${hits.join(", ")}`,
    );
    assert.equal(
      existsSync(join(tmp, "plugin", "pipeline", "skills", "pipeline", "core", "scripts")),
      false,
      "generator must not copy core/scripts into plugin/",
    );
  } finally {
    cleanup(tmp);
  }
});

test("generate does not write plugin/pipeline/commands/pipeline:<verb>.md (#1048)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const commandsDir = join(tmp, "plugin", "pipeline", "commands");
    const slashFiles = existsSync(commandsDir)
      ? readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"))
      : [];
    assert.deepEqual(slashFiles, [], "generator must not emit a per-verb slash-command tree");
    assert.equal(
      existsSync(join(commandsDir, "pipeline:loop.md")),
      false,
      "must not write plugin/pipeline/commands/pipeline:loop.md",
    );
  } finally {
    cleanup(tmp);
  }
});

test("production generate removes retired outputs without deleting unrelated plugin files (#1048)", () => {
  const tmp = makeTmp();
  try {
    const retiredCommand = join(tmp, "plugin", "pipeline", "commands", "pipeline:status.md");
    const retiredCore = join(
      tmp,
      "plugin",
      "pipeline",
      "skills",
      "pipeline",
      "core",
      "scripts",
      "pipeline.ts",
    );
    const operatorNote = join(tmp, "plugin", "pipeline", "operator-note.txt");
    const scriptNote = join(
      tmp,
      "plugin",
      "pipeline",
      "skills",
      "pipeline",
      "scripts",
      "operator-note.txt",
    );
    const otherPlugin = join(tmp, "plugin", "another-plugin", "README.md");

    for (const path of [retiredCommand, retiredCore, operatorNote, scriptNote, otherPlugin]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `sentinel:${path}\n`);
    }

    // Exercise the same cleanup + build function used by the production CLI.
    buildInto(tmp);

    assert.equal(
      existsSync(join(tmp, "plugin", "pipeline", "commands")),
      false,
      "retired per-verb command directory must be removed",
    );
    assert.equal(
      existsSync(join(tmp, "plugin", "pipeline", "skills", "pipeline", "core")),
      false,
      "retired core mirror must be removed",
    );
    assert.match(readFileSync(operatorNote, "utf8"), /^sentinel:/);
    assert.match(readFileSync(scriptNote, "utf8"), /^sentinel:/);
    assert.match(readFileSync(otherPlugin, "utf8"), /^sentinel:/);
    assert.equal(existsSync(join(tmp, SKILL_OVERLAY_REL)), true);
    assert.equal(existsSync(join(tmp, MARKETPLACE_CATALOG_REL)), true);
  } finally {
    cleanup(tmp);
  }
});

test("OPERATION_SURFACE remains a catalog and does not itself write command files (#1048)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const names = new Set(OPERATION_SURFACE.map((op) => op.name));
    assert.ok(names.has("status"), "catalog must list status");
    assert.ok(names.has("doctor"), "catalog must list doctor");
    assert.ok(names.has("loop"), "catalog must list loop");
    const commandsDir = join(tmp, "plugin", "pipeline", "commands");
    for (const op of OPERATION_SURFACE) {
      assert.equal(
        existsSync(join(commandsDir, `pipeline:${op.name}.md`)),
        false,
        `catalog entry ${op.name} must not cause pipeline:${op.name}.md to be generated`,
      );
    }
    assert.equal("renderClaudeCommand" in globalThis, false);
  } finally {
    cleanup(tmp);
  }
});

test("default build renders the plugin SKILL table from OPERATION_SURFACE (#1048)", () => {
  const tmp = makeTmp();
  const status = OPERATION_SURFACE.find((op) => op.name === "status");
  assert.ok(status, "catalog must list status");
  const original = status.desc;
  const marker = "catalog-driven plugin status marker";
  try {
    status.desc = marker;
    buildInto(tmp);
    const skill = readFileSync(join(tmp, SKILL_OVERLAY_REL), "utf8");
    assert.match(skill, new RegExp(marker));
    assert.doesNotMatch(skill, /^\/pipeline run\b/m);
  } finally {
    status.desc = original;
    cleanup(tmp);
  }
});

test("generated plugin bridge delegates to the managed Claude CLI without a plugin core (#1048)", () => {
  const tmp = makeTmp();
  const claudeRoot = makeTmp();
  try {
    buildInto(tmp);
    const managedLauncher = join(claudeRoot, "skills", "pipeline", "scripts", "pipeline.mjs");
    mkdirSync(dirname(managedLauncher), { recursive: true });
    writeFileSync(join(claudeRoot, "skills", "pipeline", ".pipeline-installer-managed"), "\n");
    writeFileSync(
      managedLauncher,
      'console.log(JSON.stringify({ delegated: process.argv.slice(2) }));\n',
    );

    const pluginLauncher = join(
      tmp,
      "plugin",
      "pipeline",
      "skills",
      "pipeline",
      "scripts",
      "pipeline.mjs",
    );
    const result = spawnSync(process.execPath, [pluginLauncher, "status", "1048"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeRoot },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { delegated: ["status", "1048"] });
    assert.equal(
      existsSync(join(tmp, "plugin", "pipeline", "skills", "pipeline", "core")),
      false,
    );

    const skill = readFileSync(join(tmp, SKILL_OVERLAY_REL), "utf8");
    assert.equal(skill, renderHostSkill());
    assert.doesNotMatch(skill, /## Setup \(zero install after first run\)/);
    assert.doesNotMatch(skill, /CLAUDE_PLUGIN_ROOT}\/skills\/pipeline\/core\/scripts/);
  } finally {
    cleanup(tmp);
    cleanup(claudeRoot);
  }
});

test("generated plugin bridge fails with install remediation when managed CLI is absent (#1048)", () => {
  const tmp = makeTmp();
  const claudeRoot = makeTmp();
  try {
    buildInto(tmp);
    const pluginLauncher = join(
      tmp,
      "plugin",
      "pipeline",
      "skills",
      "pipeline",
      "scripts",
      "pipeline.mjs",
    );
    const result = spawnSync(process.execPath, [pluginLauncher, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeRoot },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /install --host claude/);
    assert.match(result.stderr, /managed Claude CLI install not found/);
  } finally {
    cleanup(tmp);
    cleanup(claudeRoot);
  }
});

test("build.mjs no longer exports per-verb command renderers (#1048)", async () => {
  const buildMjs = await import("./build.mjs");
  assert.equal(
    buildMjs.renderClaudeCommand,
    undefined,
    "renderClaudeCommand must not be exported so it cannot be reattached",
  );
  assert.equal(
    buildMjs.renderCodexCommand,
    undefined,
    "renderCodexCommand must not be exported so it cannot be reattached",
  );
  assert.ok(Array.isArray(buildMjs.OPERATION_SURFACE), "OPERATION_SURFACE stays the catalog");
});

test("--check: matching SKILL overlay + catalog pass without a plugin core tree (#1048)", () => {
  const gen = makeTmp();
  const repo = makeTmp();
  try {
    buildInto(gen);
    for (const rel of skillAndCatalogTargets()) {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), readFileSync(join(gen, rel)));
    }
    assert.equal(
      existsSync(join(repo, "plugin", "pipeline", "skills", "pipeline", "core", "scripts")),
      false,
    );
    const drift = compare(gen, repo);
    assert.deepEqual(drift, [], `expected no drift without a core copy; got: ${drift.join("; ")}`);
  } finally {
    cleanup(gen);
    cleanup(repo);
  }
});

test("--check: stale SKILL overlay or marketplace catalog fails (#1048)", () => {
  const gen = makeTmp();
  const repo = makeTmp();
  try {
    buildInto(gen);
    for (const rel of skillAndCatalogTargets()) {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), readFileSync(join(gen, rel)));
    }
    writeFileSync(join(repo, SKILL_OVERLAY_REL), "stale skill overlay\n");
    const skillDrift = compare(gen, repo);
    assert.ok(
      skillDrift.some((d) => d.includes(SKILL_OVERLAY_REL)),
      `stale SKILL must fail check; got: ${skillDrift.join("; ")}`,
    );

    writeFileSync(join(repo, SKILL_OVERLAY_REL), readFileSync(join(gen, SKILL_OVERLAY_REL)));
    writeFileSync(join(repo, MARKETPLACE_CATALOG_REL), "{}\n");
    const catalogDrift = compare(gen, repo);
    assert.ok(
      catalogDrift.some((d) => d.includes(MARKETPLACE_CATALOG_REL)),
      `stale catalog must fail check; got: ${catalogDrift.join("; ")}`,
    );
  } finally {
    cleanup(gen);
    cleanup(repo);
  }
});

test("write and check targets match SKILL_HOST_IDS plus plugin SKILL and catalog", () => {
  const hostTargets = hostSkillWriteTargets();
  assert.deepEqual([...hostTargets], [
    "hosts/claude/SKILL.md",
    "hosts/codex/SKILL.md",
    "hosts/grok/SKILL.md",
    "hosts/opencode/SKILL.md",
  ]);
  assert.deepEqual([...SKILL_HOST_IDS], ["claude", "codex", "grok", "opencode"]);
  const check = skillAndCatalogTargets();
  assert.deepEqual(check.slice(0, 4), hostTargets);
  assert.ok(check.includes(SKILL_OVERLAY_REL));
  assert.ok(check.includes(MARKETPLACE_CATALOG_REL));
  assert.equal(
    check.some((p) => p === "hosts/omp/SKILL.md"),
    false,
  );
});

test("buildInto writes four byte-identical host SKILLs from renderHostSkill", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const expected = renderHostSkill();
    for (const rel of hostSkillWriteTargets()) {
      assert.equal(readFileSync(join(tmp, rel), "utf8"), expected);
    }
    assert.equal(readFileSync(join(tmp, SKILL_OVERLAY_REL), "utf8"), expected);
    assert.equal(existsSync(join(tmp, "hosts", "omp", "SKILL.md")), false);
  } finally {
    cleanup(tmp);
  }
});

test("--check: one-byte stale host SKILL fails", () => {
  const gen = makeTmp();
  const repo = makeTmp();
  try {
    buildInto(gen);
    for (const rel of skillAndCatalogTargets()) {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), readFileSync(join(gen, rel)));
    }
    writeFileSync(join(repo, "hosts/claude/SKILL.md"), "x");
    const drift = compare(gen, repo);
    assert.ok(
      drift.some((d) => d.includes("hosts/claude/SKILL.md")),
      `stale host SKILL must fail check; got: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(gen);
    cleanup(repo);
  }
});

test("committed SKILL overlay and catalog match a fresh generate (live --check contract)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const drift = compare(tmp, REPO_ROOT);
    assert.deepEqual(
      drift,
      [],
      `committed SKILL/catalog stale — run node scripts/build.mjs: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(tmp);
  }
});
