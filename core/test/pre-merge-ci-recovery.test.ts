// Pre-merge CI classify + bounded recovery ladder (#679).
// All I/O via AdvancePreMergeDeps — no live network/git/subprocess.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  buildCiExhaustedBlockReason,
  loadCiRecoveryMarkers,
  resolveRebasePushResult,
  saveCiRecoveryMarkers,
  type AdvancePreMergeDeps,
  type PreMergePollingContext,
} from "../scripts/stages/pre_merge.ts";
import { extractWorkflowRunId, trimLogExcerpt } from "../scripts/gh.ts";
import { readEvents } from "../scripts/run-store.ts";
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

/** Durable runDir is required before recovery can return waiting (#679). */
async function withRunDir<T>(fn: (runDir: string) => Promise<T>): Promise<T> {
  const runDir = await mkdtemp(join(tmpdir(), "ci-recovery-"));
  try {
    return await fn(runDir);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

function baseDeps(overrides: Partial<AdvancePreMergeDeps> = {}): {
  deps: AdvancePreMergeDeps;
  rec: {
    blocked: Array<{ reason: string; kind: string }>;
    reruns: number;
    closeCalls: number;
    reopenCalls: number;
    assertionFix: number;
  };
} {
  const rec = {
    blocked: [] as Array<{ reason: string; kind: string }>,
    reruns: 0,
    closeCalls: 0,
    reopenCalls: 0,
    assertionFix: 0,
  };
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
      rec.closeCalls++;
    },
    reopenPr: async () => {
      rec.reopenCalls++;
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

test("buildCiExhaustedBlockReason surfaces closed PR reopen step", () => {
  const reason = buildCiExhaustedBlockReason({
    failedChecks: [{ name: "test", bucket: "fail", link: RUN_URL }],
    headSha: SHA_HEAD,
    classification: "infra",
    logExcerpt: null,
    rerunAttempted: true,
    archiveFailRecoveryAttempted: true,
    assertionFixAttempted: false,
    assertionFixEnabled: false,
    rerunEnabled: true,
    prLeftClosed: { prNumber: PR },
    closeReopenError: "close succeeded; reopen failed",
  });
  assert.match(reason, /CRITICAL: PR #678 is still CLOSED/i);
  assert.match(reason, /gh pr reopen 678/);
  assert.match(reason, /reopen PR #678/i);
});

test("saveCiRecoveryMarkers fails closed without runDir", () => {
  const result = saveCiRecoveryMarkers(undefined, { ciRerunAttemptedForSha: SHA_HEAD });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /runDir unavailable/);
});

// ---------------------------------------------------------------------------
// 6.1 flake → re-run → green advances without setBlocked
// ---------------------------------------------------------------------------

test("flake fail → re-run → green advances without needs-human", async (t) => {
  await withRunDir(async (runDir) => {
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
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.equal(rec.reruns, 1);
    assert.equal(rec.blocked.length, 0);
    assert.equal(pollingCtx.ciRerunAttemptedForSha, SHA_HEAD);

    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.advanced, true, "green after re-run must advance");
    assert.equal(rec.blocked.length, 0, "must never setBlocked for CI on this path");
    assert.equal(rec.reruns, 1, "must not re-run again after green");
  });
});

// ---------------------------------------------------------------------------
// 6.2 double fail → single ci-exhausted; re-run once
// ---------------------------------------------------------------------------

test("double fail after re-run → single ci-exhausted block; re-run not called twice", async (t) => {
  await withRunDir(async (runDir) => {
    const { deps, rec } = baseDeps();
    const pollingCtx: PreMergePollingContext = {};

    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.equal(rec.reruns, 1);

    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
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
});

// ---------------------------------------------------------------------------
// 6.3 durable marker after simulated restart skips second re-run
// ---------------------------------------------------------------------------

test("durable marker after simulated restart skips second re-run", async (t) => {
  await withRunDir(async (runDir) => {
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
  });
});

// ---------------------------------------------------------------------------
// 6.3b marker-write failure cannot re-consume recovery after restart (#679)
// ---------------------------------------------------------------------------

test("marker-write failure refuses re-run and restart cannot re-consume budget side-effect", async (t) => {
  // runDir path is a regular file → mkdir/write inside it fails.
  const parent = await mkdtemp(join(tmpdir(), "ci-recovery-bad-"));
  const badRunDir = join(parent, "not-a-dir");
  await writeFile(badRunDir, "not a directory\n");
  try {
    const { deps, rec } = baseDeps();
    const ctx1: PreMergePollingContext = {};
    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx: ctx1, runDir: badRunDir }, deps);
    });
    assert.equal(first!.status, "blocked", "must escalate when markers cannot be persisted");
    assert.equal(rec.reruns, 0, "must not re-run without durable marker");
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
    assert.match(rec.blocked[0].reason, /Durable recovery marker persistence failed/i);

    // Simulated restart: empty ctx, same bad runDir — still no re-run (side-effect never taken).
    const ctx2: PreMergePollingContext = {};
    rec.blocked.length = 0;
    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx: ctx2, runDir: badRunDir }, deps);
    });
    assert.equal(second!.status, "blocked");
    assert.equal(rec.reruns, 0, "restart must not re-run when markers never persisted");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("absent runDir refuses re-run and escalates (no waiting without durable state)", async (t) => {
  const { deps, rec } = baseDeps();
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx: {} }, deps);
  });
  assert.equal(out!.status, "blocked");
  assert.equal(rec.reruns, 0, "must not re-run without runDir");
  assert.equal(rec.blocked[0].kind, "ci-exhausted");
  assert.match(rec.blocked[0].reason, /runDir unavailable|persistence failed/i);
});

