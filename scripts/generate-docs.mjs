#!/usr/bin/env node
// Docs generator entry point (#597).
//
// Write mode (default): regenerate generator-owned artifacts in place.
// Check mode (--check): exit non-zero when any committed artifact would change.
//
// Stale diagnostics use a `stale generated docs:` block with bullet paths so
// core/scripts/docs-freshness.ts extractStalePaths can parse them.
//
// Presence of this file activates scripts/ci-docs.mjs and the docs-freshness gate.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CORE_SCRIPTS = join(REPO_ROOT, "core", "scripts");

const CHECK_MODE = process.argv.includes("--check");

/**
 * Dynamically import a TypeScript module under core/scripts via native strip-types.
 * @param {string} relName e.g. "docs-generate.ts"
 */
async function importCore(relName) {
  const abs = join(CORE_SCRIPTS, relName);
  // Node resolves node_modules from the importer path; run with cwd that has zod.
  return import(pathToFileURL(abs).href);
}

function readText(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf8");
}

function writeText(rel, content) {
  const abs = join(REPO_ROOT, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function listGitTagReleases() {
  const res = spawnSync(
    "git",
    [
      "tag",
      "-l",
      "v*",
      "--format=%(refname:short)|%(creatordate:short)|%(contents:subject)",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || "git tag failed").trim();
    throw new Error(`generate-docs: failed to list git tags: ${err}`);
  }
  return res.stdout ?? "";
}

function normalize(text) {
  return text.replace(/\s*$/, "\n");
}

async function main() {
  // Ensure core dependencies are resolvable (zod) when invoked from repo root.
  const coreNodeModules = join(REPO_ROOT, "core", "node_modules");
  if (!existsSync(coreNodeModules)) {
    console.error(
      "generate-docs: core/node_modules missing — run `cd core && npm ci` first",
    );
    process.exit(1);
  }

  // Prefer loading modules with NODE_PATH so type-stripped imports find zod.
  if (!process.env.NODE_PATH?.includes(coreNodeModules)) {
    process.env.NODE_PATH = [coreNodeModules, process.env.NODE_PATH]
      .filter(Boolean)
      .join(":");
    // NODE_PATH changes after process start are not always re-read; use createRequire path instead via import from core package context.
  }

  const { buildGeneratedArtifacts, parseGitTagListLines, normalizeTrailingNewline } =
    await importCore("docs-generate.ts");
  const { generateConfigSchema } = await importCore("config.ts");
  const { DEFAULT_CONFIG } = await import(
    pathToFileURL(join(CORE_SCRIPTS, "types.ts")).href
  );

  const skillClaude = readText("hosts/claude/SKILL.md");
  const skillCodex = readText("hosts/codex/SKILL.md");
  if (skillClaude === null || skillCodex === null) {
    console.error("generate-docs: host SKILL.md files are required");
    process.exit(1);
  }

  // SKILL files must already contain markers (bootstrap: insert once if missing).
  const ensureMarkers = (text, hostLabel) => {
    if (
      text.includes("<!-- BEGIN GENERATED: cli-command-table -->") &&
      text.includes("<!-- END GENERATED: cli-command-table -->")
    ) {
      return text;
    }
    throw new Error(
      `generate-docs: ${hostLabel} SKILL.md is missing GENERATED cli-command-table markers`,
    );
  };

  const claudeSrc = ensureMarkers(skillClaude, "hosts/claude");
  const codexSrc = ensureMarkers(skillCodex, "hosts/codex");

  const tagStdout = listGitTagReleases();
  const changelogReleases = parseGitTagListLines(tagStdout);

  const schema = generateConfigSchema();
  const defaults =
    DEFAULT_CONFIG && typeof DEFAULT_CONFIG === "object"
      ? /** @type {Record<string, unknown>} */ (DEFAULT_CONFIG)
      : undefined;

  const artifacts = buildGeneratedArtifacts({
    skillClaude: claudeSrc,
    skillCodex: codexSrc,
    configSchema: schema,
    configDefaults: defaults,
    changelogReleases,
  });

  if (CHECK_MODE) {
    const stale = [];
    for (const art of artifacts) {
      const current = readText(art.relPath);
      const expected = normalizeTrailingNewline(art.content);
      if (current === null || normalize(current) !== expected) {
        stale.push(art.relPath);
      }
    }
    if (stale.length > 0) {
      console.error("generate-docs --check: stale generated docs:");
      for (const p of stale) console.error(`  - ${p}`);
      console.error("");
      console.error("Run: node scripts/generate-docs.mjs");
      process.exit(1);
    }
    console.log("generate-docs --check: ok");
    process.exit(0);
  }

  for (const art of artifacts) {
    writeText(art.relPath, normalizeTrailingNewline(art.content));
    console.log(`wrote ${art.relPath}`);
  }
  console.log("generate-docs: done");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
