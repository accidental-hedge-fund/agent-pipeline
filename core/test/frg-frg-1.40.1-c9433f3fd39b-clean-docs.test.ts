import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/frg-1.40.1-c9433f3fd39b/clean-docs.json", import.meta.url),
);

test("FRG clean-docs fixture names release 1.40.1", () => {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  assert.equal(fixture.release_version, "1.40.1");
});
