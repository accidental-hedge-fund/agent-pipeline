// FRG pack-1398-tugboat-ship-1.39.8 clean-openspec fixture (#1189).
// File-read only. No network, git, subprocess, or production imports.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  here,
  "fixtures/frg/pack-1398-tugboat-ship-1.39.8/clean-openspec.json",
);

test("pack-1398-tugboat-ship-1.39.8 clean-openspec fixture names release 1.39.8", () => {
  const raw = fs.readFileSync(FIXTURE, "utf8");
  const parsed = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(parsed.release_version, "1.39.8");
});
