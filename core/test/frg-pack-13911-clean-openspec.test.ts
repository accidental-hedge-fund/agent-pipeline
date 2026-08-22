// FRG pack-13911 clean-OpenSpec fixture (#1217). Reads only the run-scoped
// JSON path and asserts release_version. No production stage imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-openspec.json",
    import.meta.url,
  ),
);

test("pack-13911 clean-OpenSpec fixture names release 1.39.11", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(fixture.release_version, "1.39.11");
});
