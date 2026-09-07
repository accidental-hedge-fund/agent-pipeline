import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const fixtureUrl = new URL(
  "./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json",
  import.meta.url,
);

test("pack-1401-pipeline-ship-1.40.1 clean-docs fixture has the exact release", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as {
    release_version?: unknown;
  };

  assert.equal(fixture.release_version, "1.40.1");
});
