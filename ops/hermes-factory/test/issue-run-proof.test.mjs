import assert from "node:assert/strict";
import test from "node:test";
import {
  ISSUE_RUN_PROOF_LIMITS,
  parseIssueAdvanceLinkage,
  validateIssueAdvanceEvidence,
} from "../lib/issue-run-proof.mjs";

const ISSUE = 905;
const REPO_DIR = "/repo";
const RUN_ID = "905-2026-08-08T12-00-00-000Z";
const EVENTS_PATH = `${REPO_DIR}/.agent-pipeline/runs/${RUN_ID}/events.jsonl`;
const HEAD = "a".repeat(40);

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function loopEvent(seq, kind, data) {
  return { seq, time: `2026-08-08T12:00:0${seq}.000Z`, kind, data };
}

function outerEvents(link = {}, finish = {}) {
  return [
    loopEvent(0, "loop_run_initialized", { run_id: "pipeline-loop-one" }),
    loopEvent(1, "loop_item_advance_linked", {
      item_id: String(ISSUE),
      pipeline_run_id: RUN_ID,
      events: EVENTS_PATH,
      ...link,
    }),
    loopEvent(2, "loop_item_stage_progress", { item_id: String(ISSUE), stage: "review" }),
    loopEvent(3, "loop_item_advance_finished", {
      item_id: String(ISSUE),
      pipeline_run_id: RUN_ID,
      events: EVENTS_PATH,
      outcome: "ready_to_deploy",
      ...finish,
    }),
  ];
}

function advanceEvents() {
  return [
    {
      schema_version: 1,
      type: "run_start",
      at: "2026-08-08T12:00:00Z",
      run_id: RUN_ID,
      issue: ISSUE,
      repo: "owner/repo",
    },
    {
      schema_version: 6,
      type: "stage_accounting",
      at: "2026-08-08T12:00:30Z",
      run_id: RUN_ID,
      issue: ISSUE,
      stage: "planning",
      harness: "grok",
      adapter: "grok",
      model_slot: "planning",
      requested_model: "grok-4.5",
      resolved_model: "grok-4.5",
      command_count: 1,
      subprocess_count: 1,
      outcome: "success",
    },
    {
      schema_version: 6,
      type: "stage_accounting",
      at: "2026-08-08T12:01:00Z",
      run_id: RUN_ID,
      issue: ISSUE,
      stage: "implementing",
      harness: "grok",
      adapter: "grok",
      requested_model: "grok-4.5",
      resolved_model: "grok-4.5",
      command_count: 1,
      subprocess_count: 1,
      outcome: "success",
    },
    {
      schema_version: 1,
      type: "review_verdict",
      at: "2026-08-08T12:02:00Z",
      round: 1,
      sha: HEAD,
      verdict: "approve",
      finding_counts: {},
      reviewer_harness: "codex",
      self_review: false,
    },
    {
      schema_version: 1,
      type: "run_complete",
      at: "2026-08-08T12:03:00Z",
      final_state: "ready-to-deploy",
      elapsed_ms: 180_000,
    },
  ];
}

test("parses one exact run-confined successful advance linkage", () => {
  assert.deepEqual(
    parseIssueAdvanceLinkage(jsonl(outerEvents()), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    { pipeline_run_id: RUN_ID, events_path: EVENTS_PATH },
  );
});

test("rejects synthetic, traversing, duplicated, mismatched, and unsuccessful linkage", () => {
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(outerEvents({ pipeline_run_id: "pipeline-loop-fake" })), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /actual Pipeline advance run id|does not match issue/,
  );
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(outerEvents({ events: `${REPO_DIR}/.agent-pipeline/runs/${RUN_ID}/../other/events.jsonl` })), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /exact run-confined path/,
  );
  const duplicate = outerEvents();
  duplicate.splice(2, 0, loopEvent(2, "loop_item_advance_linked", duplicate[1].data));
  duplicate[3].seq = 3;
  duplicate[4].seq = 4;
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(duplicate), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /2 advance linkage records/,
  );
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(outerEvents({}, { pipeline_run_id: "905-2026-08-08T12-00-01-000Z" })), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /does not match the exact linkage/,
  );
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(outerEvents({}, { outcome: "blocked_recoverable" })), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /not ready_to_deploy/,
  );
});

test("validates exact run, grok-4.5, independent Codex review, and current head", () => {
  const proof = validateIssueAdvanceEvidence(jsonl(advanceEvents()), {
    expectedIssue: ISSUE,
    expectedRunId: RUN_ID,
    expectedPrHead: HEAD,
  });
  assert.deepEqual(proof, {
    run_id: RUN_ID,
    issue: ISSUE,
    final_state: "ready-to-deploy",
    grok_invocations: 2,
    review_verdicts: 1,
    reviewed_head: HEAD,
  });
});

