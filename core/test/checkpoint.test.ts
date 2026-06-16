// Tests for checkpoint.ts — pure helpers + checkApprovalCheckpoint gate.
// No real GH/git calls; all I/O is injected via deps fakes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckpointComment,
  checkApprovalCheckpoint,
  extractCheckpointSha,
  extractCheckpointStage,
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
// extractCheckpointStage
// ---------------------------------------------------------------------------

test("extractCheckpointStage: returns null when no **Stage**: line", () => {
  assert.equal(extractCheckpointStage({ body: "no stage info here" }), null);
});

test("extractCheckpointStage: returns null for malformed line", () => {
  assert.equal(extractCheckpointStage({ body: "Stage: implementing" }), null); // not bold
});

test("extractCheckpointStage: extracts stage from a real checkpoint comment", () => {
  const body = buildCheckpointComment("implementing", "a".repeat(40));
  assert.equal(extractCheckpointStage({ body }), "implementing");
});

test("extractCheckpointStage: extracts stage pre-merge", () => {
  const body = buildCheckpointComment("pre-merge", "a".repeat(40));
  assert.equal(extractCheckpointStage({ body }), "pre-merge");
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
// Finding 3: stage-scoped approval — a checkpoint comment for stage A must NOT
// be treated as approval for a different stage B.
// ---------------------------------------------------------------------------

test("checkApprovalCheckpoint (c-scoped): comment for SAME stage → approved (null)", async () => {
  const { deps, posted, labeled } = makeDeps();
  const body = buildCheckpointComment("implementing", SHA);
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    /* no awaiting label */ [],
    1,
    SHA,
    [makeComment(body)],
    deps,
  );
  assert.equal(result, null, "same-stage comment should count as approval");
  assert.equal(posted.length, 0);
  assert.equal(labeled.length, 0);
});

test("checkApprovalCheckpoint (c-scoped): comment for DIFFERENT stage → fires new checkpoint (Finding 3)", async () => {
  const { deps, posted, labeled } = makeDeps();
  // Prior comment is for "implementing"; now checking "pre-merge"
  const implementingComment = buildCheckpointComment("implementing", SHA);
  const result = await checkApprovalCheckpoint(
    "pre-merge",
    { approvalCheckpoints: ["implementing", "pre-merge"] },
    /* no awaiting label */ [],
    7,
    SHA,
    [makeComment(implementingComment)],
    deps,
  );
  assert.ok(result !== null, "should fire checkpoint for pre-merge even though implementing comment exists");
  assert.equal((result as any).status, "waiting");
  // A new checkpoint comment for "pre-merge" should be posted
  assert.equal(posted.length, 1);
  assert.ok(posted[0].body.includes("pre-merge"));
  assert.equal(labeled.length, 1);
});

test("multi-checkpoint: implementing approved, pre-merge fires independently (Finding 3 regression)", async () => {
  // Step 1: implementing checkpoint fires when no comment exists
  const deps1 = makeDeps();
  await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing", "pre-merge"] },
    [],
    1, SHA, [], deps1.deps,
  );
  assert.equal(deps1.labeled.length, 1, "implementing: label applied");
  assert.equal(deps1.posted.length, 1, "implementing: comment posted");

  // Step 2: human removes awaiting label — re-invoke at implementing → should approve
  const implementingComment = makeComment(deps1.posted[0].body);
  const deps2 = makeDeps();
  const res2 = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing", "pre-merge"] },
    /* label removed */ [],
    1, SHA, [implementingComment], deps2.deps,
  );
  assert.equal(res2, null, "implementing: approved after label removal");

  // Step 3: now at pre-merge — old implementing comment should NOT count as approval
  const deps3 = makeDeps();
  const res3 = await checkApprovalCheckpoint(
    "pre-merge",
    { approvalCheckpoints: ["implementing", "pre-merge"] },
    /* no label */ [],
    1, SHA, [implementingComment], deps3.deps,
  );
  assert.ok(res3 !== null, "pre-merge: checkpoint should fire despite implementing comment");
  assert.equal((res3 as any).status, "waiting");
  assert.equal(deps3.posted.length, 1, "pre-merge: new comment posted");
  assert.ok(deps3.posted[0].body.includes("pre-merge"), "comment must name the pre-merge stage");
});

