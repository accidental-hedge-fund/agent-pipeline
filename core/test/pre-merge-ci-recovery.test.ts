// Pre-merge CI classify + bounded recovery ladder (#679).
// All I/O via AdvancePreMergeDeps — no live network/git/subprocess.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  buildCiExhaustedBlockReason,
  loadCiRecoveryMarkers,
  type AdvancePreMergeDeps,
  type PreMergePollingContext,
} from "../scripts/stages/pre_merge.ts";
import { extractWorkflowRunId, trimLogExcerpt } from "../scripts/gh.ts";
import type { CheckRun, PipelineConfig } from "../scripts/types.ts";

const ISSUE = 679;
const PR = 678;
const SHA_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_PRE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RUN_URL = "https://github.com/acme/x/actions/runs/30476223443";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
  pre_merge_ci_assertion_fix: false,
  pre_merge_ci_rerun_enabled: true,
} as unknown as PipelineConfig;

const reviewComment = `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA_HEAD} -->`;

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

function baseDeps(overrides: Partial<AdvancePreMergeDeps> = {}): {
  deps: AdvancePreMergeDeps;
  rec: {
    blocked: Array<{ reason: string; kind: string }>;
    reruns: number;
    closeReopen: number;
    assertionFix: number;
  };
} {
  const rec = { blocked: [] as Array<{ reason: string; kind: string }>, reruns: 0, closeReopen: 0, assertionFix: 0 };
  const deps: AdvancePreMergeDeps = {
    getPrForIssue: async () => PR,
    getIssueDetail: (async () => ({
      comments: [{ body: reviewComment }],
    })) as AdvancePreMergeDeps["getIssueDetail"],
    getPrDetail: (async () => ({
      head_sha: SHA_HEAD,
      mergeable: true,
      mergeable_state: "CLEAN",
    })) as AdvancePreMergeDeps["getPrDetail"],
    getPrCommits: async () => [],
    getPrChecks: async () => [
      { name: "test", bucket: "fail", link: RUN_URL } as CheckRun,
    ],
    getForIssue: (async () => ({ path: "/wt", slug: "s" })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => false,
    rebaseAlreadyAttempted: () => true,
    tryRebaseAndPush: async () => {
      throw new Error("rebase must not be called when already attempted");
    },
    markRebaseAttempted: () => {},
    fetchCheckLogExcerpt: async () =>
      "Unable to deserialize cloned data due to invalid or unsupported version",
    rerunFailedWorkflows: async () => {
      rec.reruns++;
      return { attempted: true, runIds: ["30476223443"] };
    },
    closePr: async () => {
      rec.closeReopen++;
    },
    reopenPr: async () => {
      rec.closeReopen++;
    },
    getSuccessfulCheckRunCount: async () => 0,
    getDiffFilePaths: async () => [],
    setBlocked: (async (_c, _n, reason, _s, kind) => {
      rec.blocked.push({ reason, kind: kind ?? "" });
    }) as AdvancePreMergeDeps["setBlocked"],
    transition: async () => {},
    postComment: async () => {},
    getGhActor: async () => "test-actor",
    getPrDiff: async () => "",
    ...overrides,
  };
  return { deps, rec };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test("extractWorkflowRunId parses actions run URLs", () => {
  assert.equal(extractWorkflowRunId(RUN_URL), "30476223443");
  assert.equal(
    extractWorkflowRunId(`${RUN_URL}/job/999`),
    "30476223443",
  );
  assert.equal(extractWorkflowRunId(undefined), null);
  assert.equal(extractWorkflowRunId("https://example.com/other"), null);
});

test("trimLogExcerpt keeps last lines and caps size", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  const out = trimLogExcerpt(lines.join("\n"), 10, 500);
  assert.ok(out);
  assert.ok(out!.includes("line 99"));
  assert.ok(!out!.includes("line 0"));
});

test("buildCiExhaustedBlockReason includes URL, SHA, classification, recipe cues", () => {
  const reason = buildCiExhaustedBlockReason({
    failedChecks: [{ name: "test", bucket: "fail", state: "FAILURE", link: RUN_URL }],
    headSha: SHA_HEAD,
    classification: "infra",
    logExcerpt: "Unable to deserialize cloned data",
    preArchiveGreenSha: SHA_PRE,
    rerunAttempted: true,
    archiveFailRecoveryAttempted: false,
    assertionFixAttempted: false,
    assertionFixEnabled: false,
    rerunEnabled: true,
  });
  assert.match(reason, /classification: infra/);
  assert.ok(reason.includes(SHA_HEAD));
  assert.ok(reason.includes(SHA_PRE));
  assert.ok(reason.includes(RUN_URL));
  assert.ok(reason.includes("test: fail"));
  assert.ok(reason.includes("Unable to deserialize"));
  assert.match(reason, /re-run budget/i);
});

// ---------------------------------------------------------------------------
// 6.1 flake → re-run → green advances without setBlocked
// ---------------------------------------------------------------------------

test("flake fail → re-run → green advances without needs-human", async (t) => {
  let poll = 0;
  const { deps, rec } = baseDeps({
    getPrChecks: async () => {
      poll++;
      if (poll === 1) {
        return [{ name: "test", bucket: "fail", link: RUN_URL } as CheckRun];
      }
      return [{ name: "test", bucket: "pass" } as CheckRun];
    },
  });
  const pollingCtx: PreMergePollingContext = {};

  let first;
  await quiet(t, async () => {
    first = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(first!.status, "waiting");
  assert.equal(rec.reruns, 1);
  assert.equal(rec.blocked.length, 0);
  assert.equal(pollingCtx.ciRerunAttemptedForSha, SHA_HEAD);

  let second;
  await quiet(t, async () => {
    second = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(second!.advanced, true, "green after re-run must advance");
  assert.equal(rec.blocked.length, 0, "must never setBlocked for CI on this path");
  assert.equal(rec.reruns, 1, "must not re-run again after green");
});

// ---------------------------------------------------------------------------
// 6.2 double fail → single ci-exhausted; re-run once
// ---------------------------------------------------------------------------

test("double fail after re-run → single ci-exhausted block; re-run not called twice", async (t) => {
  const { deps, rec } = baseDeps();
  const pollingCtx: PreMergePollingContext = {};

  let first;
  await quiet(t, async () => {
    first = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(first!.status, "waiting");
  assert.equal(rec.reruns, 1);

  let second;
  await quiet(t, async () => {
    second = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(second!.status, "blocked");
  assert.equal(second!.reason, "CI failed");
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
  assert.match(rec.blocked[0].reason, /classification: infra/);
  assert.ok(rec.blocked[0].reason.includes(RUN_URL));
  assert.ok(rec.blocked[0].reason.includes(SHA_HEAD));
  assert.equal(rec.reruns, 1, "re-run seam not called twice for same SHA");
});

// ---------------------------------------------------------------------------
// 6.3 durable marker after simulated restart skips second re-run
// ---------------------------------------------------------------------------

test("durable marker after simulated restart skips second re-run", async (t) => {
  const runDir = await mkdtemp(join(tmpdir(), "ci-recovery-"));
  try {
    const { deps, rec } = baseDeps();

    // Process 1: first red → re-run, markers flushed to runDir.
    const ctx1: PreMergePollingContext = {};
    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx: ctx1, runDir }, deps);
    });
    assert.equal(rec.reruns, 1);
    const disk = loadCiRecoveryMarkers(runDir);
    assert.equal(disk.ciRerunAttemptedForSha, SHA_HEAD);
    const raw = await readFile(join(runDir, "pre-merge-ci-recovery.json"), "utf8");
    assert.match(raw, new RegExp(SHA_HEAD));

    // Process 2: empty in-memory ctx, same runDir → hydrates, escalates without re-run.
    const ctx2: PreMergePollingContext = {};
    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx: ctx2, runDir }, deps);
    });
    assert.equal(out!.status, "blocked");
    assert.equal(rec.reruns, 1, "restart must not re-consume re-run budget");
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6.4 archive-only + prior green prefers recovery; assertion does not close+reopen
// ---------------------------------------------------------------------------

test("archive-only + prior green + infra — re-run before block", async (t) => {
  const { deps, rec } = baseDeps({
    getDiffFilePaths: async () => ["openspec/specs/x/spec.md"],
    getSuccessfulCheckRunCount: async (sha) => (sha === SHA_PRE ? 2 : 0),
  });
  const pollingCtx: PreMergePollingContext = { preArchiveSha: SHA_PRE };

  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(out!.status, "waiting");
  assert.equal(rec.reruns, 1);
  assert.equal(rec.closeReopen, 0, "re-run first; no close+reopen yet");
  assert.equal(rec.blocked.length, 0);
});

test("archive-only + prior green after re-run exhausted — one close+reopen then wait", async (t) => {
  const { deps, rec } = baseDeps({
    getDiffFilePaths: async () => ["openspec/changes/archive/x.md"],
    getSuccessfulCheckRunCount: async () => 1,
  });
  const pollingCtx: PreMergePollingContext = {
    preArchiveSha: SHA_PRE,
    ciRerunAttemptedForSha: SHA_HEAD,
  };

  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(out!.status, "waiting");
  assert.match(out!.reason ?? "", /closed and reopened/i);
  assert.equal(rec.closeReopen, 2, "close + reopen once each");
  assert.equal(rec.reruns, 0);
  assert.equal(rec.blocked.length, 0);
  assert.equal(pollingCtx.ciArchiveFailRecoveryAttemptedForSha, SHA_HEAD);
});

test("archive-only assertion failure does not close+reopen to hide product red", async (t) => {
  const { deps, rec } = baseDeps({
    fetchCheckLogExcerpt: async () => "AssertionError: expected 1 to equal 2",
    getDiffFilePaths: async () => ["openspec/specs/x/spec.md"],
    getSuccessfulCheckRunCount: async () => 1,
  });
  const pollingCtx: PreMergePollingContext = { preArchiveSha: SHA_PRE };

  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(out!.status, "blocked");
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
  assert.equal(rec.closeReopen, 0, "must not close+reopen for assertion archive-only");
  assert.equal(rec.reruns, 0, "assertion does not take infra re-run path");
});

// ---------------------------------------------------------------------------
// 6.5 assertion fix disabled / enabled
// ---------------------------------------------------------------------------

test("assertion fix disabled escalates without auto-fix", async (t) => {
  let fixCalls = 0;
  const { deps, rec } = baseDeps({
    fetchCheckLogExcerpt: async () => "AssertionError: boom",
    runCiAssertionFix: async () => {
      fixCalls++;
      return { ok: true };
    },
  });
  // pre_merge_ci_assertion_fix defaults false on cfg
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx: {} }, deps);
  });
  assert.equal(out!.status, "blocked");
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
  assert.equal(fixCalls, 0);
});