// ---------------------------------------------------------------------------
// 6.4 archive-only + prior green prefers recovery; assertion does not close+reopen
// ---------------------------------------------------------------------------

test("archive-only + prior green + infra — re-run before block", async (t) => {
  await withRunDir(async (runDir) => {
    const { deps, rec } = baseDeps({
      getDiffFilePaths: async () => ["openspec/specs/x/spec.md"],
      getSuccessfulCheckRunCount: async (sha) => (sha === SHA_PRE ? 2 : 0),
    });
    const pollingCtx: PreMergePollingContext = { preArchiveSha: SHA_PRE };

    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "waiting");
    assert.equal(rec.reruns, 1);
    assert.equal(rec.closeCalls, 0, "re-run first; no close+reopen yet");
    assert.equal(rec.reopenCalls, 0);
    assert.equal(rec.blocked.length, 0);
  });
});

test("archive-only + prior green after re-run exhausted — one close+reopen then wait", async (t) => {
  await withRunDir(async (runDir) => {
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
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "waiting");
    assert.match(out!.reason ?? "", /closed and reopened/i);
    assert.equal(rec.closeCalls, 1, "close once");
    assert.equal(rec.reopenCalls, 1, "reopen once");
    assert.equal(rec.reruns, 0);
    assert.equal(rec.blocked.length, 0);
    assert.equal(pollingCtx.ciArchiveFailRecoveryAttemptedForSha, SHA_HEAD);
  });
});

