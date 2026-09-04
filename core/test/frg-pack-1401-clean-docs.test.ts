// Pins the FRG pack-1401 clean-docs fixture release_version (#1436).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json",
);

test("pack-1401 clean-docs fixture pins release_version 1.40.1", () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version: string;
  };
  assert.equal(fixture.release_version, "1.40.1");
});
