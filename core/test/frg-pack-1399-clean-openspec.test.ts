// File-read contract for #1201 FRG pack-1399-tugboat-ship-1.39.9 clean-openspec.
// Reads only the run-scoped fixture. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/frg/pack-1399-tugboat-ship-1.39.9/clean-openspec.json",
    import.meta.url,
  ),
);

test("pack-1399-tugboat-ship-1.39.9 clean-openspec fixture names release 1.39.9", () => {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.39.9");
});
