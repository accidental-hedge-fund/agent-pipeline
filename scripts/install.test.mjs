#!/usr/bin/env node
// Unit tests for shadow-detection and dependency-prompting helpers in scripts/install.mjs.
// Run with: node --test scripts/install.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  MANAGED_MARKER,
  INSTALL_RECEIPT,
  DEPS,
  HOSTS,
  VALID_HOSTS,
  reloadHostsFromManifests,
  loadOuterHostManifests,
  checkLoopCoherence,
  detectPersonalSkill,
  uniqueBackupPath,
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
  installClaudeCommands,
  uninstallClaudeCommands,
  installOpenCodeCommands,
  uninstallOpenCodeCommands,
  renderOpenCodePipelineCommand,
  uninstallHost,
  opencodeBase,
  opencodeSkillDir,
  installHost,
} from "./install.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "pipeline-install-test-"));
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// Synthetic registry entry exercising the manual-only path of the generic
// dep-prompt machinery (installCmd: null), which no shipped dep uses today.
// Registered into DEPS for this test process only.
DEPS["test-manual-dep"] = {
  label: "test-manual-dep",
  description: "synthetic manual-only dependency (test fixture)",
  hosts: null,
  featureGate: null,
  installCmd: null,
  updateCmd: null,
  manualInstall: "manually install test-manual-dep",
};

// ---------------------------------------------------------------------------
// 4.2 — no marker → detectPersonalSkill returns { shadowing: true }
// ---------------------------------------------------------------------------

test("detectPersonalSkill: directory present, no marker → shadowing true", () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = detectPersonalSkill("claude");
    assert.equal(result.shadowing, true);
    assert.equal(result.dest, dest);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4.3 — marker present → detectPersonalSkill returns { shadowing: false }
// ---------------------------------------------------------------------------

test("detectPersonalSkill: marker present → shadowing false", () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MANAGED_MARKER), "");
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = detectPersonalSkill("claude");
    assert.equal(result.shadowing, false);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("detectPersonalSkill: no directory → shadowing false", () => {
  const tmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = detectPersonalSkill("claude");
    assert.equal(result.shadowing, false);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4.4 — uniqueBackupPath: first non-existing, increments, throws at 100
// ---------------------------------------------------------------------------

test("uniqueBackupPath: returns first non-existing stem", () => {
  const tmp = makeTmp();
  const ts = "2026-01-01T00-00-00";
  try {
    const result = uniqueBackupPath(tmp, ts);
    assert.equal(result, join(tmp, `pipeline.${ts}.bak`));
    assert.equal(existsSync(result), false);
  } finally {
    cleanup(tmp);
  }
});

test("uniqueBackupPath: increments suffix when stem exists", () => {
  const tmp = makeTmp();
  const ts = "2026-01-01T00-00-00";
  writeFileSync(join(tmp, `pipeline.${ts}.bak`), "");
  try {
    const result = uniqueBackupPath(tmp, ts);
    assert.equal(result, join(tmp, `pipeline.${ts}.bak.1`));
  } finally {
    cleanup(tmp);
  }
});

test("uniqueBackupPath: increments past multiple existing backups", () => {
  const tmp = makeTmp();
  const ts = "2026-01-01T00-00-00";
  writeFileSync(join(tmp, `pipeline.${ts}.bak`), "");
  writeFileSync(join(tmp, `pipeline.${ts}.bak.1`), "");
  writeFileSync(join(tmp, `pipeline.${ts}.bak.2`), "");
  try {
    const result = uniqueBackupPath(tmp, ts);
    assert.equal(result, join(tmp, `pipeline.${ts}.bak.3`));
  } finally {
    cleanup(tmp);
  }
});

test("uniqueBackupPath: throws after 100 collisions", () => {
  const tmp = makeTmp();
  const ts = "2026-01-01T00-00-00";
  writeFileSync(join(tmp, `pipeline.${ts}.bak`), "");
  for (let i = 1; i <= 100; i++) {
    writeFileSync(join(tmp, `pipeline.${ts}.bak.${i}`), "");
  }
  try {
    assert.throws(
      () => uniqueBackupPath(tmp, ts),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("unique backup path"));
        return true;
      },
    );
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// 4.5 — CLAUDE_CONFIG_DIR override: detection + backup paths use custom dir
// ---------------------------------------------------------------------------

test("CLAUDE_CONFIG_DIR override: detectPersonalSkill uses custom dir", () => {
  const tmp = makeTmp();
  const customDest = join(tmp, "skills", "pipeline");
  mkdirSync(customDest, { recursive: true });
  // No marker — personal install
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = detectPersonalSkill("claude");
    assert.equal(result.shadowing, true);
    assert.ok(result.dest.startsWith(tmp), "dest should be under the custom CLAUDE_CONFIG_DIR");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("CLAUDE_CONFIG_DIR override: uniqueBackupPath targets custom dir", () => {
  const tmp = makeTmp();
  const ts = "2026-06-07T12-00-00";
  const result = uniqueBackupPath(tmp, ts);
  assert.ok(result.startsWith(tmp), "backup path should be under the custom dir");
  cleanup(tmp);
});

// ---------------------------------------------------------------------------
// 4.6 — non-TTY path: emits warning, does not prompt, auto-relocates
// ---------------------------------------------------------------------------

test("offerRelocationWith non-TTY: auto-relocates dest and returns 'proceed'", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "test content");
  const ts = "2026-06-07T00-00-00";
  const backupPath = join(tmp, `pipeline.${ts}.bak`);
  try {
    // isTTY = false simulates a non-interactive environment
    const result = await offerRelocationWith(dest, tmp, false, false);
    assert.equal(result, "proceed");
    // dest should have been moved
    assert.equal(existsSync(dest), false, "dest should no longer exist");
    // backup should exist somewhere under tmp (timestamp may differ slightly)
    const backupsExist = ["bak", "bak.1"].some((suffix) =>
      existsSync(join(tmp, `pipeline.${ts}.bak`)) ||
      existsSync(join(tmp, `pipeline.${ts}.bak.1`))
    );
    // Just verify dest is gone and at least one backup-pattern path exists under tmp
    const entries = (await import("node:fs")).readdirSync(tmp);
    const hasBackup = entries.some((e) => e.startsWith("pipeline.") && e.endsWith(".bak"));
    assert.ok(hasBackup, "a backup directory should exist under the base dir");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("offerRelocationWith dry-run: does not relocate, returns 'proceed'", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  try {
    const result = await offerRelocationWith(dest, tmp, true, false);
    assert.equal(result, "proceed");
    // dest must still exist — dry-run never mutates
    assert.ok(existsSync(dest), "dest should still exist after dry-run");
  } finally {
    cleanup(tmp);
  }
});

test("offerRelocationWith TTY accept ('y'): relocates and returns 'proceed'", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "personal skill");
  try {
    // Inject a prompt that answers "y" — exercises the real accept branch.
    const result = await offerRelocationWith(dest, tmp, false, true, async () => "y");
    assert.equal(result, "proceed");
    assert.equal(existsSync(dest), false, "dest moved after accepted relocation");
    const entries = (await import("node:fs")).readdirSync(tmp);
    assert.ok(
      entries.some((e) => e.startsWith("pipeline.") && e.includes(".bak")),
      "a backup directory should exist under the base dir",
    );
  } finally {
    cleanup(tmp);
  }
});

test("offerRelocationWith TTY decline ('n'): preserves dest and returns 'skip'", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "personal skill");
  try {
    // Inject a prompt that answers "n" — the declined path must NOT touch data.
    const result = await offerRelocationWith(dest, tmp, false, true, async () => "n");
    assert.equal(result, "skip");
    assert.ok(existsSync(dest), "dest must remain untouched after decline");
    assert.ok(existsSync(join(dest, "SKILL.md")), "personal files preserved on decline");
    const entries = (await import("node:fs")).readdirSync(tmp);
    assert.ok(
      !entries.some((e) => e.startsWith("pipeline.") && e.includes(".bak")),
      "no backup should be created when the user declines",
    );
  } finally {
    cleanup(tmp);
  }
});

test("offerRelocationWith TTY empty answer (Enter): treated as decline → 'skip'", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  try {
    const result = await offerRelocationWith(dest, tmp, false, true, async () => "");
    assert.equal(result, "skip");
    assert.ok(existsSync(dest), "dest preserved when user just presses Enter");
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Race-condition regression: backup path created between selection and rename
// ---------------------------------------------------------------------------

test("offerRelocationWith non-TTY: uses fallback suffix when stem backup is pre-created (race)", async () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "personal skill");

  // Simulate a concurrent process that already created the timestamped stem
  // before our rename fires. We do this by pre-populating the stem-named path
  // so the first rename attempt fails with ENOTEMPTY/EEXIST, forcing a retry.
  // uniqueBackupPath uses the same ts format so we need to pre-create ANY
  // plausible stem. We inject a custom promptFn that first creates the stem to
  // trigger the race, but since this is the non-TTY path (no prompt), we instead
  // pre-create the stem before calling offerRelocationWith.
  //
  // The ts in offerRelocationWith is derived from `new Date()`, so we capture
  // all .bak entries after the call rather than predicting the exact stem.
  const { readdirSync } = await import("node:fs");

  // Pre-create a stem that matches the current second so the first candidate
  // is taken. We over-provision by creating stems for the current and adjacent
  // seconds to be robust against second boundaries.
  const nowTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  mkdirSync(join(tmp, `pipeline.${nowTs}.bak`), { recursive: true });
  writeFileSync(join(tmp, `pipeline.${nowTs}.bak`, "sentinel"), "occupied by race");

  try {
    const result = await offerRelocationWith(dest, tmp, false, false);
    assert.equal(result, "proceed");
    assert.equal(existsSync(dest), false, "dest should have been relocated");

    const entries = readdirSync(tmp);
    // The stem backup contains "sentinel" (untouched). Dest must be in a .bak.N entry.
    const fallbackEntries = entries.filter((e) => e.includes(".bak.") && e.startsWith("pipeline."));
    assert.ok(
      fallbackEntries.length > 0 || entries.some((e) => e.endsWith(".bak") && !existsSync(join(tmp, e, "sentinel"))),
      "dest must be relocated to a non-colliding backup path",
    );
    // The occupied stem must still contain its sentinel (not overwritten).
    assert.ok(
      existsSync(join(tmp, `pipeline.${nowTs}.bak`, "sentinel")),
      "pre-existing backup must not be overwritten (no-clobber guarantee)",
    );
  } finally {
    cleanup(tmp);
  }
});

// ==========================================================================
// Dependency detection helpers
// ==========================================================================

// ---------------------------------------------------------------------------
// 2.3 openspecPresent — smoke-tests the return type contract
// ---------------------------------------------------------------------------

test("openspecPresent: returns null or string (never throws)", () => {
  const result = openspecPresent();
  assert.ok(result === null || typeof result === "string", "openspecPresent returns string or null");
});

// ---------------------------------------------------------------------------
// 2.4 last30daysPresent — checks ~/.claude/skills/last30days/
// ---------------------------------------------------------------------------

test("last30daysPresent: returns null when skill dir does not exist", () => {
  const tmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = last30daysPresent();
    assert.equal(result, null);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("last30daysPresent: returns 'unknown' when skill dir exists but no plugin.json", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, "skills", "last30days"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = last30daysPresent();
    assert.equal(result, "unknown");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("last30daysPresent: returns version from plugin.json", () => {
  const tmp = makeTmp();
  const pluginDir = join(tmp, "skills", "last30days", ".claude-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ version: "3.3.2" }));
  process.env.CLAUDE_CONFIG_DIR = tmp;
  try {
    const result = last30daysPresent();
    assert.equal(result, "3.3.2");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
  }
});

// ==========================================================================
// Relevance gating — getRelevantDeps
// ==========================================================================

// ---------------------------------------------------------------------------
// 3.1 readPipelineConfig — minimal YAML parser
// ---------------------------------------------------------------------------

test("readPipelineConfig: returns empty object when file does not exist", () => {
  const tmp = makeTmp();
  const config = readPipelineConfig(tmp);
  assert.deepEqual(config, {});
  cleanup(tmp);
});

test("readPipelineConfig: parses openspec.enabled and last30days.enabled", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, ".github"));
  writeFileSync(
    join(tmp, ".github", "pipeline.yml"),
    "openspec:\n  enabled: auto\nlast30days:\n  enabled: true\n",
  );
  const config = readPipelineConfig(tmp);
  assert.equal(config?.openspec?.enabled, "auto");
  assert.equal(config?.last30days?.enabled, "true");
  cleanup(tmp);
});

test("readPipelineConfig: ignores comment lines", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, ".github"));
  writeFileSync(
    join(tmp, ".github", "pipeline.yml"),
    "# top comment\nopenspec:\n  # sub comment\n  enabled: on\n",
  );
  const config = readPipelineConfig(tmp);
  assert.equal(config?.openspec?.enabled, "on");
  cleanup(tmp);
});

