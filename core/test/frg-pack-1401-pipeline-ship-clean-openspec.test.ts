// Pack-1401-pipeline-ship-1.40.1 clean-openspec fixture pin (#1449).
// Zero network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  here,
  "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json",
);

test("pack-1401-pipeline-ship-1.40.1 clean-openspec fixture names release 1.40.1", () => {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw) as { release_version: string };
  assert.equal(fixture.release_version, "1.40.1");
});
