// Run-scoped FRG clean-docs fixture for pack-1398-tugboat-ship-1.39.8 (#1194).
// In-process read of a repo-local JSON file — no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACK_RUN_ID = "pack-1398-tugboat-ship-1.39.8";
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "frg",
  PACK_RUN_ID,
  "clean-docs.json",
);

test("pack-1398 clean-docs fixture names release_version 1.39.8", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(fixture.release_version, "1.39.8");
});

test("pack-1398 clean-docs test reads only the run-scoped fixture path", () => {
  assert.ok(
    FIXTURE_PATH.endsWith(`fixtures/frg/${PACK_RUN_ID}/clean-docs.json`),
    FIXTURE_PATH,
  );
});
