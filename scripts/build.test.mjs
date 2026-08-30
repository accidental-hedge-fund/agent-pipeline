#!/usr/bin/env node
// Tests for scripts/build.mjs packaging law (#1048/#1050): no plugin/ tree,
// no slash pack, --check is the four generated host SKILLs only.
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

import {
  OPERATION_SURFACE,
  SKILL_HOST_IDS,
  SKILL_OVERLAY_REL,
  MARKETPLACE_CATALOG_REL,
  buildInto,
  checkSkillCatalogFreshness,
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

test("generate does not recreate plugin/ (#1050)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    assert.equal(
      existsSync(join(tmp, "plugin")),
      false,
      "generator must not create a plugin/ directory",
    );
    assert.equal(
      existsSync(join(tmp, SKILL_OVERLAY_REL)),
      false,
      "generator must not write plugin/pipeline/skills/pipeline/SKILL.md",
    );
    const hits = listRelFiles(join(tmp, "plugin"));
    assert.deepEqual(hits, [], `generator must not write under plugin/; found: ${hits.join(", ")}`);
  } finally {
    cleanup(tmp);
  }
});

test("generate does not write a marketplace catalog (#1050)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    assert.equal(
      existsSync(join(tmp, MARKETPLACE_CATALOG_REL)),
      false,
      "generator must not write .claude-plugin/marketplace.json",
    );
    assert.equal(existsSync(join(tmp, ".claude-plugin")), false);
  } finally {
    cleanup(tmp);
  }
});

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

test("generate does not mkdir, copy, or write leftover plugin/ paths (#1050)", () => {
  const tmp = makeTmp();
  try {
    const leftover = join(tmp, "plugin", "pipeline", "operator-note.txt");
    mkdirSync(dirname(leftover), { recursive: true });
    writeFileSync(leftover, "sentinel\n");
    buildInto(tmp);
    assert.equal(existsSync(join(tmp, SKILL_OVERLAY_REL)), false);
    assert.match(readFileSync(leftover, "utf8"), /^sentinel/);
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

test("default build renders host SKILL tables from OPERATION_SURFACE (#1048/#1050)", () => {
  const tmp = makeTmp();
  const status = OPERATION_SURFACE.find((op) => op.name === "status");
  assert.ok(status, "catalog must list status");
  const original = status.desc;
  const marker = "catalog-driven host status marker";
  try {
    status.desc = marker;
    buildInto(tmp);
    const skill = readFileSync(join(tmp, "hosts", "claude", "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(marker));
    assert.doesNotMatch(skill, /^\/pipeline run\b/m);
    assert.equal(existsSync(join(tmp, SKILL_OVERLAY_REL)), false);
  } finally {
    status.desc = original;
    cleanup(tmp);
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

test("--check: matching host SKILLs pass when plugin/ is absent (#1050)", () => {
  const repo = makeTmp();
  try {
    buildInto(repo);
    rmSync(join(repo, "plugin"), { recursive: true, force: true });
    rmSync(join(repo, ".claude-plugin"), { recursive: true, force: true });
    for (const rel of hostSkillWriteTargets()) {
      assert.equal(existsSync(join(repo, rel)), true, `host SKILL missing: ${rel}`);
    }
    assert.equal(existsSync(join(repo, SKILL_OVERLAY_REL)), false);
    const drift = checkSkillCatalogFreshness(repo);
    assert.deepEqual(
      drift,
      [],
      `absent plugin overlay must not fail --check; got: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(repo);
  }
});

test("--check: stale host SKILL fails (#1050)", () => {
  const gen = makeTmp();
  const repo = makeTmp();
  try {
    buildInto(gen);
    for (const rel of skillAndCatalogTargets()) {
      mkdirSync(join(repo, dirname(rel)), { recursive: true });
      writeFileSync(join(repo, rel), readFileSync(join(gen, rel)));
    }
    writeFileSync(join(repo, "hosts/claude/SKILL.md"), "stale host skill\n");
    const skillDrift = compare(gen, repo);
    assert.ok(
      skillDrift.some((d) => d.includes("hosts/claude/SKILL.md")),
      `stale host SKILL must fail check; got: ${skillDrift.join("; ")}`,
    );
  } finally {
    cleanup(gen);
    cleanup(repo);
  }
});

test("write and check targets are the four host SKILLs only (#1050)", () => {
  const hostTargets = hostSkillWriteTargets();
  assert.deepEqual([...hostTargets], [
    "hosts/claude/SKILL.md",
    "hosts/codex/SKILL.md",
    "hosts/grok/SKILL.md",
    "hosts/opencode/SKILL.md",
  ]);
  assert.deepEqual([...SKILL_HOST_IDS], ["claude", "codex", "grok", "opencode"]);
  const check = skillAndCatalogTargets();
  assert.deepEqual([...check], hostTargets);
  assert.equal(check.includes(SKILL_OVERLAY_REL), false);
  assert.equal(check.includes(MARKETPLACE_CATALOG_REL), false);
  assert.equal(
    check.some((p) => p === "hosts/omp/SKILL.md"),
    false,
  );
  assert.equal(
    check.some((p) => p.startsWith("plugin/")),
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
    assert.equal(existsSync(join(tmp, SKILL_OVERLAY_REL)), false);
    assert.equal(existsSync(join(tmp, "hosts", "omp", "SKILL.md")), false);
  } finally {
    cleanup(tmp);
  }
});

test("--check: one-byte stale host SKILL fails the real check path", () => {
  const repo = makeTmp();
  try {
    buildInto(repo);
    const rel = "hosts/claude/SKILL.md";
    const original = readFileSync(join(repo, rel), "utf8");
    const oneByte = `${original.slice(0, -1)}X`;
    assert.equal(oneByte.length, original.length);
    assert.notEqual(oneByte, original);
    writeFileSync(join(repo, rel), oneByte);
    const drift = checkSkillCatalogFreshness(repo);
    assert.ok(
      drift.some((d) => d.includes("hosts/claude/SKILL.md")),
      `stale host SKILL must fail check; got: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(repo);
  }
});

test("committed host SKILLs match a fresh generate (live --check contract)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const drift = compare(tmp, REPO_ROOT);
    assert.deepEqual(
      drift,
      [],
      `committed host SKILLs stale — run node scripts/build.mjs: ${drift.join("; ")}`,
    );
  } finally {
    cleanup(tmp);
  }
});

test("root package.json files does not list plugin or .claude-plugin (#1050)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files), "root package.json must declare files");
  assert.equal(pkg.files.includes("plugin"), false);
  assert.equal(pkg.files.includes(".claude-plugin"), false);
});
