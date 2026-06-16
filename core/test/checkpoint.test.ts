// Tests for checkpoint.ts — pure helpers + checkApprovalCheckpoint gate.
// No real GH/git calls; all I/O is injected via deps fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckpointComment,
  checkApprovalCheckpoint,
  extractCheckpointSha,
  findCheckpointComment,
  NULL_SHA,
  CHECKPOINT_COMMENT_HEADER,
} from "../scripts/stages/checkpoint.ts";
import { AWAITING_APPROVAL_LABEL } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// findCheckpointComment
// ---------------------------------------------------------------------------

test("findCheckpointComment: returns null when no comments", () => {
  assert.equal(findCheckpointComment([]), null);
});

test("findCheckpointComment: returns null when no checkpoint comment present", () => {
  const comments = [
    { author: "bot", body: "## Review 1\nsome review", createdAt: "2024-01-01T00:00:00Z" },
    { author: "human", body: "LGTM", createdAt: "2024-01-02T00:00:00Z" },
  ];
  assert.equal(findCheckpointComment(comments), null);
});

test("findCheckpointComment: returns the checkpoint comment when present", () => {
  const checkpoint = { author: "bot", body: `${CHECKPOINT_COMMENT_HEADER}\nfoo`, createdAt: "2024-01-02T00:00:00Z" };
  const comments = [
    { author: "bot", body: "## Review 1", createdAt: "2024-01-01T00:00:00Z" },
    checkpoint,
  ];
  assert.equal(findCheckpointComment(comments), checkpoint);
});

test("findCheckpointComment: returns the LATEST checkpoint comment when multiple present", () => {
  const older = { author: "bot", body: `${CHECKPOINT_COMMENT_HEADER}\nold`, createdAt: "2024-01-01T00:00:00Z" };
  const newer = { author: "bot", body: `${CHECKPOINT_COMMENT_HEADER}\nnew`, createdAt: "2024-01-02T00:00:00Z" };
  const comments = [older, { author: "human", body: "ok", createdAt: "2024-01-01T12:00:00Z" }, newer];
  assert.equal(findCheckpointComment(comments), newer);
});

// ---------------------------------------------------------------------------
// extractCheckpointSha
// ---------------------------------------------------------------------------

test("extractCheckpointSha: returns null when no sentinel", () => {
  assert.equal(extractCheckpointSha({ body: "no sentinel here" }), null);
});

test("extractCheckpointSha: returns null for partial/malformed sentinel", () => {
  assert.equal(extractCheckpointSha({ body: "<!-- checkpoint-sha: not-hex -->" }), null);
  assert.equal(extractCheckpointSha({ body: "<!-- checkpoint-sha: abc123 -->" }), null); // < 40 chars
});

test("extractCheckpointSha: parses a valid 40-char hex SHA", () => {
  const sha = "a".repeat(40);
  const body = `some text\n<!-- checkpoint-sha: ${sha} -->\nmore text`;
  assert.equal(extractCheckpointSha({ body }), sha);
});

test("extractCheckpointSha: extracts SHA from realistic checkpoint comment", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const body = buildCheckpointComment("implementing", sha);
  assert.equal(extractCheckpointSha({ body }), sha);
});

// ---------------------------------------------------------------------------
// buildCheckpointComment
// ---------------------------------------------------------------------------

test("buildCheckpointComment: starts with the correct header", () => {
  const body = buildCheckpointComment("implementing", "a".repeat(40));
  assert.ok(body.startsWith(CHECKPOINT_COMMENT_HEADER));
});

test("buildCheckpointComment: contains the stage name", () => {
  const body = buildCheckpointComment("pre-merge", "a".repeat(40));
  assert.ok(body.includes("pre-merge"));
});

test("buildCheckpointComment: contains the short SHA (first 7 chars)", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const body = buildCheckpointComment("implementing", sha);
  assert.ok(body.includes(sha.slice(0, 7)));
});

test("buildCheckpointComment: contains the full SHA in the sentinel", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const body = buildCheckpointComment("implementing", sha);
  assert.ok(body.includes(`<!-- checkpoint-sha: ${sha} -->`));
});

test("buildCheckpointComment: contains How to approve section", () => {
  const body = buildCheckpointComment("implementing", "a".repeat(40));
  assert.ok(body.includes("### How to approve"));
  assert.ok(body.includes("pipeline:awaiting-approval"));
});

test("buildCheckpointComment: includes notice when provided", () => {
  const body = buildCheckpointComment("implementing", "a".repeat(40), "Branch advanced.");
  assert.ok(body.includes("Branch advanced."));
});

test("buildCheckpointComment: NULL_SHA renders as (no branch yet)", () => {
  const body = buildCheckpointComment("implementing", NULL_SHA);
  assert.ok(body.includes("(no branch yet)"));
  // Sentinel still contains the 40-char null SHA so it can be compared
  assert.ok(body.includes(`<!-- checkpoint-sha: ${NULL_SHA} -->`));
});

// ---------------------------------------------------------------------------
// checkApprovalCheckpoint — all branches
// ---------------------------------------------------------------------------

type Comment = { author: string; body: string; createdAt: string };

function makeComment(body: string): Comment {
  return { author: "bot", body, createdAt: "2024-01-01T00:00:00Z" };
}

function makeDeps() {
  const posted: { issueNumber: number; body: string }[] = [];
  const labeled: number[] = [];
  return {
    deps: {
      postCheckpointComment: async (n: number, body: string) => { posted.push({ issueNumber: n, body }); },
      applyAwaitingApprovalLabel: async (n: number) => { labeled.push(n); },
    },
    posted,
    labeled,
  };
}

