// Run-scoped FRG clean-docs fixture for pack-1395-tugboat-ship-1.39.5 (#1157).
// Zero network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-docs.json",
);

test("pack-1395 clean-docs fixture release_version is 1.39.5", () => {
  const raw = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(fixture.release_version, "1.39.5");
});
