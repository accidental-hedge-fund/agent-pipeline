// Pins FRG pack-1401-pipeline-ship-1.40.1 clean-docs fixture (#1430).
// No network, git, or subprocess.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json",
);

describe("frg pack-1401-pipeline-ship-1.40.1 clean-docs fixture", () => {
  test("pins release_version to 1.40.1", () => {
    const raw = fs.readFileSync(fixturePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.release_version, "1.40.1");
  });
});
