import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/frg-1.40.1-0672994e898c-r2/clean-docs.json", import.meta.url),
);

test("clean-docs fixture names release 1.40.1", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
    release_version: unknown;
  };
  assert.equal(fixture.release_version, "1.40.1");
});
