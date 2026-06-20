// Unit tests for idempotent stage-audit helpers (#259).
// No real gh subprocess calls — all I/O is injected via deps seams.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuditSentinel,
  reconcileAuditComment,
  retryComment,
  setGhRunId,
  transition,
  setBlocked,
  type ReconcileAuditDeps,
  type TransitionDeps,
  type SetBlockedDeps,
} from "../scripts/gh.ts";
import type { PipelineConfig } from "../scripts/types.ts";

// ---------------------------------------------------------------------------
// Minimal fake config (no real network)
// ---------------------------------------------------------------------------

const fakeCfg = {
  repo: "acme/test",
  base_branch: "main",
  domain: "test",
  repo_dir: "/tmp/test",
  marker_footer: "*Automated by Claude Code Pipeline Skill*",
} as unknown as PipelineConfig;

// ---------------------------------------------------------------------------
// buildAuditSentinel — pure function
// ---------------------------------------------------------------------------

test("buildAuditSentinel: returns the expected HTML comment format", () => {
  const s = buildAuditSentinel("42/2026-06-20T20:00:00Z", "fix-1");
  assert.equal(s, "<!-- pipeline-audit: run=42/2026-06-20T20:00:00Z state=fix-1 -->");
});

test("buildAuditSentinel: state=blocked", () => {
  const s = buildAuditSentinel("42/2026-06-20T20:00:00Z", "blocked");
  assert.equal(s, "<!-- pipeline-audit: run=42/2026-06-20T20:00:00Z state=blocked -->");
});

// ---------------------------------------------------------------------------
// retryComment — retry logic with injectable sleep
// ---------------------------------------------------------------------------

test("retryComment: resolves on first attempt without retrying", async () => {
  let calls = 0;
  await retryComment(async () => { calls++; }, 3, async () => {});
  assert.equal(calls, 1);
});

test("retryComment: retries after first failure and resolves on second attempt", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await retryComment(
    async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    },
    3,
    async (ms) => { sleeps.push(ms); },
  );
  assert.equal(calls, 2, "must call thunk exactly twice");
  assert.equal(sleeps.length, 1, "must sleep once between attempt 1 and 2");
  assert.equal(sleeps[0], 1000, "first backoff must be 1 s (2^0 * 1000)");
});

test("retryComment: exhausts all attempts and re-throws the last error", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    () =>
      retryComment(
        async () => {
          calls++;
          throw new Error(`attempt-${calls}`);
        },
        3,
        async (ms) => { sleeps.push(ms); },
      ),
    (err: Error) => {
      assert.equal(err.message, "attempt-3", "must re-throw last error");
      return true;
    },
  );
  assert.equal(calls, 3, "must attempt exactly 3 times");
  assert.equal(sleeps.length, 2, "must sleep between each pair of attempts");
  assert.equal(sleeps[0], 1000, "first sleep: 2^0 * 1000");
  assert.equal(sleeps[1], 2000, "second sleep: 2^1 * 1000");
});

// ---------------------------------------------------------------------------
// reconcileAuditComment — no-op when marker present
// ---------------------------------------------------------------------------

test("reconcileAuditComment: ignores sentinel quoted in a non-pipeline comment", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  // A human comment quoting the sentinel in a code block — must NOT suppress repair
  const comments = [
    { body: "Here is my review:\n```\n<!-- pipeline-audit: run=old-run state=fix-1 -->\n```" },
  ];
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair body", comments, "pipeline-bot", deps);
  assert.equal(posted, 1, "must post repair: sentinel in non-pipeline comment is not trusted");
});

test("reconcileAuditComment: no-op when sentinel already present", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  const comments = [
    { author: "someone-else", body: "some unrelated comment" },
    { author: "pipeline-bot", body: "## Pipeline: fix 1\ntransition body\n<!-- pipeline-audit: run=old-run state=fix-1 -->" },
  ];
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair body", comments, "pipeline-bot", deps);
  assert.equal(posted, 0, "must not post when a trusted-authored sentinel is already present");
});

test("reconcileAuditComment: forged '## Pipeline:' sentinel by an untrusted author does NOT suppress repair (#259 security)", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  // A comment that perfectly mimics a pipeline audit comment — correct heading, sentinel,
  // and matching state marker — but authored by someone OTHER than the pipeline's actor.
  // Body-prefix text is forgeable, so this must NOT be trusted to suppress the audit repair.
  const comments = [
    { author: "attacker", body: "## Pipeline: fix 1\ntransition body\n<!-- pipeline-audit: run=old-run state=fix-1 -->" },
  ];
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair body", comments, "pipeline-bot", deps);
  assert.equal(posted, 1, "a forged sentinel from an untrusted author must NOT suppress repair");
});

