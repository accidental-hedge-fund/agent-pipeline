// Run-scoped FRG OpenSpec fixture for pack-1396-tugboat-ship-1.39.6 (#1170).
// Reads only the pack-run path. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_RELATIVE = "fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-openspec.json";
const FIXTURE_PATH = fileURLToPath(new URL(`./${FIXTURE_RELATIVE}`, import.meta.url));

test("pack-1396 clean-openspec fixture names release 1.39.6", () => {
  assert.match(
    FIXTURE_PATH,
    /pack-1396-tugboat-ship-1\.39\.6\/clean-openspec\.json$/,
    "test must read only the run-scoped fixture path",
  );
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(fixture.release_version, "1.39.6");
});
