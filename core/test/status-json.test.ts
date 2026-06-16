// Tests for #154: `buildStatusPayload` assembles the stable JSON envelope for
// `pipeline <issue> --status --json`. Pure unit tests — no real network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatusPayload,
  deriveNextAction,
  deriveStatus,
  type StatusIssueDetail,
} from "../scripts/status-json.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const CFG = { repo: "acme/repo", domain: "test" } as unknown as Pick<PipelineConfig, "repo" | "domain">;

function makeDetail(overrides: Partial<StatusIssueDetail> = {}): StatusIssueDetail {
  return {
    number: 154,
    title: "Add JSON status",
    state: "open",
    labels: ["pipeline:review-1"],
    comments: [],
    url: "https://github.com/acme/repo/issues/154",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 4.1 — minimum fields and schema_version
// ---------------------------------------------------------------------------

test("buildStatusPayload: all minimum fields are present", () => {
  const payload = buildStatusPayload(makeDetail(), null, null, CFG);
  assert.equal(payload.schema_version, "1");
  assert.ok("status" in payload);
  assert.ok("issue" in payload);
  assert.ok("stage" in payload);
  assert.ok("pr" in payload);
  assert.ok("branch" in payload);
  assert.ok("worktree" in payload);
  assert.ok("last_event" in payload);
  assert.ok("review_summary" in payload);
  assert.ok("next_action" in payload);
  assert.ok("config" in payload);
});

test("buildStatusPayload: schema_version is \"1\"", () => {
  assert.equal(buildStatusPayload(makeDetail(), null, null, CFG).schema_version, "1");
});

test("buildStatusPayload: issue number and title come from detail", () => {
  const payload = buildStatusPayload(makeDetail({ number: 99, title: "Fix it" }), null, null, CFG);
  assert.equal(payload.issue.number, 99);
  assert.equal(payload.issue.title, "Fix it");
});

test("buildStatusPayload: config carries repo and domain from cfg", () => {
  const payload = buildStatusPayload(makeDetail(), null, null, CFG);
  assert.equal(payload.config.repo, "acme/repo");
  assert.equal(payload.config.domain, "test");
});

// ---------------------------------------------------------------------------
// 4.1 — stage field
// ---------------------------------------------------------------------------

test("buildStatusPayload: stage from pipeline: label", () => {
  const payload = buildStatusPayload(makeDetail({ labels: ["pipeline:review-2"] }), null, null, CFG);
  assert.equal(payload.stage, "review-2");
});

test("buildStatusPayload: stage is null when no pipeline: label", () => {
  const payload = buildStatusPayload(makeDetail({ labels: [] }), null, null, CFG);
  assert.equal(payload.stage, null);
});

// ---------------------------------------------------------------------------
// 4.1 — pr field
// ---------------------------------------------------------------------------

test("buildStatusPayload: pr is null when no PR exists", () => {
  assert.equal(buildStatusPayload(makeDetail(), null, null, CFG).pr, null);
});

test("buildStatusPayload: pr has number and correct GitHub url when PR exists", () => {
  const payload = buildStatusPayload(makeDetail(), 42, null, CFG);
  assert.ok(payload.pr !== null);
  assert.equal(payload.pr.number, 42);
  assert.equal(payload.pr.url, "https://github.com/acme/repo/pull/42");
});

// ---------------------------------------------------------------------------
// 4.1 — branch and worktree fields
// ---------------------------------------------------------------------------

test("buildStatusPayload: branch and worktree are null when no worktree", () => {
  const payload = buildStatusPayload(makeDetail(), null, null, CFG);
  assert.equal(payload.branch, null);
  assert.equal(payload.worktree, null);
});

test("buildStatusPayload: branch and worktree populated from worktreeInfo", () => {
  const payload = buildStatusPayload(
    makeDetail({ number: 154 }),
    null,
    { path: "/repo/.worktrees/pipeline-154-foo", slug: "foo" },
    CFG,
  );
  assert.equal(payload.worktree, "/repo/.worktrees/pipeline-154-foo");
  assert.equal(payload.branch, "pipeline/154-foo");
});

// ---------------------------------------------------------------------------
// 4.1 — status discriminant
// ---------------------------------------------------------------------------

test("buildStatusPayload: status is ok when stage is set and not blocked", () => {
  const payload = buildStatusPayload(makeDetail({ labels: ["pipeline:review-1"] }), null, null, CFG);
  assert.equal(payload.status, "ok");
});

test("buildStatusPayload: status is blocked when no pipeline: label", () => {
  const payload = buildStatusPayload(makeDetail({ labels: [] }), null, null, CFG);
  assert.equal(payload.status, "blocked");
});

test("buildStatusPayload: status is blocked when the blocked label is present", () => {
  const payload = buildStatusPayload(
    makeDetail({ labels: ["pipeline:review-1", "blocked"] }),
    null,
    null,
    CFG,
  );
  assert.equal(payload.status, "blocked");
});

test("buildStatusPayload: status is needs-human when stage is needs-human", () => {
  const payload = buildStatusPayload(makeDetail({ labels: ["pipeline:needs-human"] }), null, null, CFG);
  assert.equal(payload.status, "needs-human");
});

test("buildStatusPayload: status is waiting when stage is backlog", () => {
  const payload = buildStatusPayload(makeDetail({ labels: ["pipeline:backlog"] }), null, null, CFG);
  assert.equal(payload.status, "waiting");
});

// ---------------------------------------------------------------------------
// 4.1 — last_event
// ---------------------------------------------------------------------------

test("buildStatusPayload: last_event is null when no pipeline comments", () => {
  assert.equal(buildStatusPayload(makeDetail({ comments: [] }), null, null, CFG).last_event, null);
});

test("buildStatusPayload: last_event from last pipeline comment", () => {
  const detail = makeDetail({
    comments: [
      { author: "bot", body: "## Pipeline: Blocked\nsome reason", createdAt: "2026-06-01T00:00:00Z" },
      { author: "human", body: "just a note", createdAt: "2026-06-02T00:00:00Z" },
    ],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.last_event !== null);
  assert.equal(payload.last_event.timestamp, "2026-06-01T00:00:00Z");
  assert.equal(payload.last_event.description, "## Pipeline: Blocked");
});

test("buildStatusPayload: last_event from last Review comment", () => {
  const detail = makeDetail({
    comments: [
      { author: "bot", body: "## Review 1 — approved (commit abc)", createdAt: "2026-06-05T00:00:00Z" },
    ],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.last_event !== null);
  assert.equal(payload.last_event.description, "## Review 1 — approved (commit abc)");
});

test("buildStatusPayload: last_event from label event when no pipeline comments exist", () => {
  const detail = makeDetail({
    comments: [{ author: "human", body: "just a note", createdAt: "2026-06-01T00:00:00Z" }],
    labelEvents: [{ label: "pipeline:backlog", createdAt: "2026-06-10T12:00:00Z" }],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.last_event !== null);
  assert.equal(payload.last_event.timestamp, "2026-06-10T12:00:00Z");
  assert.match(payload.last_event.description, /pipeline:backlog/);
});

test("buildStatusPayload: last_event from label event when newer than last pipeline comment", () => {
  const detail = makeDetail({
    comments: [
      { author: "bot", body: "## Pipeline: Blocked\nsome reason", createdAt: "2026-06-01T00:00:00Z" },
    ],
    labelEvents: [{ label: "pipeline:review-1", createdAt: "2026-06-15T08:00:00Z" }],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.last_event !== null);
  assert.equal(payload.last_event.timestamp, "2026-06-15T08:00:00Z");
  assert.match(payload.last_event.description, /pipeline:review-1/);
});

test("buildStatusPayload: last_event from comment when newer than label events", () => {
  const detail = makeDetail({
    comments: [
      { author: "bot", body: "## Review 2 — needs-attention (commit xyz)", createdAt: "2026-06-20T10:00:00Z" },
    ],
    labelEvents: [{ label: "pipeline:review-2", createdAt: "2026-06-19T08:00:00Z" }],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.last_event !== null);
  assert.equal(payload.last_event.timestamp, "2026-06-20T10:00:00Z");
  assert.equal(payload.last_event.description, "## Review 2 — needs-attention (commit xyz)");
});

// ---------------------------------------------------------------------------
// 4.1 — review_summary
// ---------------------------------------------------------------------------

test("buildStatusPayload: review_summary is null when no review comments", () => {
  assert.equal(buildStatusPayload(makeDetail(), null, null, CFG).review_summary, null);
});

test("buildStatusPayload: review_summary parses verdict from review comment", () => {
  const detail = makeDetail({
    comments: [
      {
        author: "bot",
        body: "## Review 1 — approved (commit abc1234)\n**Reviewer**: codex\n\n### Findings\n",
        createdAt: "2026-06-05T00:00:00Z",
      },
    ],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.review_summary !== null);
  assert.equal(payload.review_summary.verdict, "approved");
  assert.equal(payload.review_summary.timestamp, "2026-06-05T00:00:00Z");
});

test("buildStatusPayload: review_summary counts findings", () => {
  const detail = makeDetail({
    comments: [
      {
        author: "bot",
        body: [
          "## Review 2 — needs-attention (commit def5678)",
          "**Reviewer**: codex",
          "",
          "### Findings",
          "**1. [HIGH] Null deref** (confidence: 0.9) `override-key: abc1`",
          "**2. [MEDIUM] Missing test** (confidence: 0.8) `override-key: abc2`",
        ].join("\n"),
        createdAt: "2026-06-06T00:00:00Z",
      },
    ],
  });
  const payload = buildStatusPayload(detail, null, null, CFG);
  assert.ok(payload.review_summary !== null);
  assert.equal(payload.review_summary.verdict, "needs-attention");
  assert.equal(payload.review_summary.findings_count, 2);
});

// ---------------------------------------------------------------------------
// deriveStatus helper
// ---------------------------------------------------------------------------

test("deriveStatus: closed issue is ok regardless of stage", () => {
  assert.equal(deriveStatus("review-1", false, "closed"), "ok");
  assert.equal(deriveStatus(null, false, "closed"), "ok");
});

test("deriveStatus: no stage → blocked", () => {
  assert.equal(deriveStatus(null, false, "open"), "blocked");
});

test("deriveStatus: blocked flag → blocked", () => {
  assert.equal(deriveStatus("review-1", true, "open"), "blocked");
});

test("deriveStatus: needs-human stage → needs-human", () => {
  assert.equal(deriveStatus("needs-human", false, "open"), "needs-human");
});

test("deriveStatus: backlog → waiting", () => {
  assert.equal(deriveStatus("backlog", false, "open"), "waiting");
});

test("deriveStatus: active stage → ok", () => {
  assert.equal(deriveStatus("review-1", false, "open"), "ok");
  assert.equal(deriveStatus("pre-merge", false, "open"), "ok");
  assert.equal(deriveStatus("ready-to-deploy", false, "open"), "ok");
});

// ---------------------------------------------------------------------------
// deriveNextAction helper
// ---------------------------------------------------------------------------

test("deriveNextAction: null stage → add pipeline:ready label", () => {
  assert.match(deriveNextAction(null, false), /pipeline:ready/);
});

test("deriveNextAction: blocked flag overrides stage description", () => {
  const out = deriveNextAction("review-1", true);
  assert.match(out, /unblock/i);
});

test("deriveNextAction: needs-human → human decision required", () => {
  assert.match(deriveNextAction("needs-human", false), /human decision/i);
});

test("deriveNextAction: ready-to-deploy → awaiting human merge", () => {
  assert.match(deriveNextAction("ready-to-deploy", false), /awaiting human merge/i);
});

test("deriveNextAction: unknown stage → fallback with stage name", () => {
  const out = deriveNextAction("some-future-stage", false);
  assert.match(out, /some-future-stage/);
});
