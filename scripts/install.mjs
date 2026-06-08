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
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = homedir();

// Sentinel written into every installer-managed skill dir. Its absence marks a
// pre-existing personal install that would shadow the plugin's /pipeline skill.
const MANAGED_MARKER = ".pipeline-installer-managed";

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
    postInstall: "Invoke with /pipeline. Live-detected this session (no restart).",
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

// ---------------------------------------------------------------------------
// Shadow detection + relocation
// ---------------------------------------------------------------------------

function detectPersonalSkill(host) {
  const dest = join(HOSTS[host].skillsDir(), "pipeline");
  if (!existsSync(dest)) return { shadowing: false, dest };
  if (existsSync(join(dest, MANAGED_MARKER))) return { shadowing: false, dest };
  return { shadowing: true, dest };
}

function uniqueBackupPath(base, timestamp) {
  const stem = join(base, `pipeline.${timestamp}.bak`);
  if (!existsSync(stem)) return stem;
  for (let i = 1; i <= 100; i++) {
    const p = `${stem}.${i}`;
    if (!existsSync(p)) return p;
  }
  throw new Error(`Cannot find a unique backup path under ${base} — remove old backups and retry.`);
}

// Atomically renames dest to a unique backup path under base/ts, retrying on
// EEXIST/ENOTEMPTY so a concurrent process creating the same timestamped path
// cannot violate the no-overwrite guarantee. Returns the actual path used.
function relocatePersonalSkill(dest, base, ts) {
  const stem = join(base, `pipeline.${ts}.bak`);
  const tryRename = (p) => {
    try {
      renameSync(dest, p);
      return p;
    } catch (err) {
      if (err.code === "EEXIST" || err.code === "ENOTEMPTY" || err.code === "EISDIR") return null;
      throw err;
    }
  };
  const first = tryRename(stem);
  if (first) return first;
  for (let i = 1; i <= 100; i++) {
    const r = tryRename(`${stem}.${i}`);
    if (r) return r;
  }
  throw new Error(`Cannot find a unique backup path under ${base} — remove old backups and retry.`);
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// offerRelocationWith is the testable core; isTTY and promptFn are injectable
// for unit tests. Returns "proceed" (install this host) or "skip" (preserve the
// personal install untouched and skip this host).
async function offerRelocationWith(dest, base, dryRun, isTTY, promptFn = promptLine) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = uniqueBackupPath(base, ts);
  const relocateCmd = `mv '${dest}' '${backupPath}'`;

  if (dryRun) {
    warn(
      `Personal install detected at ${dest} — would shadow the plugin's /pipeline.\n` +
        `  (dry-run) To relocate manually: ${relocateCmd}`,
    );
    return "proceed";
  }

  if (!isTTY) {
    // Non-interactive (CI, piped npx): the install target is this exact path, so
    // proceeding would overwrite the personal install. Auto-relocate to a backup
    // first so data is preserved rather than silently destroyed.
    warn(
      `Personal pipeline skill detected at ${dest} (no ${MANAGED_MARKER} marker).\n` +
        `  Non-interactive environment — auto-relocating to preserve data.`,
    );
    const actualNonTTYBackup = relocatePersonalSkill(dest, base, ts);
    warn(`  Backed up to: ${actualNonTTYBackup}`);
    return "proceed";
  }

  // Interactive TTY: prompt the user.
  warn(
    `A personal pipeline skill exists at:\n  ${dest}\n` +
      `  The plugin installs to this same path, so installing here would overwrite it.`,
  );
  const answer = await promptFn(`  Relocate it to ${backupPath} first? [y/N] `);
  if (answer.toLowerCase() === "y") {
    const actualTTYBackup = relocatePersonalSkill(dest, base, ts);
    log(`  ✓ Relocated to ${actualTTYBackup}`);
    return "proceed";
  }

  // Declined: leave the personal install untouched and skip this host's install
  // (proceeding would overwrite it). The duplicate-/pipeline consequence is real
  // when a personal skill install coexists with the marketplace plugin.
  warn(
    `Personal install left in place at ${dest}.\n` +
      `  Skipped installing here to avoid overwriting it.\n` +
      `  Note: a personal skill install alongside the marketplace plugin shows up as\n` +
      `  duplicate /pipeline entries. To migrate, relocate it then re-run install:\n` +
      `    ${relocateCmd}`,
  );
  return "skip";
}

async function offerRelocation(dest, base, dryRun) {
  return offerRelocationWith(dest, base, dryRun, Boolean(process.stdin.isTTY));
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
  // Sentinel: written into staging so it lands atomically with the skill tree.
  // Future runs use this to distinguish an installer-managed dir from a personal one.
  writeFileSync(join(stagingDir, MANAGED_MARKER), "");
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

async function main() {
  const { verb, host, dryRun } = parseArgs(process.argv);
  const hosts = selectedHosts(host);

  if (verb === "install" || verb === "update") {
    preflight(hosts);
    log(`Installing agent-pipeline → [${hosts.join(", ")}]${dryRun ? " (dry-run)" : ""}\n`);
    for (const h of hosts) {
      if (h === "claude") {
        const { shadowing, dest } = detectPersonalSkill(h);
        if (shadowing) {
          const action = await offerRelocation(dest, claudeBase(), dryRun);
          if (action === "skip") {
            log(`  ↷ Skipped Claude Code install — relocate the personal install first, then re-run.`);
            continue;
          }
        }
      }
      installHost(h, dryRun);
    }
    log("\nDone.");
  } else if (verb === "uninstall") {
    log(`Uninstalling agent-pipeline ← [${hosts.join(", ")}]${dryRun ? " (dry-run)" : ""}\n`);
    for (const h of hosts) uninstallHost(h, dryRun);
    log("\nDone.");
  } else {
    fail(`Unknown command '${verb}'. Use install, update, or uninstall.`);
  }
}

// Named exports for unit tests.
export { MANAGED_MARKER, detectPersonalSkill, uniqueBackupPath, relocatePersonalSkill, offerRelocationWith };

// ESM main guard — tolerates bin symlinks by resolving both paths before comparing.
function _isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (_isMain()) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
