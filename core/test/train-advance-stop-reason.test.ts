// Unit tests for pure train advance STOP reason composition (#1074).
// No network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeTrainAdvanceStopReason,
  extractTrainAdvanceLoopEvidence,
  hasStructuredTrainAdvanceEvidence,
  parseIssueIdFromItemId,
  scopeTrainAdvanceEvidenceForIssue,
  type TrainAdvanceLoopEvidence,
} from "../scripts/stages/train-advance-stop-reason.ts";

test("compose: supervisor_no_progress + issue is not exit-only", () => {
  const evidence: TrainAdvanceLoopEvidence = {
    stopReason: "supervisor_no_progress",
    exitCode: 1,
  };
  const msg = composeTrainAdvanceStopReason(evidence, 1010);
  assert.match(msg, /supervisor_no_progress/);
  assert.match(msg, /#1010|1010/);
  assert.doesNotMatch(msg, /^advance failed for #1010: pipeline advance exited with code 1$/);
  assert.ok(!/^pipeline advance exited with code 1$/.test(msg));
});

test("compose: recovery_exhausted class + issue", () => {
  const evidence: TrainAdvanceLoopEvidence = {
    blockedClass: "recovery_exhausted",
    blockedIssue: 839,
    exitCode: 1,
  };
  const msg = composeTrainAdvanceStopReason(evidence, 839);
  assert.match(msg, /recovery_exhausted/);
  assert.match(msg, /#839/);
});

test("compose: empty evidence → exit code only, no invented class", () => {
  const msg = composeTrainAdvanceStopReason({ exitCode: 1 }, 42);
  assert.match(msg, /exited with code 1/);
  assert.doesNotMatch(msg, /supervisor_no_progress|dependency_deadlock|recovery_exhausted/);
});

test("compose: engine message when no events", () => {
  const msg = composeTrainAdvanceStopReason(
    { engineMessage: "lock is held by codex pid 1" },
    7,
  );
  assert.match(msg, /lock is held/);
  assert.match(msg, /#7/);
  assert.doesNotMatch(msg, /supervisor_no_progress/);
});

test("compose: priority stop reason over blocked class (both present)", () => {
  const msg = composeTrainAdvanceStopReason(
    {
      stopReason: "dependency_deadlock",
      blockedClass: "recovery_exhausted",
      blockedIssue: 10,
    },
    10,
  );
  assert.match(msg, /dependency_deadlock/);
  assert.match(msg, /recovery_exhausted/);
  const stopIdx = msg.indexOf("dependency_deadlock");
  const classIdx = msg.indexOf("recovery_exhausted");
  assert.ok(stopIdx >= 0 && classIdx > stopIdx, "stop reason before blocked class");
});

test("extract: last loop_run_stopped.reason wins", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      { kind: "loop_run_stopped", data: { reason: "dependency_deadlock" } },
      { kind: "loop_run_stopped", data: { reason: "supervisor_no_progress" } },
    ],
    exitCode: 1,
  });
  assert.equal(evidence.stopReason, "supervisor_no_progress");
  assert.equal(evidence.exitCode, 1);
});

test("extract: last loop_item_blocked class + issue", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "12", class: "workflow-engine-defect" },
      },
      {
        kind: "loop_item_blocked",
        data: { item_id: "#99", class: "recovery_exhausted" },
      },
    ],
  });
  assert.equal(evidence.blockedClass, "recovery_exhausted");
  assert.equal(evidence.blockedIssue, 99);
});

test("extract: drive stopReason without events", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    stopReason: "supervisor_no_progress",
    exitCode: 0,
  });
  assert.equal(evidence.stopReason, "supervisor_no_progress");
  assert.ok(hasStructuredTrainAdvanceEvidence(evidence));
});

