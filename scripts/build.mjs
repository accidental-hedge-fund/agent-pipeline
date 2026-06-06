#!/usr/bin/env node
// Assembles the committed Claude Code plugin from the single source of truth
// (core/ + hosts/claude/). Run after editing core or the Claude overlay:
//
//   node scripts/build.mjs           regenerate plugin/ and .claude-plugin/marketplace.json
//   node scripts/build.mjs --check   verify the committed output is up to date (CI gate)
//
// The plugin is committed so `/plugin marketplace add accidental-hedge-fund/agent-pipeline`
// works directly off the repo with no build step on the user's machine.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE_ENTRIES = ["scripts", "profiles", "package.json", "package-lock.json"];

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

function renderShim(profile) {
  const tmpl = readFileSync(join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs"), "utf8");
  return tmpl.replaceAll("__PROFILE__", profile);
}

// Rewrite the personal-skill paths in the Claude overlay to the plugin runtime
// path. Claude Code expands ${CLAUDE_PLUGIN_ROOT} for plugin-context commands.
function pluginSkillMd() {
  const md = readFileSync(join(REPO_ROOT, "hosts", "claude", "SKILL.md"), "utf8");
  return md.replaceAll("~/.claude/skills/pipeline", "${CLAUDE_PLUGIN_ROOT}/skills/pipeline");
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function buildInto(root) {
  const skillDir = join(root, "plugin", "pipeline", "skills", "pipeline");
  const coreDst = join(skillDir, "core");
  mkdirSync(coreDst, { recursive: true });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(root, "plugin", "pipeline", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });

  // Skill payload: core + rewritten SKILL.md + shim.
  for (const entry of CORE_ENTRIES) {
    const src = join(REPO_ROOT, "core", entry);
    if (existsSync(src)) cpSync(src, join(coreDst, entry), { recursive: true });
  }
  writeFileSync(join(skillDir, "SKILL.md"), pluginSkillMd());
  const shim = join(skillDir, "scripts", "pipeline.mjs");
  writeFileSync(shim, renderShim("claude"));
  chmodSync(shim, 0o755);

  // Manifests.
  writeJson(join(root, "plugin", "pipeline", ".claude-plugin", "plugin.json"), PLUGIN_MANIFEST);
  writeJson(join(root, ".claude-plugin", "marketplace.json"), MARKETPLACE);
}

// --- recursive compare for --check ---
function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

function compare(generatedRoot) {
  const targets = [
    join("plugin", "pipeline"),
    join(".claude-plugin", "marketplace.json"),
  ];
  const drift = [];
  for (const t of targets) {
    const genPath = join(generatedRoot, t);
    const genFiles = statSync(genPath).isDirectory()
      ? listFiles(genPath).map((f) => relative(generatedRoot, f))
      : [t];
    for (const rel of genFiles) {
      const a = join(generatedRoot, rel);
      const b = join(REPO_ROOT, rel);
      if (!existsSync(b)) drift.push(`missing in repo: ${rel}`);
      else if (readFileSync(a, "utf8") !== readFileSync(b, "utf8")) drift.push(`differs: ${rel}`);
    }
    // committed files that should no longer exist
    const repoPath = join(REPO_ROOT, t);
    if (existsSync(repoPath) && statSync(repoPath).isDirectory()) {
      for (const f of listFiles(repoPath)) {
        const rel = relative(REPO_ROOT, f);
        if (!existsSync(join(generatedRoot, rel))) drift.push(`stale in repo: ${rel}`);
      }
    }
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
        console.error("✗ plugin/ is out of date — run `node scripts/build.mjs` and commit:");
        for (const d of drift) console.error(`  - ${d}`);
        process.exit(1);
      }
      console.log("✓ plugin/ is up to date with core/ + hosts/claude/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    rmSync(join(REPO_ROOT, "plugin"), { recursive: true, force: true });
    buildInto(REPO_ROOT);
    console.log("✓ generated plugin/ and .claude-plugin/marketplace.json");
  }
}

main();
