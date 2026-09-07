import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const FIXTURE_URL = new URL(
  "./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-docs.json",
  import.meta.url,
);

test("clean-docs fixture identifies release 1.40.1", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_URL, "utf8"));

  assert.equal(fixture.release_version, "1.40.1");
});
