// FRG pack-run fixture contract for pack-13915-pipeline-ship-1.39.15 (#1291).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-13915-pipeline-ship-1.39.15/clean-openspec.json",
);

test("pack-run clean-openspec fixture names release 1.39.15", () => {
  const parsed: unknown = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  const releaseVersion = (parsed as { release_version?: unknown }).release_version;
  assert.equal(releaseVersion, "1.39.15");
});
