// Unit tests for auto_recover countRecoveryAttempts (#270).
// Verifies that recovery attempt counting is idempotent when a transient error
// causes the RECOVERY_MARKER comment to be posted more than once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { countRecoveryAttempts } from "../scripts/stages/auto_recover.ts";

test("countRecoveryAttempts: zero comments → 0", () => {
  assert.equal(countRecoveryAttempts([]), 0);
});

test("countRecoveryAttempts: one recovery comment → 1", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1);
});

test("countRecoveryAttempts: two distinct rounds → 2", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nRound 1." },
    { body: "## Pipeline: Auto-Recovery (2/2)\n\nRound 2." },
  ];
  assert.equal(countRecoveryAttempts(comments), 2);
});

test("countRecoveryAttempts: duplicate round token (retry) counts as one — regression for #270", () => {
  // If postComment sees a transient error after GitHub accepted the write,
  // a retry posts the same marker body again. The count must still be 1,
  // not 2, so the next run does not consume a budget slot that was never used.
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nImplementation failed..." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1, "duplicate round token deduped to 1 attempt");
});

test("countRecoveryAttempts: Limit comment is excluded from count", () => {
  // The Limit comment also contains the RECOVERY_MARKER substring; it must not
  // be counted as an additional recovery attempt.
  const comments = [
    { body: "## Pipeline: Auto-Recovery (1/2)\n\nRound 1." },
    { body: "## Pipeline: Auto-Recovery Limit\n\nNo more retries." },
  ];
  assert.equal(countRecoveryAttempts(comments), 1);
});

test("countRecoveryAttempts: only Limit comment → 0 recovery attempts", () => {
  const comments = [
    { body: "## Pipeline: Auto-Recovery Limit\n\nNo more retries." },
  ];
  assert.equal(countRecoveryAttempts(comments), 0);
});

test("countRecoveryAttempts: unrelated comments are ignored", () => {
  const comments = [
    { body: "## Review 2 — approve\n\nLooks good." },
    { body: "## Pipeline: Blocked at pre merge\n\nCI failed." },
  ];
  assert.equal(countRecoveryAttempts(comments), 0);
});
