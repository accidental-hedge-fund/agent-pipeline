#!/usr/bin/env node
// Regression tests for scripts/postinstall.mjs (#153).
// Run with: node --test scripts/postinstall.test.mjs
//
// The bug this guards: an earlier round made core dependency provisioning a
// MANDATORY root postinstall (`(cd core && npm ci ...)`). A failing nested
// `npm ci` (transient registry outage, offline, cache-permission, engine-strict
// mismatch) then aborted the whole package install before `scripts/install.mjs`
// could run, breaking existing `npx … agent-pipeline install` flows. The
// postinstall must be best-effort: warn and exit 0 on failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const POSTINSTALL = join(REPO_ROOT, "scripts", "postinstall.mjs");

/** Run postinstall.mjs with a stub `npm` (and `npm.cmd`) on PATH that exits with
 *  `npmExit`, isolating the test from the real registry. */
function runPostinstallWithStubNpm(npmExit) {
  const stubDir = mkdtempSync(join(tmpdir(), "postinstall-stub-"));
  try {
    // POSIX stub
    const npmStub = join(stubDir, "npm");
    writeFileSync(npmStub, `#!/bin/sh\nexit ${npmExit}\n`);
    chmodSync(npmStub, 0o755);
    // Windows stub (harmless elsewhere)
    writeFileSync(join(stubDir, "npm.cmd"), `@echo off\r\nexit /b ${npmExit}\r\n`);

    return spawnSync(NODE, [POSTINSTALL], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
      stdio: "pipe",
    });
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

test("postinstall exits 0 when the nested `npm ci` FAILS (best-effort, non-fatal)", () => {
  const r = runPostinstallWithStubNpm(1);
  assert.equal(r.status, 0, `postinstall must not abort the package install; got exit ${r.status}`);
  const stderr = r.stderr.toString();
  assert.match(stderr, /best-effort/i, "must warn that provisioning was best-effort");
});

test("postinstall exits 0 when the nested `npm ci` SUCCEEDS", () => {
  const r = runPostinstallWithStubNpm(0);
  assert.equal(r.status, 0, `postinstall must exit 0 on success; got exit ${r.status}`);
  // No best-effort warning on the success path.
  assert.doesNotMatch(r.stderr.toString(), /best-effort/i, "no warning expected when provisioning succeeds");
});
