#!/usr/bin/env node
// Packaging coherence gate tests (#627).
// Run via: node scripts/run-scripts-tests.mjs  (or npm run ci:scripts)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkPackagingCoherence,
  parseEnginesFloorMajor,
} from "./packaging-coherence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadPkg(rel) {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

// ---------------------------------------------------------------------------
// Pure helpers — fixture mismatches prove the gate bites
// ---------------------------------------------------------------------------

test("parseEnginesFloorMajor: >=24 and >=24.0.0 → 24", () => {
  assert.equal(parseEnginesFloorMajor(">=24"), 24);
  assert.equal(parseEnginesFloorMajor(">=24.0.0"), 24);
  assert.equal(parseEnginesFloorMajor(" >=18 "), 18);
});

test("parseEnginesFloorMajor: unparseable ranges return null", () => {
  assert.equal(parseEnginesFloorMajor("*"), null);
  assert.equal(parseEnginesFloorMajor(""), null);
  assert.equal(parseEnginesFloorMajor("18 || >=24"), null);
  assert.equal(parseEnginesFloorMajor(undefined), null);
  assert.equal(parseEnginesFloorMajor(null), null);
});

test("checkPackagingCoherence: matching versions and >=24 engines pass", () => {
  const result = checkPackagingCoherence(
    { version: "1.28.4", engines: { node: ">=24" } },
    { version: "1.28.4", engines: { node: ">=24" } },
  );
  assert.equal(result.ok, true);
});

test("checkPackagingCoherence: divergent versions fail naming both sides", () => {
  const result = checkPackagingCoherence(
    { version: "1.28.4", engines: { node: ">=24" } },
    { version: "1.28.0", engines: { node: ">=24" } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("1.28.4") && f.includes("1.28.0")));
});

test("checkPackagingCoherence: root engines >=18 with core >=24 fails", () => {
  const result = checkPackagingCoherence(
    { version: "1.0.0", engines: { node: ">=18" } },
    { version: "1.0.0", engines: { node: ">=24" } },
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((f) => /engines\.node/.test(f) && /18/.test(f) && /24/.test(f)),
    `expected engines mismatch failure; got: ${JSON.stringify(result.failures)}`,
  );
});

test("checkPackagingCoherence: unparseable root engines fail", () => {
  const result = checkPackagingCoherence(
    { version: "1.0.0", engines: { node: "*" } },
    { version: "1.0.0", engines: { node: ">=24" } },
  );
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => /unparseable|not a simple/.test(f)));
});

// ---------------------------------------------------------------------------
// Live repo gate — the real package.json pair must stay coherent
// ---------------------------------------------------------------------------

test("live repo: root and core package.json versions and engines are coherent", () => {
  const root = loadPkg("package.json");
  const core = loadPkg("core/package.json");
  const result = checkPackagingCoherence(root, core);
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : `packaging coherence failures:\n  - ${result.failures.join("\n  - ")}`,
  );
  // Explicit acceptance pins for #627
  assert.equal(root.version, core.version);
  assert.equal(parseEnginesFloorMajor(root.engines?.node), 24);
  assert.equal(parseEnginesFloorMajor(core.engines?.node), 24);
});