// Restart after re-run must still see archive-only prior-green (preArchiveSha durable).
// Without hydrating preArchiveSha, a second process would re-capture the current head
// and skip close+reopen, escalating without pre-archive green evidence (#679 review 2).
test("archive-only prior-green: restart after re-run still close+reopens; escalate retains pre-archive SHA", async (t) => {
  await withRunDir(async (runDir) => {
    const { deps, rec } = baseDeps({
      getDiffFilePaths: async (_cfg, base, head) => {
        // Only the true pre-archive baseline yields openspec-only paths.
        if (base === SHA_PRE && head === SHA_HEAD) {
          return ["openspec/changes/archive/x.md"];
        }
        return ["core/scripts/stages/pre_merge.ts"];
      },
      // Seam is (cfg, sha) — match production signature so prior-green is real.
      getSuccessfulCheckRunCount: async (_cfg, sha) => (sha === SHA_PRE ? 2 : 0),
    });

    // Process 1: archive-only + prior green + infra → re-run; baseline + re-run marker on disk.
    const ctx1: PreMergePollingContext = { preArchiveSha: SHA_PRE };
    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx: ctx1, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.equal(rec.reruns, 1);
    assert.equal(rec.closeCalls, 0);
    const diskAfterRerun = loadCiRecoveryMarkers(runDir);
    assert.equal(diskAfterRerun.ciRerunAttemptedForSha, SHA_HEAD);
    assert.equal(
      diskAfterRerun.preArchiveSha,
      SHA_PRE,
      "preArchiveSha must be durable alongside re-run marker",
    );

    // Process 2: empty in-memory ctx (simulated restart). Must hydrate preArchiveSha
    // and take close+reopen — not re-run again, not premature escalate.
    const ctx2: PreMergePollingContext = {};
    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx: ctx2, runDir }, deps);
    });
    assert.equal(second!.status, "waiting");
    assert.match(second!.reason ?? "", /closed and reopened/i);
    assert.equal(rec.reruns, 1, "restart must not re-consume re-run budget");
    assert.equal(rec.closeCalls, 1, "archive close+reopen after re-run on restart");
    assert.equal(rec.reopenCalls, 1);
    assert.equal(rec.blocked.length, 0);
    assert.equal(ctx2.preArchiveSha, SHA_PRE, "hydrated preArchiveSha after restart");
    assert.equal(ctx2.ciArchiveFailRecoveryAttemptedForSha, SHA_HEAD);

    // Process 3: still red, budget exhausted → escalate with pre-archive green evidence.
    const ctx3: PreMergePollingContext = {};
    let third;
    await quiet(t, async () => {
      third = await advance(cfg, ISSUE, { pollingCtx: ctx3, runDir }, deps);
    });
    assert.equal(third!.status, "blocked");
    assert.equal(rec.closeCalls, 1, "must not thrash close+reopen after restart");
    assert.equal(rec.reruns, 1);
    assert.equal(rec.blocked.length, 1);
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
    assert.ok(
      rec.blocked[0].reason.includes(SHA_PRE),
      "escalation reason must retain pre-archive green SHA after restart",
    );
    assert.ok(rec.blocked[0].reason.includes(SHA_HEAD));
  });
});

test("archive close succeeds reopen fails — retry reopen; escalate with PR closed guidance", async (t) => {
  await withRunDir(async (runDir) => {
    let reopenAttempts = 0;
    const { deps, rec } = baseDeps({
      getDiffFilePaths: async () => ["openspec/changes/archive/x.md"],
      getSuccessfulCheckRunCount: async () => 1,
      reopenPr: async () => {
        reopenAttempts++;
        rec.reopenCalls++;
        throw new Error(`gh: reopen failed attempt ${reopenAttempts}`);
      },
    });
    const pollingCtx: PreMergePollingContext = {
      preArchiveSha: SHA_PRE,
      ciRerunAttemptedForSha: SHA_HEAD,
    };

    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "blocked");
    assert.equal(rec.closeCalls, 1, "close once");
    assert.equal(reopenAttempts, 2, "reopen retried once after initial failure");
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
    assert.match(rec.blocked[0].reason, /still CLOSED/i);
    assert.match(rec.blocked[0].reason, /gh pr reopen 678/);
    assert.match(rec.blocked[0].reason, /close succeeded; reopen failed/i);
    assert.equal(pollingCtx.ciArchiveFailRecoveryAttemptedForSha, SHA_HEAD);
  });
});

