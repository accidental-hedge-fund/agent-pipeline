// FRG clean-openspec run-scoped fixture contract (#933).
// Hermetic: reads only the pack-run fixture path; no network, git, or subprocess I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Run-scoped path only — must not load a shared cross-run fixture. */
const FIXTURE_PATH = path.join(
  __dirname,
  "fixtures",
  "frg",
  "frg-1-33-0-d5d716355f2ed48d04aa8dde",
  "clean-openspec.json",
);

test("run-scoped clean-openspec fixture names release 1.33.0", () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), `fixture missing: ${FIXTURE_PATH}`);
  const raw = fs.readFileSync(FIXTURE_PATH, "utf8");
  const parsed = JSON.parse(raw) as { release_version?: unknown };
  assert.equal(parsed.release_version, "1.33.0");
});

test("run-scoped fixture path is exclusive to this pack run", () => {
  const normalized = FIXTURE_PATH.replaceAll("\\", "/");
  assert.match(
    normalized,
    /core\/test\/fixtures\/frg\/frg-1-33-0-d5d716355f2ed48d04aa8dde\/clean-openspec\.json$/,
  );
  assert.ok(
    !normalized.includes("/fixtures/frg/shared/"),
    "must not use a shared cross-run fixture path",
  );
});