// ---------------------------------------------------------------------------
// 3.2 / 3.3 getRelevantDeps — feature flag gating
// ---------------------------------------------------------------------------

test("getRelevantDeps: empty config and no repo → no deps offered", () => {
  const deps = getRelevantDeps({}, null);
  assert.deepEqual(deps, [], "no feature flags set → nothing to offer");
});

test("getRelevantDeps: openspec.enabled=auto with no openspec/ dir → omits openspec", () => {
  const tmp = makeTmp();
  const deps = getRelevantDeps({ openspec: { enabled: "auto" } }, tmp);
  assert.ok(!deps.includes("openspec"), "auto without openspec/ dir should omit openspec");
  cleanup(tmp);
});

test("getRelevantDeps: openspec.enabled=auto with openspec/ dir → includes openspec", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, "openspec"), { recursive: true });
  const deps = getRelevantDeps({ openspec: { enabled: "auto" } }, tmp);
  assert.ok(deps.includes("openspec"), "auto with openspec/ dir should include openspec");
  cleanup(tmp);
});

test("getRelevantDeps: openspec.enabled=on → includes openspec", () => {
  const deps = getRelevantDeps({ openspec: { enabled: "on" } }, null);
  assert.ok(deps.includes("openspec"));
});

test("getRelevantDeps: openspec.enabled=off → omits openspec", () => {
  const deps = getRelevantDeps({ openspec: { enabled: "off" } }, null);
  assert.ok(!deps.includes("openspec"));
});

test("getRelevantDeps: missing last30days flag → omits last30days", () => {
  const deps = getRelevantDeps({}, null);
  assert.ok(!deps.includes("last30days"));
});

test("getRelevantDeps: last30days.enabled=true → includes last30days", () => {
  const deps = getRelevantDeps({ last30days: { enabled: "true" } }, null);
  assert.ok(deps.includes("last30days"));
});

test("getRelevantDeps: last30days.enabled=false → omits last30days", () => {
  const deps = getRelevantDeps({ last30days: { enabled: "false" } }, null);
  assert.ok(!deps.includes("last30days"));
});

// ==========================================================================
// Prompt routing — promptDeps
// ==========================================================================

// ---------------------------------------------------------------------------
// 4.4 non-TTY without opt-in → all deps skipped
// ---------------------------------------------------------------------------

test("promptDeps: non-TTY without yesDeps → all deps skipped, no prompt called", async () => {
  let promptCalled = false;
  const results = await promptDeps(["openspec", "last30days"], {
    isTTY: false,
    yesDeps: false,
    promptFn: async () => { promptCalled = true; return "y"; },
    runCmd: () => ({ status: 0 }),
  });
  assert.equal(promptCalled, false, "prompt must not be called in non-TTY without opt-in");
  assert.equal(results["openspec"]?.status, "skipped");
  assert.equal(results["last30days"]?.status, "skipped");
});

// ---------------------------------------------------------------------------
// 4.5 auto-accept path: yesDeps in non-TTY → installs without prompt
// ---------------------------------------------------------------------------

test("promptDeps: non-TTY with yesDeps=true → auto-installs without prompting", async () => {
  let promptCalled = false;
  let installCalled = false;
  const results = await promptDeps(["last30days"], {
    isTTY: false,
    yesDeps: true,
    promptFn: async () => { promptCalled = true; return "n"; },
    runCmd: () => { installCalled = true; return { status: 0 }; },
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
  });
  assert.equal(promptCalled, false, "prompt must not be called when yesDeps is set");
  assert.equal(installCalled, true, "install must be called when yesDeps is set");
  assert.equal(results["last30days"]?.status, "installed");
});

// ---------------------------------------------------------------------------
// 4.6 TTY + accept → installs; TTY + decline → declined
// ---------------------------------------------------------------------------

test("promptDeps: TTY + user answers Y → installs dep", async () => {
  let installCalled = false;
  const results = await promptDeps(["last30days"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    runCmd: () => { installCalled = true; return { status: 0 }; },
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
  });
  assert.equal(installCalled, true);
  assert.equal(results["last30days"]?.status, "installed");
});

test("promptDeps: TTY + user answers N → declined, no install", async () => {
  let installCalled = false;
  const results = await promptDeps(["last30days"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "n",
    runCmd: () => { installCalled = true; return { status: 0 }; },
  });
  assert.equal(installCalled, false);
  assert.equal(results["last30days"]?.status, "declined");
});

test("promptDeps: returns empty object when depKeys is empty", async () => {
  const results = await promptDeps([], { isTTY: true });
  assert.deepEqual(results, {});
});

test("promptDeps: dryRun=true → returns empty object without prompting or installing", async () => {
  let promptCalled = false;
  let installCalled = false;
  const results = await promptDeps(["last30days"], {
    dryRun: true,
    isTTY: true,
    promptFn: async () => { promptCalled = true; return "y"; },
    runCmd: () => { installCalled = true; return { status: 0 }; },
  });
  assert.deepEqual(results, {});
  assert.equal(promptCalled, false);
  assert.equal(installCalled, false);
});

// ==========================================================================
// Install/update execution — installDep
// ==========================================================================

// ---------------------------------------------------------------------------
// 5.1 / 5.2 / 5.3 installDep
// ---------------------------------------------------------------------------

test("installDep: successful install returns { status: 'installed' }", async () => {
  const result = await installDep("last30days", "install", () => ({ status: 0 }));
  assert.equal(result.status, "installed");
});

test("installDep: successful update returns { status: 'updated' }", async () => {
  const result = await installDep("openspec", "update", () => ({ status: 0 }));
  assert.equal(result.status, "updated");
});

test("installDep: non-zero exit returns { status: 'failed' } with manualCmd", async () => {
  const result = await installDep("last30days", "install", () => ({ status: 1, stderr: "ENOENT" }));
  assert.equal(result.status, "failed");
  assert.ok(result.error, "error field should be set");
  assert.ok(result.manualCmd, "manualCmd should be set for failed dep");
});

test("installDep: thrown error returns { status: 'failed' } without propagating", async () => {
  const result = await installDep("openspec", "install", () => { throw new Error("exec failed"); });
  assert.equal(result.status, "failed");
  assert.ok(result.error.includes("exec failed"));
});

// ==========================================================================
// Status reporting — printDepSummary
// ==========================================================================

// ---------------------------------------------------------------------------
// 6.1 / 6.2 / 6.4 printDepSummary output
// ---------------------------------------------------------------------------

test("printDepSummary: renders installed/updated/already-current/declined lines", () => {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({
      "test-manual-dep": { status: "installed" },
      openspec: { status: "already current", version: "1.4.1" },
      last30days: { status: "declined" },
      "some-other-dep": { status: "updated" },
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const out = lines.join("\n");
  assert.ok(out.includes("installed"), "should mention installed");
  assert.ok(out.includes("updated"), "should mention updated");
  assert.ok(out.includes("already current"), "should mention already current");
  assert.ok(out.includes("1.4.1"), "should include version for already-current");
  assert.ok(out.includes("declined"), "should mention declined");
});

test("printDepSummary: skipped deps include re-run hint", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({ openspec: { status: "skipped" } });
  } finally {
    console.log = origLog;
  }
  const out = lines.join("\n");
  assert.ok(out.includes("--yes-deps"), "skipped hint must mention --yes-deps");
  assert.ok(out.includes("PIPELINE_INSTALL_DEPS=1"), "skipped hint must mention env var");
});

test("printDepSummary: failed dep includes manual install command", () => {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({
      openspec: {
        status: "failed",
        error: "exec failed",
        manualCmd: DEPS.openspec.manualInstall,
      },
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const out = lines.join("\n");
  assert.ok(out.includes("failed"), "should mention failed");
  assert.ok(out.includes(DEPS.openspec.manualInstall), "should include manual install command");
});

test("printDepSummary: no re-run hint when nothing is skipped", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({ openspec: { status: "installed" } });
  } finally {
    console.log = origLog;
  }
  const out = lines.join("\n");
  assert.ok(!out.includes("--yes-deps"), "no hint when nothing is skipped");
});

test("printDepSummary: no output when results is empty", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({});
  } finally {
    console.log = origLog;
  }
  assert.equal(lines.length, 0);
});

// ==========================================================================
// Failure isolation
// ==========================================================================

test("promptDeps: failed dep does not abort subsequent deps", async () => {
  const installOrder = [];
  const results = await promptDeps(["last30days", "openspec"], {
    isTTY: false,
    yesDeps: true,
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
    runCmd: (cmd) => {
      installOrder.push(cmd);
      // last30days installs via npx, openspec via npm — fail only the first.
      if (cmd === "npx") return { status: 1, stderr: "error" };
      return { status: 0 };
    },
  });
  assert.equal(results["last30days"]?.status, "failed", "first dep failed");
  assert.equal(results["openspec"]?.status, "installed", "second dep still installed");
  assert.equal(installOrder.length, 2, "both install commands were attempted");
});

// ==========================================================================
// Integration scenarios (8.1 – 8.3)
// ==========================================================================

test("integration 8.1: fresh install — TTY accept installs every offered dep", async () => {
  const installOrder = [];
  const results = await promptDeps(["openspec", "last30days"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
    runCmd: (cmd, args) => { installOrder.push(`${cmd} ${args.join(" ")}`); return { status: 0 }; },
  });
  assert.equal(results["openspec"]?.status, "installed");
  assert.equal(results["last30days"]?.status, "installed");
  assert.equal(installOrder.length, 2, "both deps have automated installs");
});

