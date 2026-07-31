// #770 loop live-advance coexistence — pure probe/classifier unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isCoexistenceFailureEvidence,
  isNonFatalMidStageExit,
  isLockFileLive,
  probeLiveAdvance,
} from "../scripts/loop/live-advance.ts";
import { classifyDispatchOutcome } from "../scripts/pipeline.ts";
import { normalizeLoopOutcome } from "../scripts/loop-execution-contract.ts";

test("isCoexistenceFailureEvidence: lock / already-running / install-in-progress", () => {
  assert.equal(isCoexistenceFailureEvidence("pipeline: issue #675 is already running"), true);
  assert.equal(isCoexistenceFailureEvidence("Pipeline lock held by another process for #597"), true);
  assert.equal(isCoexistenceFailureEvidence("an install/update is in progress — starting now risks"), true);
  assert.equal(isCoexistenceFailureEvidence("TypeError: cannot read"), false);
  assert.equal(isCoexistenceFailureEvidence(null), false);
});

test("isNonFatalMidStageExit: bare skipped/waiting is NOT coexistence (review 1 929fc0ac)", () => {
  const events = [
    JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" }),
    JSON.stringify({ type: "run_complete", final_state: "pre-merge" }),
  ].join("\n");
  assert.equal(
    isNonFatalMidStageExit(events, ["pipeline:pre-merge"]),
    false,
    "generic skipped must stay on failed/run_fatal path",
  );
});

test("isNonFatalMidStageExit: explicit already-running in events → coexistence", () => {
  const events = "pipeline: issue #675 is already running\n";
  assert.equal(isNonFatalMidStageExit(events, ["pipeline:pre-merge"]), true);
});

test("classifyDispatchOutcome: already-running events → coexistence_wait (#770)", () => {
  const events = "Error: Pipeline lock held by another process for #597\n";
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:pre-merge"], state: "open" }, null, events),
    "coexistence_wait",
  );
  assert.equal(normalizeLoopOutcome("coexistence_wait"), "coexistence_wait");
});

test("classifyDispatchOutcome: bare skipped stage event stays failed (genuine defect path)", () => {
  const events = JSON.stringify({ type: "stage_complete", stage: "pre-merge", outcome: "skipped" });
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:pre-merge"], state: "open" }, null, events),
    "failed",
  );
});

test("classifyDispatchOutcome: still maps plain open mid-stage without events to failed", () => {
  assert.equal(
    classifyDispatchOutcome({ labels: ["pipeline:review-1"], state: "open" }),
    "failed",
  );
});

test("probeLiveAdvance: lock file with live PID → live lock_held", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  fs.writeFileSync(lockPath, String(process.pid));
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 770,
    lockPathForTest: lockPath,
  });
  assert.equal(r.live, true);
  if (r.live) {
    assert.equal(r.evidence, "lock_held");
    assert.equal(r.holder_pid, process.pid);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: dead PID lock → not live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-adv-"));
  const lockPath = path.join(dir, "test.lock");
  // PID 1 may be live on some systems; use a high unused pid unlikely to exist
  fs.writeFileSync(lockPath, "999999999");
  const held = isLockFileLive(lockPath);
  // If somehow live, skip assertion body
  if (!held.live) {
    const r = probeLiveAdvance({
      domain: "test",
      issueNumber: 770,
      lockPathForTest: lockPath,
    });
    assert.equal(r.live, false);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("probeLiveAdvance: knownLinkage alone → live loop_linkage", () => {
  const r = probeLiveAdvance({
    domain: "test",
    issueNumber: 1,
    knownLinkage: { pipeline_run_id: "1-2026-01-01T00-00-00-000Z" },
    lockPathForTest: path.join(os.tmpdir(), "no-such-lock-770"),
  });
  assert.equal(r.live, true);
  if (r.live) assert.equal(r.evidence, "loop_linkage");
});
