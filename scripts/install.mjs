#!/usr/bin/env node
// agent-pipeline cross-tool installer.
//
//   node scripts/install.mjs install   [--host claude|codex|all] [--dry-run]
//   node scripts/install.mjs update    [--host …]            (alias for install; idempotent)
//   node scripts/install.mjs uninstall [--host …]
//
// Zero runtime dependencies (node: builtins only) so it can be run directly
// from a clone or via `npx github:accidental-hedge-fund/agent-pipeline`. It copies the shared
// core + the right host overlay into each host's skills directory, writes a
// portable launcher shim, and pre-installs the core's npm dependencies.
//
// Honors CLAUDE_CONFIG_DIR and CODEX_HOME for non-default install locations.

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();

// ---------------------------------------------------------------------------
// Host definitions
// ---------------------------------------------------------------------------

function claudeBase() {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(HOME, ".claude");
}

// Codex's user-skill path has drifted between ~/.codex/skills (installer + current
// CLI) and ~/.agents/skills (newer docs). Honor CODEX_HOME first, then prefer
// whichever base already exists, defaulting to ~/.codex.
function codexSkillsDir() {
  if (process.env.CODEX_HOME) return join(resolve(process.env.CODEX_HOME), "skills");
  const codexHome = join(HOME, ".codex");
  if (existsSync(codexHome)) return join(codexHome, "skills");
  const agentsHome = join(HOME, ".agents");
  if (existsSync(agentsHome)) return join(agentsHome, "skills");
  return join(codexHome, "skills");
}

const HOSTS = {
  claude: {
    label: "Claude Code",
    profile: "claude",
    overlayDir: join(REPO_ROOT, "hosts", "claude"),
    overlayFiles: ["SKILL.md"],
    overlayDirs: [],
    baseExists: () => existsSync(claudeBase()),
    skillsDir: () => join(claudeBase(), "skills"),
    postInstall:
      "Invoke with /pipeline. Live-detected this session (no restart). " +
      "Tip: removing a duplicate plugin install avoids two /pipeline entries.",
  },
  codex: {
    label: "Codex",
    profile: "codex",
    overlayDir: join(REPO_ROOT, "hosts", "codex"),
    overlayFiles: ["SKILL.md"],
    overlayDirs: ["agents"],
    baseExists: () => existsSync(dirname(codexSkillsDir())),
    skillsDir: () => codexSkillsDir(),
    postInstall: "Restart Codex to pick it up, then invoke with $pipeline.",
  },
};

// Whitelisted core payload (node_modules is intentionally excluded; the shim
// or this installer provisions it via `npm ci`).
const CORE_ENTRIES = ["scripts", "profiles", "package.json", "package-lock.json"];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const verb = args[0] && !args[0].startsWith("-") ? args[0] : "install";
  let host = "all";
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") host = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
  }
  return { verb, host, dryRun };
}

function selectedHosts(hostArg) {
  if (hostArg === "all") {
    const present = Object.keys(HOSTS).filter((h) => HOSTS[h].baseExists());
    if (present.length === 0) {
      fail(
        "No host detected (neither ~/.claude nor ~/.codex found). " +
          "Pass --host claude or --host codex to force one.",
      );
    }
    return present;
  }
  if (!HOSTS[hostArg]) fail(`Unknown --host '${hostArg}'. Use claude, codex, or all.`);
  return [hostArg];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(`⚠️  ${msg}`);
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function which(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "command", ["-v", bin], {
    stdio: "ignore",
    shell: true,
  });
  return r.status === 0;
}

// The Codex ($pipeline) profile reviews by driving Claude Code through the
// cc-plugin-codex companion (claude-companion.mjs). It is a SEPARATE plugin,
// not shipped here. Detect it so a Codex install surfaces the dependency.
function companionPresent() {
  if (process.env.PIPELINE_CC_COMPANION) return existsSync(process.env.PIPELINE_CC_COMPANION);
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(HOME, ".codex");
  return [
    join(codexHome, "plugins", "cache", "local-plugins", "cc", "local", "scripts", "claude-companion.mjs"),
    join(codexHome, "plugins", "cc", "scripts", "claude-companion.mjs"),
  ].some((p) => existsSync(p));
}

// The Claude (/pipeline) profile reviews by driving Codex through the
// codex-plugin-cc companion (codex-companion.mjs). It is a SEPARATE Claude Code
// plugin, not shipped here. Detect it so a Claude install surfaces the dependency.
function codexCompanionPresent() {
  if (process.env.PIPELINE_CODEX_COMPANION) return existsSync(process.env.PIPELINE_CODEX_COMPANION);
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(HOME, ".claude");
  const candidates = [
    join(claudeDir, "plugins", "marketplaces", "openai-codex", "plugins", "codex", "scripts", "codex-companion.mjs"),
  ];
  // Versioned install cache: plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs
  const cacheBase = join(claudeDir, "plugins", "cache", "openai-codex", "codex");
  if (existsSync(cacheBase)) {
    for (const version of readdirSync(cacheBase)) {
      candidates.push(join(cacheBase, version, "scripts", "codex-companion.mjs"));
    }
  }
  return candidates.some((p) => existsSync(p));
}

