// Regression: ship playbook train completion gate must evaluate the last
// train_status even when human-readable prose precedes the JSON object.
// Whole-stream json.load on mixed captures false-fails a complete train.

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
  "examples/supervisor/shell/train-status-complete.py",
);
const playbook = path.join(
  repoRoot,
  "examples/supervisor/shell/pipeline-ship-playbook.sh",
);

const completeStatus = {
  schema_version: 1,
  kind: "train_status",
  complete: true,
  blocker: null,
  ordered_issues: [1, 2],
  current_issue: null,
  next_action: "complete",
};

const incompleteStatus = {
  ...completeStatus,
  complete: false,
  current_issue: 2,
  next_action: "advance",
};

const blockedStatus = {
  ...completeStatus,
  complete: false,
  blocker: "issue 2 stuck in review",
};

function writeCapture(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

function runHelper(capturePath: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("python3", [helper, capturePath], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

/** Old broken gate: whole-stream json.load only (must fail on mixed prose+JSON). */
function wholeStreamJsonLoadOk(capturePath: string): string {
  const r = spawnSync(
    "python3",
    [
      "-c",
      `import json,sys
p=sys.argv[1]
try:
  d=json.load(open(p))
except Exception:
  print("0"); raise SystemExit
if isinstance(d, list):
  d=d[-1]
complete=d.get("complete")
blocker=d.get("blocker")
print("1" if complete and not blocker else "0")
`,
      capturePath,
    ],
    { encoding: "utf8" },
  );
  return (r.stdout ?? "").trim();
}

test("helper exists and playbook launches repo tugboat (train gate lives there)", () => {
  assert.ok(fs.existsSync(helper), "missing train-status-complete.py");
  assert.ok(fs.existsSync(playbook), "missing pipeline-ship-playbook.sh");
  const body = fs.readFileSync(playbook, "utf8");
  assert.match(body, /exec "\$REPO_DIR\/examples\/supervisor\/shell\/tugboat\.sh" "\$@"/);
  const tug = fs.readFileSync(
    path.join(repoRoot, "examples/supervisor/shell/tugboat.sh"),
    "utf8",
  );
  assert.match(tug, /TRAIN_STATUS_COMPLETE_BIN/);
  assert.match(tug, /train-status-complete\.py/);
  assert.doesNotMatch(
    tug,
    /json\.load\(open\(p\)\).*complete|d=json\.load\(open\(p\)\)[\s\S]{0,120}complete=d\.get/,
  );
});

test("mixed prose + trailing complete train_status → success", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    [
      "Training milestone v1.35.0…",
      "issue 1 ready-to-deploy",
      "issue 2 merged",
      JSON.stringify(completeStatus, null, 2),
      "",
    ].join("\n"),
  );

  // Prove the old whole-stream approach false-fails (regression bite).
  assert.equal(
    wholeStreamJsonLoadOk(capture),
    "0",
    "whole-stream json.load must fail on prose+JSON (proves the bug)",
  );

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1");
  assert.ok(!fs.existsSync(capture + ".blocker"));
});

test("pure JSON complete train_status → success (no regression)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    JSON.stringify(completeStatus, null, 2) + "\n",
  );

  assert.equal(wholeStreamJsonLoadOk(capture), "1");
  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1");
});

test("incomplete last train_status → fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    "progress note\n" + JSON.stringify(incompleteStatus) + "\n",
  );

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0");
});

test("blocker on last train_status → fail closed and side file written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    "still shipping\n" + JSON.stringify(blockedStatus) + "\n",
  );

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0");
  const blockerPath = capture + ".blocker";
  assert.ok(fs.existsSync(blockerPath), "expected train.json.blocker");
  assert.equal(
    fs.readFileSync(blockerPath, "utf8"),
    "issue 2 stuck in review",
  );
});

test("last train_status wins over earlier incomplete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    [
      "mid-train",
      JSON.stringify(incompleteStatus),
      "done",
      JSON.stringify(completeStatus),
      "",
    ].join("\n"),
  );

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1");
});

test("array of statuses: last train_status in array wins", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(
    dir,
    "train.json",
    JSON.stringify([incompleteStatus, completeStatus]) + "\n",
  );

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "1");
});

test("train_plan JSON is not a completed train_status (#1275)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const plan = {
    schema_version: 1,
    kind: "train_plan",
    merge_mode: true,
    ordered_issues: [10, 11],
    merge_first: [10],
    items: [
      { issue: 10, stage: "ready-to-deploy", pr: 20, intended_action: "would-merge" },
    ],
  };
  const capture = writeCapture(dir, "train.json", JSON.stringify(plan, null, 2) + "\n");
  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0");
});

test("no train_status → incomplete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-train-status-"));
  const capture = writeCapture(dir, "train.json", "only prose, no status\n");

  const r = runHelper(capture);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "0");
});