// ---------------------------------------------------------------------------
// Finding 4: apply label BEFORE posting comment so partial failure is fail-closed
// ---------------------------------------------------------------------------

test("checkApprovalCheckpoint (b): label applied BEFORE comment posted (Finding 4)", async () => {
  const order: string[] = [];
  const deps = {
    applyAwaitingApprovalLabel: async (n: number) => { order.push(`label:${n}`); },
    postCheckpointComment: async (n: number, _body: string) => { order.push(`comment:${n}`); },
  };
  await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [], 42, SHA, [], deps,
  );
  assert.deepEqual(order, ["label:42", "comment:42"], "label must be applied before comment is posted");
});

test("checkApprovalCheckpoint (b): label failure leaves no comment — safe on retry (Finding 4)", async () => {
  const posted: string[] = [];
  const deps = {
    applyAwaitingApprovalLabel: async (_n: number) => { throw new Error("label API failed"); },
    postCheckpointComment: async (_n: number, body: string) => { posted.push(body); },
  };
  await assert.rejects(
    () => checkApprovalCheckpoint("implementing", { approvalCheckpoints: ["implementing"] }, [], 1, SHA, [], deps),
    /label API failed/,
  );
  assert.equal(posted.length, 0, "comment must NOT be posted when label application throws");
});

// ---------------------------------------------------------------------------
// Dry-run pattern: deps that do nothing simulate --dry-run behaviour (Finding 2)
// ---------------------------------------------------------------------------

test("checkApprovalCheckpoint with no-op deps: returns waiting without side effects (dry-run pattern)", async () => {
  const mutations: string[] = [];
  const noOpDeps = {
    postCheckpointComment: async (_n: number, _body: string) => { mutations.push("post"); },
    applyAwaitingApprovalLabel: async (_n: number) => { mutations.push("label"); },
  };
  // Simulate dry-run by swapping in no-op deps that record calls but produce no real side-effects.
  // In the real pipeline, --dry-run replaces these with console.log-only stubs.
  const result = await checkApprovalCheckpoint(
    "implementing",
    { approvalCheckpoints: ["implementing"] },
    [], 1, SHA, [], noOpDeps,
  );
  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  // The no-op stubs were called (to verify the contract), but would produce no real GH writes
  assert.equal(mutations.length, 2);
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

// ---------------------------------------------------------------------------
// Finding 6: SHA comparison on cleared label — label absent but SHA changed
// ---------------------------------------------------------------------------

test("checkApprovalCheckpoint (c-sha-stale): label absent + same-stage comment + SHA changed → re-issues checkpoint (Finding 6)", async () => {
  const { deps, posted, labeled } = makeDeps();

  // Human approved at SHA, then someone pushed NEW_SHA before pipeline re-ran.
  const existingCheckpoint = makeComment(buildCheckpointComment("implementing", SHA));
  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    /* labels: no awaiting-approval */ [],
    42,
    NEW_SHA, // current head has advanced past the approved SHA
    [existingCheckpoint],
    deps,
  );

  assert.ok(result !== null, "should return waiting — cannot dispatch with stale approval");
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 1, "re-issue checkpoint comment for new SHA");
  assert.ok(posted[0].body.includes(NEW_SHA.slice(0, 7)), "new comment should contain new short SHA");
  assert.ok(posted[0].body.includes("re-issuing"), "notice text should mention re-issue");
  assert.equal(labeled.length, 1, "re-apply awaiting-approval label");
  assert.equal(labeled[0], 42);
});

test("checkApprovalCheckpoint (c-sha-unchanged): label absent + same-stage comment + SHA unchanged → dispatches normally (Finding 6 — no false positive)", async () => {
  const { deps, posted, labeled } = makeDeps();

  const existingCheckpoint = makeComment(buildCheckpointComment("implementing", SHA));
  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    [],
    42,
    SHA, // current head matches approved SHA
    [existingCheckpoint],
    deps,
  );

  assert.equal(result, null, "SHA unchanged → dispatch normally (approval is still valid)");
  assert.equal(posted.length, 0, "must not re-post when SHA matches");
  assert.equal(labeled.length, 0, "must not re-label when SHA matches");
});

