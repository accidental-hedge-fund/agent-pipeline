// Drift guard: annotated v* tag push publishes GitHub Release (#1167).
// Tugboat wait-release polls gh release view; it does not create the Release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(__dirname, "../../.github/workflows/release.yml");
const TUGBOAT = join(__dirname, "../../examples/supervisor/shell/tugboat.sh");

test("release.yml publishes GitHub Release on v* tag push (#1167)", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  assert.match(src, /^on:\n  push:\n    tags:\n      - "v\*"\n/m);
  assert.match(src, /gh release create/);
  assert.match(src, /--verify-tag/);
  assert.match(src, /gh release view/);
  assert.doesNotMatch(src, /workflow_dispatch/);
});

test("tugboat wait-release does not create GitHub Releases (#1167)", () => {
  const src = readFileSync(TUGBOAT, "utf8");
  const shipOneStart = src.indexOf("ship_one() {");
  const shipOneEnd = src.indexOf("\n# ---------- run serial multi-milestone");
  const shipOne = src.slice(shipOneStart, shipOneEnd);
  assert.match(shipOne, /gh release view "v\$version"/);
  assert.doesNotMatch(shipOne, /gh release create/);
  assert.doesNotMatch(shipOne, /\bgit tag\b/);
});
