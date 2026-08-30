import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-13916-pipeline-ship-1.39.16/clean-docs.json", import.meta.url),
);

test("clean-docs fixture pins release_version to 1.39.16", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(fixture.release_version, "1.39.16");
});
