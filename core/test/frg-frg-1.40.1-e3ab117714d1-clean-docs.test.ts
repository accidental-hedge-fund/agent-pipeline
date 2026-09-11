// FRG clean-docs fixture identity for pack run frg-1.40.1-e3ab117714d1 (#1592).
// Reads only the run-scoped JSON fixture. No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  here,
  "fixtures/frg/frg-1.40.1-e3ab117714d1/clean-docs.json",
);

test("clean-docs fixture names release 1.40.1", () => {
  const parsed = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
    release_version?: unknown;
  };
  assert.equal(parsed.release_version, "1.40.1");
});
