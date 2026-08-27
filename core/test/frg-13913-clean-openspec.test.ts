// FRG clean-openspec fixture for pack-13913-release-v1.39.13-frg-20260827-1530 (#1256).
// Disk-read only: no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json",
);

test("pack-run clean-openspec fixture names release 1.39.13", () => {
  const parsed: unknown = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal((parsed as { release_version?: unknown }).release_version, "1.39.13");
});

test("fixture and test stay on the run-scoped path", () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const matches = source.match(/fixtures\/frg\/[^"'`\s]+/g) ?? [];
  assert.deepEqual(
    [...new Set(matches)],
    ["fixtures/frg/pack-13913-release-v1.39.13-frg-20260827-1530/clean-openspec.json"],
  );
});
