// FRG pack-1392-tugboat-ship-1.39.2 clean-openspec fixture (#1113).
// Reads only the run-scoped fixture. Does not import production modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_RELATIVE = "fixtures/frg/pack-1392-tugboat-ship-1.39.2/clean-openspec.json";
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), FIXTURE_RELATIVE);
const EXPECTED_RELEASE = "1.39.2";

function loadFixture(): { release_version?: unknown } {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { release_version?: unknown };
}

function assertReleaseVersion(releaseVersion: unknown): void {
  assert.equal(releaseVersion, EXPECTED_RELEASE);
}

test("pack-1392-tugboat-ship-1.39.2 clean-openspec fixture names release 1.39.2", () => {
  const fixture = loadFixture();
  assertReleaseVersion(fixture.release_version);
});

test("unit test fails when release_version is not 1.39.2", () => {
  assert.throws(() => assertReleaseVersion("0.0.0"), { name: "AssertionError" });
});

test("fixture and test stay run-scoped and do not import production modules", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.match(source, /fixtures\/frg\/pack-1392-tugboat-ship-1\.39\.2\/clean-openspec\.json/);
  assert.doesNotMatch(source, /from ["']\.\.\/scripts\//);
});
