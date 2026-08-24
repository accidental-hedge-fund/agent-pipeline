// Run-scoped FRG clean-openspec fixture for pack-13912-tugboat-ship-1.39.12.
// Reads only that pack_run_id path. No production imports, network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_PATH = join(
  import.meta.dirname,
  "fixtures/frg/pack-13912-tugboat-ship-1.39.12/clean-openspec.json",
);

test("pack-13912-tugboat-ship-1.39.12 clean-openspec fixture names release 1.39.12", () => {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  assert.equal(
    (parsed as { release_version?: unknown }).release_version,
    "1.39.12",
  );
});