test("archive close succeeds reopen recovers on retry → waiting", async (t) => {
  await withRunDir(async (runDir) => {
    let reopenAttempts = 0;
    const { deps, rec } = baseDeps({
      getDiffFilePaths: async () => ["openspec/changes/archive/x.md"],
      getSuccessfulCheckRunCount: async () => 1,
      reopenPr: async () => {
        reopenAttempts++;
        rec.reopenCalls++;
        if (reopenAttempts === 1) throw new Error("transient reopen failure");
      },
    });
    const pollingCtx: PreMergePollingContext = {
      preArchiveSha: SHA_PRE,
      ciRerunAttemptedForSha: SHA_HEAD,
    };

    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "waiting");
    assert.equal(reopenAttempts, 2);
    assert.equal(rec.closeCalls, 1);
    assert.equal(rec.blocked.length, 0);
  });
});

test("archive-only assertion failure does not close+reopen to hide product red", async (t) => {
  await withRunDir(async (runDir) => {
    const { deps, rec } = baseDeps({
      fetchCheckLogExcerpt: async () => "AssertionError: expected 1 to equal 2",
      getDiffFilePaths: async () => ["openspec/specs/x/spec.md"],
      getSuccessfulCheckRunCount: async () => 1,
    });
    const pollingCtx: PreMergePollingContext = { preArchiveSha: SHA_PRE };

    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "blocked");
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
    assert.equal(rec.closeCalls, 0, "must not close+reopen for assertion archive-only");
    assert.equal(rec.reruns, 0, "assertion does not take infra re-run path");
  });
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
  await withRunDir(async (runDir) => {
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
      first = await advance(cfgFix, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.equal(fixCalls, 1);
    assert.equal(pollingCtx.ciAssertionFixAttemptedForSha, SHA_HEAD);

    let second;
    await quiet(t, async () => {
      second = await advance(cfgFix, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.status, "blocked");
    assert.equal(fixCalls, 1, "must not invoke assertion fix twice");
    assert.equal(rec.blocked[0].kind, "ci-exhausted");
  });
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
  await withRunDir(async (runDir) => {
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
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
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
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.status, "waiting");
    assert.equal(rec.reruns, 1);
    assert.equal(pollingCtx.ciRerunAttemptedForSha, SHA2);
  });
});

// ---------------------------------------------------------------------------
// #771 settled-failure no-thrash regressions
// ---------------------------------------------------------------------------

const SHA_H2 = "dddddddddddddddddddddddddddddddddddddddd";

test("#771 1.1 settled failure + budget exhausted → blocked; rebase at most once across hops", async (t) => {
  await withRunDir(async (runDir) => {
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        // Success but HEAD unchanged → no-op rebase thrash class.
        return true;
      },
      // Exhaust remaining ladder on same tick after no-op rebase.
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
    });
    const pollingCtx: PreMergePollingContext = {};

    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "blocked");
    assert.equal(first!.reason, "CI failed");
    assert.equal(rec.blocked[0]?.kind, "ci-exhausted");
    assert.equal(rebaseCalls, 1, "first hop may attempt one rebase");
    assert.equal(pollingCtx.ciRebaseAttemptedForSha, SHA_HEAD);

    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.status, "blocked");
    assert.equal(rebaseCalls, 1, "second hop must not re-invoke tryRebaseAndPush for same head");
  });
});

test("#771 1.2 pending checks remain waiting — no false settle / no ci-exhausted", async (t) => {
  const { deps, rec } = baseDeps({
    getPrChecks: async () => [{ name: "test", bucket: "pending" } as CheckRun],
    rebaseAlreadyAttempted: () => false,
    tryRebaseAndPush: async () => {
      throw new Error("must not rebase while pending");
    },
  });
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx: {} }, deps);
  });
  assert.equal(out!.status, "waiting");
  assert.match(out!.reason ?? "", /CI still running/i);
  assert.equal(rec.blocked.length, 0, "must not setBlocked ci-exhausted while pending");
});

