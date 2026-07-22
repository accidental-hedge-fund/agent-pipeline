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
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  linkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { OPERATION_SURFACE, renderClaudeCommand, renderCodexCommand } from "./build.mjs";

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
  let yesDeps = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") host = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--yes-deps") yesDeps = true;
    else if (args[i] === "--force") force = true;
  }
  return { verb, host, dryRun, yesDeps, force };
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

function preflight() {
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
  log("");
}

// loop:contract-coherence (#451) — runs the SAME check function `pipeline doctor`
// and the `pipeline:loop` run-start preflight use (core/scripts/loop-preflight.ts),
// so the three surfaces cannot diverge (design.md decision 4). Unlike doctor (which
// treats a missing goal-loop install as a hard failure — it IS one, for the purpose
// of that diagnostic), the installer only refuses to complete an INCOMPATIBLE
// pairing: goal-loop is optional for a standalone Pipeline install, so its absence
// is reported as info, not a blocker. Runs before any host install (external
// mutation) begins. Returns { ok, message? } rather than calling fail() itself,
// so it stays unit-testable (fail() calls process.exit); main() calls fail()
// on an ok:false result.
async function checkLoopCoherence() {
  let loopPreflight;
  let doctor;
  try {
    loopPreflight = await import(pathToFileURL(join(REPO_ROOT, "core", "scripts", "loop-preflight.ts")).href);
    doctor = await import(pathToFileURL(join(REPO_ROOT, "core", "scripts", "stages", "doctor.ts")).href);
  } catch {
    // loop-preflight module unavailable in this checkout — do not block an
    // otherwise-normal Pipeline install on it.
    return { ok: true };
  }
  const deps = doctor.realDoctorDeps();
  const discovered = await loopPreflight.discoverGoalLoop(deps);
  if (!discovered) {
    log(
      "  ℹ goal-loop not installed (optional) — /pipeline:loop and $pipeline:loop will be " +
        "unavailable until it is: https://github.com/comamitc/goal-loop",
    );
    return { ok: true };
  }
  const result = await loopPreflight.checkLoopContractCoherence(deps);
  if (result.status === "fail") {
    return { ok: false, message: `loop:contract-coherence: ${result.detail}\n  → ${result.remediation}` };
  }
  log(`  ✓ loop:contract-coherence: ${result.detail}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Live-run deferral (#450) — refuse to overwrite an installed core while a
// pipeline run holds a lock, unless --force. Mirrors PipelineLock's liveness
// semantics (core/scripts/lock.ts): a signalable PID is live, ESRCH is stale,
// EPERM (exists but not signalable by us) is treated conservatively as live.
// ---------------------------------------------------------------------------

/** List `/tmp/pipeline-*.lock` file paths. Pure I/O seam; unit tests inject a fake. */
function listPipelineLocks() {
  let entries;
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return [];
  }
  return entries
    .filter((name) => /^pipeline-.*\.lock$/.test(name))
    .map((name) => join(tmpdir(), name));
}

/** Read a lock file's contents (raw PID text), or null if unreadable. */
function readLockFile(lockPath) {
  try {
    return readFileSync(lockPath, "utf8").trim();
  } catch {
    return null;
  }
}

/** Probe whether `pid` is a live, signalable process — same semantics as
 *  `PipelineLock.handleExistingLock` in core/scripts/lock.ts. */
function isPidLiveDefault(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false;
    if (err.code === "EPERM") return true; // exists, can't signal → conservative
    return false;
  }
}

// Default seams for findLiveRunLocks. Named per-field so tests can override
// exactly one.
const defaultLockSeams = {
  listLocks: listPipelineLocks,
  readLock: readLockFile,
  isPidLive: isPidLiveDefault,
};

/** Pure scan: returns the subset of `/tmp/pipeline-*.lock` files that are held
 *  by a live PID, as `{ path, pid }`. A lock with unparseable contents (no
 *  integer PID) is treated as stale, not live — mirrors PipelineLock's garbage-
 *  contents handling. Performs no real filesystem/process-signal call when
 *  `listLocks`/`readLock`/`isPidLive` are all overridden (unit-test seam). */
function findLiveRunLocks({
  listLocks = defaultLockSeams.listLocks,
  readLock = defaultLockSeams.readLock,
  isPidLive = defaultLockSeams.isPidLive,
} = {}) {
  const live = [];
  for (const lockPath of listLocks()) {
    const raw = readLock(lockPath);
    if (raw === null) continue; // unreadable → treat as stale
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue; // unparseable → stale
    if (isPidLive(pid)) live.push({ path: lockPath, pid });
  }
  return live;
}

/** Format the refusal/warning message naming every blocking lock and the remedy. */
function formatLiveRunMessage(liveLocks, { asWarning }) {
  const lines = liveLocks.map((l) => `    ${l.path} (pid ${l.pid})`);
  const header = asWarning
    ? "A pipeline run is in progress — updating would swap files underneath it. Proceeding anyway (--force):"
    : "A pipeline run is in progress — updating would swap files underneath it. Blocking locks:";
  const footer = asWarning
    ? ""
    : "\n  Retry after those runs finish, or re-run with --force to override.";
  return `${header}\n${lines.join("\n")}${footer}`;
}

// ---------------------------------------------------------------------------
// Update lock (#450 round 2) — closes the TOCTOU between the live-run scan
// above and the copy. The installer holds this lock across the scan AND the
// entire copy; the launcher shim (hosts/_shared/entry.template.mjs) reserves
// a pipeline-*.lock-shaped slot and re-checks this lock immediately before it
// loads any engine module. Either the reservation lands on disk before the
// installer's scan (so the scan sees it and refuses) or the update lock is
// still held when the shim re-checks (so the shim backs off before loading
// anything) — a run starting in between can no longer slip through both.
// ---------------------------------------------------------------------------

const UPDATE_LOCK_PATH = join(tmpdir(), ".pipeline-installer-update.lock");

/** Acquire the installer's exclusive update lock. Returns false if another
 *  live installer instance already holds it. Reclaims a stale lock (dead
 *  PID) using the same liveness semantics as the run-lock scan.
 *
 *  Stale reclamation is ownership-safe (#450 delta finding 99d25184): an
 *  unconditional unlink of the shared pathname would let two racing
 *  installers both observe the same stale pid, with the slower unlink
 *  deleting the faster racer's freshly acquired lock. Instead the observed
 *  stale file is claimed exclusively via atomic rename — exactly one racer's
 *  rename succeeds, the other loses with ENOENT and re-evaluates — and the
 *  claimed content is re-verified before being discarded: if a LIVE holder's
 *  fresh lock was captured (it replaced the stale file between our read and
 *  our rename), it is renamed back and the lock is reported as held. */
function acquireUpdateLock(lockPath = UPDATE_LOCK_PATH, isPidLive = isPidLiveDefault) {
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const raw = readLockFile(lockPath);
      const pid = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(pid) && pid > 0 && isPidLive(pid)) return false;
      const claimPath = `${lockPath}.reclaim-${process.pid}`;
      try {
        renameSync(lockPath, claimPath);
      } catch {
        continue; // lost the reclaim race — re-evaluate from the top
      }
      const claimedRaw = readLockFile(claimPath);
      const claimedPid = claimedRaw ? Number.parseInt(claimedRaw, 10) : NaN;
      if (Number.isFinite(claimedPid) && claimedPid > 0 && isPidLive(claimedPid)) {
        // We captured a live holder's fresh lock — give it back via link, not
        // rename: link is atomic and FAILS with EEXIST instead of replacing,
        // so a third installer that acquired while lockPath was vacant is
        // never clobbered (#450 delta finding f8bda4a3). If link loses to
        // such a third acquirer, the captured holder's ownership is decided
        // by the pre-copy ownership verification every installer performs
        // (verifyUpdateLockOwnership below) before touching any file.
        try {
          linkSync(claimPath, lockPath);
        } catch {
          // EEXIST: a third installer legitimately owns lockPath now.
        }
        try {
          unlinkSync(claimPath);
        } catch {
          // best-effort cleanup
        }
        return false;
      }
      try {
        unlinkSync(claimPath); // ours exclusively — safe to discard
      } catch {
        // best-effort cleanup
      }
      // loop: contend on a fresh exclusive "wx" acquire
    }
  }
}

/** Re-read the update lock and confirm this process still owns it. Run
 *  immediately before the copy section: an installer whose freshly acquired
 *  lock was displaced during a concurrent stale-reclaim (#450 delta findings
 *  99d25184/f8bda4a3) observes foreign or missing content here and backs off
 *  instead of copying without exclusivity. */
function verifyUpdateLockOwnership(lockPath = UPDATE_LOCK_PATH) {
  const raw = readLockFile(lockPath);
  return raw !== null && Number.parseInt(raw, 10) === process.pid;
}

function releaseUpdateLock(lockPath = UPDATE_LOCK_PATH) {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
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

// Install the namespaced pipeline:<command> command files for the Claude host (#273).
// Each file is written to <claudeBase>/commands/pipeline:<name>.md.
function installClaudeCommands(claudeBaseDir, dryRun) {
  const commandsDir = join(claudeBaseDir, "commands");
  if (dryRun) {
    log(`  (dry-run) would write ${OPERATION_SURFACE.length} pipeline:<command> files to ${commandsDir}`);
    return;
  }
  mkdirSync(commandsDir, { recursive: true });
  for (const op of OPERATION_SURFACE) {
    const content = renderClaudeCommand(op, "~/.claude/skills/pipeline");
    writeFileSync(join(commandsDir, `pipeline:${op.name}.md`), content);
  }
  log(`  ✓ wrote ${OPERATION_SURFACE.length} pipeline:<command> files to ${commandsDir}`);
}

// Install the namespaced pipeline:<command> agent YAML files for the Codex host (#273).
// Each file is written to <codexSkillsDir>/pipeline/agents/pipeline-<name>.yaml so that
// Codex's agent discovery surface includes each $pipeline:<command> as a distinct entry.
function installCodexCommands(agentsDir, dryRun) {
  if (dryRun) {
    log(`  (dry-run) would write ${OPERATION_SURFACE.length} pipeline:<command> agent files to ${agentsDir}`);
    return;
  }
  mkdirSync(agentsDir, { recursive: true });
  for (const op of OPERATION_SURFACE) {
    const content = renderCodexCommand(op);
    writeFileSync(join(agentsDir, `pipeline-${op.name}.yaml`), content);
  }
  log(`  ✓ wrote ${OPERATION_SURFACE.length} pipeline:<command> agent files to ${agentsDir}`);
}

function installHost(host, dryRun) {
  const cfg = HOSTS[host];
  const skillsDir = cfg.skillsDir();
  const dest = join(skillsDir, "pipeline");
  log(`→ ${cfg.label}: ${dest}`);
  if (dryRun) {
    log(`  (dry-run) would stage core + ${host} overlay, swap atomically, then npm ci in core/`);
    if (host === "claude") installClaudeCommands(claudeBase(), true);
    if (host === "codex") installCodexCommands(join(dest, "agents"), true);
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
  // Install the namespaced pipeline:<command> command/agent files for each host.
  if (host === "claude") installClaudeCommands(claudeBase(), false);
  if (host === "codex") installCodexCommands(join(dest, "agents"), false);
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
// Dependency-prompting phase
// ---------------------------------------------------------------------------
//
// Confirmed install commands — re-verify against upstream READMEs on each
// installer release:
//
//   openspec (@fission-ai/openspec) — OpenSpec CLI:
//     Install:  npm install -g @fission-ai/openspec@latest
//     Update:   npm install -g @fission-ai/openspec@latest (idempotent)
//     Detect:   which openspec + npm list -g @fission-ai/openspec
//     Gate:     openspec.enabled in .github/pipeline.yml (auto|on|off)
//
//   last30days (mvanhorn/last30days-skill) — last30days Claude skill:
//     Install:  npx --yes skills add mvanhorn/last30days-skill -g
//     Update:   npx --yes skills update last30days -g
//     Detect:   ~/.claude/skills/last30days/ + .claude-plugin/plugin.json
//     Gate:     last30days.enabled: true in .github/pipeline.yml

const DEPS = {
  openspec: {
    label: "openspec CLI (@fission-ai/openspec)",
    description: "OpenSpec planning CLI — required for openspec-enabled repos",
    hosts: null,
    featureGate: "openspec",
    installCmd: ["npm", "install", "-g", "@fission-ai/openspec@latest"],
    updateCmd: ["npm", "install", "-g", "@fission-ai/openspec@latest"],
    manualInstall: "npm install -g @fission-ai/openspec@latest",
  },
  last30days: {
    label: "last30days skill",
    description: "last30days Claude skill — required for last30days-enabled repos",
    hosts: null,
    featureGate: "last30days",
    installCmd: ["npx", "--yes", "skills", "add", "mvanhorn/last30days-skill", "-g"],
    updateCmd: ["npx", "--yes", "skills", "update", "last30days", "-g"],
    manualInstall: "npx skills add mvanhorn/last30days-skill -g",
  },
};

// Returns version string (or "unknown") if openspec is installed, null if not.
function openspecPresent() {
  if (!which("openspec")) return null;
  // Try npm list -g for authoritative version
  const r = spawnSync("npm", ["list", "-g", "@fission-ai/openspec", "--depth=0", "--json"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 8000,
  });
  if (r.status === 0 && r.stdout) {
    try {
      const parsed = JSON.parse(r.stdout);
      const v = parsed?.dependencies?.["@fission-ai/openspec"]?.version;
      if (v) return v;
    } catch {}
  }
  // Fallback: openspec --version
  const vr = spawnSync("openspec", ["--version"], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
  if (vr.status === 0 && vr.stdout) return vr.stdout.trim();
  return "unknown";
}

// Returns version string (or "unknown") if last30days skill is installed, null if not.
// Mirrors the runtime resolver candidates: $LAST30DAYS_SKILL_DIR, ~/.claude/skills/last30days,
// ~/.codex/skills/last30days.
function last30daysPresent() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(HOME, ".claude");
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(HOME, ".codex");
  const candidates = [
    process.env.LAST30DAYS_SKILL_DIR ? resolve(process.env.LAST30DAYS_SKILL_DIR) : null,
    join(claudeDir, "skills", "last30days"),
    join(codexHome, "skills", "last30days"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const pluginJson = join(candidate, ".claude-plugin", "plugin.json");
    if (existsSync(pluginJson)) {
      try {
        const plugin = JSON.parse(readFileSync(pluginJson, "utf8"));
        if (plugin.version) return plugin.version;
      } catch {}
    }
    return "unknown";
  }
  return null;
}

// Returns { present, version } for a dependency key.
function detectDep(key) {
  switch (key) {
    case "openspec": { const v = openspecPresent(); return { present: v !== null, version: v }; }
    case "last30days": { const v = last30daysPresent(); return { present: v !== null, version: v }; }
    default: return { present: false, version: null };
  }
}

// Fetches the latest published version for a dep. Returns version string or null on failure.
function fetchLatestVersion(key) {
  if (key === "openspec") {
    const r = spawnSync("npm", ["view", "@fission-ai/openspec", "version"], {
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
    return null;
  }
  // GitHub releases via gh CLI for other deps
  const repos = {
    last30days: "mvanhorn/last30days-skill",
  };
  const repo = repos[key];
  if (!repo || !which("gh")) return null;
  const r = spawnSync("gh", ["api", `/repos/${repo}/releases/latest`, "--jq", ".tag_name"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10000,
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim().replace(/^v/, "");
  return null;
}

// Minimal YAML parser for .github/pipeline.yml (builtins only, no external deps).
// Handles flat and one-level-deep key: value pairs; ignores comments.
function readPipelineConfig(repoPath) {
  const configPath = join(repoPath, ".github", "pipeline.yml");
  if (!existsSync(configPath)) return {};
  const lines = readFileSync(configPath, "utf8").split("\n");
  const config = {};
  let section = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const topMatch = line.match(/^([A-Za-z][\w-]*):\s*(.*)/);
    if (topMatch) {
      section = topMatch[1];
      const val = topMatch[2].trim();
      config[section] = val || {};
      continue;
    }
    const subMatch = line.match(/^[ \t]+([A-Za-z][\w-]*):\s*(.*)/);
    if (subMatch && section) {
      if (typeof config[section] !== "object" || config[section] === null) config[section] = {};
      config[section][subMatch[1]] = subMatch[2].trim();
    }
  }
  return config;
}

// Walks up from startDir to find the git root. Falls back to startDir if not in a git repo.
function findGitRoot(startDir) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDir,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return startDir;
}

// Returns the ordered list of dep keys relevant to the current install.
// repoPath should be the git root so feature flags and openspec/ detection are
// repo-relative regardless of what subdirectory the installer was invoked from.
function getRelevantDeps(pipelineConfig, repoPath) {
  const relevant = [];

  // OpenSpec — gated by feature flag (supports auto|on|off and boolean equivalents).
  const openspecVal = pipelineConfig?.openspec?.enabled;
  if (openspecVal === "on" || openspecVal === "true" || openspecVal === true) {
    relevant.push("openspec");
  } else if (openspecVal === "auto" || openspecVal === undefined || openspecVal === null) {
    // Auto: offer only when the target repo has an openspec/ directory.
    if (repoPath && existsSync(join(repoPath, "openspec"))) relevant.push("openspec");
  }
  // "off" | "false" | false → do not add

  // last30days — gated by feature flag.
  const last30daysVal = pipelineConfig?.last30days?.enabled;
  if (last30daysVal === "true" || last30daysVal === true || last30daysVal === "on") {
    relevant.push("last30days");
  }

  return relevant;
}

// Runs the install/update command for a dep. Returns a result object.
// runCmd is injectable for tests.
async function installDep(key, action, runCmd) {
  const dep = DEPS[key];
  const cmd = action === "update" && dep.updateCmd ? dep.updateCmd : dep.installCmd;
  const exec = runCmd || ((c, a) => spawnSync(c, a, { stdio: "inherit" }));
  try {
    const r = exec(cmd[0], cmd.slice(1));
    if ((r.status ?? 1) !== 0) {
      return {
        status: "failed",
        error: (r.stderr || `exit code ${r.status}`).toString().trim().split("\n")[0],
        manualCmd: dep.manualInstall,
      };
    }
    return { status: action === "update" ? "updated" : "installed" };
  } catch (err) {
    return { status: "failed", error: err.message, manualCmd: dep.manualInstall };
  }
}

// Iterates relevant deps, detects each, prompts (TTY) or skips (non-TTY), and installs.
// All injectable: isTTY, yesDeps, promptFn, runCmd, detectFn, fetchLatestFn.
async function promptDeps(depKeys, {
  dryRun = false,
  yesDeps = false,
  isTTY = false,
  promptFn = promptLine,
  runCmd = null,
  detectFn = detectDep,
  fetchLatestFn = fetchLatestVersion,
} = {}) {
  if (dryRun || !depKeys.length) return {};
  const results = {};
  log("\nOptional dependency check:");

  for (const key of depKeys) {
    const dep = DEPS[key];
    if (!dep) continue;

    if (!isTTY && !yesDeps) {
      // Non-interactive, no opt-in → skip without prompting.
      results[key] = { status: "skipped" };
      log(`  ℹ  ${dep.label}: skipped (non-interactive)`);
      continue;
    }

    // Manual-only deps have no automated install command — show instructions instead.
    if (!dep.installCmd) {
      const detection = detectFn(key);
      if (detection.present) {
        // Check against latest even for manual deps — flag stale installs for manual update.
        const latest = fetchLatestFn(key);
        const installed = detection.version;
        if (latest && installed && installed !== "unknown" && installed !== latest) {
          results[key] = { status: "manual-update-needed", version: installed, latest, manualCmd: dep.manualInstall };
          log(`  ⚠  ${dep.label}: update available (${installed} → ${latest}) — update manually`);
          if (dep.manualInstall) log(`      ${dep.manualInstall}`);
        } else {
          results[key] = { status: "already current", version: installed };
          log(`  ✓ ${dep.label}: present${installed ? ` (${installed})` : ""}`);
        }
      } else {
        let accepted;
        if (yesDeps) {
          accepted = true;
          log(`  → ${dep.label}: showing install instructions (--yes-deps)`);
        } else {
          const answer = await promptFn(`  ${dep.label}: requires manual install.\n    ${dep.description}\n    Show instructions? [y/N] `);
          accepted = answer.toLowerCase() === "y";
        }
        if (accepted) {
          results[key] = { status: "manual-only", manualCmd: dep.manualInstall };
          if (dep.manualInstall) log(`  ℹ  ${dep.label}: install manually:\n      ${dep.manualInstall}`);
        } else {
          results[key] = { status: "declined" };
          log(`  ↷ ${dep.label}: declined`);
        }
      }
      continue;
    }

    const detection = detectFn(key);
    let action, promptText;

    if (!detection.present) {
      action = "install";
      promptText = `  Install ${dep.label}?\n    ${dep.description}\n    [y/N] `;
    } else {
      // Present — check against latest to decide install vs update vs already current.
      const latest = fetchLatestFn(key);
      const installed = detection.version;
      if (latest && installed && installed !== "unknown" && installed === latest) {
        results[key] = { status: "already current", version: installed };
        log(`  ✓ ${dep.label}: already current (${installed})`);
        continue;
      }
      action = "update";
      const vInfo = installed && installed !== "unknown"
        ? ` (installed: ${installed}${latest ? `, latest: ${latest}` : ""})`
        : " (version unknown)";
      promptText = `  Update ${dep.label} to latest${vInfo}?\n    ${dep.description}\n    [y/N] `;
    }

    let accepted;
    if (yesDeps) {
      accepted = true;
      log(`  → ${dep.label}: auto-accepted (--yes-deps)`);
    } else {
      const answer = await promptFn(promptText);
      accepted = answer.toLowerCase() === "y";
    }

    if (!accepted) {
      results[key] = { status: "declined" };
      log(`  ↷ ${dep.label}: declined`);
      continue;
    }

    const result = await installDep(key, action, runCmd);
    results[key] = result;
    if (result.status === "installed" || result.status === "updated") {
      log(`  ✓ ${dep.label}: ${result.status}`);
    } else if (result.status === "failed") {
      warn(`${dep.label}: install failed — ${result.error || "unknown error"}`);
    }
  }

  return results;
}

// Prints a per-dependency status summary after the core install.
function printDepSummary(results) {
  const entries = Object.entries(results);
  if (!entries.length) return;
  log("\nDependency status:");
  let anySkipped = false;
  for (const [key, result] of entries) {
    const label = DEPS[key]?.label || key;
    switch (result.status) {
      case "installed":
        log(`  ✓ ${label}: installed`); break;
      case "updated":
        log(`  ✓ ${label}: updated`); break;
      case "already current":
        log(`  ✓ ${label}: already current${result.version ? ` (${result.version})` : ""}`); break;
      case "manual-only":
        log(`  ℹ  ${label}: install manually`);
        if (result.manualCmd) log(`      ${result.manualCmd}`);
        break;
      case "manual-update-needed":
        warn(`${label}: update available (${result.version} → ${result.latest}) — update manually`);
        if (result.manualCmd) log(`      ${result.manualCmd}`);
        break;
      case "declined":
        log(`  ↷ ${label}: declined`); break;
      case "skipped":
        log(`  ℹ  ${label}: skipped`);
        anySkipped = true;
        break;
      case "failed":
        warn(`${label}: failed — ${result.error || "unknown error"}`);
        if (result.manualCmd) log(`      Manual install: ${result.manualCmd}`);
        break;
      default:
        log(`  ? ${label}: ${result.status}`);
    }
  }
  if (anySkipped) {
    log("\n  Re-run with --yes-deps or PIPELINE_INSTALL_DEPS=1 to auto-install skipped dependencies.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { verb, host, dryRun, yesDeps, force } = parseArgs(process.argv);
  const hosts = selectedHosts(host);

  if (verb === "install" || verb === "update") {
    preflight();
    const loopCheck = await checkLoopCoherence();
    if (!loopCheck.ok) fail(loopCheck.message);

    // Live-run deferral (#450): only guards a host that already has an
    // installed core — a first install onto a fresh host has nothing to race.
    // Skipped under --dry-run, which never copies a file anyway.
    const anyExistingInstall =
      !dryRun && hosts.some((h) => existsSync(join(HOSTS[h].skillsDir(), "pipeline")));
    let holdingUpdateLock = false;
    if (anyExistingInstall) {
      if (!acquireUpdateLock()) {
        fail("Another install/update is already in progress. Retry once it finishes.");
      }
      holdingUpdateLock = true;
      // Pre-copy ownership verification (#450 delta f8bda4a3): a concurrent
      // stale-reclaim can displace a freshly acquired lock; confirm the lock
      // still carries our pid before any file is touched.
      if (!verifyUpdateLockOwnership()) {
        fail("Another install/update displaced the update lock. Retry once it finishes.");
      }
      const liveLocks = findLiveRunLocks();
      if (liveLocks.length > 0) {
        if (force) {
          warn(formatLiveRunMessage(liveLocks, { asWarning: true }));
        } else {
          releaseUpdateLock();
          fail(formatLiveRunMessage(liveLocks, { asWarning: false }));
        }
      }
    }

    try {
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
    } finally {
      if (holdingUpdateLock) releaseUpdateLock();
    }

    // Dependency-prompting phase: run after core install, never blocks completion.
    const repoPath = findGitRoot(process.cwd());
    const pipelineConfig = readPipelineConfig(repoPath);
    const relevantDeps = getRelevantDeps(pipelineConfig, repoPath);
    const autoAccept = yesDeps || process.env.PIPELINE_INSTALL_DEPS === "1";
    const depResults = await promptDeps(relevantDeps, {
      dryRun,
      yesDeps: autoAccept,
      isTTY: Boolean(process.stdin.isTTY),
    });
    printDepSummary(depResults);

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
export {
  MANAGED_MARKER,
  DEPS,
  checkLoopCoherence,
  detectPersonalSkill,
  uniqueBackupPath,
  relocatePersonalSkill,
  offerRelocationWith,
  openspecPresent,
  last30daysPresent,
  detectDep,
  fetchLatestVersion,
  readPipelineConfig,
  findGitRoot,
  getRelevantDeps,
  promptDeps,
  installDep,
  printDepSummary,
  parseArgs,
  findLiveRunLocks,
  formatLiveRunMessage,
  acquireUpdateLock,
  releaseUpdateLock,
  verifyUpdateLockOwnership,
  UPDATE_LOCK_PATH,
};

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
