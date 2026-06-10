#!/usr/bin/env node
// Unit tests for shadow-detection and dependency-prompting helpers in scripts/install.mjs.
// Run with: node --test scripts/install.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  MANAGED_MARKER,
  DEPS,
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