function preflight(hosts) {
  log("\nPrerequisite check (warnings do not block install; the skill needs these at run time):");
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor >= 24) log(`  ✓ node ${process.versions.node} (>= 24)`);
  else warn(`node ${process.versions.node} — the pipeline core requires Node >= 24 at run time.`);
  for (const bin of ["git", "gh", "claude", "codex", "npm"]) {
    if (which(bin)) log(`  ✓ ${bin}`);
    else warn(`${bin} not found on PATH — required at run time.`);
  }
  if (which("gh")) {
    const auth = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
    if (auth.status === 0) log("  ✓ gh authenticated");
    else warn("gh is not authenticated — run `gh auth login` before using the pipeline.");
  }
  // OpenSpec is optional — only repos that opt in (an `openspec/` dir, or
  // `openspec.enabled` in .github/pipeline.yml) need the CLI. Info, not a warning.
  if (which("openspec")) log("  ✓ openspec (optional) — for OpenSpec-enabled repos");
  else log("  ℹ openspec not found (optional) — only for OpenSpec-enabled repos; install: npm i -g @fission-ai/openspec");
  if (hosts.includes("codex")) {
    if (companionPresent()) log("  ✓ cc companion (claude-companion.mjs) — needed for $pipeline review");
    else
      warn(
        "Codex review needs the cc-plugin-codex companion (claude-companion.mjs). " +
          "Install it with `npx cc-plugin-codex install`, then `claude auth login`. " +
          "(Override its path with PIPELINE_CC_COMPANION.)",
      );
  }
  if (hosts.includes("claude")) {
    if (codexCompanionPresent()) log("  ✓ codex companion (codex-companion.mjs) — needed for /pipeline review");
    else
      warn(
        "Claude review needs the codex-plugin-cc companion (codex-companion.mjs). " +
          "Install it in Claude Code with `/plugin marketplace add openai/codex-plugin-cc` then " +
          "`/plugin install codex@openai-codex`, and ensure the `codex` CLI is authenticated. " +
          "(Override its path with PIPELINE_CODEX_COMPANION.)",
      );
  }
  log("");
}

function renderShim(profile) {
  const tmpl = readFileSync(join(REPO_ROOT, "hosts", "_shared", "entry.template.mjs"), "utf8");
  return tmpl.replaceAll("__PROFILE__", profile);
}

function stageInto(stagingDir, host) {
  const cfg = HOSTS[host];
  // Overlay (SKILL.md, codex agents/).
  for (const f of cfg.overlayFiles) {
    cpSync(join(cfg.overlayDir, f), join(stagingDir, f));
  }
  for (const d of cfg.overlayDirs) {
    cpSync(join(cfg.overlayDir, d), join(stagingDir, d), { recursive: true });
  }
  // Shared core (whitelisted; no node_modules).
  const coreDst = join(stagingDir, "core");
  mkdirSync(coreDst, { recursive: true });
  for (const entry of CORE_ENTRIES) {
    const src = join(REPO_ROOT, "core", entry);
    if (existsSync(src)) cpSync(src, join(coreDst, entry), { recursive: true });
  }
  // Launcher shim.
  const scriptsDst = join(stagingDir, "scripts");
  mkdirSync(scriptsDst, { recursive: true });
  const shimPath = join(scriptsDst, "pipeline.mjs");
  writeFileSync(shimPath, renderShim(cfg.profile));
  chmodSync(shimPath, 0o755);
}

function installHost(host, dryRun) {
  const cfg = HOSTS[host];
  const skillsDir = cfg.skillsDir();
  const dest = join(skillsDir, "pipeline");
  log(`→ ${cfg.label}: ${dest}`);
  if (dryRun) {
    log(`  (dry-run) would stage core + ${host} overlay, swap atomically, then npm ci in core/`);
    return;
  }
  mkdirSync(skillsDir, { recursive: true });
  // Atomic staging: build a temp tree as a sibling of dest, then swap.
  const staging = mkdtempSync(join(skillsDir, ".pipeline-staging-"));
  try {
    stageInto(staging, host);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  // Pre-warm dependencies so the first invocation is instant (the shim also
  // self-heals if this is skipped or fails).
  if (which("npm")) {
    const ci = spawnSync("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
      cwd: join(dest, "core"),
      stdio: "inherit",
    });
    if ((ci.status ?? 1) !== 0) {
      warn(`npm ci failed in ${join(dest, "core")} — deps will install on first run instead.`);
    }
  } else {
    warn("npm not found — dependencies will install on first run.");
  }
  log(`  ✓ installed. ${cfg.postInstall}`);
}

function uninstallHost(host, dryRun) {
  const cfg = HOSTS[host];
  const dest = join(cfg.skillsDir(), "pipeline");
  if (!existsSync(dest)) {
    log(`→ ${cfg.label}: nothing installed at ${dest}`);
    return;
  }
  log(`→ ${cfg.label}: removing ${dest}`);
  if (dryRun) {
    log("  (dry-run) would rm -rf the skill directory");
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  log("  ✓ removed");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { verb, host, dryRun } = parseArgs(process.argv);
  const hosts = selectedHosts(host);

  if (verb === "install" || verb === "update") {
    preflight(hosts);
    log(`Installing agent-pipeline → [${hosts.join(", ")}]${dryRun ? " (dry-run)" : ""}\n`);
    for (const h of hosts) installHost(h, dryRun);
    log("\nDone.");
  } else if (verb === "uninstall") {
    log(`Uninstalling agent-pipeline ← [${hosts.join(", ")}]${dryRun ? " (dry-run)" : ""}\n`);
    for (const h of hosts) uninstallHost(h, dryRun);
    log("\nDone.");
  } else {
    fail(`Unknown command '${verb}'. Use install, update, or uninstall.`);
  }
}

main();
