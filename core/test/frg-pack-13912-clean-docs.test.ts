// Factory-gate clean-docs fixture pin for pack-13912-tugboat-ship-1.39.12 (#1230).
// Reads only the run-scoped path. Does not change production pipeline behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_REL = "fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-docs.json";
const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), FIXTURE_REL);

test("pack-13912 clean-docs fixture pins release_version 1.39.12", () => {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: unknown;
  };
  assert.equal(parsed.release_version, "1.39.12");
});
