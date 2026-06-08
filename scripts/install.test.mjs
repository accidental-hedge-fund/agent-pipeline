#!/usr/bin/env node
// Unit tests for shadow-detection helpers in scripts/install.mjs.
// Run with: node --test scripts/install.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  MANAGED_MARKER,
  detectPersonalSkill,
  uniqueBackupPath,
  offerRelocationWith,
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
