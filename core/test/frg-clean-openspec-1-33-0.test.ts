// FRG clean-OpenSpec fixture guard for pack run frg-1-33-0-f66627485c58a658c444ae3b (#939).
// Pins release_version at the run-scoped path only; no production behavior.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REL =
  "fixtures/frg/frg-1-33-0-f66627485c58a658c444ae3b/clean-openspec.json";
const FIXTURE_PATH = path.join(here, FIXTURE_REL);

test("FRG clean-openspec fixture names release 1.33.0 at the run-scoped path", () => {
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(parsed.release_version, "1.33.0");
});
