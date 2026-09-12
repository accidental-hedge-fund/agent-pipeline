// Run-scoped FRG clean-openspec fixture for pack run frg-1.40.1-c9433f3fd39b (#1601).
// Reads only the issue-owned JSON fixture and asserts the literal release value.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-openspec.json", import.meta.url),
);

test("run-scoped clean-openspec fixture names release 1.40.1", () => {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: string;
  };
  assert.equal(parsed.release_version, "1.40.1");
});
