import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/frg/pack-1396-tugboat-ship-1.39.6/clean-docs.json", import.meta.url),
);

test("FRG pack-1396-tugboat-ship-1.39.6 clean-docs fixture names release 1.39.6", () => {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(parsed.release_version, "1.39.6");
});
