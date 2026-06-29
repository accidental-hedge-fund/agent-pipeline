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

// Single source of truth for the namespaced command surface (#273).
// Each entry generates a `/pipeline:<name>` command file on the Claude host and
// a `$pipeline:<name>` entry documented on the Codex host from the same source.
// `argHint` appears in the command's argument-hint frontmatter.
// `desc` is the one-line description shown in the skill/command menu.
// `cliArgs` is the CLI argument string that the host command forwards to
//   (injected after `pipeline.mjs`; `$ARGUMENTS` is replaced by user args).
export const OPERATION_SURFACE = [
  {
    name: "status",
    desc: "Read-only status of issue or PR N — stage, blocker, PR, last review",
    argHint: "<N>",
    cliArgs: "status $ARGUMENTS",
    fast: true,
  },
  {
    name: "unblock",
    desc: 'Post the answer and clear the blocked label for issue N',
    argHint: '<N> "<answer>"',
    cliArgs: "unblock $ARGUMENTS",
    fast: true,
  },
  {
    name: "override",
    desc: "Disposition a review finding and auto-resume the advance loop for issue N",
    argHint: '<N> "<key>: <reason>"',
    cliArgs: "override $ARGUMENTS",
    fast: false,
  },
  {
    name: "summary",
    desc: "Print the evidence bundle for issue N",
    argHint: "<N>",
    // summary <N> is the issue-bundle form; the host command routes via --summary flag
    // because `pipeline summary <run-id>` is the exact-run selector.
    cliArgs: "$1 --summary",
    specialCli: true,
    fast: true,
  },
  {
    name: "doctor",
    desc: "Run deterministic preflight checks and print a pass/fail summary",
    argHint: "",
    cliArgs: "doctor",
    fast: true,
  },
  {
    name: "init",
    desc: "Ensure pipeline labels and scaffold .github/pipeline.yml",
    argHint: "",
    cliArgs: "init",
    fast: true,
  },
  {
    name: "cleanup",
    desc: "Sweep merged-PR worktrees and delete their local branches",
    argHint: "",
    cliArgs: "cleanup",
    fast: true,
  },
  {
    name: "intake",
    desc: "Spec a rough description into a GitHub issue and ROADMAP PR",
    argHint: '[--description "<text>"] [--release <version>]',
    cliArgs: "intake $ARGUMENTS",
    fast: false,
  },
  {
    name: "sweep",
    desc: "Batch re-spec thin issues and reconcile ROADMAP.md",
    argHint: "[--apply] [--repo <owner/repo>]",
    cliArgs: "sweep $ARGUMENTS",
    fast: false,
  },
  {
    name: "triage",
    desc: "Set a pre-pipeline stage label (ready or backlog) on issue N",
    argHint: "<N> --stage <ready|backlog>",
    cliArgs: "triage $ARGUMENTS",
    fast: true,
  },
  {
    name: "merge",
    desc: "Human-only squash merge of a ready-to-deploy PR",
    argHint: "<pr>",
    cliArgs: "merge $ARGUMENTS",
    fast: true,
  },
  {
    name: "release",
    desc: "Prepare a release PR for the given version",
    argHint: "<version | major | minor | patch>",
    cliArgs: "release $ARGUMENTS",
    fast: false,
  },
  {
    name: "roadmap",
    desc: "Generate a dependency-aware scored roadmap for the backlog",
    argHint: "[--apply] [--next <N>]",
    cliArgs: "roadmap $ARGUMENTS",
    fast: false,
  },
  {
    name: "logs",
    desc: "List or stream pipeline run logs",
    argHint: "[<run-id>] [-f]",
    cliArgs: "logs $ARGUMENTS",
    fast: true,
  },
];

function renderShim(profile) {
  const tmpl = readFileSync(join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs"), "utf8");
  return tmpl.replaceAll("__PROFILE__", profile);
}

// Generate a Claude command markdown file for one operation entry.
// `skillPath` is the path prefix used in the Invoke line (differs between
// personal install and plugin install).
export function renderClaudeCommand(op, skillPath) {
  const argHintLine = op.argHint ? `argument-hint: ${op.argHint}` : "";
  const invocation = op.specialCli
    ? `\`node ${skillPath}/scripts/pipeline.mjs ${op.cliArgs}\``
    : op.argHint
    ? `\`node ${skillPath}/scripts/pipeline.mjs ${op.cliArgs}\``
    : `\`node ${skillPath}/scripts/pipeline.mjs ${op.cliArgs}\``;
  const orchNote = op.fast
    ? "Run synchronously (completes in seconds). No background process or Monitor needed."
    : "See the pipeline SKILL.md for orchestration instructions when this command runs a model harness.";
  const specialNote = op.specialCli
    ? "\nNote: pass the issue number as the sole argument. `$1` is expanded to that number by this command."
    : "";

  return [
    "---",
    `description: ${op.desc}`,
    ...(argHintLine ? [argHintLine] : []),
    "---",
    "",
    `Invoke: ${invocation}`,
    "",
    orchNote,
    ...(specialNote ? [specialNote] : []),
  ].join("\n") + "\n";
}

// Generate a Codex agent YAML file for one operation entry.
// Written to <codexSkills>/pipeline/agents/pipeline-<name>.yaml at install time.
export function renderCodexCommand(op) {
  const hint = op.argHint ? ` ${op.argHint}` : "";
  const escapedDesc = op.desc.replace(/"/g, '\\"');
  const escapedHint = hint.replace(/"/g, '\\"');
  return [
    "interface:",
    `  display_name: "pipeline:${op.name}"`,
    `  short_description: "${escapedDesc}"`,
    `  default_prompt: "$pipeline:${op.name}${escapedHint}"`,
  ].join("\n") + "\n";
}

// Rewrite personal-skill paths in a command file to the plugin runtime path.
function pluginifyCommandFile(content) {
  return content.replaceAll("~/.claude/skills/pipeline", "${CLAUDE_PLUGIN_ROOT}/skills/pipeline");
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
  const commandsDir = join(root, "plugin", "pipeline", "commands");
  mkdirSync(coreDst, { recursive: true });
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(root, "plugin", "pipeline", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(commandsDir, { recursive: true });

  // Skill payload: core + rewritten SKILL.md + shim.
  for (const entry of CORE_ENTRIES) {
    const src = join(REPO_ROOT, "core", entry);
    if (existsSync(src)) cpSync(src, join(coreDst, entry), { recursive: true });
  }
  writeFileSync(join(skillDir, "SKILL.md"), pluginSkillMd());
  const shim = join(skillDir, "scripts", "pipeline.mjs");
  writeFileSync(shim, renderShim("claude"));
  chmodSync(shim, 0o755);

  // Namespaced command files: one `pipeline:<name>.md` per operation (#273).
  // Generated from OPERATION_SURFACE so Claude and Codex stay symmetric.
  for (const op of OPERATION_SURFACE) {
    const raw = renderClaudeCommand(op, "~/.claude/skills/pipeline");
    const pluginContent = pluginifyCommandFile(raw);
    writeFileSync(join(commandsDir, `pipeline:${op.name}.md`), pluginContent);
  }

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
    join("plugin", "pipeline", "commands"),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
