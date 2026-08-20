// Run-scoped FRG clean-openspec fixture for pack-1395-tugboat-ship-1.39.5 (#1158).
// Disk-read only: no network, git, subprocess, or production stage imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json",
    import.meta.url,
  ),
);
const EXPECTED_RELEASE = "1.39.5";

function loadFixture(path: string): { release_version?: unknown } {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("fixture is not a JSON object");
  }
  return parsed as { release_version?: unknown };
}

function assertReleaseVersion(fixture: { release_version?: unknown }): void {
  assert.equal(fixture.release_version, EXPECTED_RELEASE);
}

test("pack-1395 clean-openspec fixture names release 1.39.5", () => {
  assertReleaseVersion(loadFixture(FIXTURE_PATH));
});

test("unit test fails when the fixture is missing, is not JSON, or names a different release", () => {
  const missingPath = fileURLToPath(
    new URL(
      "./fixtures/frg/pack-1395-tugboat-ship-1.39.5/does-not-exist.json",
      import.meta.url,
    ),
  );
  assert.throws(() => loadFixture(missingPath), { code: "ENOENT" });
  assert.throws(() => JSON.parse("{"), SyntaxError);
  assert.throws(() => assertReleaseVersion({}));
  assert.throws(() => assertReleaseVersion({ release_version: "0.0.0" }));
});