test("reconcileAuditComment: null trustedActor (actor unresolved) trusts nothing and posts repair (#259)", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  const comments = [
    { author: "pipeline-bot", body: "## Pipeline: fix 1\n<!-- pipeline-audit: run=old-run state=fix-1 -->" },
  ];
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair body", comments, null, deps);
  assert.equal(posted, 1, "when the actor can't be resolved, fail toward repair (trust nothing)");
});

test("reconcileAuditComment: posts repair when only a different-state sentinel is present", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  // Comments have state=review-1 but we're checking for state=fix-1 — still absent
  const comments = [
    { body: "## Pipeline: review 1\n<!-- pipeline-audit: run=old-run state=review-1 -->" },
  ];
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair body", comments, "pipeline-bot", deps);
  assert.equal(posted, 1, "must post repair when state=fix-1 sentinel is absent even if another state's sentinel exists");
});

test("reconcileAuditComment: posts repair comment when sentinel is absent", async () => {
  const posted: string[] = [];
  const warns: string[] = [];
  const deps: ReconcileAuditDeps = {
    postComment: async (_cfg, _n, body) => { posted.push(body); },
    warn: (msg) => warns.push(msg),
  };
  const repairBody = `repair for fix-1\n${buildAuditSentinel("new-run", "fix-1")}`;
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", repairBody, [], "pipeline-bot", deps);
  assert.equal(posted.length, 1, "must post exactly one repair comment");
  assert.equal(posted[0], repairBody);
  assert.ok(warns.length > 0, "must warn when posting repair");
});

test("reconcileAuditComment: only scans the last 20 comments", async () => {
  let posted = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { posted++; },
    warn: () => {},
  };
  // Place a matching sentinel at position 0 (oldest), with 21 newer comments after it.
  const comments = [
    { body: "## Pipeline: fix 1\n<!-- pipeline-audit: run=old-run state=fix-1 -->" },
    ...Array.from({ length: 21 }, (_, i) => ({ body: `noise comment ${i}` })),
  ];
  // The sentinel is outside the last-20 window; reconciler should post.
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "new-run", "repair", comments, "pipeline-bot", deps);
  assert.equal(posted, 1, "must post when sentinel is outside the last-20 window");
});

// ---------------------------------------------------------------------------
// reconcileAuditComment — retry on transient failure, propagate on exhaustion
// ---------------------------------------------------------------------------

test("reconcileAuditComment: retries postComment on transient failure and resolves", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const deps: ReconcileAuditDeps = {
    postComment: async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
    },
    warn: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
  };
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "run-x", "body", [], "pipeline-bot", deps);
  assert.equal(calls, 2, "must retry once and succeed");
  assert.equal(sleeps.length, 1, "must sleep once between attempts");
});

test("reconcileAuditComment: propagates error when all retries fail (no silent swallow)", async () => {
  let calls = 0;
  const deps: ReconcileAuditDeps = {
    postComment: async () => { calls++; throw new Error("persistent"); },
    warn: () => {},
    sleep: async () => {},
  };
  await assert.rejects(
    () => reconcileAuditComment(fakeCfg, 42, "fix-1", "run-x", "body", [], "pipeline-bot", deps),
    /persistent/,
    "must propagate error, not swallow it",
  );
  assert.equal(calls, 3, "must exhaust all 3 attempts");
});

// ---------------------------------------------------------------------------
// reconcileAuditComment — idempotent across two calls
// ---------------------------------------------------------------------------

test("reconcileAuditComment: second call skips when first call's repair is in comments", async () => {
  const stored: { author: string; body: string }[] = [];
  const deps: ReconcileAuditDeps = {
    postComment: async (_cfg, _n, body) => { stored.push({ author: "pipeline-bot", body }); },
    warn: () => {},
  };

  const repairBody = `## Pipeline: fix 1\nrepair\n${buildAuditSentinel("run-2", "fix-1")}`;

  // First call: no sentinel → posts repair
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "run-2", repairBody, [], "pipeline-bot", deps);
  assert.equal(stored.length, 1, "first call must post once");

  // Second call: sentinel now in stored comments → no-op
  await reconcileAuditComment(fakeCfg, 42, "fix-1", "run-2", repairBody, stored, "pipeline-bot", deps);
  assert.equal(stored.length, 1, "second call must not post again");
});

