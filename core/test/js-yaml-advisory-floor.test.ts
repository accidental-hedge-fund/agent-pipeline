// Regression guard for #625: js-yaml carries two published DoS advisories in
// the range >=4.0.0 <4.3.0 (GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m). Both are
// fixed in 4.3.0. This test pins the declared range floor AND the lockfile
// resolution to >=4.3.0 so a future `npm install` or manual edit can't
// silently drop the parser back into the advisory range.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const LOCK_PATH = fileURLToPath(new URL("../package-lock.json", import.meta.url));
const FIX_VERSION = [4, 3, 0];

function parseVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`unparseable version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeastFix(version: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > FIX_VERSION[i]) return true;
    if (version[i] < FIX_VERSION[i]) return false;
  }
  return true;
}

test("core/package.json declares a js-yaml floor >= 4.3.0 within the 4.x major", () => {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const range = pkg.dependencies["js-yaml"];
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
  assert.ok(
    match,
    `js-yaml range must be a caret range (e.g. "^4.3.0"), got ${JSON.stringify(range)}`,
  );
  const floor: [number, number, number] = [Number(match![1]), Number(match![2]), Number(match![3])];
  assert.equal(floor[0], 4, `js-yaml range must stay within the 4.x major, got ${range}`);
  assert.ok(
    isAtLeastFix(floor),
    `js-yaml declared floor ${range} is below the advisory fix version 4.3.0 ` +
      `(GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m); require >=4.3.0`,
  );
});

test("core/package-lock.json resolves js-yaml to >= 4.3.0", () => {
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  const resolved = lock.packages["node_modules/js-yaml"];
  assert.ok(resolved, "node_modules/js-yaml entry missing from core/package-lock.json");
  const version = parseVersion(resolved.version ?? "");
  assert.ok(
    isAtLeastFix(version),
    `js-yaml lockfile resolution ${resolved.version} is below the advisory fix version 4.3.0 ` +
      `(GHSA-h67p-54hq-rp68, GHSA-52cp-r559-cp3m); require >=4.3.0`,
  );
});
