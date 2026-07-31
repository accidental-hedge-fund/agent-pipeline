#!/usr/bin/env node
// Generate operator docs from structured sources (#597).
//
//   node scripts/generate-docs.mjs           write generated artifacts
//   node scripts/generate-docs.mjs --check   exit non-zero if committed artifacts are stale
//
// Artifacts:
//   docs/cli.md
//   docs/config.md
//   CHANGELOG.md
//   hosts/claude/SKILL.md  (region between GENERATED markers)
//   hosts/codex/SKILL.md   (same)
//
// Sources of truth:
//   core/scripts/command-registry.ts + command-docs.ts
//   core/scripts/config.ts (PartialConfigSchema via generateConfigSchema)
//   git tags (CHANGELOG)

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

async function loadGenerators() {
  // Import pure transforms via Node type-stripping (same as core tests).
  const modUrl = pathToFileURL(join(REPO_ROOT, "core/scripts/docs-generate.ts")).href;
  return import(modUrl);
}

async function loadConfigSchema() {
  const modUrl = pathToFileURL(join(REPO_ROOT, "core/scripts/config.ts")).href;
  const { generateConfigSchema } = await import(modUrl);
  return generateConfigSchema();
}

function readText(rel) {
  const p = join(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

function writeText(rel, body) {
  const p = join(REPO_ROOT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body, "utf8");
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/u, "") + "\n";
}

/**
 * List annotated version tags via git. Injectable for tests via env is not used;
 * unit tests cover renderChangelogMarkdown with fixtures instead.
 */
function listReleasesFromGit() {
  let out;
  try {
    out = execFileSync(
      "git",
      ["tag", "-l", "v*", "--format=%(refname:short)\t%(creatordate:short)\t%(contents:subject)\n%(contents:body)"],
      { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    console.error("generate-docs: failed to list git tags:", err?.message ?? err);
    process.exit(2);
  }

  // Tags are separated by blank-ish records; parse line-oriented format:
  // first line: version\tdate\tsubject
  // following lines until next version-like start: body
  const releases = [];
  const chunks = out.split(/\n(?=v\d+\.\d+)/);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const header = lines[0] ?? "";
    const parts = header.split("\t");
    const versionRaw = (parts[0] ?? "").trim();
    if (!/^v?\d+\.\d+/.test(versionRaw)) continue;
    const version = versionRaw.replace(/^v/, "");
    const date = (parts[1] ?? "").trim() || undefined;
    const subject = (parts[2] ?? "").trim();
    const bodyRest = lines.slice(1).join("\n").trim();
    const body = [subject, bodyRest].filter(Boolean).join("\n\n");
    releases.push({ version, date, body });
  }
  return releases;
}

function ensureSkillMarkers(rel, hostLabel) {
  const body = readText(rel);
  if (body === null) {
    console.error(`generate-docs: missing ${rel}`);
    process.exit(2);
  }
  if (!body.includes("<!-- BEGIN GENERATED: cli-command-table -->")) {
    console.error(
      `generate-docs: ${rel} is missing GENERATED cli-command-table markers.\n` +
        `  Insert around the Modes command inventory:\n` +
        `  <!-- BEGIN GENERATED: cli-command-table -->\n` +
        `  …\n` +
        `  <!-- END GENERATED: cli-command-table -->\n` +
        `  (${hostLabel})`,
    );
    process.exit(2);
  }
  return body;
}

function compareOrWrite(rel, next, mismatches) {
  const normalized = normalize(next);
  const prev = readText(rel);
  if (CHECK) {
    if (prev === null || normalize(prev) !== normalized) {
      mismatches.push(rel);
      return;
    }
    return;
  }
  if (prev === null || normalize(prev) !== normalized) {
    writeText(rel, normalized);
    console.log(`wrote ${rel}`);
  } else {
    console.log(`unchanged ${rel}`);
  }
}

async function main() {
  const gen = await loadGenerators();
  const {
    buildCliInventory,
    renderCliReferenceMarkdown,
    renderSkillCommandTable,
    replaceSkillGeneratedRegion,
    renderConfigReferenceMarkdown,
    renderChangelogMarkdown,
  } = gen;

  const inventory = buildCliInventory();
  const cliMd = renderCliReferenceMarkdown(inventory);

  const schema = await loadConfigSchema();
  const configMd = renderConfigReferenceMarkdown(schema);

  const releases = listReleasesFromGit();
  const changelogMd = renderChangelogMarkdown(releases);

  const mismatches = [];
  compareOrWrite("docs/cli.md", cliMd, mismatches);
  compareOrWrite("docs/config.md", configMd, mismatches);
  compareOrWrite("CHANGELOG.md", changelogMd, mismatches);

  for (const [rel, token] of [
    ["hosts/claude/SKILL.md", "/pipeline"],
    ["hosts/codex/SKILL.md", "$pipeline"],
  ]) {
    const current = ensureSkillMarkers(rel, token);
    const table = renderSkillCommandTable(token, inventory);
    const next = replaceSkillGeneratedRegion(current, table);
    if (next === null) {
      console.error(`generate-docs: could not replace markers in ${rel}`);
      process.exit(2);
    }
    compareOrWrite(rel, next, mismatches);
  }

  if (CHECK) {
    if (mismatches.length > 0) {
      console.error("generate-docs --check: stale generated docs:");
      for (const m of mismatches) console.error(`  - ${m}`);
      console.error("Run: node scripts/generate-docs.mjs");
      process.exit(1);
    }
    console.log("generate-docs --check: ok");
    return;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
