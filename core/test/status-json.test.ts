// Tests for #154: `buildStatusPayload` assembles the stable JSON envelope for
// `pipeline <issue> --status --json`. Pure unit tests — no real network/git/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatusPayload,
  classifyRecoverParkedSpend,
  deriveHostGuidance,
  deriveNextAction,
  deriveStatus,
  formatWriteHealthStatusWarning,
  HOST_GUIDANCE_VALUES,
  largestConfiguredStageTimeoutSec,
  type HostGuidance,
  type StageTimeoutConfig,
  type StatusIssueDetail,
} from "../scripts/status-json.ts";
import { formatRecoverParkedSpentComment } from "../scripts/recover-parked.ts";
import type { WriteHealthRecord } from "../scripts/run-store.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const CFG = {
  repo: "acme/repo",
  domain: "test",
  implementation_timeout: 2400,
  review_timeout: 1500,
  plan_review_timeout: 300,
  fix_timeout: 2400,
  ci_timeout: 900,
  test_gate: { timeout: 300 },
  eval_gate: { timeout: 300 },
} as unknown as Pick<PipelineConfig, "repo" | "domain"> & StageTimeoutConfig;

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
  assert.ok("host_guidance" in payload);
  assert.ok("config" in payload);
  assert.ok("possibly_wedged" in payload);
  assert.ok("event_stream_write_health" in payload);
  assert.equal(payload.event_stream_write_health, null);
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

