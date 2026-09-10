// #1563 structural authority guard: release command is the only tag owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("auto-tag-release workflow has FRG verification step ordered before tag create/push", () => {
  const src = readFileSync(join(root, ".github/workflows/auto-tag-release.yml"), "utf8");
  assert.match(src, /^name: auto-tag-release-disabled$/m);
  assert.match(src, /^  workflow_dispatch:$/m);
  assert.match(src, /^    if: \$\{\{ false \}\}$/m);
  assert.doesNotMatch(src, /^  push:\n    branches:/m);
});

test("release.yml is the sole tag-triggered publisher and post-tag docs owner", () => {
  const publisher = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(publisher, /^  push:\n    tags:\n      - "v\*"/m);
  assert.match(publisher, /workflow_dispatch:/);
  assert.match(publisher, /node --experimental-strip-types core\/scripts\/publish-github-release\.ts/);
  assert.match(publisher, /release-docs-refresh\.mjs/);
  assert.match(publisher, /test "\$observed" = "\$released"/);
  assert.match(publisher, /Check out current main before docs/);
});
