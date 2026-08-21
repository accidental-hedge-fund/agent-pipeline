// Run-scoped FRG pack-1398 clean-openspec fixture (#1195).
// Reads only the pack-run JSON path. Does not import production modules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_REL = "fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json";
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), FIXTURE_REL);

function assertPack1398Release(parsed: unknown): void {
  assert.equal(typeof parsed, "object", "fixture must parse to an object");
  assert.notEqual(parsed, null, "fixture must not be null");
  const record = parsed as { release_version?: unknown };
  assert.equal(record.release_version, "1.39.8");
}

test("pack-1398 clean-openspec fixture names release 1.39.8", () => {
  assert.match(FIXTURE_PATH, /pack-1398-tugboat-ship-1\.39\.8/);
  assert.equal(FIXTURE_PATH.includes("fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json"), true);
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assertPack1398Release(parsed);
});

test("assertion fails when release_version is missing", () => {
  assert.throws(() => assertPack1398Release({}));
});

test("assertion fails when release_version is not 1.39.8", () => {
  assert.throws(() => assertPack1398Release({ release_version: "1.39.7" }));
});
