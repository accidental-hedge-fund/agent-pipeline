// Run-scoped FRG clean-openspec fixture for pack-1394-tugboat-ship-1.39.4 (#1137).
// Reads the committed fixture only. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1394-tugboat-ship-1.39.4/clean-openspec.json", import.meta.url),
);

const EXPECTED_RELEASE_VERSION = "1.39.4";

function assertReleaseVersion(fixture: { release_version?: unknown }): void {
  assert.equal(fixture.release_version, EXPECTED_RELEASE_VERSION);
}

function readPack1394CleanOpenSpecFixture(): { release_version?: unknown } {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
}

test("pack-1394 clean-openspec fixture path is run-scoped", () => {
  assert.match(FIXTURE_PATH, /pack-1394-tugboat-ship-1\.39\.4[/\\]clean-openspec\.json$/);
});

test("pack-1394 clean-openspec fixture release_version is 1.39.4", () => {
  const fixture = readPack1394CleanOpenSpecFixture();
  assertReleaseVersion(fixture);
});

test("clean-openspec fixture assertion fails when release_version is not 1.39.4", () => {
  assert.throws(() => assertReleaseVersion({ release_version: "0.0.0" }));
});

test("clean-openspec fixture assertion fails when release_version is missing", () => {
  assert.throws(() => assertReleaseVersion({}));
});
