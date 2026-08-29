#!/usr/bin/env node
// Regenerates committed host SKILLs, the transitional plugin SKILL overlay,
// and the marketplace catalog (#1049). Run after editing renderer sources
// (`core/scripts/host-skill.ts`, `core/scripts/operation-surface.ts`,
// outer-host manifests) or when --check reports staleness:
//
//   node scripts/build.mjs           regenerate four host SKILLs + plugin SKILL + catalog
//   node scripts/build.mjs --check   verify those exact outputs (CI gate)
//
// The product install path is the pipeline CLI plus host SKILL (`install --host claude`).
// This generator does not vendor core/scripts into plugin/ and does not emit a
// per-verb /pipeline:* command pack (#1048). Whole-tree deletion of plugin/ is #1050.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
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
export const SKILL_OVERLAY_REL = join("plugin", "pipeline", "skills", "pipeline", "SKILL.md");
export const MARKETPLACE_CATALOG_REL = join(".claude-plugin", "marketplace.json");

export function hostSkillWriteTargets(ids = SKILL_HOST_IDS) {
  return ids.map((id) => `hosts/${id}/SKILL.md`);
}

/** Exact SKILL/catalog targets for write and --check (same list). */
export function skillAndCatalogTargets(ids = SKILL_HOST_IDS) {
  return [...hostSkillWriteTargets(ids), SKILL_OVERLAY_REL, MARKETPLACE_CATALOG_REL];
}

// These directories were wholly generated before #1048 and are no longer part
// of the plugin package. Keep cleanup scoped to those retired outputs: plugin/
// can also contain operator notes or other plugins that this generator does not
// own.
const RETIRED_GENERATED_DIRS = [
  join("plugin", "pipeline", "commands"),
  join("plugin", "pipeline", "skills", "pipeline", "core"),
];

const MARKETPLACE = {
  $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
  name: "ahf-tools",
  owner: { name: "AHF" },
  description: "AHF internal Claude Code tools.",
  plugins: [
    {
      name: "pipeline",
      source: "./plugin/pipeline",
      description:
        "Advance a GitHub issue/PR through a label-driven pipeline to ready-to-deploy (Claude Code).",
      category: "development",
    },
  ],
};

const PLUGIN_MANIFEST = {
  name: "pipeline",
  description: "Advance a GitHub issue/PR through a label-driven pipeline to ready-to-deploy.",
  author: { name: "AHF" },
  homepage: "https://github.com/accidental-hedge-fund/agent-pipeline",
  repository: "https://github.com/accidental-hedge-fund/agent-pipeline",
};

function renderClaudePluginBridge() {
  return `#!/usr/bin/env node
// Transitional marketplace bridge (#1048). The product engine lives in the
// managed Claude install; this plugin shell deliberately contains no core copy.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const configuredRoot = process.env.CLAUDE_CONFIG_DIR?.trim();
const claudeRoot = configuredRoot
  ? resolve(configuredRoot)
  : join(homedir(), ".claude");
const managedSkill = join(claudeRoot, "skills", "pipeline");
const managedMarker = join(managedSkill, ".pipeline-installer-managed");
const managedLauncher = join(managedSkill, "scripts", "pipeline.mjs");

if (!existsSync(managedMarker) || !existsSync(managedLauncher)) {
  console.error(\`pipeline plugin bridge: managed Claude CLI install not found at \${managedLauncher}\`);
  console.error("Install it with: npx --yes github:accidental-hedge-fund/agent-pipeline install --host claude");
  process.exit(1);
}

const child = spawnSync(process.execPath, [managedLauncher, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
if (child.error) {
  console.error(\`pipeline plugin bridge: failed to launch managed CLI: \${child.error.message}\`);
  process.exit(1);
}
if (child.signal) {
  console.error(\`pipeline plugin bridge: managed CLI terminated by \${child.signal}\`);
  process.exit(1);
}
process.exit(child.status ?? 1);
`;
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function buildInto(
  root,
  { operationSurface = OPERATION_SURFACE, manifests } = {},
) {
  for (const rel of RETIRED_GENERATED_DIRS) {
    rmSync(join(root, rel), { recursive: true, force: true });
  }

  const skill = renderHostSkill({ operationSurface, manifests });
  for (const rel of hostSkillWriteTargets()) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, skill);
  }

  const skillDir = join(root, "plugin", "pipeline", "skills", "pipeline");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(root, "plugin", "pipeline", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });

  // Plugin SKILL calls the same renderer directly. Do not read a generated
  // host file or restore the Setup/Required essay.
  writeFileSync(join(skillDir, "SKILL.md"), skill);
  const shim = join(skillDir, "scripts", "pipeline.mjs");
  writeFileSync(shim, renderClaudePluginBridge());
  chmodSync(shim, 0o755);
  // Host-facing material filter launcher (#742) — same install surface as pipeline.mjs.
  const materialFilter = join(skillDir, "scripts", "material-filter.mjs");
  cpSync(join(REPO_ROOT, "hosts", "_shared", "material-filter.mjs"), materialFilter);
  chmodSync(materialFilter, 0o755);
  // Transitional resolver asset retained until #1050. The plugin bridge
  // delegates to the managed launcher, which carries and loads its own copy.
  const enginesNode = join(skillDir, "scripts", "ensure-engines-node.mjs");
  cpSync(join(REPO_ROOT, "scripts", "ensure-engines-node.mjs"), enginesNode);
  chmodSync(enginesNode, 0o755);

  // Manifests. No per-verb plugin/pipeline/commands/ tree (#1048).
  writeJson(join(root, "plugin", "pipeline", ".claude-plugin", "plugin.json"), PLUGIN_MANIFEST);
  writeJson(join(root, ".claude-plugin", "marketplace.json"), MARKETPLACE);
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
        "✗ host SKILL, plugin SKILL overlay, or marketplace catalog is out of date — run `node scripts/build.mjs` and commit:",
      );
      for (const d of drift) console.error(`  - ${d}`);
      process.exit(1);
    }
    console.log("✓ host SKILLs, plugin SKILL overlay, and marketplace catalog are up to date");
  } else {
    buildInto(REPO_ROOT);
    console.log("✓ generated host SKILLs, plugin SKILL overlay, and .claude-plugin/marketplace.json");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