test("#771 1.3 red + pending → waiting, no recovery side-effect", async (t) => {
  let rebaseCalls = 0;
  let reruns = 0;
  const { deps, rec } = baseDeps({
    getPrChecks: async () =>
      [
        { name: "test", bucket: "fail", link: RUN_URL },
        { name: "lint", bucket: "pending" },
      ] as CheckRun[],
    rebaseAlreadyAttempted: () => false,
    tryRebaseAndPush: async () => {
      rebaseCalls++;
      return true;
    },
    rerunFailedWorkflows: async () => {
      reruns++;
      return { attempted: true, runIds: ["1"] };
    },
  });
  let out;
  await quiet(t, async () => {
    out = await advance(cfg, ISSUE, { pollingCtx: {}, runDir: undefined }, deps);
  });
  assert.equal(out!.status, "waiting");
  assert.equal(rebaseCalls, 0, "pending precedence: no rebase");
  assert.equal(reruns, 0, "pending precedence: no re-run");
  assert.equal(rec.blocked.length, 0);
});

test("#771 1.4 after one allowlisted recovery at H, second hop blocks (no re-invoke)", async (t) => {
  await withRunDir(async (runDir) => {
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true; // no-op HEAD
      },
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "n/a" }),
    });
    const pollingCtx: PreMergePollingContext = {};

    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(rebaseCalls, 1);
    assert.equal(rec.blocked.length, 1);

    rec.blocked.length = 0;
    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.status, "blocked");
    assert.equal(rebaseCalls, 1, "must not rebase again after one-shot budget");
    assert.equal(rec.blocked.length, 1);
  });
});

test("#771 1.5 rebase success but HEAD unchanged → not rebased; CI re-running; budget consumed", async (t) => {
  await withRunDir(async (runDir) => {
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true;
      },
      // Force escalate after no-op rebase (no re-run side-effect wait).
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
    });
    const pollingCtx: PreMergePollingContext = {};

    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.notEqual(first!.reason, "rebased; CI re-running");
    assert.equal(first!.status, "blocked");
    assert.equal(pollingCtx.ciRebaseAttemptedForSha, SHA_HEAD);
    assert.equal(loadCiRecoveryMarkers(runDir).ciRebaseAttemptedForSha, SHA_HEAD);

    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(rebaseCalls, 1, "second hop does not rebase again");
    assert.equal(rec.blocked.length, 2); // block each hop is ok; no thrash wait
  });
});

test("#771 1.6 rebase moves HEAD H1→H2 → waiting rebased; pending on H2 stays waiting", async (t) => {
  await withRunDir(async (runDir) => {
    let head = SHA_HEAD;
    let poll = 0;
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      getPrDetail: (async () => ({
        head_sha: head,
        mergeable: true,
        mergeable_state: "CLEAN",
      })) as AdvancePreMergeDeps["getPrDetail"],
      getIssueDetail: (async () => ({
        comments: [
          {
            body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${head} -->`,
          },
        ],
      })) as AdvancePreMergeDeps["getIssueDetail"],
      getPrChecks: async () => {
        poll++;
        if (poll === 1) {
          return [{ name: "test", bucket: "fail", link: RUN_URL } as CheckRun];
        }
        // After rebase moved head: CI pending on new tip.
        return [{ name: "test", bucket: "pending" } as CheckRun];
      },
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        head = SHA_H2;
        return true;
      },
    });
    // Keep review SHA gate aligned after head move (second poll).
    const origGetIssue = deps.getIssueDetail!;
    deps.getIssueDetail = (async () => ({
      comments: [
        {
          body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${head} -->`,
        },
      ],
    })) as AdvancePreMergeDeps["getIssueDetail"];
    void origGetIssue;

    const pollingCtx: PreMergePollingContext = {};

    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.equal(first!.reason, "rebased; CI re-running");
    assert.equal(rebaseCalls, 1);
    assert.equal(rec.blocked.length, 0);

    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(second!.status, "waiting");
    assert.match(second!.reason ?? "", /CI still running/i);
    assert.equal(rebaseCalls, 1, "must not rebase again while pending on H2");
    assert.equal(rec.blocked.length, 0);
  });
});

