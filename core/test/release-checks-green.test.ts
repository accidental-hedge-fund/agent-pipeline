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
const playbook = path.join(
  repoRoot,
  "examples/supervisor/shell/pipeline-ship-playbook.sh",
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
      { name: "test", state: "SUCCESS", bucket: "pass" },
      { name: "lint", state: "SUCCESS", bucket: "pass" },
    ]),
    "1",
  );
});

// gh pr checks --json name,state,bucket is the real schema. `conclusion` is
// NOT an accepted JSON field (gh rejects it with exit 1: "Unknown JSON
// field"), which broke the playbook's CI-wait loop in the field. These assert
// gh's actual return shape.
test("release-checks-green: gh's real bucket schema -> green (1)", () => {
  assert.equal(
    classify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
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

// Regression: the playbook's CI-wait loop must call gh with a VALID --json
// field list. `gh pr checks --json name,state,conclusion` fails with exit 1
// ("Unknown JSON field: conclusion") — conclusion is not an accepted field —
// which made every poll error and the wait loop exhaust its budget without
// ever seeing green. gh's real schema uses `bucket`, not `conclusion`.
test("playbook CI-wait uses valid gh pr checks fields", () => {
  const body = fs.readFileSync(playbook, "utf8");
  const m = body.match(/gh pr checks "\$pr" --json ([a-z,]+)/);
  assert.ok(m, "CI-wait gh pr checks line not found");
  assert.doesNotMatch(m[1], /conclusion/, "conclusion is not a valid gh field");
  assert.match(m[1], /\bbucket\b/, "gh pr checks --json should use bucket");
});
