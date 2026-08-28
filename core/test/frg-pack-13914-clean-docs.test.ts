// Factory-gate clean-docs pin for pack run
// pack-13914-pipeline-ship-1.39.14 (#1279).
// Reads only the run-scoped fixture and fails if release_version is not 1.39.14.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_RELATIVE =
  "./fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-docs.json";
const FIXTURE_PATH = fileURLToPath(new URL(FIXTURE_RELATIVE, import.meta.url));

test("pack-13914 clean-docs fixture pins release_version 1.39.14", () => {
  assert.match(
    FIXTURE_PATH,
    /core\/test\/fixtures\/frg\/pack-13914-pipeline-ship-1\.39\.14\/clean-docs\.json$/,
  );
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: unknown;
  };
  assert.equal(parsed.release_version, "1.39.14");
});
