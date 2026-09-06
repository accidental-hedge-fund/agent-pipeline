import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL(
    "./fixtures/frg/pack-1401-pipeline-ship-1.40.1/clean-openspec.json",
    import.meta.url,
  ),
);

test("pack-1401 clean-openspec fixture names release 1.40.1", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.40.1");
});
