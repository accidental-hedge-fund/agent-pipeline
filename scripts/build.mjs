#!/usr/bin/env node
// Regenerates the committed SKILL overlay and marketplace catalog from
// hosts/claude/ (+ hosts/_shared launcher template). Run after editing those
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SKILL_OVERLAY_REL = join("plugin", "pipeline", "skills", "pipeline", "SKILL.md");
export const MARKETPLACE_CATALOG_REL = join(".claude-plugin", "marketplace.json");

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

// Verb catalog for docs and the host SKILL table (#273, #1048).
// Operators invoke `pipeline <verb>`. This listing is not a reason to emit one
// host command file per verb. `argHint` / `desc` / `cliArgs` remain catalog
// metadata for docs generators. `fast` / `inRepoLoop` classify orchestration.
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
    name: "recover-parked",
    desc:
      "One supervisor pass for parked issue N: deterministic recover first; reflow only stale/DNR/below-high (never auto-override HIGH/CRITICAL/security); re-enter single if clear",
    argHint: "<N>",
    cliArgs: "recover-parked $ARGUMENTS",
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
    desc: "Run deterministic preflight checks and print a pass/fail summary (opt-in --harness-smoke for role-aware runtime smoke)",
    argHint: "[--harness-smoke]",
    cliArgs: "doctor $ARGUMENTS",
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
    name: "decompose",
    desc: "Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes)",
    argHint: "--epic <N> [--description \"…\"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl]",
    cliArgs: "decompose $ARGUMENTS",
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
    desc: "Operator-authorized squash merge of a ready-to-deploy PR",
    argHint: "<pr>",
    cliArgs: "merge $ARGUMENTS",
    fast: true,
  },
  {
    name: "merge-queue",
    desc: "Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete",
    argHint: "--milestone <title> [--apply] [--release-when-complete --release-version <v>]",
    cliArgs: "merge-queue $ARGUMENTS",
    fast: false,
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
    desc: "List or stream pipeline run logs (events --follow exits 0 on run_complete; --no-until-terminal for interrupt-only)",
    argHint: "[<run-id>] [--events] [-f]",
    cliArgs: "logs $ARGUMENTS",
    fast: true,
  },
  // loop (#451, internalized #512): a self-contained CLI run, not an external
  // hand-off. The pipeline CLI runs the deterministic loop preflight (argument
  // normalization, loop:store-schema-compatibility, native-/goal capability),
  // then drives the durable run — contract, ledger, lock, recovery,
  // reconciliation, resume — entirely in-repo through this skill's own loop
  // supervisor. It invokes no externally installed goal-loop skill.
  {
    name: "loop",
    desc: "Durable multi-item run — driven in-repo by the pipeline's own loop supervisor",
    argHint: "[--milestone <name>] [--label <label>] [--range <spec>] [--roadmap-slice <slice>] [<N> ...] [--resume <run-id>] [--audit]",
    cliArgs: "loop $ARGUMENTS",
    // Multi-item drive/resume is long-running (minutes–hours). Do NOT use the
    // shared fast template ("completes in seconds" / "no Monitor") — #668.
    // Specialized packaging via inRepoLoop (early handoff #665 + event follow).
    fast: false,
    inRepoLoop: true,
  },
];

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

export function buildInto(root) {
  const skillDir = join(root, "plugin", "pipeline", "skills", "pipeline");
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  mkdirSync(join(root, "plugin", "pipeline", ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });

  // SKILL overlay + launcher shim only. Do not copy core/ into plugin/ (#1048).
  writeFileSync(join(skillDir, "SKILL.md"), pluginSkillMd());
  const shim = join(skillDir, "scripts", "pipeline.mjs");
  writeFileSync(shim, renderShim("claude"));
  chmodSync(shim, 0o755);
  // Host-facing material filter launcher (#742) — same install surface as pipeline.mjs.
  const materialFilter = join(skillDir, "scripts", "material-filter.mjs");
  cpSync(join(REPO_ROOT, "hosts", "_shared", "material-filter.mjs"), materialFilter);
  chmodSync(materialFilter, 0o755);
  // Shared Node >=24 resolver loaded by the generated shim (#1236).
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
    rmSync(join(REPO_ROOT, "plugin"), { recursive: true, force: true });
    buildInto(REPO_ROOT);
    console.log("✓ generated SKILL overlay and .claude-plugin/marketplace.json");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
