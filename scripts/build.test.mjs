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

import {
  OPERATION_SURFACE,
  SKILL_OVERLAY_REL,
  MARKETPLACE_CATALOG_REL,
  buildInto,
  compare,
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

test("OPERATION_SURFACE remains a catalog and does not itself write command files (#1048)", () => {
  const tmp = makeTmp();
  try {
    buildInto(tmp);
    const names = new Set(OPERATION_SURFACE.map((op) => op.name));
    for (const expected of ["status", "doctor", "single", "loop", "merge-queue", "recover-parked"]) {
      if (expected === "single") continue; // single is CLI-only; not every catalog lists it
    }
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
    mkdirSync(join(repo, dirname(SKILL_OVERLAY_REL)), { recursive: true });
    mkdirSync(join(repo, dirname(MARKETPLACE_CATALOG_REL)), { recursive: true });
    writeFileSync(join(repo, SKILL_OVERLAY_REL), readFileSync(join(gen, SKILL_OVERLAY_REL)));
    writeFileSync(
      join(repo, MARKETPLACE_CATALOG_REL),
      readFileSync(join(gen, MARKETPLACE_CATALOG_REL)),
    );
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
    mkdirSync(join(repo, dirname(SKILL_OVERLAY_REL)), { recursive: true });
    mkdirSync(join(repo, dirname(MARKETPLACE_CATALOG_REL)), { recursive: true });
    writeFileSync(join(repo, SKILL_OVERLAY_REL), "stale skill overlay\n");
    writeFileSync(
      join(repo, MARKETPLACE_CATALOG_REL),
      readFileSync(join(gen, MARKETPLACE_CATALOG_REL)),
    );
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
