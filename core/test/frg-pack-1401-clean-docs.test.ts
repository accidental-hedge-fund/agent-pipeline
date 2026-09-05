// Run-scoped clean-docs fixture for factory-gate pack
// pack-1401-pipeline-ship-1.40.1 (#1448). Hermetic: no network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("clean-docs fixture release_version is 1.40.1", () => {
  const raw = readFileSync(
    join(here, "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json"),
    "utf8",
  );
  const fixture = JSON.parse(raw) as { release_version: string };
  assert.equal(fixture.release_version, "1.40.1");
});