test("buildStatusPayload: needs-spec is an admission hold", () => {
  const payload = buildStatusPayload(makeDetail({ labels: ["pipeline:needs-spec"] }), null, null, CFG);
  assert.equal(payload.status, "waiting");
  assert.match(payload.next_action, /triage/);
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
// possibly_wedged (#398)
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-07T12:00:00Z");
// CFG's largest timeout is implementation_timeout/fix_timeout at 2400s = 2,400,000ms;
// +60s margin => 2,460,000ms threshold.
const STALE_AT = new Date(NOW.getTime() - 2_460_001).toISOString();
const FRESH_AT = new Date(NOW.getTime() - 1_000).toISOString();

test("possibly_wedged: null when no run-events summary is available", () => {
  const payload = buildStatusPayload(makeDetail(), null, null, CFG, null, NOW);
  assert.equal(payload.possibly_wedged, null);
});

test("possibly_wedged: null when the run is finalized, regardless of last-event age", () => {
  const payload = buildStatusPayload(
    makeDetail(),
    null,
    null,
    CFG,
    { finalized: true, lastEvent: { type: "run_complete", at: STALE_AT }, writeHealth: null },
    NOW,
  );
  assert.equal(payload.possibly_wedged, null);
});

test("possibly_wedged: null when the unfinalized run's last event is within the threshold", () => {
  const payload = buildStatusPayload(
    makeDetail(),
    null,
    null,
    CFG,
    { finalized: false, lastEvent: { type: "stage_start", at: FRESH_AT }, writeHealth: null },
    NOW,
  );
  assert.equal(payload.possibly_wedged, null);
});

test("possibly_wedged: populated when the unfinalized run's last event predates the threshold", () => {
  const payload = buildStatusPayload(
    makeDetail(),
    null,
    null,
    CFG,
    { finalized: false, lastEvent: { type: "harness_timeout", at: STALE_AT }, writeHealth: null },
    NOW,
  );
  assert.ok(payload.possibly_wedged !== null);
  assert.equal(payload.possibly_wedged.last_event_type, "harness_timeout");
  assert.equal(payload.possibly_wedged.threshold_ms, 2_460_000);
  assert.equal(payload.possibly_wedged.last_event_age_ms, 2_460_001);
});

test("largestConfiguredStageTimeoutSec: returns the max over the configured stage timeouts", () => {
  assert.equal(largestConfiguredStageTimeoutSec(CFG), 2400);
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

test("deriveNextAction: needs-human → human disposition required, not autonomous override (#1379)", () => {
  const out = deriveNextAction("needs-human", false);
  assert.match(out, /human disposition required/i);
  assert.doesNotMatch(
    out,
    /use `--override "<key>: <reason>"` or fix residual findings/,
    "pre-change autonomous override instruction must not return",
  );
  assert.doesNotMatch(out, /use `--override/);
  assert.doesNotMatch(out, /run `pipeline override`/);
});

test("deriveNextAction: recover-parked guidance names recover-parked then STOP (#1379)", () => {
  const out = deriveNextAction("needs-human", false, "recover-parked");
  assert.match(out, /pipeline recover-parked/);
  assert.match(out, /remains parked/i);
  assert.match(out, /operator-supplied disposition/i);
  assert.doesNotMatch(out, /use `--override/);
});

test("deriveNextAction: human-disposition-required forbids invented override (#1379)", () => {
  const out = deriveNextAction("needs-human", false, "human-disposition-required");
  assert.match(out, /stop and request an exact operator-supplied disposition/i);
  assert.doesNotMatch(out, /use `--override/);
  assert.match(out, /do not invoke `pipeline override`/i);
});

test("deriveNextAction: ready-to-deploy → awaiting operator-authorized merge", () => {
  assert.match(deriveNextAction("ready-to-deploy", false), /operator-authorized merge/i);
});

test("deriveNextAction: unknown stage → fallback with stage name", () => {
  const out = deriveNextAction("some-future-stage", false);
  assert.match(out, /some-future-stage/);
});

// ---------------------------------------------------------------------------
// event_stream_write_health (#633)
// ---------------------------------------------------------------------------

const ELEVATED_HEALTH: WriteHealthRecord = {
  schema_version: 1,
  failure_count: 2,
  last_failure_at: "2026-08-02T12:00:00Z",
  last_error: "ENOSPC: no space left on device",
  last_event_type: "blocker_set",
  worst_criticality: "control-critical",
  exclusive_fallback_attempted: false,
  exclusive_fallback_succeeded: false,
};

test("event_stream_write_health: elevated writeHealth appears in status JSON without schema bump (#633)", () => {
  const payload = buildStatusPayload(
    makeDetail(),
    null,
    null,
    CFG,
    {
      finalized: true,
      lastEvent: { type: "run_complete", at: "2026-08-02T12:00:00Z" },
      writeHealth: ELEVATED_HEALTH,
    },
  );
  assert.equal(payload.schema_version, "1");
  assert.ok(payload.event_stream_write_health !== null);
  assert.equal(payload.event_stream_write_health!.failure_count, 2);
  assert.equal(payload.event_stream_write_health!.worst_criticality, "control-critical");
});

test("event_stream_write_health: healthy writeHealth stays null (does not invent failure) (#633)", () => {
  const payload = buildStatusPayload(
    makeDetail(),
    null,
    null,
    CFG,
    {
      finalized: true,
      lastEvent: { type: "run_complete", at: "2026-08-02T12:00:00Z" },
      writeHealth: {
        schema_version: 1,
        failure_count: 0,
        last_failure_at: null,
        last_error: null,
        last_event_type: null,
        worst_criticality: null,
        exclusive_fallback_attempted: false,
        exclusive_fallback_succeeded: false,
      },
    },
  );
  assert.equal(payload.event_stream_write_health, null);
});

// ---------------------------------------------------------------------------
// host_guidance (#1379)
// ---------------------------------------------------------------------------

const PRE_CHANGE_AUTONOMOUS_OVERRIDE =
  /use `--override "<key>: <reason>"` or fix residual findings/;

function residualReviewComment(): StatusIssueDetail["comments"][number] {
  return {
    author: "bot",
    body: [
      "## Review 1 — needs-attention (commit abc1234)",
      "**Reviewer**: codex",
      "",
      "### Findings",
      "**1. [MEDIUM] Missing test** (confidence: 0.8) `override-key: abcd1234`",
    ].join("\n"),
    createdAt: "2026-09-01T00:00:00Z",
  };
}

function spentComment(issue: number, stage: string): StatusIssueDetail["comments"][number] {
  return {
    author: "bot",
    body: formatRecoverParkedSpentComment({
      fingerprint: "deadbeefdeadbeef",
      issue,
      stage,
      keys: ["abcd1234"],
      at: "2026-09-02T00:00:00Z",
    }),
    createdAt: "2026-09-02T00:00:00Z",
  };
}

test("host_guidance closed enum round-trips each value without schema bump (#1379)", () => {
  const fixtures: Array<{ labels: string[]; comments?: StatusIssueDetail["comments"]; expected: HostGuidance }> = [
    { labels: ["pipeline:review-1"], expected: "continue" },
    { labels: ["pipeline:needs-human"], expected: "recover-parked" },
    {
      labels: ["pipeline:needs-human"],
      comments: [spentComment(154, "needs-human")],
      expected: "human-disposition-required",
    },
    { labels: ["pipeline:ready-to-deploy"], expected: "operator-merge" },
  ];
  const seen = new Set<HostGuidance>();
  for (const f of fixtures) {
    const payload = buildStatusPayload(
      makeDetail({ labels: f.labels, comments: f.comments ?? [] }),
      null,
      null,
      CFG,
    );
    assert.equal(payload.schema_version, "1");
    assert.equal(payload.host_guidance, f.expected);
    seen.add(payload.host_guidance);
  }
  for (const value of HOST_GUIDANCE_VALUES) {
    assert.ok(seen.has(value), `missing round-trip fixture for host_guidance=${value}`);
  }
  assert.deepEqual([...HOST_GUIDANCE_VALUES], [
    "continue",
    "recover-parked",
    "human-disposition-required",
    "operator-merge",
  ]);
});

test("host_guidance: unspent residual park projects recover-parked (#1379)", () => {
  const payload = buildStatusPayload(
    makeDetail({ labels: ["pipeline:needs-human"], comments: [] }),
    null,
    null,
    CFG,
  );
  assert.equal(payload.host_guidance, "recover-parked");
  assert.match(payload.next_action, /pipeline recover-parked/);
  assert.doesNotMatch(payload.next_action, PRE_CHANGE_AUTONOMOUS_OVERRIDE);
  assert.equal(payload.schema_version, "1");
});

test("host_guidance: spent fingerprint projects human-disposition-required (#1379)", () => {
  const payload = buildStatusPayload(
    makeDetail({
      number: 154,
      labels: ["pipeline:needs-human"],
      comments: [spentComment(154, "needs-human")],
    }),
    null,
    null,
    CFG,
  );
  assert.equal(payload.host_guidance, "human-disposition-required");
  assert.match(payload.next_action, /operator-supplied disposition/i);
  assert.doesNotMatch(payload.next_action, PRE_CHANGE_AUTONOMOUS_OVERRIDE);
  assert.equal(payload.schema_version, "1");
});

test("host_guidance: unknown spend fails closed to human-disposition-required (#1379)", () => {
  const unknownSpendComments = [
    {
      author: "bot",
      body:
        "## Pipeline: recover-parked supervisor pass spent\n" +
        "<!-- pipeline-recover-parked-spent: v1 {not-json} -->",
      createdAt: "2026-09-02T00:00:00Z",
    },
  ];
  assert.equal(
    classifyRecoverParkedSpend({
      issue: 154,
      stage: "needs-human",
      comments: unknownSpendComments,
    }),
    "unknown",
  );
  const payload = buildStatusPayload(
    makeDetail({ labels: ["pipeline:needs-human"], comments: unknownSpendComments }),
    null,
    null,
    CFG,
  );
  assert.equal(payload.host_guidance, "human-disposition-required");
  assert.notEqual(payload.host_guidance, "recover-parked");
  assert.doesNotMatch(payload.next_action, PRE_CHANGE_AUTONOMOUS_OVERRIDE);
});

test("host_guidance: ready-to-deploy projects operator-merge (#1379)", () => {
  const payload = buildStatusPayload(
    makeDetail({ labels: ["pipeline:ready-to-deploy"] }),
    42,
    null,
    CFG,
  );
  assert.equal(payload.host_guidance, "operator-merge");
  assert.match(payload.next_action, /operator-authorized merge/i);
});

test("blocked residual park does not instruct unblock or autonomous override (#1379)", () => {
  const payload = buildStatusPayload(
    makeDetail({
      labels: ["pipeline:review-1", "blocked"],
      comments: [
        residualReviewComment(),
        {
          author: "bot",
          body: "## Pipeline: Blocked at review 1\n<!-- pipeline-blocker-kind: needs-human -->",
          createdAt: "2026-09-01T01:00:00Z",
        },
      ],
    }),
    null,
    null,
    CFG,
  );
  assert.ok(
    payload.host_guidance === "recover-parked" ||
      payload.host_guidance === "human-disposition-required",
  );
  assert.doesNotMatch(payload.next_action, PRE_CHANGE_AUTONOMOUS_OVERRIDE);
  assert.doesNotMatch(payload.next_action, /Unblock with `--unblock/);
  assert.doesNotMatch(payload.next_action, /remove the `blocked` label/);
});

test("question-blocked non-park keeps typed unblock next_action (#1379)", () => {
  const payload = buildStatusPayload(
    makeDetail({
      labels: ["pipeline:implementing", "blocked"],
      comments: [
        {
          author: "bot",
          body: "## Pipeline: Blocked at implementing\nA recorded question.\n<!-- pipeline-blocker-kind: harness-failure -->",
          createdAt: "2026-09-01T01:00:00Z",
        },
      ],
    }),
    null,
    null,
    CFG,
  );
  assert.equal(payload.host_guidance, "continue");
  assert.match(payload.next_action, /`--unblock/);
});

test("human-decision-required park is human-disposition-required even if unspent (#1379)", () => {
  const guidance = deriveHostGuidance({
    stage: "needs-human",
    blocked: true,
    issue: 154,
    comments: [
      {
        body: "## Pipeline: Human decision required\n**Category**: product-decision\n<!-- pipeline-blocker-kind: human-decision-required -->",
      },
    ],
  });
  assert.equal(guidance, "human-disposition-required");
});

test("formatWriteHealthStatusWarning: warns only when elevated (#633)", () => {
  assert.equal(formatWriteHealthStatusWarning(null), null);
  assert.equal(
    formatWriteHealthStatusWarning({
      schema_version: 1,
      failure_count: 0,
      last_failure_at: null,
      last_error: null,
      last_event_type: null,
      worst_criticality: null,
      exclusive_fallback_attempted: false,
      exclusive_fallback_succeeded: false,
    }),
    null,
  );
  const warn = formatWriteHealthStatusWarning(ELEVATED_HEALTH);
  assert.ok(warn);
  assert.match(warn!, /event stream write failure/i);
  assert.match(warn!, /control-critical/);
});