test("#771 1.7 durable rebase marker survives process restart — no second rebase", async (t) => {
  await withRunDir(async (runDir) => {
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true; // no-op head
      },
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
    });

    const ctx1: PreMergePollingContext = {};
    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx: ctx1, runDir }, deps);
    });
    assert.equal(rebaseCalls, 1);
    assert.equal(loadCiRecoveryMarkers(runDir).ciRebaseAttemptedForSha, SHA_HEAD);

    // Fresh process: empty ctx, hydrate from disk; worktree marker absent (recreated).
    const ctx2: PreMergePollingContext = {};
    deps.rebaseAlreadyAttempted = () => false;
    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx: ctx2, runDir }, deps);
    });
    assert.equal(second!.status, "blocked");
    assert.equal(rebaseCalls, 1, "restart must not re-consume durable rebase budget");
    assert.equal(rec.blocked[rec.blocked.length - 1]!.kind, "ci-exhausted");
  });
});

test("#771 1.8 terminal gate_result ci/fail once per failed SHA; no partial rebased spam", async (t) => {
  await withRunDir(async (runDir) => {
    let rebaseCalls = 0;
    const { deps } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true;
      },
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
    });
    const pollingCtx: PreMergePollingContext = {};

    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    await quiet(t, async () => {
      await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });

    const events = await readEvents(runDir);
    const ciFails = events.filter(
      (e) => e.type === "gate_result" && (e as { gate?: string }).gate === "ci" &&
        (e as { result?: string }).result === "fail",
    );
    const rebasedPartials = events.filter(
      (e) =>
        e.type === "gate_result" &&
        (e as { gate?: string }).gate === "ci" &&
        (e as { result?: string }).result === "partial" &&
        String((e as { reason?: string }).reason ?? "").includes("rebased; CI re-running"),
    );
    assert.equal(ciFails.length, 1, "terminal ci/fail once per failed head SHA");
    assert.equal(rebasedPartials.length, 0, "must not spam partial rebased rows on pure re-poll");
    assert.equal(rebaseCalls, 1);
    assert.equal(pollingCtx.ciTerminalFailRecordedForSha, SHA_HEAD);
  });
});

test("#771 1.9 persist failure → ci-exhausted; no rebase side-effect thrash", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "ci-rebase-bad-"));
  const badRunDir = join(parent, "not-a-dir");
  await writeFile(badRunDir, "not a directory\n");
  try {
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true;
      },
    });
    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx: {}, runDir: badRunDir }, deps);
    });
    assert.equal(out!.status, "blocked");
    assert.equal(rebaseCalls, 0, "must not rebase without durable marker");
    assert.equal(rec.blocked[0]!.kind, "ci-exhausted");
    assert.match(rec.blocked[0]!.reason, /Durable recovery marker persistence failed|runDir|persist/i);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("#771 concurrent head change during CI poll → wait re-eval; no recovery on stale SHA", async (t) => {
  await withRunDir(async (runDir) => {
    let head = SHA_HEAD;
    let rebaseCalls = 0;
    let reruns = 0;
    const { deps, rec } = baseDeps({
      getPrDetail: (async () => ({
        head_sha: head,
        mergeable: true,
        mergeable_state: "CLEAN",
      })) as AdvancePreMergeDeps["getPrDetail"],
      getPrChecks: async () => {
        // Simulate a concurrent developer push while getPrChecks is in flight:
        // checks return red for the pre-poll tip, then head moves before recovery.
        const checks = [{ name: "test", bucket: "fail", link: RUN_URL } as CheckRun];
        head = SHA_H2;
        return checks;
      },
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        return true;
      },
      rerunFailedWorkflows: async () => {
        reruns++;
        return { attempted: true, runIds: ["1"] };
      },
    });
    const pollingCtx: PreMergePollingContext = {};
    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "waiting");
    assert.match(out!.reason ?? "", /head advanced|waiting for checks/i);
    assert.equal(rebaseCalls, 0, "must not tryRebaseAndPush against a post-poll concurrent head");
    assert.equal(reruns, 0, "must not re-run workflows for the stale polled SHA");
    assert.equal(rec.blocked.length, 0);
    assert.equal(
      pollingCtx.ciRebaseAttemptedForSha,
      undefined,
      "must not consume rebase budget for the pre-poll SHA when head moved",
    );
  });
});

