// Run-scoped clean OpenSpec fixture for pack run frg-1.40.1-0672994e898c-r2 (#1587).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const fixturePath = path.join(
  import.meta.dirname,
  "fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-openspec.json",
);

test("clean-openspec fixture names release 1.40.1", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version: unknown;
  };
  assert.equal(parsed.release_version, "1.40.1");
});
