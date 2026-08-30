import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/frg/pack-1400-pipeline-ship-1.40.0/clean-docs.json",
);

test("pack-1400-pipeline-ship-1.40.0 clean-docs fixture names release 1.40.0", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.40.0");
});
