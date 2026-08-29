#!/usr/bin/env node
// Regenerates the committed SKILL overlay and marketplace catalog from
// hosts/claude/ (+ shared launcher-adjacent assets). Run after editing those
// sources or when --check reports staleness:
//
//   node scripts/build.mjs           regenerate plugin/ SKILL overlay + .claude-plugin/marketplace.json
//   node scripts/build.mjs --check   verify SKILL overlay and marketplace catalog freshness (CI gate)
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
import { applySkillCommandTable } from "../core/scripts/docs-generate.ts";
import { OPERATION_SURFACE } from "../core/scripts/operation-surface.ts";

export { OPERATION_SURFACE };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_OVERLAY_REL = join("plugin", "pipeline", "skills", "pipeline", "SKILL.md");
export const MARKETPLACE_CATALOG_REL = join(".claude-plugin", "marketplace.json");

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

// Rewrite the personal-skill paths in the Claude overlay to the plugin runtime
// path. Claude Code expands ${CLAUDE_PLUGIN_ROOT} for plugin-context commands.
function pluginSkillMd(operationSurface) {
  const md = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");
  const pluginMd = applySkillCommandTable(md, "/pipeline", { operationSurface }).replaceAll(
    "~/.claude/skills/pipeline",
    "${CLAUDE_PLUGIN_ROOT}/skills/pipeline",
  );
  const setupHeading = "## Setup (zero install after first run)";
  const requiredHeading = "\nRequired:";
  const setupStart = pluginMd.indexOf(setupHeading);
  const requiredStart = pluginMd.indexOf(requiredHeading, setupStart);
  if (setupStart < 0 || requiredStart < 0) {
    throw new Error("hosts/claude/SKILL.md is missing the expected Setup/Required section");
  }
  const bridgeSetup = `${setupHeading}\n\n` +
    "This transitional marketplace overlay contains no engine core. Its launcher delegates " +
    "to the managed Claude CLI install under `$CLAUDE_CONFIG_DIR/skills/pipeline` (or " +
    "`~/.claude/skills/pipeline`). Before first use, provision that install with " +
    "`npx --yes github:accidental-hedge-fund/agent-pipeline install --host claude`.";
  return pluginMd.slice(0, setupStart) + bridgeSetup + pluginMd.slice(requiredStart);
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function buildInto(root, { operationSurface = OPERATION_SURFACE } = {}) {
  for (const rel of RETIRED_GENERATED_DIRS) {
    rmSync(join(root, rel), { recursive: true, force: true });
  }

  const skillDir = join(root, "plugin", "pipeline", "skills", "pipeline");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(root, "plugin", "pipeline", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });

  // SKILL overlay + launcher shim only. Do not copy core/ into plugin/ (#1048).
  writeFileSync(join(skillDir, "SKILL.md"), pluginSkillMd(operationSurface));
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
  const targets = [SKILL_OVERLAY_REL, MARKETPLACE_CATALOG_REL];
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

function main() {
  const check = process.argv.includes("--check");
  if (check) {
    const tmp = mkdtempSync(join(tmpdir(), "agent-pipeline-build-"));
    try {
      buildInto(tmp);
      const drift = compare(tmp);
      if (drift.length) {
        console.error(
          "✗ SKILL overlay or marketplace catalog is out of date — run `node scripts/build.mjs` and commit:",
        );
        for (const d of drift) console.error(`  - ${d}`);
        process.exit(1);
      }
      console.log("✓ SKILL overlay and marketplace catalog are up to date");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    buildInto(REPO_ROOT);
    console.log("✓ generated SKILL overlay and .claude-plugin/marketplace.json");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