test("#771 1.10 external head advance during failed rebase → wait re-eval; no thrash for old SHA", async (t) => {
  await withRunDir(async (runDir) => {
    let head = SHA_HEAD;
    let rebaseCalls = 0;
    const { deps, rec } = baseDeps({
      getPrDetail: (async () => ({
        head_sha: head,
        mergeable: true,
        mergeable_state: "CLEAN",
      })) as AdvancePreMergeDeps["getPrDetail"],
      getIssueDetail: (async () => ({
        comments: [
          {
            body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${head} -->`,
          },
        ],
      })) as AdvancePreMergeDeps["getIssueDetail"],
      rebaseAlreadyAttempted: () => false,
      tryRebaseAndPush: async () => {
        rebaseCalls++;
        // Local rebase failed, but head advanced externally.
        head = SHA_H2;
        return false;
      },
    });
    deps.getIssueDetail = (async () => ({
      comments: [
        {
          body: `## Review 2 (Adversarial) — approve\n\nLGTM\n\n<!-- reviewed-sha: ${head} -->`,
        },
      ],
    })) as AdvancePreMergeDeps["getIssueDetail"];

    const pollingCtx: PreMergePollingContext = {};
    let first;
    await quiet(t, async () => {
      first = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(first!.status, "waiting");
    assert.notEqual(first!.reason, "rebased; CI re-running");
    assert.match(first!.reason ?? "", /head advanced|waiting for checks/i);
    assert.equal(pollingCtx.ciRebaseAttemptedForSha, SHA_HEAD);
    assert.equal(rec.blocked.length, 0);
    assert.equal(rebaseCalls, 1);

    // Second hop still on external head H2 with red checks — may rebase once for H2, not H1.
    let second;
    await quiet(t, async () => {
      second = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    // Either waiting (recovery for H2) or blocked — but never re-rebase for SHA_HEAD.
    assert.ok(second!.status === "waiting" || second!.status === "blocked");
    // Budget for H1 consumed; if a second rebase happened it is for H2 only.
    assert.ok(rebaseCalls <= 2);
  });
});

test("#771 1.11 log fetch failure still escalates with failing check names", async (t) => {
  await withRunDir(async (runDir) => {
    const { deps, rec } = baseDeps({
      rebaseAlreadyAttempted: () => true,
      fetchCheckLogExcerpt: async () => {
        throw new Error("log fetch boom");
      },
      rerunFailedWorkflows: async () => ({ attempted: false, runIds: [], reason: "unavailable" }),
    });
    const pollingCtx: PreMergePollingContext = {
      ciRebaseAttemptedForSha: SHA_HEAD,
      ciRerunAttemptedForSha: SHA_HEAD,
    };
    let out;
    await quiet(t, async () => {
      out = await advance(cfg, ISSUE, { pollingCtx, runDir }, deps);
    });
    assert.equal(out!.status, "blocked");
    assert.equal(rec.blocked[0]!.kind, "ci-exhausted");
    assert.match(rec.blocked[0]!.reason, /test/);
    assert.ok(rec.blocked[0]!.reason.includes(SHA_HEAD));
  });
});

test("#771 resolveRebasePushResult helper truth table", async () => {
  const moved = await resolveRebasePushResult("aaa", true, "bbb");
  assert.deepEqual(moved, { ok: true, headMoved: true, beforeSha: "aaa", afterSha: "bbb" });
  const noop = await resolveRebasePushResult("aaa", true, "aaa");
  assert.deepEqual(noop, { ok: true, headMoved: false, beforeSha: "aaa", afterSha: "aaa" });
  const fail = await resolveRebasePushResult("aaa", false, "aaa");
  assert.equal(fail.ok, false);
  const external = await resolveRebasePushResult("aaa", false, "bbb");
  assert.equal(external.ok, false);
  if (!external.ok) assert.equal(external.afterSha, "bbb");
});
