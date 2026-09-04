// Run-scoped FRG fixture pin for pack-1401-pipeline-ship-1.40.1
// (capability `frg-pack-1401-pipeline-ship-clean-openspec`, #1443).
// Zero network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json",
);

test("pack-1401-pipeline-ship-1.40.1 clean-openspec fixture names release 1.40.1", () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    release_version: string;
  };
  assert.equal(fixture.release_version, "1.40.1");
});