// ---------------------------------------------------------------------------
// transition() — sentinel embedded, retry used
// ---------------------------------------------------------------------------

test("transition: comment body contains the audit sentinel", async () => {
  setGhRunId("259/2026-06-20T20:00:00Z");
  const posted: string[] = [];
  const deps: TransitionDeps = {
    getIssueDetail: async () => ({ labels: ["harness:claude"] }),
    editLabels: async () => {},
    postComment: async (_cfg, _n, body) => { posted.push(body); },
    sleep: async () => {},
  };
  await transition(fakeCfg, 42, "review-1", "fix-1", "reviewer found issues", deps);
  setGhRunId(undefined);

  assert.equal(posted.length, 1);
  assert.ok(
    posted[0].includes("<!-- pipeline-audit: run=259/2026-06-20T20:00:00Z state=fix-1 -->"),
    `comment must contain sentinel; got: ${posted[0]}`,
  );
});

test("transition: retries postComment on first failure and posts exactly once", async () => {
  setGhRunId("259/2026-06-20T20:00:00Z");
  let postCalls = 0;
  const deps: TransitionDeps = {
    getIssueDetail: async () => ({ labels: [] }),
    editLabels: async () => {},
    postComment: async (_cfg, _n, _body) => {
      postCalls++;
      if (postCalls === 1) throw new Error("network blip");
    },
    sleep: async () => {},
  };
  await transition(fakeCfg, 42, "review-1", "fix-1", "summary", deps);
  setGhRunId(undefined);

  assert.equal(postCalls, 2, "must call postComment twice (1 fail + 1 success)");
});

test("transition: propagates error when all retries exhaust", async () => {
  setGhRunId("259/2026-06-20T20:00:00Z");
  let postCalls = 0;
  const deps: TransitionDeps = {
    getIssueDetail: async () => ({ labels: [] }),
    editLabels: async () => {},
    postComment: async () => { postCalls++; throw new Error("persistent failure"); },
    sleep: async () => {},
  };
  await assert.rejects(
    () => transition(fakeCfg, 42, "review-1", "fix-1", "summary", deps),
    /persistent failure/,
  );
  setGhRunId(undefined);
  assert.equal(postCalls, 3, "must exhaust all 3 attempts");
});

test("transition: uses _activeRunId=unknown when no run id is set", async () => {
  setGhRunId(undefined);
  const posted: string[] = [];
  const deps: TransitionDeps = {
    getIssueDetail: async () => ({ labels: [] }),
    editLabels: async () => {},
    postComment: async (_cfg, _n, body) => { posted.push(body); },
    sleep: async () => {},
  };
  await transition(fakeCfg, 42, "planning", "review-1", "", deps);
  assert.ok(
    posted[0].includes("state=review-1 -->"),
    "sentinel must reference the toStage",
  );
  assert.ok(
    posted[0].includes("run=unknown"),
    "run must fall back to 'unknown' when no active run id",
  );
});

// ---------------------------------------------------------------------------
// setBlocked() — sentinel embedded, retry used
// ---------------------------------------------------------------------------

test("setBlocked: comment body contains the blocked audit sentinel", async () => {
  setGhRunId("259/2026-06-20T20:00:00Z");
  const posted: string[] = [];
  const deps: SetBlockedDeps = {
    getIssueDetail: async () => ({ labels: ["pipeline:review-1", "harness:codex"] }),
    addBlockedLabel: async () => {},
    postComment: async (_cfg, _n, body) => { posted.push(body); },
    sleep: async () => {},
  };
  await setBlocked(fakeCfg, 42, "test reason", "review-1", "needs-human", deps);
  setGhRunId(undefined);

  assert.equal(posted.length, 1);
  assert.ok(
    posted[0].includes("<!-- pipeline-audit: run=259/2026-06-20T20:00:00Z state=blocked -->"),
    `comment must contain blocked sentinel; got: ${posted[0]}`,
  );
});

test("setBlocked: retries postComment on first failure", async () => {
  setGhRunId("259/2026-06-20T20:00:00Z");
  let postCalls = 0;
  const deps: SetBlockedDeps = {
    getIssueDetail: async () => ({ labels: [] }),
    addBlockedLabel: async () => {},
    postComment: async () => {
      postCalls++;
      if (postCalls === 1) throw new Error("transient");
    },
    sleep: async () => {},
  };
  await setBlocked(fakeCfg, 42, "reason", null, "needs-human", deps);
  setGhRunId(undefined);
  assert.equal(postCalls, 2, "must retry once and succeed");
});