const SHA = "1234567890abcdef1234567890abcdef12345678";
const NEW_SHA = "abcdef1234567890abcdef1234567890abcdef12";

// (a) Stage not in approvalCheckpoints → null
test("checkApprovalCheckpoint (a): stage not in checkpoints → returns null", async () => {
  const { deps } = makeDeps();
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["pre-merge"] },
    [],
    1,
    SHA,
    [],
    deps,
  );
  assert.equal(result, null);
});

// (a) Empty checkpoints list → null
test("checkApprovalCheckpoint (a): empty approvalCheckpoints → returns null", async () => {
  const { deps } = makeDeps();
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: [] },
    [],
    1,
    SHA,
    [],
    deps,
  );
  assert.equal(result, null);
});

// (b) Label absent + no prior checkpoint comment → fire
test("checkApprovalCheckpoint (b): first encounter — posts comment and applies label", async () => {
  const { deps, posted, labeled } = makeDeps();
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    /* labels */ [],
    /* issueNumber */ 42,
    SHA,
    /* comments */ [],
    deps,
  );
  assert.ok(result !== null);
  assert.equal(result!.advanced, false);
  assert.equal((result as any).status, "waiting");
  assert.ok((result as any).reason.includes("implementing"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].issueNumber, 42);
  assert.ok(posted[0].body.startsWith(CHECKPOINT_COMMENT_HEADER));
  assert.equal(labeled.length, 1);
  assert.equal(labeled[0], 42);
});

// (c) Label absent + checkpoint comment exists → approved, return null
test("checkApprovalCheckpoint (c): label absent after human approval → returns null (dispatch normally)", async () => {
  const { deps, posted, labeled } = makeDeps();
  const checkpointBody = buildCheckpointComment("implementing", SHA);
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    /* labels: no awaiting-approval */ [],
    1,
    SHA,
    [makeComment(checkpointBody)],
    deps,
  );
  assert.equal(result, null);
  assert.equal(posted.length, 0);
  assert.equal(labeled.length, 0);
});

// (d) Label present + SHA matches → waiting, no new comment
test("checkApprovalCheckpoint (d): label present, SHA unchanged → waiting, no re-post", async () => {
  const { deps, posted, labeled } = makeDeps();
  const checkpointBody = buildCheckpointComment("implementing", SHA);
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [AWAITING_APPROVAL_LABEL],
    1,
    SHA,
    [makeComment(checkpointBody)],
    deps,
  );
  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 0);
  assert.equal(labeled.length, 0);
});

// (e) Label present + SHA stale → re-issue comment with notice
test("checkApprovalCheckpoint (e): label present, SHA changed → re-issues comment with notice", async () => {
  const { deps, posted } = makeDeps();
  const oldCheckpointBody = buildCheckpointComment("implementing", SHA);
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [AWAITING_APPROVAL_LABEL],
    1,
    NEW_SHA,
    [makeComment(oldCheckpointBody)],
    deps,
  );
  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.includes("Branch advanced"));
  assert.ok(posted[0].body.includes(`<!-- checkpoint-sha: ${NEW_SHA} -->`));
});

// (e) Label present + no checkpoint comment → re-issue
test("checkApprovalCheckpoint (e): label present, no comment found → re-issues comment", async () => {
  const { deps, posted } = makeDeps();
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [AWAITING_APPROVAL_LABEL],
    5,
    SHA,
    /* comments: no checkpoint comment */ [],
    deps,
  );
  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.startsWith(CHECKPOINT_COMMENT_HEADER));
});

// NULL_SHA round-trip: NULL_SHA stored == NULL_SHA current → still waiting (no re-post)
test("checkApprovalCheckpoint: NULL_SHA stored == NULL_SHA current → no re-post (no branch yet)", async () => {
  const { deps, posted } = makeDeps();
  const checkpointBody = buildCheckpointComment("implementing", NULL_SHA);
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [AWAITING_APPROVAL_LABEL],
    1,
    NULL_SHA,
    [makeComment(checkpointBody)],
    deps,
  );
  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 0, "should not re-post when SHA unchanged (both NULL_SHA)");
});

// ---------------------------------------------------------------------------
// Integration-level: full advance-loop tick simulation (tasks 5.1 and 5.2)
// ---------------------------------------------------------------------------
// These tests simulate the checkApprovalCheckpoint call in the pipeline's advance
// loop. They use only the pure function — no real pipeline.ts dispatch.

test("integration: loop stops at implementing with approvalCheckpoints=['implementing']", async () => {
  const { deps, posted, labeled } = makeDeps();
  const cfg = { approvalCheckpoints: ["implementing"] };

  // No label, no prior comment → fires checkpoint
  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    cfg,
    /* labels */ [],
    99,
    SHA,
    /* comments */ [],
    deps,
  );
  assert.ok(result !== null, "should return waiting outcome");
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 1, "checkpoint comment should be posted");
  assert.ok(posted[0].body.startsWith(CHECKPOINT_COMMENT_HEADER));
  assert.equal(labeled.length, 1, "awaiting-approval label should be applied");
});

test("integration: re-invoke with label absent dispatches implementing normally", async () => {
  const { deps, posted, labeled } = makeDeps();
  const cfg = { approvalCheckpoints: ["implementing"] };

  // Prior checkpoint comment exists but label was removed (human approved)
  const existingCheckpoint = makeComment(buildCheckpointComment("implementing", SHA));
  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    cfg,
    /* labels: no awaiting-approval */ [],
    99,
    SHA,
    [existingCheckpoint],
    deps,
  );
  assert.equal(result, null, "should return null so dispatch proceeds normally");
  assert.equal(posted.length, 0);
  assert.equal(labeled.length, 0);
});
