// Run-scoped FRG clean-openspec fixture for pack-1397-tugboat-ship-1.39.7.
// File-read only: no production pipeline or FRG module imports, and no
// network, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-1397-tugboat-ship-1.39.7/clean-openspec.json",
);

test("pack-1397-tugboat-ship-1.39.7 clean-openspec fixture names release 1.39.7", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.39.7");
});
