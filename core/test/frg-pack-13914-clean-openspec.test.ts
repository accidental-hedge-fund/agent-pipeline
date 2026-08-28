// Run-scoped FRG clean-openspec fixture for pack-13914-pipeline-ship-1.39.14 (#1280).
// Disk-read only: no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REL = "fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-openspec.json";
const fixturePath = path.join(here, FIXTURE_REL);

test("pack-13914 clean-openspec fixture names release 1.39.14", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.39.14");
});

test("this test loads only the run-scoped fixture path", () => {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const matches = src.match(/fixtures\/frg\/[^\s"'`]+/g) ?? [];
  assert.deepEqual(
    [...new Set(matches)],
    ["fixtures/frg/pack-13914-pipeline-ship-1.39.14/clean-openspec.json"],
  );
});
