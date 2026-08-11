// Regression: ship playbook must wait for the release PR's observable checks
// to go green before `release finish`. `pipeline release finish` refuses to
// merge while checks are pending/failing, so without this wait the ship races
// the just-opened release PR's CI and fails release-finish with exit 1.
// The classification logic lives in release-checks-green.py (pure, testable).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const helper = path.join(
  repoRoot,
  "examples/supervisor/shell/release-checks-green.py",
);

function classify(checks: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-checks-green-"));
  const f = path.join(dir, "checks.json");
  fs.writeFileSync(f, JSON.stringify(checks));
  try {
    const r = spawnSync("python3", [helper, f], { encoding: "utf8" });
    assert.equal(r.status, 0, `helper exited ${r.status}: ${r.stderr}`);
    return r.stdout.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("release-checks-green: all success -> green (1)", () => {
  assert.equal(
    classify([
      { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
      { name: "lint", state: "SUCCESS", conclusion: "SUCCESS" },
    ]),
    "1",
  );
});

test("release-checks-green: success with null conclusion -> green (1)", () => {
  assert.equal(
    classify([{ name: "test", state: "SUCCESS", conclusion: null }]),
    "1",
  );
});

test("release-checks-green: neutral/skipped -> green (1)", () => {
  assert.equal(
    classify([{ name: "fmt", state: "SUCCESS", conclusion: "NEUTRAL" }]),
    "1",
  );
});

test("release-checks-green: pending -> waiting (0)", () => {
  assert.equal(
    classify([{ name: "test", state: "PENDING", conclusion: "PENDING" }]),
    "0",
  );
});

test("release-checks-green: queued -> waiting (0)", () => {
  assert.equal(
    classify([{ name: "test", state: "QUEUED", conclusion: null }]),
    "0",
  );
});

test("release-checks-green: mixed pending+success -> waiting (0)", () => {
  assert.equal(
    classify([
      { name: "test", state: "SUCCESS", conclusion: "SUCCESS" },
      { name: "lint", state: "QUEUED", conclusion: null },
    ]),
    "0",
  );
});

test("release-checks-green: failure -> failed (-1)", () => {
  assert.equal(
    classify([{ name: "test", state: "FAILURE", conclusion: "FAILURE" }]),
    "-1",
  );
});

test("release-checks-green: cancelled -> failed (-1)", () => {
  assert.equal(
    classify([{ name: "test", state: "CANCELLED", conclusion: "CANCELLED" }]),
    "-1",
  );
});

test("release-checks-green: empty checks -> green (1)", () => {
  assert.equal(classify([]), "1");
});
