// Pin test for FRG pack pack-1398-tugboat-ship-1.39.8 clean-docs fixture (#1188).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-docs.json",
);

test("FRG pack-1398-tugboat-ship-1.39.8 clean-docs fixture pins release_version 1.39.8", () => {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as { release_version: unknown };
  assert.equal(fixture.release_version, "1.39.8");
});