test("checkApprovalCheckpoint (c-no-sha-sentinel): label absent + same-stage comment with no SHA sentinel → fires fresh checkpoint (Finding 2)", async () => {
  // A malformed or hand-crafted comment without a checkpoint-sha sentinel: storedSha = null.
  // Without a valid sentinel we cannot verify this is a pipeline-issued checkpoint, so
  // we reject it and fire a fresh pipeline checkpoint (#23, Finding 2).
  const { deps, posted, labeled } = makeDeps();
  const bodyWithNoSentinel = `${CHECKPOINT_COMMENT_HEADER}\n\n**Stage**: implementing\n\n### How to approve\n1. Remove label.`;
  const existingCheckpoint = makeComment(bodyWithNoSentinel);
  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    [],
    42,
    NEW_SHA,
    [existingCheckpoint],
    deps,
  );
  assert.ok(result !== null, "no sentinel → treat as malformed, fire fresh checkpoint");
  assert.equal((result as any).status, "waiting");
  assert.equal(posted.length, 1, "fresh checkpoint comment must be posted");
  assert.ok(posted[0].body.includes(`<!-- checkpoint-sha: ${NEW_SHA} -->`), "new comment must contain sentinel for current HEAD");
  assert.equal(labeled.length, 1, "awaiting-approval label must be re-applied");
});

// Regression for #23 Finding 1: implementing checkpoint posted with real worktree SHA
// completes in a single approval round-trip (no false re-issue on the cleared check).
test("(regression F1): implementing checkpoint with real worktree SHA — first approval completes in one round", async () => {
  // Before the fix, beforeImplementing stored NULL_SHA when no PR existed. On the next run,
  // the outer gate resolved the real worktree SHA and re-issued (NULL_SHA ≠ realSha).
  // After the fix, beforeImplementing resolves the real worktree SHA so the round-trip
  // succeeds without a double-approval.
  const WORKTREE_SHA = "cafe" + "0".repeat(36);

  // Step 1: implementing checkpoint fires with real worktree SHA (not NULL_SHA)
  const deps1 = makeDeps();
  const res1 = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    [],
    42,
    WORKTREE_SHA,
    [],
    deps1.deps,
  );
  assert.ok(res1 !== null, "step 1: checkpoint fires");
  assert.ok(deps1.posted[0].body.includes(`<!-- checkpoint-sha: ${WORKTREE_SHA} -->`), "step 1: real SHA in sentinel");

  // Step 2: human removes label, pipeline re-runs with same worktree SHA → dispatch immediately
  const checkpoint = makeComment(deps1.posted[0].body);
  const deps2 = makeDeps();
  const res2 = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    /* label removed */ [],
    42,
    WORKTREE_SHA,
    [checkpoint],
    deps2.deps,
  );
  assert.equal(res2, null, "step 2: dispatch normally after single approval — no false re-issue");
  assert.equal(deps2.posted.length, 0, "no re-issue when SHA matches");
  assert.equal(deps2.labeled.length, 0, "no re-label when approved");
});

// ---------------------------------------------------------------------------
// Finding 4: real worktree SHA (non-NULL) appears in checkpoint comment
// ---------------------------------------------------------------------------

test("checkApprovalCheckpoint (b): real worktree SHA appears as short SHA in comment — not '(no branch yet)' (Finding 4)", async () => {
  // Simulates the case where pipeline.ts resolves the worktree HEAD and passes
  // a real 40-char SHA instead of NULL_SHA when no PR exists yet.
  const WORKTREE_SHA = "cafe" + "0".repeat(36);
  const { deps, posted } = makeDeps();

  const result = await checkApprovalCheckpoint(
    "implementing" as any,
    { approvalCheckpoints: ["implementing"] },
    /* labels: none */ [],
    42,
    WORKTREE_SHA,
    /* comments: none */ [],
    deps,
  );

  assert.ok(result !== null);
  assert.equal((result as any).status, "waiting");
  assert.ok(posted[0].body.includes(WORKTREE_SHA.slice(0, 7)), "short SHA must appear in comment");
  assert.ok(!posted[0].body.includes("(no branch yet)"), "null-SHA placeholder must NOT appear when real SHA provided");
});