test("extract: empty events does not invent class", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [],
    exitCode: 2,
    engineMessage: "boom",
  });
  assert.equal(evidence.stopReason, undefined);
  assert.equal(evidence.blockedClass, undefined);
  assert.equal(evidence.exitCode, 2);
  assert.equal(evidence.engineMessage, "boom");
  assert.equal(hasStructuredTrainAdvanceEvidence(evidence), false);
});

test("scope: drops other issue blocked class, keeps stop reason", () => {
  const wave: TrainAdvanceLoopEvidence = {
    stopReason: "supervisor_no_progress",
    blockedClass: "recovery_exhausted",
    blockedIssue: 5,
    exitCode: 1,
  };
  const for5 = scopeTrainAdvanceEvidenceForIssue(wave, 5);
  assert.equal(for5.blockedClass, "recovery_exhausted");
  const for9 = scopeTrainAdvanceEvidenceForIssue(wave, 9);
  assert.equal(for9.stopReason, "supervisor_no_progress");
  assert.equal(for9.blockedClass, undefined);
  assert.equal(for9.blockedIssue, undefined);
});

test("parseIssueIdFromItemId", () => {
  assert.equal(parseIssueIdFromItemId("42"), 42);
  assert.equal(parseIssueIdFromItemId("#42"), 42);
  assert.equal(parseIssueIdFromItemId(7), 7);
  assert.equal(parseIssueIdFromItemId("x"), undefined);
});

// ---------------------------------------------------------------------------
// #1095 — last terminal wins: recovered loop_item_blocked is not current
// ---------------------------------------------------------------------------

test("extract (#1095): loop_item_blocked then ready_to_deploy does not leave class current", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "1037", class: "implementation-ci" },
      },
      {
        kind: "loop_item_advance_finished",
        data: { item_id: "1037", outcome: "ready_to_deploy" },
      },
      { kind: "loop_run_complete", data: { outcome: "all_done" } },
    ],
  });
  assert.equal(evidence.blockedClass, undefined);
  assert.equal(evidence.blockedIssue, undefined);
  assert.equal(evidence.stopReason, undefined);
});

test("extract (#1095): loop_item_blocked then ledger ready transition clears that item", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "12", class: "implementation-ci" },
      },
      {
        kind: "loop_item_transitioned",
        data: { item_id: "12", from: "in_progress", to: "ready" },
      },
    ],
  });
  assert.equal(evidence.blockedClass, undefined);
  assert.equal(evidence.blockedIssue, undefined);
});

test("extract (#1095): later loop_run_stopped stays current stop evidence", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "88", class: "implementation-ci" },
      },
      {
        kind: "loop_item_advance_finished",
        data: { item_id: "88", outcome: "ready_to_deploy" },
      },
      { kind: "loop_run_complete", data: { outcome: "all_done" } },
      { kind: "loop_run_stopped", data: { reason: "supervisor_no_progress" } },
    ],
  });
  assert.equal(evidence.stopReason, "supervisor_no_progress");
  assert.equal(evidence.blockedClass, undefined);
});

test("extract (#1095): sibling still blocked keeps its class after peer ready", () => {
  const evidence = extractTrainAdvanceLoopEvidence({
    events: [
      {
        kind: "loop_item_blocked",
        data: { item_id: "1", class: "implementation-ci" },
      },
      {
        kind: "loop_item_blocked",
        data: { item_id: "2", class: "review-findings" },
      },
      {
        kind: "loop_item_advance_finished",
        data: { item_id: "1", outcome: "ready_to_deploy" },
      },
    ],
  });
  assert.equal(evidence.blockedClass, "review-findings");
  assert.equal(evidence.blockedIssue, 2);
  const for1 = scopeTrainAdvanceEvidenceForIssue(evidence, 1);
  assert.equal(for1.blockedClass, undefined);
  const for2 = scopeTrainAdvanceEvidenceForIssue(evidence, 2);
  assert.equal(for2.blockedClass, "review-findings");
  assert.equal(for2.blockedIssue, 2);
});
