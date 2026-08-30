#!/usr/bin/env node
// Regenerates committed host SKILLs (#1049/#1050). Run after editing renderer
// sources (`core/scripts/host-skill.ts`, `core/scripts/operation-surface.ts`,
// outer-host manifests) or when --check reports staleness:
//
//   node scripts/build.mjs           regenerate four host SKILLs
//   node scripts/build.mjs --check   verify those exact outputs (CI gate)
//
// The product install path is the pipeline CLI plus host SKILL (`install --host claude`).
// This generator does not write plugin/ or a marketplace catalog (#1050).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATION_SURFACE } from "../core/scripts/operation-surface.ts";
import {
  SKILL_HOST_IDS,
  renderHostSkill,
} from "../core/scripts/host-skill.ts";

export { OPERATION_SURFACE, SKILL_HOST_IDS, renderHostSkill };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Retired overlay path. Tests assert generate does not write it. */
export const SKILL_OVERLAY_REL = join("plugin", "pipeline", "skills", "pipeline", "SKILL.md");
/** Retired catalog path. Tests assert generate does not write it. */
export const MARKETPLACE_CATALOG_REL = join(".claude-plugin", "marketplace.json");

export function hostSkillWriteTargets(ids = SKILL_HOST_IDS) {
  return ids.map((id) => `hosts/${id}/SKILL.md`);
}

/** Exact SKILL targets for write and --check (same list). No plugin/ or catalog. */
export function skillAndCatalogTargets(ids = SKILL_HOST_IDS) {
  return hostSkillWriteTargets(ids);
}

export function buildInto(
  root,
  { operationSurface = OPERATION_SURFACE, manifests } = {},
) {
  const skill = renderHostSkill({ operationSurface, manifests });
  for (const rel of hostSkillWriteTargets()) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, skill);
  }
}

export function compare(generatedRoot, repoRoot = REPO_ROOT) {
  const targets = skillAndCatalogTargets();
  const drift = [];
  for (const rel of targets) {
    const a = join(generatedRoot, rel);
    const b = join(repoRoot, rel);
    if (!existsSync(a)) drift.push(`missing in generated: ${rel}`);
    else if (!existsSync(b)) drift.push(`missing in repo: ${rel}`);
    else if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) drift.push(`differs: ${rel}`);
  }
  return drift;
}

/** Real `--check` path: generate into a temp tree and compare to `repoRoot`. */
export function checkSkillCatalogFreshness(repoRoot = REPO_ROOT) {
  const tmp = mkdtempSync(join(tmpdir(), "agent-pipeline-build-"));
  try {
    buildInto(tmp);
    return compare(tmp, repoRoot);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const drift = checkSkillCatalogFreshness();
    if (drift.length) {
      console.error(
        "✗ generated host SKILL is out of date — run `node scripts/build.mjs` and commit:",
      );
      for (const d of drift) console.error(`  - ${d}`);
      process.exit(1);
    }
    console.log("✓ generated host SKILLs are up to date");
  } else {
    buildInto(REPO_ROOT);
    console.log("✓ generated host SKILLs");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
