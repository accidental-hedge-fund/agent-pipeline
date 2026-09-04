// Pin the run-scoped FRG clean-openspec fixture for pack-1401-pipeline-ship-1.40.1
// to release 1.40.1 (#1431). The file is the contract; this test fails if
// release_version is missing, is not a string, or is any other value.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json", import.meta.url),
);

test("pack-1401-pipeline-ship-1.40.1 clean-openspec fixture names release 1.40.1", () => {
  const parsed: unknown = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  const fixture = parsed as { release_version?: unknown };
  assert.equal(typeof fixture.release_version, "string");
  assert.equal(fixture.release_version, "1.40.1");
});
