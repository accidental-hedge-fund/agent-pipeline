// #1216 — factory-gate clean-docs pack instance for pack run
// pack-13911-tugboat-ship-1.39.11. Pins release_version 1.39.11.
// Reads only the run-scoped fixture path.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-13911-tugboat-ship-1.39.11/clean-docs.json", import.meta.url),
);

test("pack-13911 clean-docs fixture pins release_version 1.39.11", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: unknown;
  };
  assert.equal(fixture.release_version, "1.39.11");
});
