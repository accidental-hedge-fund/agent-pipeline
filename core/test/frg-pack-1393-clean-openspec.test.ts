// Run-scoped FRG fixture for pack-1393-goal-ship-1.39.3 (#1122).
// Reads only the committed fixture path. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/frg/pack-1393-goal-ship-1.39.3/clean-openspec.json",
);

type CleanOpenSpecFixture = {
  release_version?: unknown;
};

function loadRunScopedFixture(): CleanOpenSpecFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as CleanOpenSpecFixture;
}

function assertReleaseVersion(fixture: CleanOpenSpecFixture): void {
  assert.equal(fixture.release_version, "1.39.3");
}

test("pack-1393-goal-ship-1.39.3 clean-openspec fixture names release 1.39.3", () => {
  assertReleaseVersion(loadRunScopedFixture());
});

test("unit test fails when the fixture version is missing or not 1.39.3", () => {
  const fixture = loadRunScopedFixture();
  const missing: CleanOpenSpecFixture = { ...fixture };
  delete missing.release_version;
  assert.throws(() => assertReleaseVersion(missing), { name: "AssertionError" });
  assert.throws(() => assertReleaseVersion({ ...fixture, release_version: "0.0.0" }), {
    name: "AssertionError",
  });
});
