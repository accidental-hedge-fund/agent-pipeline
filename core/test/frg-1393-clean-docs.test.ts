// Run-scoped FRG clean-docs fixture for pack-1393-goal-ship-1.39.3 (#1121).
// Reads the committed fixture only. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1393-goal-ship-1.39.3/clean-docs.json", import.meta.url),
);

const EXPECTED_RELEASE_VERSION = "1.39.3";

function assertReleaseVersion(fixture: { release_version?: unknown }): void {
  assert.equal(fixture.release_version, EXPECTED_RELEASE_VERSION);
}

function readPack1393CleanDocsFixture(): { release_version?: unknown } {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
}

test("pack-1393 clean-docs fixture path is run-scoped", () => {
  assert.match(FIXTURE_PATH, /pack-1393-goal-ship-1\.39\.3[/\\]clean-docs\.json$/);
});

test("pack-1393 clean-docs fixture release_version is 1.39.3", () => {
  const fixture = readPack1393CleanDocsFixture();
  assertReleaseVersion(fixture);
});

test("clean-docs fixture assertion fails when release_version is not 1.39.3", () => {
  assert.throws(() => assertReleaseVersion({ release_version: "0.0.0" }));
});

test("clean-docs fixture assertion fails when release_version is missing", () => {
  assert.throws(() => assertReleaseVersion({}));
});
