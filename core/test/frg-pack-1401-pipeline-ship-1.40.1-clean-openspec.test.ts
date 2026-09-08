import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const fixtureUrl = new URL(
  "./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json",
  import.meta.url,
);

test("clean OpenSpec fixture names release 1.40.1", () => {
  const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as {
    release_version?: unknown;
  };

  assert.equal(fixture.release_version, "1.40.1");
});