test("integration 8.2: non-interactive mode — all deps skipped, hint present", async () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    const results = await promptDeps(["openspec", "last30days"], {
      isTTY: false,
      yesDeps: false,
    });
    printDepSummary(results);
    const out = lines.join("\n");
    assert.equal(results["openspec"]?.status, "skipped");
    assert.equal(results["last30days"]?.status, "skipped");
    assert.ok(out.includes("--yes-deps"), "hint must be present");
    assert.ok(out.includes("PIPELINE_INSTALL_DEPS=1"), "env var hint must be present");
  } finally {
    console.log = origLog;
  }
});

test("integration 8.3: --yes-deps in non-TTY — installable deps auto-installed, manual-only shows instructions without prompting", async () => {
  let promptCalled = false;
  const results = await promptDeps(["openspec", "test-manual-dep"], {
    isTTY: false,
    yesDeps: true,
    promptFn: async () => { promptCalled = true; return "n"; },
    runCmd: () => ({ status: 0 }),
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
  });
  assert.equal(promptCalled, false);
  assert.equal(results["openspec"]?.status, "installed");
  // test-manual-dep is manual-only — yesDeps shows instructions, does not call installCmd
  assert.equal(results["test-manual-dep"]?.status, "manual-only");
});

// ==========================================================================
// Manual-only dep handling (installCmd: null) — exercised via test-manual-dep
// ==========================================================================

test("promptDeps: manual-only — TTY accept → status manual-only, no installCmd called", async () => {
  let installCalled = false;
  const results = await promptDeps(["test-manual-dep"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    runCmd: () => { installCalled = true; return { status: 0 }; },
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
  });
  assert.equal(installCalled, false, "no shell command should be run for manual-only dep");
  assert.equal(results["test-manual-dep"]?.status, "manual-only");
  assert.ok(results["test-manual-dep"]?.manualCmd, "manualCmd should be set");
});

test("promptDeps: manual-only — TTY decline → status declined, no installCmd called", async () => {
  let installCalled = false;
  const results = await promptDeps(["test-manual-dep"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "n",
    runCmd: () => { installCalled = true; return { status: 0 }; },
    detectFn: () => ({ present: false, version: null }),
    fetchLatestFn: () => null,
  });
  assert.equal(installCalled, false);
  assert.equal(results["test-manual-dep"]?.status, "declined");
});

test("promptDeps: manual-only — already present → status already current", async () => {
  const results = await promptDeps(["test-manual-dep"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    detectFn: () => ({ present: true, version: "1.2.0" }),
    fetchLatestFn: () => null,
  });
  assert.equal(results["test-manual-dep"]?.status, "already current");
  assert.equal(results["test-manual-dep"]?.version, "1.2.0");
});

test("printDepSummary: manual-only status renders install instructions", () => {
  const lines = [];
  const origLog = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    printDepSummary({
      "test-manual-dep": {
        status: "manual-only",
        manualCmd: DEPS["test-manual-dep"].manualInstall,
      },
    });
  } finally {
    console.log = origLog;
  }
  const out = lines.join("\n");
  assert.ok(out.includes("install manually"), "should mention manual install");
  assert.ok(out.includes(DEPS["test-manual-dep"].manualInstall), "should include the manualInstall command");
});

// ==========================================================================
// Regression: last30days detection covers Codex and env-override (Finding 2)
// ==========================================================================

test("last30daysPresent: returns non-null when skill exists under Codex (CODEX_HOME)", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, "skills", "last30days"), { recursive: true });
  process.env.CODEX_HOME = tmp;
  // Ensure CLAUDE_CONFIG_DIR points somewhere without the skill
  const claudeTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  try {
    const result = last30daysPresent();
    assert.notEqual(result, null, "skill under CODEX_HOME should be detected");
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
    cleanup(claudeTmp);
  }
});

test("last30daysPresent: returns version from plugin.json under Codex skill dir", () => {
  const tmp = makeTmp();
  const pluginDir = join(tmp, "skills", "last30days", ".claude-plugin");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ version: "4.0.0" }));
  process.env.CODEX_HOME = tmp;
  const claudeTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  try {
    const result = last30daysPresent();
    assert.equal(result, "4.0.0");
  } finally {
    delete process.env.CODEX_HOME;
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
    cleanup(claudeTmp);
  }
});

// ==========================================================================
// Regression: manual-only version comparison for present installs
// ==========================================================================

test("promptDeps: manual-only present + stale version → manual-update-needed", async () => {
  const results = await promptDeps(["test-manual-dep"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    detectFn: () => ({ present: true, version: "1.0.0" }),
    fetchLatestFn: () => "2.0.0",
  });
  assert.equal(results["test-manual-dep"]?.status, "manual-update-needed");
  assert.equal(results["test-manual-dep"]?.version, "1.0.0");
  assert.equal(results["test-manual-dep"]?.latest, "2.0.0");
  assert.ok(results["test-manual-dep"]?.manualCmd, "should carry manualCmd for update instructions");
});

test("promptDeps: manual-only present + current version → already current", async () => {
  const results = await promptDeps(["test-manual-dep"], {
    isTTY: true,
    yesDeps: false,
    promptFn: async () => "y",
    detectFn: () => ({ present: true, version: "2.0.0" }),
    fetchLatestFn: () => "2.0.0",
  });
  assert.equal(results["test-manual-dep"]?.status, "already current");
});

test("printDepSummary: manual-update-needed renders version diff and manual cmd", () => {
  const lines = [];
  const warns = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    printDepSummary({
      "test-manual-dep": {
        status: "manual-update-needed",
        version: "1.0.0",
        latest: "2.0.0",
        manualCmd: DEPS["test-manual-dep"].manualInstall,
      },
    });
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  const out = [...lines, ...warns].join("\n");
  assert.ok(out.includes("1.0.0"), "should show installed version");
  assert.ok(out.includes("2.0.0"), "should show latest version");
  assert.ok(out.includes(DEPS["test-manual-dep"].manualInstall), "should include manual update command");
});

// ==========================================================================
// Regression: findGitRoot resolves to repo root from subdirectory
// ==========================================================================

test("findGitRoot: returns startDir when not in a git repo", () => {
  const tmp = makeTmp();
  try {
    const result = findGitRoot(tmp);
    assert.equal(result, tmp, "non-git dir should be returned as-is");
  } finally {
    cleanup(tmp);
  }
});

test("findGitRoot: resolves to root from a nested subdir", () => {
  const tmp = makeTmp();
  spawnSync("git", ["init"], { cwd: tmp, stdio: "pipe" });
  const subdir = join(tmp, "nested", "subdir");
  mkdirSync(subdir, { recursive: true });
  try {
    const root = findGitRoot(subdir);
    assert.equal(root, realpathSync(tmp), "should resolve to git root from nested subdir");
  } finally {
    cleanup(tmp);
  }
});

test("getRelevantDeps: reads openspec from git root, not invocation subdir", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, ".github"), { recursive: true });
  writeFileSync(join(tmp, ".github", "pipeline.yml"), "openspec:\n  enabled: auto\n");
  mkdirSync(join(tmp, "openspec"), { recursive: true });
  const subdir = join(tmp, "nested");
  mkdirSync(subdir);
  try {
    // With git root as repoPath: openspec/ is found → openspec included.
    const depsFromRoot = getRelevantDeps(readPipelineConfig(tmp), tmp);
    assert.ok(depsFromRoot.includes("openspec"), "openspec detected when repoPath is git root");
    // Without git root fix (using subdir as repoPath): openspec/ not found → omitted.
    const depsFromSubdir = getRelevantDeps(readPipelineConfig(subdir), subdir);
    assert.ok(!depsFromSubdir.includes("openspec"), "openspec omitted when repoPath is a subdir (demonstrates the bug)");
  } finally {
    cleanup(tmp);
  }
});

test("last30daysPresent: LAST30DAYS_SKILL_DIR env override takes precedence", () => {
  const tmp = makeTmp();
  mkdirSync(join(tmp, "skills", "last30days"), { recursive: true });
  const skillOverride = makeTmp();
  mkdirSync(join(skillOverride, ".claude-plugin"), { recursive: true });
  writeFileSync(join(skillOverride, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "9.9.9" }));
  process.env.LAST30DAYS_SKILL_DIR = skillOverride;
  process.env.CLAUDE_CONFIG_DIR = tmp; // this one also has the skill
  try {
    const result = last30daysPresent();
    assert.equal(result, "9.9.9", "LAST30DAYS_SKILL_DIR override must take precedence");
  } finally {
    delete process.env.LAST30DAYS_SKILL_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(tmp);
    cleanup(skillOverride);
  }
});

test("last30daysPresent: returns null when skill missing from all locations", () => {
  const claudeTmp = makeTmp();
  const codexTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  process.env.CODEX_HOME = codexTmp;
  try {
    const result = last30daysPresent();
    assert.equal(result, null);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    cleanup(claudeTmp);
    cleanup(codexTmp);
  }
});

// ---------------------------------------------------------------------------
// checkLoopCoherence (#451) — the installer's loop:contract-coherence gate.
// Uses the real filesystem under CLAUDE_CONFIG_DIR/CODEX_HOME overrides (the
// same seam as the last30daysPresent tests above) rather than a fake, since
// checkLoopCoherence itself takes no injectable deps — it calls the same
// shared check function doctor and pipeline:loop use. Returns { ok, message? }
// instead of calling process.exit, so the incompatible-pairing path is
// testable here.
// ---------------------------------------------------------------------------

function writeGoalLoopSkill(root, { version = "0.2.0", contractSchema = "goal-loop/contract@2", ledgerSchema = "goal-loop/ledger@2" } = {}) {
  const dir = join(root, "skills", "goal-loop");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".goal-loop-manifest.json"), JSON.stringify({ package: "goal-loop", version }));
  writeFileSync(
    join(dir, "state.py"),
    `CONTRACT_SCHEMA = "${contractSchema}"\nLEDGER_SCHEMA = "${ledgerSchema}"\n`,
  );
}

test("checkLoopCoherence: goal-loop absent → ok:true (optional, not blocking)", async () => {
  const claudeTmp = makeTmp();
  const codexTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  process.env.CODEX_HOME = codexTmp;
  try {
    const result = await checkLoopCoherence();
    assert.equal(result.ok, true);
    // Must not claim loop is unavailable without external goal-loop (#627)
    assert.equal(result.message, undefined);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    cleanup(claudeTmp);
    cleanup(codexTmp);
  }
});

test("checkLoopCoherence: supported goal-loop install → ok:true", async () => {
  const claudeTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  writeGoalLoopSkill(claudeTmp);
  try {
    const result = await checkLoopCoherence();
    assert.equal(result.ok, true);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(claudeTmp);
  }
});

test("checkLoopCoherence: unsupported contract schema → ok:false naming both sides", async () => {
  const claudeTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  writeGoalLoopSkill(claudeTmp, { contractSchema: "goal-loop/contract@1" });
  try {
    const result = await checkLoopCoherence();
    assert.equal(result.ok, false);
    assert.match(result.message, /goal-loop\/contract@1/);
    assert.match(result.message, /goal-loop\/contract@2/);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(claudeTmp);
  }
});

