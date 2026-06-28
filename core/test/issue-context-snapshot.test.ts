// Unit tests for issue-context-snapshot.ts (#318).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildContextSnapshot,
  renderContextSnapshotBlock,
  detectConflicts,
  renderConflictWarningBlock,
  findUnacknowledgedComments,
  CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT,
} from "../scripts/issue-context-snapshot.ts";
import { classifyComment } from "../scripts/gh.ts";

// ---------------------------------------------------------------------------
// classifyComment
// ---------------------------------------------------------------------------

test("classifyComment: empty body → pipeline", () => {
  assert.equal(classifyComment(""), "pipeline");
  assert.equal(classifyComment("   "), "pipeline");
});

test("classifyComment: pipeline header → pipeline", () => {
  assert.equal(classifyComment("## Implementation Plan\n\nsome plan"), "pipeline");
  assert.equal(classifyComment("## Plan Review\n\nfeedback"), "pipeline");
  assert.equal(classifyComment("## Pipeline: blocked\n\nreason"), "pipeline");
  assert.equal(classifyComment("## Pre-Planning Context\n\nsnap"), "pipeline");
  assert.equal(classifyComment("  ## Review 1\n\nfindings"), "pipeline");
});

test("classifyComment: human comment → human", () => {
  assert.equal(classifyComment("Can we also handle the edge case?"), "human");
  assert.equal(classifyComment("LGTM, ship it"), "human");
  assert.equal(classifyComment("## Some Unrelated Header\n\nhuman content"), "human");
});

// ---------------------------------------------------------------------------
// buildContextSnapshot
// ---------------------------------------------------------------------------

function makeComment(author: string, body: string, createdAt = "2026-01-01T00:00:00Z") {
  return { author, body, createdAt };
}

const PIPELINE_COMMENT = makeComment("bot", "## Implementation Plan\n\nthe plan");
const HUMAN_COMMENT_A = makeComment("alice", "Please also handle timeouts.");
const HUMAN_COMMENT_B = makeComment("bob", "Agreed with alice on timeouts.");

test("buildContextSnapshot: empty comments → empty snapshot", () => {
  const snap = buildContextSnapshot([]);
  assert.equal(snap.entries.length, 0);
  assert.equal(snap.truncated, false);
  assert.equal(snap.totalChars, 0);
});

test("buildContextSnapshot: only pipeline comments → empty snapshot", () => {
  const snap = buildContextSnapshot([PIPELINE_COMMENT]);
  assert.equal(snap.entries.length, 0);
});

test("buildContextSnapshot: human comments are included", () => {
  const snap = buildContextSnapshot([PIPELINE_COMMENT, HUMAN_COMMENT_A, HUMAN_COMMENT_B]);
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.entries[0].author, "alice");
  assert.equal(snap.entries[1].author, "bob");
  assert.equal(snap.truncated, false);
});

test("buildContextSnapshot: character cap drops oldest entries first", () => {
  const a = makeComment("alice", "A".repeat(200));
  const b = makeComment("bob", "B".repeat(200));
  const c = makeComment("carol", "C".repeat(200));
  // Total = 600 chars; cap = 350 → should drop alice (oldest) first
  const snap = buildContextSnapshot([a, b, c], 350);
  assert.equal(snap.truncated, true);
  // Alice's 200 chars dropped; bob + carol = 400 > 350 → alice AND bob dropped
  // Result: only carol remains (200 ≤ 350)
  assert.equal(snap.entries.length, 1);
  assert.equal(snap.entries[0].author, "carol");
});

test("buildContextSnapshot: exactly at cap → no truncation", () => {
  const a = makeComment("alice", "A".repeat(100));
  const snap = buildContextSnapshot([a], 100);
  assert.equal(snap.truncated, false);
  assert.equal(snap.entries.length, 1);
});

test("buildContextSnapshot: default cap is 8000", () => {
  assert.equal(CONTEXT_SNAPSHOT_MAX_CHARS_DEFAULT, 8_000);
});

// ---------------------------------------------------------------------------
// renderContextSnapshotBlock
// ---------------------------------------------------------------------------

test("renderContextSnapshotBlock: empty snapshot → empty string", () => {
  const snap = buildContextSnapshot([]);
  assert.equal(renderContextSnapshotBlock(snap), "");
});

test("renderContextSnapshotBlock: includes untrusted fence and author labels", () => {
  const snap = buildContextSnapshot([HUMAN_COMMENT_A, HUMAN_COMMENT_B]);
  const rendered = renderContextSnapshotBlock(snap);
  assert.match(rendered, /HUMAN COMMENTS/);
  assert.match(rendered, /untrusted-human-comments/);
  assert.match(rendered, /@alice/);
  assert.match(rendered, /@bob/);
  assert.match(rendered, /Please also handle timeouts/);
});