test("rejects substituted or missing Grok model identity", () => {
  for (const patch of [
    { requested_model: undefined },
    { resolved_model: undefined },
    { requested_model: "grok-4.4" },
    { resolved_model: "grok-4.5-build" },
  ]) {
    const events = advanceEvents();
    Object.assign(events[2], patch);
    assert.throws(
      () => validateIssueAdvanceEvidence(jsonl(events), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
      /requested and resolved grok-4\.5/,
    );
  }
});

test("rejects a missing or failed Grok model invocation", () => {
  const noGrok = advanceEvents();
  noGrok[1] = { ...noGrok[1], harness: "codex", adapter: "codex", requested_model: "gpt-5", resolved_model: "gpt-5" };
  noGrok[2] = { ...noGrok[2], harness: "codex", adapter: "codex", requested_model: "gpt-5", resolved_model: "gpt-5" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(noGrok), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /not run by the Grok adapter/,
  );

  const failed = advanceEvents();
  failed[2] = { ...failed[2], outcome: "failure" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(failed), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /implementer-owned Grok stage did not complete successfully/,
  );
});

test("rejects Claude implementation, plan review, review, and fix accounting", () => {
  for (const stage of ["implementing", "plan-review", "review-1", "fix-2"]) {
    const events = advanceEvents();
    events.splice(3, 0, {
      ...events[2],
      at: "2026-08-08T12:01:30Z",
      stage,
      harness: "claude",
      adapter: "claude",
      requested_model: "claude-opus-4-1",
      resolved_model: "claude-opus-4-1",
    });
    assert.throws(
      () => validateIssueAdvanceEvidence(jsonl(events), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
      new RegExp(`Claude invocation is forbidden for stage ${stage}`),
    );
  }
});

test("rejects a non-Grok implementer stage even when another Grok record exists", () => {
  const events = advanceEvents();
  events.splice(3, 0, {
    ...events[2],
    at: "2026-08-08T12:01:30Z",
    stage: "fix-1",
    harness: "codex",
    adapter: "codex",
    requested_model: "gpt-5.6",
    resolved_model: "gpt-5.6",
  });
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(events), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /implementer-owned stage fix-1 was not run by the Grok adapter/,
  );
});

test("rejects disguised implementer and reviewer adapters and classifies plan-review by model slot", () => {
  const disguised = advanceEvents();
  disguised[2] = { ...disguised[2], harness: "codex", adapter: "codex" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(disguised), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /not run by the Grok adapter/,
  );

  const wrongReviewer = advanceEvents();
  wrongReviewer.splice(3, 0, {
    ...wrongReviewer[2],
    at: "2026-08-08T12:01:30Z",
    stage: "review-1",
    model_slot: "review",
  });
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(wrongReviewer), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /not run by the Codex adapter/,
  );

  const planReview = advanceEvents();
  planReview.splice(3, 0,
    {
      ...planReview[2],
      at: "2026-08-08T12:01:20Z",
      stage: "plan-review",
      model_slot: "planning",
    },
    {
      ...planReview[2],
      at: "2026-08-08T12:01:30Z",
      stage: "plan-review",
      model_slot: "review",
      harness: "codex",
      adapter: "codex",
      requested_model: "gpt-5.6",
      resolved_model: "gpt-5.6",
    },
  );
  assert.doesNotThrow(
    () => validateIssueAdvanceEvidence(jsonl(planReview), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
  );
});

test("rejects same-harness fallback, missing self-review proof, and stale reviewed head", () => {
  for (const reviewPatch of [
    { reviewer_harness: "grok", self_review: true },
    { reviewer_harness: "codex", self_review: undefined },
    { reviewer_harness: "claude", self_review: false },
  ]) {
    const events = advanceEvents();
    Object.assign(events[3], reviewPatch);
    assert.throws(
      () => validateIssueAdvanceEvidence(jsonl(events), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
      /independent Codex review/,
    );
  }

  const staleHead = advanceEvents();
  staleHead[3] = { ...staleHead[3], sha: "b".repeat(40) };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(staleHead), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /does not approve the expected PR head/,
  );

  const notApproved = advanceEvents();
  notApproved[3] = { ...notApproved[3], verdict: "needs_attention" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(notApproved), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /does not approve the expected PR head/,
  );
});

test("permits prior reviewed heads only when Codex also reviewed the expected head", () => {
  const events = advanceEvents();
  events.splice(3, 0, {
    ...events[3],
    at: "2026-08-08T12:01:30Z",
    sha: "b".repeat(40),
    verdict: "changes_requested",
    round: 1,
  });
  events[4] = { ...events[4], round: 2 };
  const proof = validateIssueAdvanceEvidence(jsonl(events), {
    expectedIssue: ISSUE,
    expectedRunId: RUN_ID,
    expectedPrHead: HEAD,
  });
  assert.equal(proof.review_verdicts, 2);
});

test("rejects run identity drift and non-ready terminal state", () => {
  const wrongRun = advanceEvents();
  wrongRun[0] = { ...wrongRun[0], run_id: "905-2026-08-08T12-00-01-000Z" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(wrongRun), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /run_start does not match/,
  );

  const wrongAccountingRun = advanceEvents();
  wrongAccountingRun[1] = { ...wrongAccountingRun[1], run_id: "905-2026-08-08T12-00-01-000Z" };
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(wrongAccountingRun), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /stage_accounting is not bound/,
  );

  const blocked = advanceEvents();
  blocked.at(-1).final_state = "blocked";
  assert.throws(
    () => validateIssueAdvanceEvidence(jsonl(blocked), { expectedIssue: ISSUE, expectedRunId: RUN_ID, expectedPrHead: HEAD }),
    /not ready-to-deploy/,
  );
});

test("rejects malformed, non-contiguous, and overlong JSONL", () => {
  assert.throws(
    () => parseIssueAdvanceLinkage("{bad json}\n", { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /not valid JSON/,
  );
  const nonContiguous = outerEvents();
  nonContiguous[1].seq = 2;
  assert.throws(
    () => parseIssueAdvanceLinkage(jsonl(nonContiguous), { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /non-contiguous sequence/,
  );
  const overlong = `${JSON.stringify({
    seq: 0,
    time: "2026-08-08T12:00:00Z",
    kind: "noise",
    data: { value: "x".repeat(ISSUE_RUN_PROOF_LIMITS.maxLineBytes) },
  })}\n`;
  assert.throws(
    () => parseIssueAdvanceLinkage(overlong, { repoDir: REPO_DIR, expectedIssue: ISSUE }),
    /line 1 exceeds the byte limit/,
  );
});