// ---------------------------------------------------------------------------
// Live-run deferral (#450) — findLiveRunLocks / formatLiveRunMessage (pure)
// and the wired installer guard (subprocess, real CLAUDE_CONFIG_DIR + TMPDIR).
// ---------------------------------------------------------------------------

test("parseArgs: --force sets force:true, otherwise false", () => {
  assert.equal(parseArgs(["node", "install.mjs", "update", "--force"]).force, true);
  assert.equal(parseArgs(["node", "install.mjs", "update"]).force, false);
});

test("parseArgs: validates the internal launcher reservation PID", () => {
  assert.equal(
    parseArgs(["node", "install.mjs", "update", "--internal-starting-lock-pid", "12345"])
      .internalStartingLockPid,
    12345,
  );
  assert.throws(
    () => parseArgs(["node", "install.mjs", "update", "--internal-starting-lock-pid", "12x"]),
    /positive integer PID/,
  );
  assert.throws(
    () => parseArgs(["node", "install.mjs", "update", "--internal-starting-lock-pid"]),
    /positive integer PID/,
  );
});

test("findLiveRunLocks: reports a lock whose PID is live (fakes only, no real I/O)", () => {
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "12345",
    isPidLive: (pid) => pid === 12345,
  });
  assert.deepEqual(live, [{ path: "/tmp/pipeline-lyric-utils-420.lock", pid: 12345 }]);
});

test("findLiveRunLocks: a stale (dead) PID does not block", () => {
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "99999",
    isPidLive: () => false,
    removeLock: () => {},
  });
  assert.deepEqual(live, []);
});

test("findLiveRunLocks: unparseable lock contents are treated as stale, not live", () => {
  let liveCalled = false;
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "not-a-pid",
    isPidLive: () => { liveCalled = true; return true; },
    removeLock: () => {},
  });
  assert.deepEqual(live, []);
  assert.equal(liveCalled, false, "isPidLive must not be consulted for unparseable contents");
});

// ---------------------------------------------------------------------------
// Stale-lock sweep (#567) — findLiveRunLocks unlinks a provably-dead
// (ESRCH) or unparseable lock as a side effect of the scan; a live lock and
// an EPERM (unsignalable, conservatively-live) lock are never swept.
// ---------------------------------------------------------------------------

test("findLiveRunLocks: sweeps a dead-PID lock (fakes only, no real I/O)", () => {
  const removed = [];
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "99999",
    isPidLive: () => false,
    removeLock: (p) => removed.push(p),
  });
  assert.deepEqual(live, []);
  assert.deepEqual(removed, ["/tmp/pipeline-lyric-utils-420.lock"], "a dead-PID lock must be swept");
});

test("findLiveRunLocks: sweeps a lock with unparseable contents", () => {
  const removed = [];
  findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "not-a-pid",
    isPidLive: () => true,
    removeLock: (p) => removed.push(p),
  });
  assert.deepEqual(removed, ["/tmp/pipeline-lyric-utils-420.lock"], "an unparseable lock must be swept as stale");
});

test("findLiveRunLocks: never sweeps a live lock", () => {
  const removed = [];
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "12345",
    isPidLive: () => true,
    removeLock: (p) => removed.push(p),
  });
  assert.deepEqual(live, [{ path: "/tmp/pipeline-lyric-utils-420.lock", pid: 12345 }]);
  assert.deepEqual(removed, [], "a live lock must never be swept");
});

test("findLiveRunLocks: never sweeps an EPERM (conservatively-live) lock", () => {
  const removed = [];
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => "12345",
    isPidLive: () => true, // isPidLiveDefault reports EPERM as live
    removeLock: (p) => removed.push(p),
  });
  assert.equal(live.length, 1, "an EPERM lock is treated as live and still blocks");
  assert.deepEqual(removed, [], "an EPERM lock must never be swept");
});

test("findLiveRunLocks: an unreadable lock file is left in place, not swept", () => {
  const removed = [];
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => null,
    isPidLive: () => true,
    removeLock: (p) => removed.push(p),
  });
  assert.deepEqual(live, []);
  assert.deepEqual(removed, [], "an unreadable lock is left alone, not swept — its cause is unknown");
});

test("findLiveRunLocks: an unreadable lock file is treated as stale", () => {
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-lyric-utils-420.lock"],
    readLock: () => null,
    isPidLive: () => true,
  });
  assert.deepEqual(live, []);
});

test("findLiveRunLocks: no locks present → []", () => {
  assert.deepEqual(findLiveRunLocks({ listLocks: () => [], readLock: () => null, isPidLive: () => true }), []);
});

test("findLiveRunLocks: multiple live locks are all reported", () => {
  const live = findLiveRunLocks({
    listLocks: () => ["/tmp/pipeline-a-1.lock", "/tmp/pipeline-b-2.lock"],
    readLock: (p) => (p.includes("a-1") ? "111" : "222"),
    isPidLive: () => true,
  });
  assert.deepEqual(live, [
    { path: "/tmp/pipeline-a-1.lock", pid: 111 },
    { path: "/tmp/pipeline-b-2.lock", pid: 222 },
  ]);
});

test("findLiveRunLocks: exempts only the exact live launcher reservation with matching PID contents", () => {
  const ownPid = 12345;
  const ownPath = join(tmpdir(), `pipeline-starting-${ownPid}.lock`);
  const unrelatedPath = join(tmpdir(), "pipeline-agent-pipeline-945.lock");
  const live = findLiveRunLocks({
    listLocks: () => [ownPath, unrelatedPath],
    readLock: () => String(ownPid),
    isPidLive: () => true,
    internalStartingLockPid: ownPid,
  });
  assert.deepEqual(
    live,
    [{ path: unrelatedPath, pid: ownPid }],
    "a different live lock must still block even when it contains the same PID",
  );
});

test("findLiveRunLocks: a launcher-shaped path with mismatched contents is not exempt", () => {
  const claimedPid = 12345;
  const actualPid = 54321;
  const lockPath = join(tmpdir(), `pipeline-starting-${claimedPid}.lock`);
  const live = findLiveRunLocks({
    listLocks: () => [lockPath],
    readLock: () => String(actualPid),
    isPidLive: () => true,
    internalStartingLockPid: claimedPid,
  });
  assert.deepEqual(live, [{ path: lockPath, pid: actualPid }]);
});

test("formatLiveRunMessage: refusal names every blocking lock path and PID, and mentions --force", () => {
  const msg = formatLiveRunMessage(
    [{ path: "/tmp/pipeline-a-1.lock", pid: 111 }, { path: "/tmp/pipeline-b-2.lock", pid: 222 }],
    { asWarning: false },
  );
  assert.match(msg, /\/tmp\/pipeline-a-1\.lock/);
  assert.match(msg, /111/);
  assert.match(msg, /\/tmp\/pipeline-b-2\.lock/);
  assert.match(msg, /222/);
  assert.match(msg, /--force/);
});

test("formatLiveRunMessage: warning form names the overridden locks", () => {
  const msg = formatLiveRunMessage([{ path: "/tmp/pipeline-a-1.lock", pid: 111 }], { asWarning: true });
  assert.match(msg, /\/tmp\/pipeline-a-1\.lock/);
  assert.match(msg, /111/);
});

// ---------------------------------------------------------------------------
// Wired guard — real CLI subprocess, fabricated "existing install" (no real
// npm ci / core copy needed to exercise the pre-copy refusal path) and an
// isolated TMPDIR so the scan never touches the real /tmp.
// ---------------------------------------------------------------------------

const INSTALL_SCRIPT = fileURLToPath(new URL("./install.mjs", import.meta.url));

function stubExistingCoreInstall(claudeConfigDir) {
  const dest = join(claudeConfigDir, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MANAGED_MARKER), "");
  writeFileSync(join(dest, "sentinel.txt"), "before-update");
  return dest;
}