test("assertion fix enabled runs once then stops", async (t) => {
  let fixCalls = 0;
  const cfgFix = {
    ...cfg,
    pre_merge_ci_assertion_fix: true,
  } as unknown as PipelineConfig;
  const { deps, rec } = baseDeps({
    fetchCheckLogExcerpt: async () => "AssertionError: boom",
    runCiAssertionFix: async () => {
      fixCalls++;
      return { ok: true };
    },
  });
  const pollingCtx: PreMergePollingContext = {};

  let first;
  await quiet(t, async () => {
    first = await advance(cfgFix, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(first!.status, "waiting");
  assert.equal(fixCalls, 1);
  assert.equal(pollingCtx.ciAssertionFixAttemptedForSha, SHA_HEAD);

  let second;
  await quiet(t, async () => {
    second = await advance(cfgFix, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(second!.status, "blocked");
  assert.equal(fixCalls, 1, "must not invoke assertion fix twice");
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
});

// ---------------------------------------------------------------------------
// #181 non-regression: never infinite waiting on definitive red when budget done
// ---------------------------------------------------------------------------

test("#181 non-regression: budget exhausted returns blocked not waiting", async (t) => {
  const { deps, rec } = baseDeps({
    rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
  });
  const pollingCtx: PreMergePollingContext = {
    ciRerunAttemptedForSha: SHA_HEAD,
    ciArchiveFailRecoveryAttemptedForSha: SHA_HEAD,
  };
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(out!.status, "blocked");
  assert.notEqual(out!.status, "waiting");
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
});

test("new head SHA resets re-run budget", async (t) => {
  const SHA2 = "cccccccccccccccccccccccccccccccccccccccc";
  let head = SHA_HEAD;
  const { deps, rec } = baseDeps({
    getPrDetail: (async () => ({
      head_sha: head,
      mergeable: true,
      mergeable_state: "CLEAN",
    })) as AdvancePreMergeDeps["getPrDetail"],
  });
  // Force a review comment that matches whatever head we use.
  deps.getIssueDetail = (async () => ({
    comments: [{ body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${head} -->` }],
  })) as AdvancePreMergeDeps["getIssueDetail"];

  const pollingCtx: PreMergePollingContext = { ciRerunAttemptedForSha: SHA_HEAD };

  // Still on SHA_HEAD with marker → no re-run, escalate (no archive path).
  let first;
  await quiet(t, async () => {
    first = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(first!.status, "blocked");
  assert.equal(rec.reruns, 0);

  // Advance to new head → fresh re-run budget.
  head = SHA2;
  deps.getIssueDetail = (async () => ({
    comments: [{ body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${SHA2} -->` }],
  })) as AdvancePreMergeDeps["getIssueDetail"];
  rec.blocked.length = 0;

  let second;
  await quiet(t, async () => {
    second = await advance(cfg, ISSUE, { pollingCtx }, deps);
  });
  assert.equal(second!.status, "waiting");
  assert.equal(rec.reruns, 1);
  assert.equal(pollingCtx.ciRerunAttemptedForSha, SHA2);
});
