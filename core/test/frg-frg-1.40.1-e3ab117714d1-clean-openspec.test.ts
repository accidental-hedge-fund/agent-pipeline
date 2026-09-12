import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURE_PATH = path.join(
  import.meta.dirname,
  "fixtures/frg/frg-1.40.1-e3ab117714d1/clean-openspec.json",
);

test("clean-openspec fixture names release 1.40.1", () => {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: string;
  };
  assert.equal(parsed.release_version, "1.40.1");
});
