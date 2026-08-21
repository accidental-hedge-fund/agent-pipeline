// Run-scoped factory-gate-v1 clean-docs pin for pack-1399-tugboat-ship-1.39.9 (#1200).
// Reads only this pack-run fixture. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-docs.json", import.meta.url),
);

test("clean-docs fixture release_version is 1.39.9", () => {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(fixture.release_version, "1.39.9");
});
