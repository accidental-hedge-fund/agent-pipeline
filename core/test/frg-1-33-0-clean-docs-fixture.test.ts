// FRG clean-docs fixture pin for pack run frg-1-33-0-d5d716355f2ed48d04aa8dde (#932).
// Loads only the run-scoped fixture path; no production pipeline behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "frg",
  "frg-1-33-0-d5d716355f2ed48d04aa8dde",
  "clean-docs.json",
);

test("run-scoped clean-docs fixture pins release_version to 1.33.0", () => {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const fixture = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(fixture.release_version, "1.33.0");
});
