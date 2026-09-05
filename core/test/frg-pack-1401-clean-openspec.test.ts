// Pack-1401 clean-openspec fixture contract (#1465).
// Reads only the run-scoped path and asserts release_version is 1.40.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json", import.meta.url),
);

test("pack-1401 clean-openspec fixture names release 1.40.1", () => {
  assert.match(FIXTURE_PATH, /fixtures\/frg\/pack-1401-pipeline-ship-1\.40\.1\/clean-openspec\.json$/);
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as { release_version?: string };
  assert.equal(parsed.release_version, "1.40.1");
});
