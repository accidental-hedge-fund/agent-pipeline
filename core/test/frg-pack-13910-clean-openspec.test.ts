// FRG pack-13910-tugboat-ship-1.39.10 clean-openspec fixture (#1208).
// File-read only: no network, git, subprocess, or production imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(
  here,
  "fixtures/frg/pack-13910-tugboat-ship-1.39.10/clean-openspec.json",
);

test("pack-13910-tugboat-ship-1.39.10 clean-openspec fixture names release 1.39.10", () => {
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.39.10");
});
