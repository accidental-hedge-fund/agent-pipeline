// Drift guard: annotated v* tag push publishes GitHub Release (#1167).
// Tugboat wait-release polls gh release view; it does not create the Release.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseTagNotes } from "../scripts/stages/release-complete.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = join(__dirname, "../../.github/workflows/release.yml");
const TUGBOAT = join(__dirname, "../../examples/supervisor/shell/tugboat.sh");

test("release.yml publishes GitHub Release on v* tag push (#1167)", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  assert.match(src, /^on:\n  push:\n    tags:\n      - "v\*"\n  workflow_dispatch:\n    inputs:\n      tag:\n/m);
  assert.match(src, /node --experimental-strip-types core\/scripts\/publish-github-release\.ts/);
  assert.match(src, /workflow_dispatch:/);
  assert.match(src, /candidate:/);
  assert.doesNotMatch(src, /gh release view .*&>\/dev\/null/);
  assert.doesNotMatch(src, /^\s*gh release create/m);
  assert.doesNotMatch(src, /^\s*gh release edit/m);
});

test("release.yml recovery dispatch shares the push publication job and exact tag/candidate inputs (#1563)", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  assert.match(src, /description: Exact annotated tag \(vX\.Y\.Z\)/);
  assert.match(src, /description: Exact 40-hex candidate SHA C/);
  assert.match(src, /required: true/);
  assert.equal((src.match(/^jobs:\n  release:/m) ?? []).length, 1);
  assert.match(src, /GITHUB_EVENT_NAME.*workflow_dispatch/);
});

test("release.yml order is tag checkout, root/core guards, main=C, publication, main checkout, install, docs (#1563)", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  const tagCheckout = src.indexOf("Fetch and check out the annotated tag");
  const guards = src.indexOf("Guard annotated tag, package versions, and origin/main");
  const rootVersion = src.indexOf("require('./package.json').version");
  const coreVersion = src.indexOf("require('./core/package.json').version");
  const mainEqualsC = src.indexOf("origin/main ${main} is not candidate ${C}");
  const publish = src.indexOf("Publish GitHub Release from the annotated tag");
  const mainCheckout = src.indexOf("Check out current main before docs");
  const install = src.indexOf("Install dependencies for tag-derived docs");
  const docs = src.indexOf("Refresh tag-derived docs on main");
  const order = [tagCheckout, guards, rootVersion, coreVersion, mainEqualsC, publish, mainCheckout, install, docs];
  assert.ok(order.every((index) => index >= 0), `missing workflow steps: ${JSON.stringify(order)}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i]! > order[i - 1]!, `workflow step order broken at index ${i}`);
  }
  assert.ok(src.indexOf("npm ci") > mainCheckout, "dependency install must follow main checkout");
  assert.match(src, /non-atomic/);
  const trackingRefspec = src.match(/\+refs\/heads\/main:refs\/remotes\/origin\/main/g) ?? [];
  assert.equal(trackingRefspec.length, 2, "publication guard and docs checkout must update origin/main");
  assert.doesNotMatch(src, /git fetch origin main$/m);
});

test("release.yml rejects a same-C tag whose notes diverge from TAG and C (#1563)", () => {
  const src = readFileSync(WORKFLOW, "utf8");
  const publish = src.slice(src.indexOf("Publish GitHub Release from the annotated tag"));
  const notesDump = publish.indexOf("git tag -l \"${TAG}\" --format='%(contents)' > /tmp/notes.md");
  const helper = publish.indexOf("core/scripts/publish-github-release.ts");
  assert.ok(notesDump >= 0, "publish step must dump annotated notes");
  assert.ok(helper >= 0, "publish step must invoke the publisher helper");
  assert.ok(notesDump < helper, "exact notes file must exist before create/edit");
  const C = "c".repeat(40);
  assert.equal(releaseTagNotes("1.2.3", C), `v1.2.3\n\nVerified exact-candidate release at ${C}.`);
  assert.match(publish, /outputs\.candidate/);
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