test("renderContextSnapshotBlock: truncated snapshot mentions cap", () => {
  const a = makeComment("alice", "A".repeat(200));
  const b = makeComment("bob", "B".repeat(200));
  // cap=250: total=400>250, drop alice (oldest, 200 chars), total=200≤250 → bob survives, truncated=true
  const snap = buildContextSnapshot([a, b], 250);
  assert.equal(snap.truncated, true, "precondition: snapshot must be truncated");
  assert.ok(snap.entries.length > 0, "precondition: at least one entry must survive");
  const rendered = renderContextSnapshotBlock(snap);
  assert.match(rendered, /cap/);
});

test("renderContextSnapshotBlock: opening and closing fence are balanced", () => {
  const snap = buildContextSnapshot([HUMAN_COMMENT_A]);
  const rendered = renderContextSnapshotBlock(snap);
  assert.ok(rendered.includes("<untrusted-human-comments>"), "opening tag missing");
  assert.ok(rendered.includes("</untrusted-human-comments>"), "closing tag missing");
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

test("detectConflicts: no negation → no warnings", () => {
  const snap = buildContextSnapshot([
    makeComment("alice", "Looks good to me, LGTM"),
    makeComment("bob", "I agree with the approach"),
  ]);
  assert.equal(detectConflicts(snap).length, 0);
});

test("detectConflicts: negation pattern → produces warning", () => {
  const snap = buildContextSnapshot([
    makeComment("alice", "Please don't use a global variable here"),
  ]);
  const warnings = detectConflicts(snap);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].author, "alice");
  assert.ok(warnings[0].excerpt.length > 0);
});

test("detectConflicts: multiple comments with negation → one warning per comment", () => {
  const snap = buildContextSnapshot([
    makeComment("alice", "I disagree with this approach"),
    makeComment("bob", "This won't work as described"),
  ]);
  const warnings = detectConflicts(snap);
  assert.equal(warnings.length, 2);
});

// ---------------------------------------------------------------------------
// renderConflictWarningBlock
// ---------------------------------------------------------------------------

test("renderConflictWarningBlock: no warnings → empty string", () => {
  assert.equal(renderConflictWarningBlock([]), "");
});

test("renderConflictWarningBlock: includes author and excerpt", () => {
  const warnings = [{ author: "alice", excerpt: "Please don't use globals" }];
  const block = renderConflictWarningBlock(warnings);
  assert.match(block, /@alice/);
  assert.match(block, /don't use globals/);
  assert.match(block, /Conflicts Detected/);
});

// ---------------------------------------------------------------------------
// findUnacknowledgedComments
// ---------------------------------------------------------------------------

function ts(offset = 0): string {
  return `2026-01-0${1 + offset}T00:00:00Z`;
}

test("findUnacknowledgedComments: no plan comment → empty", () => {
  const comments = [makeComment("alice", "hello", ts(0))];
  assert.equal(findUnacknowledgedComments(comments).length, 0);
});

test("findUnacknowledgedComments: human comments before plan → empty (anchor is plan)", () => {
  const comments = [
    makeComment("alice", "Pre-issue comment", ts(0)),
    makeComment("bot", "## Implementation Plan\n\nthe plan", ts(1)),
  ];
  assert.equal(findUnacknowledgedComments(comments).length, 0);
});

test("findUnacknowledgedComments: human comment after plan → returned", () => {
  const comments = [
    makeComment("bot", "## Implementation Plan\n\nthe plan", ts(0)),
    makeComment("alice", "Please also cover the edge case", ts(1)),
  ];
  const unacked = findUnacknowledgedComments(comments);
  assert.equal(unacked.length, 1);
  assert.equal(unacked[0].author, "alice");
});

test("findUnacknowledgedComments: pipeline comments after plan → not returned", () => {
  const comments = [
    makeComment("bot", "## Implementation Plan\n\nthe plan", ts(0)),
    makeComment("bot", "## Plan Review\n\nfeedback", ts(1)),
    makeComment("bot", "## Revised Implementation Plan\n\nrevised", ts(2)),
    makeComment("bot", "## Review 1\n\nfindings", ts(3)),
  ];
  assert.equal(findUnacknowledgedComments(comments).length, 0);
});

test("findUnacknowledgedComments: prefers revised plan as anchor over original plan", () => {
  const comments = [
    makeComment("bot", "## Implementation Plan\n\nplan", ts(0)),
    makeComment("alice", "Old comment after plan", ts(1)),
    makeComment("bot", "## Revised Implementation Plan\n\nrevised", ts(2)),
    makeComment("bob", "New comment after revised plan", ts(3)),
  ];
  const unacked = findUnacknowledgedComments(comments);
  // Only bob's comment (after revised plan) is unacknowledged.
  assert.equal(unacked.length, 1);
  assert.equal(unacked[0].author, "bob");
});

test("findUnacknowledgedComments: mix of human and pipeline after plan → only human returned", () => {
  const comments = [
    makeComment("bot", "## Implementation Plan\n\nplan", ts(0)),
    makeComment("alice", "Change the approach please", ts(1)),
    makeComment("bot", "## Pipeline: blocked\n\nreason", ts(2)),
    makeComment("bob", "Another human note", ts(3)),
  ];
  const unacked = findUnacknowledgedComments(comments);
  assert.equal(unacked.length, 2);
  assert.equal(unacked[0].author, "alice");
  assert.equal(unacked[1].author, "bob");
});
