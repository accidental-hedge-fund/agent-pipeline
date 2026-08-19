// Run-scoped FRG pack fixture for pack-1395-tugboat-ship-1.39.5 (#1144).
// Reads only the local fixture. No network, git, or subprocess.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-1395-tugboat-ship-1.39.5/clean-openspec.json",
);

describe("frg-1395-clean-openspec fixture", () => {
  test("names release 1.39.5", () => {
    const raw = fs.readFileSync(fixturePath, "utf8");
    const fixture = JSON.parse(raw) as { release: string };
    assert.equal(fixture.release, "1.39.5");
  });
});