function runInstaller(args, env) {
  return spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("install update: refuses and copies nothing when a lock is held by a live PID", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const dest = stubExistingCoreInstall(claudeTmp);
    const lockPath = join(lockTmp, "pipeline-lyric-utils-420.lock");
    // This test process's own PID is guaranteed live for the duration of the test.
    writeFileSync(lockPath, String(process.pid));

    const result = runInstaller(["update", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.notEqual(result.status, 0, "installer must exit non-zero when a live lock blocks the update");
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /pipeline-lyric-utils-420\.lock/);
    assert.match(output, new RegExp(String(process.pid)));
    assert.equal(
      readFileSync(join(dest, "sentinel.txt"), "utf8"),
      "before-update",
      "refusal must leave the previously installed core byte-identical — no file copied",
    );
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update --force: proceeds despite a live lock and warns about it", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    stubExistingCoreInstall(claudeTmp);
    const lockPath = join(lockTmp, "pipeline-lyric-utils-420.lock");
    writeFileSync(lockPath, String(process.pid));

    const result = runInstaller(["update", "--host", "claude", "--force"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, `--force must still complete the update: ${result.stderr}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /pipeline-lyric-utils-420\.lock/);
    assert.match(output, new RegExp(String(process.pid)));
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: a stale lock (dead PID) does not block the update, and is swept off disk", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    stubExistingCoreInstall(claudeTmp);
    // Spawn and immediately reap a short-lived child so its PID is guaranteed dead.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    const lockPath = join(lockTmp, "pipeline-lyric-utils-420.lock");
    writeFileSync(lockPath, String(deadPid));

    const result = runInstaller(["update", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, `a stale lock must not block the update: ${result.stderr}`);
    assert.equal(existsSync(lockPath), false, "the installer's scan must sweep the dead-PID lock (#567)");
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: a first install onto a host with no existing core is not guarded", () => {
  const claudeTmp = makeTmp(); // no ~/.claude/skills/pipeline present at all
  const lockTmp = makeTmp();
  try {
    writeFileSync(join(lockTmp, "pipeline-lyric-utils-420.lock"), String(process.pid));

    const result = runInstaller(["install", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, `first install must not be guarded by an unrelated live lock: ${result.stderr}`);
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

// ---------------------------------------------------------------------------
// Update lock (#450 round 2) — closes the TOCTOU between the scan above and
// the copy. Covers: (a) a shim-shaped reservation lock is caught by the same
// scan a real run's lock would be, (b) two installer instances can't proceed
// concurrently, (c) a stale update lock (dead PID) never blocks, (d) the lock
// is always cleaned up afterward.
// ---------------------------------------------------------------------------

test("install update: a shim-style pipeline-starting-<pid>.lock blocks the update like any other live lock", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const dest = stubExistingCoreInstall(claudeTmp);
    // Same filename shape the launcher shim reserves before loading the engine.
    writeFileSync(join(lockTmp, `pipeline-starting-${process.pid}.lock`), String(process.pid));

    const result = runInstaller(["update", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.notEqual(result.status, 0, "a live shim reservation must block the update");
    assert.equal(
      readFileSync(join(dest, "sentinel.txt"), "utf8"),
      "before-update",
      "a blocked update must copy no file",
    );
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: internal launcher PID exempts only its matching reservation", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    stubExistingCoreInstall(claudeTmp);
    writeFileSync(join(lockTmp, `pipeline-starting-${process.pid}.lock`), String(process.pid));

    const result = runInstaller(
      ["update", "--host", "claude", "--internal-starting-lock-pid", String(process.pid)],
      {
        CLAUDE_CONFIG_DIR: claudeTmp,
        TMPDIR: lockTmp,
        TMP: lockTmp,
        TEMP: lockTmp,
      },
    );

    assert.equal(result.status, 0, `the invoking launcher's reservation must be exempt: ${result.stderr}`);
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: internal launcher PID does not exempt an unrelated live run", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const dest = stubExistingCoreInstall(claudeTmp);
    writeFileSync(join(lockTmp, `pipeline-starting-${process.pid}.lock`), String(process.pid));
    const unrelatedPath = join(lockTmp, "pipeline-agent-pipeline-945.lock");
    writeFileSync(unrelatedPath, String(process.pid));

    const result = runInstaller(
      ["update", "--host", "claude", "--internal-starting-lock-pid", String(process.pid)],
      {
        CLAUDE_CONFIG_DIR: claudeTmp,
        TMPDIR: lockTmp,
        TMP: lockTmp,
        TEMP: lockTmp,
      },
    );

    assert.notEqual(result.status, 0, "an unrelated live run must still block the update");
    assert.match(`${result.stdout}${result.stderr}`, /pipeline-agent-pipeline-945\.lock/);
    assert.equal(readFileSync(join(dest, "sentinel.txt"), "utf8"), "before-update");
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: refuses when another installer instance already holds the update lock", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const dest = stubExistingCoreInstall(claudeTmp);
    writeFileSync(join(lockTmp, ".pipeline-installer-update.lock"), String(process.pid));

    const result = runInstaller(["update", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.notEqual(result.status, 0, "a live update lock held by another installer must block this one");
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /already in progress/i);
    assert.equal(
      readFileSync(join(dest, "sentinel.txt"), "utf8"),
      "before-update",
      "a blocked update must copy no file",
    );
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install update: a stale update lock (dead PID) does not block, and the lock is cleaned up after", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    stubExistingCoreInstall(claudeTmp);
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeFileSync(join(lockTmp, ".pipeline-installer-update.lock"), String(dead.pid));

    const result = runInstaller(["update", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, `a stale update lock must not block the update: ${result.stderr}`);
    assert.equal(
      existsSync(join(lockTmp, ".pipeline-installer-update.lock")),
      false,
      "the update lock must not be left behind after a completed update",
    );
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("acquireUpdateLock: stale (dead-pid) lock is reclaimed ownership-safely and re-acquired (#450 delta 99d25184)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-update-lock-test-"));
  const lockPath = join(dir, "update.lock");
  try {
    writeFileSync(lockPath, "999999");
    const acquired = acquireUpdateLock(lockPath, () => false); // holder is dead
    assert.equal(acquired, true, "a dead holder's lock must be reclaimed");
    assert.equal(readFileSync(lockPath, "utf8"), String(process.pid), "the fresh lock must carry our pid");
    assert.equal(existsSync(lockPath + ".reclaim-" + process.pid), false, "no reclaim residue may remain");
  } finally {
    releaseUpdateLock(lockPath);
    cleanup(dir);
  }
});

test("acquireUpdateLock: a live fresh lock captured mid-reclaim is restored, not deleted (#450 delta 99d25184)", () => {
  // Simulates the race the delta review named: the stale holder we observed is
  // replaced by ANOTHER installer's fresh live lock between our liveness read
  // and our claim. The claimed content re-verification must hand the lock
  // back and report it as held — never discard it.
  const dir = mkdtempSync(join(tmpdir(), "pipeline-update-lock-test-"));
  const lockPath = join(dir, "update.lock");
  try {
    writeFileSync(lockPath, "424242"); // the fresh racer's lock, live
    let calls = 0;
    const isPidLive = () => {
      calls++;
      // First liveness read simulates the STALE observation window; every
      // later read tells the truth: the current holder is live.
      return calls > 1;
    };
    const acquired = acquireUpdateLock(lockPath, isPidLive);
    assert.equal(acquired, false, "a live holder's lock must be reported as held");
    assert.equal(readFileSync(lockPath, "utf8"), "424242", "the live holder's lock must be restored intact");
    assert.equal(existsSync(lockPath + ".reclaim-" + process.pid), false, "no reclaim residue may remain");
  } finally {
    cleanup(dir);
  }
});

test("acquireUpdateLock: restore of a captured live lock never clobbers a third acquirer (#450 delta f8bda4a3)", () => {
  // While the captured live lock sits at the reclaim path, a third installer
  // acquires lockPath. The link-based restore must fail EEXIST and leave the
  // third acquirer's lock intact; the displaced holder is caught by
  // verifyUpdateLockOwnership before it copies anything.
  const dir = mkdtempSync(join(tmpdir(), "pipeline-update-lock-test-"));
  const lockPath = join(dir, "update.lock");
  try {
    writeFileSync(lockPath, "424242"); // the captured "live" racer's lock
    let calls = 0;
    const isPidLive = (pid) => {
      calls++;
      if (calls === 1) return false; // stale observation window
      if (calls === 2) {
        // Claimed-content re-verification: simulate the third installer
        // acquiring lockPath while the captured lock is off-path.
        writeFileSync(lockPath, "777777");
        return true; // captured holder is live -> restore branch
      }
      return true;
    };
    const acquired = acquireUpdateLock(lockPath, isPidLive);
    assert.equal(acquired, false, "the reclaimer must report the lock as held");
    assert.equal(readFileSync(lockPath, "utf8"), "777777", "the third acquirer's lock must never be clobbered");
    assert.equal(existsSync(lockPath + ".reclaim-" + process.pid), false, "no reclaim residue may remain");
  } finally {
    cleanup(dir);
  }
});

test("verifyUpdateLockOwnership: true only when the lock carries this process pid (#450 delta f8bda4a3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-update-lock-test-"));
  const lockPath = join(dir, "update.lock");
  try {
    assert.equal(verifyUpdateLockOwnership(lockPath), false, "missing lock -> not owned");
    writeFileSync(lockPath, "424242");
    assert.equal(verifyUpdateLockOwnership(lockPath), false, "foreign pid -> not owned");
    writeFileSync(lockPath, String(process.pid));
    assert.equal(verifyUpdateLockOwnership(lockPath), true, "own pid -> owned");
  } finally {
    cleanup(dir);
  }
});

test("releaseUpdateLock: refuses to release a lock owned by another process (#450 delta cd279865)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-update-lock-test-"));
  const lockPath = join(dir, "update.lock");
  try {
    writeFileSync(lockPath, "777777"); // a third installer's lock
    releaseUpdateLock(lockPath);
    assert.equal(existsSync(lockPath), true, "a foreign lock must survive cleanup");
    assert.equal(readFileSync(lockPath, "utf8"), "777777", "the foreign lock content must be untouched");
    writeFileSync(lockPath, String(process.pid));
    releaseUpdateLock(lockPath);
    assert.equal(existsSync(lockPath), false, "an owned lock must be released");
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Grok skill path (#731) — --host grok symlink materialization + help text
// ---------------------------------------------------------------------------

test("VALID_HOSTS and HOSTS include grok and opencode alongside claude and codex (#731/#861)", () => {
  // installOrder: claude(10), codex(20), opencode(30), grok(40) then pseudo-host all (#784).
  assert.deepEqual(VALID_HOSTS, ["claude", "codex", "opencode", "grok", "all"]);
  assert.ok(HOSTS.grok, "HOSTS.grok must exist");
  assert.ok(HOSTS.opencode, "HOSTS.opencode must exist");
  assert.equal(HOSTS.grok.installMode, "symlink-claude");
  assert.equal(HOSTS.claude.installMode, "tree");
  assert.equal(HOSTS.codex.installMode, "tree");
  assert.equal(HOSTS.opencode.installMode, "tree");
  assert.equal(HOSTS.opencode.profile, "opencode");
  // No hosts/grok overlay is required for this path target.
  assert.equal(HOSTS.grok.overlayFiles.length, 0);
  assert.ok(HOSTS.opencode.overlayFiles.includes("SKILL.md"));
});

test("usage header documents --host grok and opencode among implemented hosts (#731/#861)", () => {
  const src = readFileSync(fileURLToPath(new URL("./install.mjs", import.meta.url)), "utf8");
  assert.match(src, /--host claude\|codex\|grok\|opencode\|all/);
  assert.match(src, /Grok Build/);
  assert.match(src, /~\/\.grok\/skills\/pipeline/);
  assert.match(src, /OPENCODE_CONFIG_DIR|~\/\.config\/opencode/);
  // Header must not claim a hosts/grok SKILL.md fork.
  assert.match(src, /no separate hosts\/grok SKILL\.md overlay/i);
});

test("unknown --host error lists grok/opencode and points at Grok skill path (#731/#861)", () => {
  const home = makeTmp();
  // error message now lists registered hosts from manifests (#784); order is installOrder.
  try {
    const result = runInstaller(["install", "--host", "not-a-host"], {
      // Isolate from the real home so we do not touch user installs if parse somehow proceeds.
      HOME: home,
    });
    assert.notEqual(result.status, 0);
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /Unknown --host 'not-a-host'/);
    // Registry-driven list (#784): includes all registered hosts + all.
    assert.match(out, /claude/);
    assert.match(out, /codex/);
    assert.match(out, /grok/);
    assert.match(out, /opencode/);
    assert.match(out, /\ball\b/);
    assert.match(out, /~\/\.grok\/skills\/pipeline|Grok Build skill path/);
    assert.match(out, /opencode/i);
  } finally {
    cleanup(home);
  }
});

test("install --host grok: creates symlink to Claude skill when Claude is present (#731)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const claudeSkill = stubExistingCoreInstall(claudeTmp);
    const result = runInstaller(["install", "--host", "grok"], {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      // Isolate live-run lock scan from the host /tmp (other pipeline runs).
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
    const dest = join(home, ".grok", "skills", "pipeline");
    assert.ok(existsSync(dest), "Grok skill path must exist");
    const st = lstatSync(dest);
    assert.ok(st.isSymbolicLink(), "Grok path must be a symlink");
    const target = resolve(join(dest, ".."), readlinkSync(dest));
    // Prefer comparing realpaths so CLAUDE_CONFIG_DIR absolute form matches.
    assert.equal(realpathSync(dest), realpathSync(claudeSkill));
    assert.equal(realpathSync(target), realpathSync(claudeSkill));
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install --host grok: fails with remediation when Claude skill is missing (#731)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    // Claude config dir exists but no skills/pipeline managed install.
    mkdirSync(claudeTmp, { recursive: true });
    const result = runInstaller(["install", "--host", "grok"], {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.notEqual(result.status, 0);
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /requires a Claude-managed skill install/i);
    assert.match(out, /--host claude/);
    assert.equal(existsSync(join(home, ".grok", "skills", "pipeline")), false);
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install --host grok: idempotent re-run refreshes symlink (#731)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const claudeSkill = stubExistingCoreInstall(claudeTmp);
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    };
    const first = runInstaller(["install", "--host", "grok"], env);
    assert.equal(first.status, 0, first.stderr);
    const dest = join(home, ".grok", "skills", "pipeline");
    // Stale wrong target → re-run must refresh (unlink link only).
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(join(home, "wrong-target"), dest);
    const second = runInstaller(["install", "--host", "grok"], env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(realpathSync(dest), realpathSync(claudeSkill));
    // Same-target re-run is a net no-op success.
    const third = runInstaller(["install", "--host", "grok"], env);
    assert.equal(third.status, 0, third.stderr);
    assert.match(`${third.stdout}${third.stderr}`, /already linked|linked →/);
    assert.equal(realpathSync(dest), realpathSync(claudeSkill));
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install --host grok: refuses to delete documented copy layout directory (#731 fdfca57c)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    stubExistingCoreInstall(claudeTmp);
    const dest = join(home, ".grok", "skills", "pipeline");
    mkdirSync(dest, { recursive: true });
    // Simulate the documented copy-based layout with operator-owned content.
    writeFileSync(join(dest, "SKILL.md"), "operator copy layout content");
    writeFileSync(join(dest, "personal-notes.txt"), "do not delete me");

    const result = runInstaller(["install", "--host", "grok"], {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.notEqual(result.status, 0, "must refuse non-symlink Grok path without deleting it");
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /Refusing to replace non-symlink path/i);
    assert.match(out, /mv |relocate/i);
    // Path and content must remain byte-identical — no recursive delete.
    assert.ok(existsSync(dest), "copy layout directory must still exist");
    assert.equal(
      lstatSync(dest).isSymbolicLink(),
      false,
      "must not convert directory to symlink without operator action",
    );
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), "operator copy layout content");
    assert.equal(readFileSync(join(dest, "personal-notes.txt"), "utf8"), "do not delete me");
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("install --host grok: refreshes wrong-target symlink without recursive tree delete (#731)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const claudeSkill = stubExistingCoreInstall(claudeTmp);
    const skillsDir = join(home, ".grok", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // Sibling tree that must survive if a buggy rm -rf ever followed a link path.
    const sibling = join(skillsDir, "unrelated-skill");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keep.txt"), "preserve");
    const dest = join(skillsDir, "pipeline");
    symlinkSync(join(home, "stale-target"), dest);

    const result = runInstaller(["install", "--host", "grok"], {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(dest).isSymbolicLink());
    assert.equal(realpathSync(dest), realpathSync(claudeSkill));
    assert.equal(readFileSync(join(sibling, "keep.txt"), "utf8"), "preserve");
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstall --host grok: unlinks installer symlink only (#731 148c1b7b)", () => {
  const home = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const claudeSkill = stubExistingCoreInstall(claudeTmp);
    // Claude target tree must survive Grok uninstall (unlink only, not follow).
    writeFileSync(join(claudeSkill, "keep-claude.txt"), "claude-owned");
    const dest = join(home, ".grok", "skills", "pipeline");
    mkdirSync(join(home, ".grok", "skills"), { recursive: true });
    symlinkSync(claudeSkill, dest);

    const result = runInstaller(["uninstall", "--host", "grok"], {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
    assert.equal(existsSync(dest), false, "Grok symlink must be removed");
    assert.ok(existsSync(claudeSkill), "Claude target tree must not be deleted");
    assert.equal(readFileSync(join(claudeSkill, "keep-claude.txt"), "utf8"), "claude-owned");
  } finally {
    cleanup(home);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstall --host grok: refuses to delete documented copy layout directory (#731 148c1b7b)", () => {
  const home = makeTmp();
  const lockTmp = makeTmp();
  try {
    const dest = join(home, ".grok", "skills", "pipeline");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "operator copy layout content");
    writeFileSync(join(dest, "personal-notes.txt"), "do not delete me");

    const result = runInstaller(["uninstall", "--host", "grok"], {
      HOME: home,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });

    assert.notEqual(result.status, 0, "must refuse non-symlink Grok path without deleting it");
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /Refusing to delete non-symlink path/i);
    assert.match(out, /mv |backup|copy/i);
    // Path and content must remain byte-identical — no recursive delete.
    assert.ok(existsSync(dest), "copy layout directory must still exist");
    assert.equal(lstatSync(dest).isSymbolicLink(), false);
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf8"), "operator copy layout content");
    assert.equal(readFileSync(join(dest, "personal-notes.txt"), "utf8"), "do not delete me");
  } finally {
    cleanup(home);
    cleanup(lockTmp);
  }
});

// ==========================================================================
// #635 — CLAUDE_CONFIG_DIR command skill paths, uninstall command cleanup,
//        Codex personal-skill shadow detection parity
// ==========================================================================

test("installClaudeCommands: config-dir skill path embedded, not ~/.claude hardcoded (#635)", () => {
  const tmp = makeTmp();
  try {
    installClaudeCommands(tmp, false);
    const commandsDir = join(tmp, "commands");
    assert.ok(existsSync(commandsDir), "commands dir must be created");
    const files = readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"));
    assert.ok(files.length > 0, "at least one pipeline:*.md command file");
    const expectedSkill = join(tmp, "skills", "pipeline");
    for (const f of files) {
      const body = readFileSync(join(commandsDir, f), "utf8");
      assert.ok(
        body.includes(expectedSkill),
        `${f} must embed config-dir skill path ${expectedSkill}`,
      );
      assert.ok(
        !body.includes("~/.claude/skills/pipeline"),
        `${f} must not hardcode ~/.claude/skills/pipeline when config dir is custom`,
      );
    }
  } finally {
    cleanup(tmp);
  }
});

test("installClaudeCommands: dry-run writes nothing under commands/ (#635)", () => {
  const tmp = makeTmp();
  try {
    installClaudeCommands(tmp, true);
    assert.equal(
      existsSync(join(tmp, "commands")),
      false,
      "dry-run must not create commands directory",
    );
  } finally {
    cleanup(tmp);
  }
});

test("install --host claude under CLAUDE_CONFIG_DIR: command Invoke paths use config-dir skill (#635)", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const result = runInstaller(["install", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(result.status, 0, `install failed: ${result.stderr}\n${result.stdout}`);
    const commandsDir = join(claudeTmp, "commands");
    const expectedSkill = join(claudeTmp, "skills", "pipeline");
    assert.ok(existsSync(expectedSkill), "skill tree must be installed");
    const files = readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"));
    assert.ok(files.length > 0, "install must write pipeline:*.md commands");
    for (const f of files) {
      const body = readFileSync(join(commandsDir, f), "utf8");
      assert.ok(body.includes(expectedSkill), `${f} must reference ${expectedSkill}`);
      assert.ok(!body.includes("~/.claude/skills/pipeline"), `${f} must not hardcode default home path`);
    }
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstallClaudeCommands: removes pipeline:*.md only; preserves siblings; dry-run is no-op (#635)", () => {
  const tmp = makeTmp();
  const commandsDir = join(tmp, "commands");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(join(commandsDir, "pipeline:status.md"), "invoke pipeline");
  writeFileSync(join(commandsDir, "pipeline:loop.md"), "invoke loop");
  writeFileSync(join(commandsDir, "other-tool.md"), "unrelated");
  try {
    uninstallClaudeCommands(tmp, true);
    assert.ok(existsSync(join(commandsDir, "pipeline:status.md")), "dry-run keeps pipeline commands");
    assert.ok(existsSync(join(commandsDir, "other-tool.md")));

    uninstallClaudeCommands(tmp, false);
    assert.equal(existsSync(join(commandsDir, "pipeline:status.md")), false);
    assert.equal(existsSync(join(commandsDir, "pipeline:loop.md")), false);
    assert.ok(existsSync(join(commandsDir, "other-tool.md")), "non-pipeline command must remain");
  } finally {
    cleanup(tmp);
  }
});

test("install then uninstall --host claude: skill + pipeline commands gone; sibling command remains (#635)", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const install = runInstaller(["install", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);
    const skillDir = join(claudeTmp, "skills", "pipeline");
    const commandsDir = join(claudeTmp, "commands");
    assert.ok(existsSync(skillDir));
    const pipelineCmdsBefore = readdirSync(commandsDir).filter(
      (f) => f.startsWith("pipeline:") && f.endsWith(".md"),
    );
    assert.ok(pipelineCmdsBefore.length > 0);
    writeFileSync(join(commandsDir, "other-tool.md"), "keep me");

    const uninstall = runInstaller(["uninstall", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}`);
    assert.equal(existsSync(skillDir), false, "skill dir must be removed");
    const remaining = existsSync(commandsDir)
      ? readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"))
      : [];
    assert.deepEqual(remaining, [], "no pipeline:*.md commands may remain");
    assert.ok(existsSync(join(commandsDir, "other-tool.md")), "unrelated command preserved");
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstall --host claude --dry-run: leaves skill and pipeline commands in place (#635)", () => {
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const install = runInstaller(["install", "--host", "claude"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(install.status, 0, install.stderr);
    const skillDir = join(claudeTmp, "skills", "pipeline");
    const commandsDir = join(claudeTmp, "commands");
    const cmds = readdirSync(commandsDir).filter((f) => f.startsWith("pipeline:") && f.endsWith(".md"));

    const dry = runInstaller(["uninstall", "--host", "claude", "--dry-run"], {
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(dry.status, 0, dry.stderr);
    const out = `${dry.stdout}${dry.stderr}`;
    assert.match(out, /dry-run/i);
    assert.ok(existsSync(skillDir), "dry-run must not remove skill");
    for (const f of cmds) {
      assert.ok(existsSync(join(commandsDir, f)), `dry-run must leave ${f}`);
    }
  } finally {
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstallHost claude: orphan command cleanup when skill already gone (#635)", () => {
  const claudeTmp = makeTmp();
  process.env.CLAUDE_CONFIG_DIR = claudeTmp;
  try {
    const commandsDir = join(claudeTmp, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "pipeline:status.md"), "orphan");
    writeFileSync(join(commandsDir, "other-tool.md"), "keep");
    // No skills/pipeline — simulates pre-#635 uninstall that left orphans.
    uninstallHost("claude", false);
    assert.equal(existsSync(join(commandsDir, "pipeline:status.md")), false);
    assert.ok(existsSync(join(commandsDir, "other-tool.md")));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    cleanup(claudeTmp);
  }
});

// --- Codex shadow detection (#635) ---

test("detectPersonalSkill codex: no marker → shadowing true under CODEX_HOME (#635)", () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "personal codex skill");
  process.env.CODEX_HOME = tmp;
  try {
    const result = detectPersonalSkill("codex");
    assert.equal(result.shadowing, true);
    assert.equal(result.dest, dest);
    assert.ok(result.dest.startsWith(tmp), "dest under CODEX_HOME");
  } finally {
    delete process.env.CODEX_HOME;
    cleanup(tmp);
  }
});

test("detectPersonalSkill codex: managed marker → shadowing false (#635)", () => {
  const tmp = makeTmp();
  const dest = join(tmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MANAGED_MARKER), "");
  process.env.CODEX_HOME = tmp;
  try {
    const result = detectPersonalSkill("codex");
    assert.equal(result.shadowing, false);
  } finally {
    delete process.env.CODEX_HOME;
    cleanup(tmp);
  }
});

test("detectPersonalSkill codex: no directory → shadowing false (#635)", () => {
  const tmp = makeTmp();
  process.env.CODEX_HOME = tmp;
  try {
    const result = detectPersonalSkill("codex");
    assert.equal(result.shadowing, false);
  } finally {
    delete process.env.CODEX_HOME;
    cleanup(tmp);
  }
});

test("install --host codex: personal skill non-TTY auto-relocates under CODEX_HOME then installs (#635)", () => {
  const codexTmp = makeTmp();
  const lockTmp = makeTmp();
  const personal = join(codexTmp, "skills", "pipeline");
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, "SKILL.md"), "personal codex content");
  // No managed marker — must not be silently overwritten.
  try {
    const result = runInstaller(["install", "--host", "codex"], {
      CODEX_HOME: codexTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
      // Non-interactive: stdin not a TTY under spawnSync by default.
    });
    assert.equal(result.status, 0, `install failed: ${result.stderr}\n${result.stdout}`);
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /Personal pipeline skill detected|auto-relocat/i);
    // Personal content must land in a backup under codex base, not be lost.
    const backups = readdirSync(codexTmp).filter((e) => e.startsWith("pipeline.") && e.includes(".bak"));
    assert.ok(backups.length > 0, "personal skill must be relocated to a backup under CODEX_HOME");
    assert.ok(
      existsSync(join(codexTmp, backups[0], "SKILL.md")),
      "backup must contain the personal SKILL.md",
    );
    assert.equal(
      readFileSync(join(codexTmp, backups[0], "SKILL.md"), "utf8"),
      "personal codex content",
    );
    // Managed install proceeds into the skills path.
    assert.ok(existsSync(join(personal, MANAGED_MARKER)), "managed install must write marker");
  } finally {
    cleanup(codexTmp);
    cleanup(lockTmp);
  }
});

test("install --host codex: managed marker → normal overwrite, no personal-shadow relocation (#635)", () => {
  const codexTmp = makeTmp();
  const lockTmp = makeTmp();
  const dest = join(codexTmp, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MANAGED_MARKER), "");
  writeFileSync(join(dest, "sentinel.txt"), "old-managed");
  try {
    const result = runInstaller(["install", "--host", "codex"], {
      CODEX_HOME: codexTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(result.status, 0, `install failed: ${result.stderr}\n${result.stdout}`);
    const out = `${result.stdout}${result.stderr}`;
    assert.ok(
      !/Personal pipeline skill detected|auto-relocat|Relocate it/i.test(out),
      "managed install must not emit personal-shadow relocation offer",
    );
    assert.ok(existsSync(join(dest, MANAGED_MARKER)));
    // #762: tag-install receipt for pinned-track provenance
    assert.ok(existsSync(join(dest, INSTALL_RECEIPT)), "managed install must write install receipt");
    const receipt = JSON.parse(readFileSync(join(dest, INSTALL_RECEIPT), "utf8"));
    assert.equal(receipt.schema_version, 1);
    assert.ok(typeof receipt.version === "string" && receipt.version.length > 0);
    assert.ok(typeof receipt.tag === "string" && receipt.tag.startsWith("v"));
    // No pipeline.*.bak under codex base from this path.
    const backups = readdirSync(codexTmp).filter((e) => e.startsWith("pipeline.") && e.includes(".bak"));
    assert.deepEqual(backups, [], "managed overwrite must not relocate");
  } finally {
    cleanup(codexTmp);
    cleanup(lockTmp);
  }
});

test("HOSTS tree-mode: claude, codex, and opencode share installMode tree for shadow gate (#635/#861)", () => {
  assert.equal(HOSTS.claude.installMode, "tree");
  assert.equal(HOSTS.codex.installMode, "tree");
  assert.equal(HOSTS.opencode.installMode, "tree");
  assert.equal(HOSTS.grok.installMode, "symlink-claude");
});

// ---------------------------------------------------------------------------
// OpenCode host (#861) — tree install, native /pipeline command, isolation
// ---------------------------------------------------------------------------

test("installOpenCodeCommands: writes pipeline.md with absolute launcher path (#861)", () => {
  const tmp = makeTmp();
  try {
    installOpenCodeCommands(tmp, false);
    const cmdPath = join(tmp, "commands", "pipeline.md");
    assert.ok(existsSync(cmdPath), "pipeline.md must exist");
    const content = readFileSync(cmdPath, "utf8");
    const skillDir = join(tmp, "skills", "pipeline");
    const launcher = join(skillDir, "scripts", "pipeline.mjs");
    const bridge = join(skillDir, "scripts", "opencode-pipeline-bridge.mjs");
    assert.match(content, new RegExp(launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(content, new RegExp(bridge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(content, /--from-stdin/);
    assert.match(content, /\$ARGUMENTS/);
    assert.match(content, /PIPELINE_OPENCODE_ARGS_EOF/);
    // Must not dump full SKILL.md instructional body into the command template.
    assert.ok(!content.includes("State machine"), "command must not embed full skill instructions");
    assert.ok(!content.includes("## Modes"), "command must not embed full skill instructions");
    assert.match(content, /description: Advance a GitHub issue/);
  } finally {
    cleanup(tmp);
  }
});

test("installOpenCodeCommands: dry-run writes nothing under commands/ (#861)", () => {
  const tmp = makeTmp();
  try {
    installOpenCodeCommands(tmp, true);
    assert.equal(existsSync(join(tmp, "commands")), false);
  } finally {
    cleanup(tmp);
  }
});

test("uninstallOpenCodeCommands: removes pipeline.md only; preserves siblings; dry-run is no-op (#861)", () => {
  const tmp = makeTmp();
  try {
    const commandsDir = join(tmp, "commands");
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, "pipeline.md"), "owned\n");
    writeFileSync(join(commandsDir, "other.md"), "sibling\n");
    uninstallOpenCodeCommands(tmp, true);
    assert.ok(existsSync(join(commandsDir, "pipeline.md")), "dry-run must not delete");
    assert.ok(existsSync(join(commandsDir, "other.md")));
    uninstallOpenCodeCommands(tmp, false);
    assert.equal(existsSync(join(commandsDir, "pipeline.md")), false);
    assert.ok(existsSync(join(commandsDir, "other.md")), "siblings must remain");
  } finally {
    cleanup(tmp);
  }
});

test("renderOpenCodePipelineCommand: config-dir skill path embedded (#861)", () => {
  const skillDir = "/custom/opencode/skills/pipeline";
  const content = renderOpenCodePipelineCommand(skillDir);
  assert.match(content, /\/custom\/opencode\/skills\/pipeline\/scripts\/pipeline\.mjs/);
  assert.match(content, /\/custom\/opencode\/skills\/pipeline\/scripts\/opencode-pipeline-bridge\.mjs/);
  assert.ok(!content.includes("/.config/opencode/skills/pipeline"), "must not hardcode default when path is custom");
  // Explicit LLM-mediated contract (adversarial review #861): shell inject + agent instruction.
  assert.match(content, /LLM-mediated/i);
  assert.match(content, /!`node \/custom\/opencode\/skills\/pipeline\/scripts\/opencode-pipeline-bridge\.mjs/);
  assert.match(content, /report only the injected version string/i);
  assert.ok(!content.includes("## State machine"), "must not embed full skill instructional body");
});

test("install --host opencode: managed skill tree + command; isolation from Claude/Codex (#861)", () => {
  const home = makeTmp();
  const opencodeTmp = makeTmp();
  const claudeTmp = makeTmp();
  const codexTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    // Pre-seed Claude/Codex sentinels so we can prove they are untouched.
    const claudeSkill = join(claudeTmp, "skills", "pipeline");
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, "sentinel-claude.txt"), "keep-me");
    const codexSkill = join(codexTmp, "skills", "pipeline");
    mkdirSync(codexSkill, { recursive: true });
    writeFileSync(join(codexSkill, "sentinel-codex.txt"), "keep-me");

    const result = runInstaller(["install", "--host", "opencode"], {
      HOME: home,
      OPENCODE_CONFIG_DIR: opencodeTmp,
      CLAUDE_CONFIG_DIR: claudeTmp,
      CODEX_HOME: codexTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(result.status, 0, `install failed: ${result.stderr}\n${result.stdout}`);

    const skillDir = join(opencodeTmp, "skills", "pipeline");
    assert.ok(existsSync(join(skillDir, MANAGED_MARKER)), "managed marker required");
    assert.ok(existsSync(join(skillDir, "SKILL.md")), "OpenCode SKILL.md required");
    assert.ok(existsSync(join(skillDir, "scripts", "pipeline.mjs")), "launcher required");
    assert.ok(
      existsSync(join(skillDir, "scripts", "opencode-pipeline-bridge.mjs")),
      "argv bridge required",
    );
    assert.ok(existsSync(join(skillDir, "core", "package.json")), "core required");
    assert.ok(existsSync(join(skillDir, "core", "profiles", "opencode.json")), "opencode profile required");

    const cmdPath = join(opencodeTmp, "commands", "pipeline.md");
    assert.ok(existsSync(cmdPath), "native /pipeline command required");
    const cmd = readFileSync(cmdPath, "utf8");
    assert.ok(cmd.includes(join(skillDir, "scripts", "pipeline.mjs")));
    assert.ok(cmd.includes(join(skillDir, "scripts", "opencode-pipeline-bridge.mjs")));

    // Isolation: Claude/Codex sentinels untouched; no new Claude commands under claudeTmp.
    assert.equal(readFileSync(join(claudeSkill, "sentinel-claude.txt"), "utf8"), "keep-me");
    assert.equal(readFileSync(join(codexSkill, "sentinel-codex.txt"), "utf8"), "keep-me");
    assert.equal(existsSync(join(claudeTmp, "commands")), false);
  } finally {
    cleanup(home);
    cleanup(opencodeTmp);
    cleanup(claudeTmp);
    cleanup(codexTmp);
    cleanup(lockTmp);
  }
});

test("install --host opencode --dry-run: writes nothing (#861)", () => {
  const opencodeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const result = runInstaller(["install", "--host", "opencode", "--dry-run"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(result.status, 0, `dry-run failed: ${result.stderr}\n${result.stdout}`);
    assert.equal(existsSync(join(opencodeTmp, "skills", "pipeline")), false);
    assert.equal(existsSync(join(opencodeTmp, "commands", "pipeline.md")), false);
    const out = `${result.stdout}${result.stderr}`;
    assert.match(out, /dry-run/i);
  } finally {
    cleanup(opencodeTmp);
    cleanup(lockTmp);
  }
});

test("uninstall --host opencode: removes skill + pipeline.md; leaves siblings and Claude (#861)", () => {
  const opencodeTmp = makeTmp();
  const claudeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    // Install OpenCode first.
    const install = runInstaller(["install", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(install.status, 0, `install failed: ${install.stderr}\n${install.stdout}`);

    // Sibling OpenCode command + Claude sentinel.
    writeFileSync(join(opencodeTmp, "commands", "other.md"), "keep-sibling\n");
    const claudeSkill = join(claudeTmp, "skills", "pipeline");
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(join(claudeSkill, "sentinel.txt"), "claude-alive");

    const uninstall = runInstaller(["uninstall", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      CLAUDE_CONFIG_DIR: claudeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(uninstall.status, 0, `uninstall failed: ${uninstall.stderr}\n${uninstall.stdout}`);
    assert.equal(existsSync(join(opencodeTmp, "skills", "pipeline")), false);
    assert.equal(existsSync(join(opencodeTmp, "commands", "pipeline.md")), false);
    assert.ok(existsSync(join(opencodeTmp, "commands", "other.md")), "sibling command must remain");
    assert.equal(readFileSync(join(claudeSkill, "sentinel.txt"), "utf8"), "claude-alive");
  } finally {
    cleanup(opencodeTmp);
    cleanup(claudeTmp);
    cleanup(lockTmp);
  }
});

test("uninstall --host opencode --dry-run: does not delete artifacts (#861)", () => {
  const opencodeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const install = runInstaller(["install", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(install.status, 0);

    const dry = runInstaller(["uninstall", "--host", "opencode", "--dry-run"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(dry.status, 0);
    assert.ok(existsSync(join(opencodeTmp, "skills", "pipeline")));
    assert.ok(existsSync(join(opencodeTmp, "commands", "pipeline.md")));
    assert.match(`${dry.stdout}${dry.stderr}`, /dry-run/i);
  } finally {
    cleanup(opencodeTmp);
    cleanup(lockTmp);
  }
});

test("update --host opencode: refreshes managed tree without personal shadow (#861)", () => {
  const opencodeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const first = runInstaller(["install", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(first.status, 0);
    const skillDir = join(opencodeTmp, "skills", "pipeline");
    assert.ok(existsSync(join(skillDir, MANAGED_MARKER)));

    const second = runInstaller(["update", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(second.status, 0, `update failed: ${second.stderr}\n${second.stdout}`);
    const out = `${second.stdout}${second.stderr}`;
    assert.ok(!/Personal pipeline skill detected|auto-relocat|Relocate it/i.test(out));
    assert.ok(existsSync(join(skillDir, MANAGED_MARKER)));
    assert.ok(existsSync(join(opencodeTmp, "commands", "pipeline.md")));
  } finally {
    cleanup(opencodeTmp);
    cleanup(lockTmp);
  }
});

test("OPENCODE_CONFIG_DIR override: detectPersonalSkill and install paths (#861)", () => {
  const tmp = makeTmp();
  process.env.OPENCODE_CONFIG_DIR = tmp;
  try {
    const dest = join(tmp, "skills", "pipeline");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "personal");
    const result = detectPersonalSkill("opencode");
    assert.equal(result.shadowing, true);
    assert.ok(result.dest.startsWith(tmp));
    assert.equal(opencodeBase(), resolve(tmp));
    assert.equal(opencodeSkillDir(), resolve(join(tmp, "skills", "pipeline")));
  } finally {
    delete process.env.OPENCODE_CONFIG_DIR;
    cleanup(tmp);
  }
});

test("personal OpenCode skill non-TTY: auto-relocates then install proceeds (#861)", async () => {
  const base = makeTmp();
  const dest = join(base, "skills", "pipeline");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "SKILL.md"), "personal-opencode");
  // No managed marker → personal.
  const action = await offerRelocationWith(dest, base, false, false /* non-TTY */);
  assert.equal(action, "proceed");
  assert.equal(existsSync(dest), false, "personal tree must be relocated");
  const backups = readdirSync(base).filter((e) => e.startsWith("pipeline.") && e.includes(".bak"));
  assert.equal(backups.length, 1);
  assert.ok(existsSync(join(base, backups[0], "SKILL.md")));
  cleanup(base);
});

test("OpenCode version routing: bridge --version matches launcher and package.json (#861)", () => {
  // Host contract: OpenCode markdown commands are LLM-mediated prompt templates.
  // Guarantees are (1) shell-inject → bridge → launcher stdout equality and
  // (2) template does not embed full skill instructions. Tests do NOT claim
  // OpenCode returns process stdout without an LLM turn (unsupported upstream).
  const opencodeTmp = makeTmp();
  const lockTmp = makeTmp();
  try {
    const install = runInstaller(["install", "--host", "opencode"], {
      OPENCODE_CONFIG_DIR: opencodeTmp,
      TMPDIR: lockTmp,
      TMP: lockTmp,
      TEMP: lockTmp,
    });
    assert.equal(install.status, 0, `install failed: ${install.stderr}\n${install.stdout}`);

    const skillDir = join(opencodeTmp, "skills", "pipeline");
    const launcher = join(skillDir, "scripts", "pipeline.mjs");
    const bridge = join(skillDir, "scripts", "opencode-pipeline-bridge.mjs");
    const pkg = JSON.parse(readFileSync(join(skillDir, "core", "package.json"), "utf8"));
    const expected = String(pkg.version).trim();

    const launcherV = spawnSync(process.execPath, [launcher, "--version"], {
      encoding: "utf8",
      shell: false,
    });
    assert.equal(launcherV.status, 0, launcherV.stderr);
    assert.equal(launcherV.stdout.trim(), expected);

    const launcherShort = spawnSync(process.execPath, [launcher, "-V"], {
      encoding: "utf8",
      shell: false,
    });
    assert.equal(launcherShort.status, 0, launcherShort.stderr);
    assert.equal(launcherShort.stdout.trim(), expected);

    // Bridge discrete-argv path (unit-test / direct invocation contract).
    const bridgeV = spawnSync(process.execPath, [bridge, "--", "--version"], {
      encoding: "utf8",
      shell: false,
    });
    assert.equal(bridgeV.status, 0, bridgeV.stderr);
    assert.equal(bridgeV.stdout.trim(), expected);

    const bridgeShort = spawnSync(process.execPath, [bridge, "-V"], {
      encoding: "utf8",
      shell: false,
    });
    assert.equal(bridgeShort.status, 0, bridgeShort.stderr);
    assert.equal(bridgeShort.stdout.trim(), expected);

    // Bridge stdin path (OpenCode command heredoc / shell-inject contract).
    const bridgeStdin = spawnSync(process.execPath, [bridge, "--from-stdin"], {
      encoding: "utf8",
      shell: false,
      input: "--version\n",
    });
    assert.equal(bridgeStdin.status, 0, bridgeStdin.stderr);
    assert.equal(bridgeStdin.stdout.trim(), expected);

    // Command definition: LLM-mediated template + shell inject of bridge; no full skill body.
    const cmd = readFileSync(join(opencodeTmp, "commands", "pipeline.md"), "utf8");
    assert.ok(!cmd.includes("## State machine"));
    assert.ok(cmd.includes(bridge));
    assert.match(cmd, /!`node /);
    assert.match(cmd, /LLM-mediated/i);
    assert.match(cmd, /report only the injected version string/i);
  } finally {
    cleanup(opencodeTmp);
    cleanup(lockTmp);
  }
});

test("OpenCode bridge argv safety: spaces and metacharacters not shell-expanded (#861)", () => {
  // Import the pure tokenizer used by the bridge (no subprocess of user args).
  // Dynamic import of the host source (repo path) — same code staged into installs.
  return import(pathToFileURL(join(
    fileURLToPath(new URL("..", import.meta.url)),
    "hosts",
    "opencode",
    "opencode-pipeline-bridge.mjs",
  )).href).then(async (mod) => {
    const { parseArgvString } = mod;
    assert.deepEqual(parseArgvString("status 42"), ["status", "42"]);
    assert.deepEqual(parseArgvString('override 5 "key: reason with spaces"'), [
      "override",
      "5",
      "key: reason with spaces",
    ]);
    assert.deepEqual(parseArgvString("foo * $HOME `whoami`"), ["foo", "*", "$HOME", "`whoami`"]);
    assert.deepEqual(parseArgvString("single 'quoted arg'"), ["single", "quoted arg"]);

    // End-to-end: install + bridge with a fake launcher that echoes argv as JSON.
    const dir = makeTmp();
    try {
      const scriptsDir = join(dir, "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      // Minimal launcher: print argv JSON to stdout.
      writeFileSync(
        join(scriptsDir, "pipeline.mjs"),
        `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))+"\\n");\n`,
      );
      // Copy real bridge next to fake launcher.
      const bridgeSrc = join(
        fileURLToPath(new URL("..", import.meta.url)),
        "hosts",
        "opencode",
        "opencode-pipeline-bridge.mjs",
      );
      writeFileSync(join(scriptsDir, "opencode-pipeline-bridge.mjs"), readFileSync(bridgeSrc));
      const bridge = join(scriptsDir, "opencode-pipeline-bridge.mjs");

      const reason = 'key: reason with spaces and * and $HOME';
      const r = spawnSync(
        process.execPath,
        [bridge, "--", "override", "5", reason],
        { encoding: "utf8", shell: false },
      );
      assert.equal(r.status, 0, r.stderr);
      const got = JSON.parse(r.stdout.trim());
      assert.deepEqual(got, ["override", "5", reason]);

      // Stdin path with quoted spaces.
      const r2 = spawnSync(process.execPath, [bridge, "--from-stdin"], {
        encoding: "utf8",
        shell: false,
        input: `override 5 "${reason}"\n`,
      });
      assert.equal(r2.status, 0, r2.stderr);
      assert.deepEqual(JSON.parse(r2.stdout.trim()), ["override", "5", reason]);

      // Metacharacters must arrive literal (no glob/param expansion).
      const r3 = spawnSync(process.execPath, [bridge, "--from-stdin"], {
        encoding: "utf8",
        shell: false,
        input: "echo * $HOME\n",
      });
      assert.equal(r3.status, 0, r3.stderr);
      assert.deepEqual(JSON.parse(r3.stdout.trim()), ["echo", "*", "$HOME"]);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Outer-host manifest registry (#784)
// ---------------------------------------------------------------------------

test("HOSTS are built from co-located outer-host manifests (#784)", () => {
  assert.ok(HOSTS.claude.manifest, "claude must carry manifest");
  assert.equal(HOSTS.claude.manifest.manifestVersion, 1);
  assert.equal(HOSTS.claude.commandsKind, "claude-slash");
  assert.equal(HOSTS.codex.commandsKind, "codex-prompt");
  assert.equal(HOSTS.opencode.commandsKind, "opencode-native");
  assert.equal(HOSTS.grok.installMode, "symlink-claude");
  assert.ok(HOSTS.claude.userOwnedExclusion.length > 0);
  const manifests = loadOuterHostManifests();
  assert.ok(manifests.some((m) => m.id === "claude"));
  assert.ok(manifests.every((m) => m.manifestVersion === 1));
});

test("reloadHostsFromManifests: synthetic host appears without built-in module edit (#784)", () => {
  const fixture = fileURLToPath(
    new URL("../core/test/fixtures/outer-hosts/synth-complete.json", import.meta.url),
  );
  try {
    const hosts = reloadHostsFromManifests([fixture]);
    assert.ok(hosts["synth-third-party"], "synthetic host must register from fixture path");
    assert.equal(hosts["synth-third-party"].installMode, "tree");
    assert.ok(VALID_HOSTS.includes("synth-third-party"));
    assert.ok(VALID_HOSTS.includes("claude"), "built-ins still present");
  } finally {
    // Restore built-in-only registry for remaining tests.
    reloadHostsFromManifests([]);
  }
});
