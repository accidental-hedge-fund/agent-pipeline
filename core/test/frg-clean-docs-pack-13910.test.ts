// FRG pack pack-13910-tugboat-ship-1.39.10 clean-docs fixture pin (#1207).
// Reads only the run-scoped fixture path. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures",
  "frg",
  "pack-13910-tugboat-ship-1.39.10",
  "clean-docs.json",
);

test("clean-docs fixture pins release_version to 1.39.10", () => {
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  assert.equal(typeof parsed, "object");
  assert.notEqual(parsed, null);
  const fixture = parsed as { release_version?: unknown };
  assert.equal(fixture.release_version, "1.39.10");
});
