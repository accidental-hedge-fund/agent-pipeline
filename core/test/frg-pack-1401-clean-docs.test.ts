// FRG pack-1401-pipeline-ship-1.40.1 clean-docs fixture pin (#1442).
// Zero network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  here,
  "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json",
);

test("pack-1401 clean-docs fixture release_version is 1.40.1", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(fixture.release_version, "1.40.1");
});
