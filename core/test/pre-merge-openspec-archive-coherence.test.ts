// Pre-merge OpenSpec archive outcome coherence (#714).
//
// Dual-outcome fingerprints this file forbids:
//   #626 skip→block: gate_result openspec-archive skipped/no-candidates while the
//        same pass would residual-block on a still-active change id.
//   #675 partial multi-pass: pass reason lists multiple ids when only a subset
//        actually left openspec/changes/<id>/ (foreign/stacked residual).
//
// Also covers: post-sync candidate membership when the worktree lagged the
// reviewed head that introduced an extra active change.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
} from "../scripts/stages/pre_merge.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const ISSUE = 714;
const PR = 713;
const SLUG = "s";
const BRANCH = `pipeline/${ISSUE}-${SLUG}`;
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  await fn();
}

function appendOnlyRunStore(appended: string[]): RunStoreDeps {
  return {
    readFile: async () => "",
    writeFile: async () => {},
    appendFile: async (_p, data) => {
      appended.push(data);
    },
    rename: async () => {},
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ mtime: new Date(0) }),
  };
}

function gateResults(appended: string[]): Array<Record<string, unknown>> {
  return appended
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.type === "gate_result" && e.gate === "openspec-archive");
}

/** Minimal git fake: clean status, fetch/rev-parse in sync, dirty after archive add. */
function syncedGitFake(opts: {
  archived?: () => boolean;
  extra?: (args: string[]) => { stdout: string; stderr: string; code: number } | null;
}): AdvancePreMergeDeps["gitInWorktree"] {
  let addCalled = false;
  return (async (_p: string, args: string[]) => {
    if (opts.extra) {
      const hit = opts.extra(args);
      if (hit) return hit;
    }
    if (args[0] === "status") {
      if (addCalled || opts.archived?.()) {
        return { stdout: " M openspec/specs/x/spec.md", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
    if (args[0] === "rev-parse") return { stdout: HEAD, stderr: "", code: 0 };
    if (args[0] === "add") {
      addCalled = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "commit" || args[0] === "push" || args[0] === "merge") {
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "diff") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  }) as AdvancePreMergeDeps["gitInWorktree"];
}

function prDiffFor(...ids: string[]): string {
  return ids
    .map((id) => `diff --git a/openspec/changes/${id}/proposal.md b/openspec/changes/${id}/proposal.md\n`)
    .join("");
}

// ---------------------------------------------------------------------------
// 3.1 #626: single active + false skip must not dual-outcome
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec #626: PR-active id with empty worktree diff archives (no skip/no-candidates)", async (t) => {
  // Old dual path: worktree git-diff empty → skipped/no-candidates while PR residual
  // still had single-source-stages-docs. Fixed path drives candidates from PR tip.
  const CHANGE_ID = "single-source-stages-docs";
  const appended: string[] = [];
  const archiveCalls: string[] = [];
  const blocked: Array<{ reason: string; kind?: string }> = [];
  const activeDirs = new Set([CHANGE_ID]);

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () => prDiffFor(CHANGE_ID),
    // Worktree-local git diff is empty (the #626 fingerprint) — must not win over PR set.
    gitInWorktree: syncedGitFake({
      archived: () => archiveCalls.length > 0,
      extra: (args) => {
        if (args[0] === "diff") return { stdout: "", stderr: "", code: 0 };
        return null;
      },
    }),
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      activeDirs.delete(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_c, _n, reason, _s, kind) => {
      blocked.push({ reason, kind });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-626",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const events = gateResults(appended);
  assert.equal(events.length, 1, "exactly one archive gate_result");
  assert.notEqual(events[0].result, "skipped", "must not skip when PR shared set is non-empty");
  assert.notEqual(events[0].reason, "no-candidates");
  assert.deepEqual(archiveCalls, [CHANGE_ID], "must attempt archive for the PR-active id");
  assert.equal(events[0].result, "pass");
  assert.equal(events[0].reason, CHANGE_ID);
  assert.equal((out as { status: string })?.status, "waiting");
  assert.equal(blocked.length, 0, "must not residual-block after a successful archive of the only id");
});

test("maybeArchiveOpenspec #626: PR path claim without tip-tree dir → no-candidates after sync (tip is truth)", async (t) => {
  // Cumulative PR paths can still list a deleted active path; tip-tree membership
  // (listChangeDirs / changeDirExists) is authoritative after base sync (#714).
  const CHANGE_ID = "single-source-stages-docs";
  const appended: string[] = [];
  const archiveCalls: string[] = [];
  const gitCalls: string[][] = [];
  const baseGit = syncedGitFake({})!;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () => prDiffFor(CHANGE_ID),
    gitInWorktree: (async (p, args) => {
      gitCalls.push([...args]);
      return baseGit(p, args);
    }) as AdvancePreMergeDeps["gitInWorktree"],
    listChangeDirs: () => [],
    changeDirExists: () => false,
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {
      throw new Error("must not block when tip tree has no active dirs");
    },
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-626-missing-dir",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const events = gateResults(appended);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "skipped");
  assert.equal(events[0].reason, "no-candidates");
  assert.deepEqual(archiveCalls, [], "no archive attempt without an on-disk dir");
  assert.equal(out, null);
  assert.ok(
    gitCalls.some((a) => a[0] === "fetch"),
    "empty tip decision must still complete archive-base sync first (#714 / 50c7af06)",
  );
});

// ---------------------------------------------------------------------------
// 3.2 #675: partial multi-archive must not pass listing both ids
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec #675: partial multi-archive blocks residual, never pass both ids", async (t) => {
  const ALPHA = "merge-queue-repair";
  const BETA = "foreign-stacked-change";
  const appended: string[] = [];
  const archiveCalls: string[] = [];
  const blocked: Array<{ reason: string; kind?: string }> = [];
  // After CLI "success" for both, only alpha leaves the active tree (partial archive).
  const activeDirs = new Set([ALPHA, BETA]);

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () => prDiffFor(ALPHA, BETA),
    gitInWorktree: syncedGitFake({
      archived: () => archiveCalls.includes(ALPHA),
    }),
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      if (id === ALPHA) activeDirs.delete(id);
      // beta: CLI claims success but dir remains (partial / foreign-stack shape)
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_c, _n, reason, _s, kind) => {
      blocked.push({ reason, kind });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-675",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const events = gateResults(appended);
  assert.equal(events.length, 1);
  assert.notEqual(events[0].result, "pass", "must not pass when residual active ids remain");
  if (typeof events[0].reason === "string") {
    assert.ok(
      !(events[0].reason.includes(ALPHA) && events[0].reason.includes(BETA) && events[0].result === "pass"),
      "pass reason must not list both ids when only one was archived",
    );
  }
  assert.equal(events[0].result, "fail");
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blocked[0]?.kind, "openspec-invalid");
  assert.match(blocked[0]?.reason ?? "", new RegExp(BETA));
  assert.match(blocked[0]?.reason ?? "", /openspec archive/);
  const diagnostic = (out as { diagnostic?: { reason_code?: string; evidence_key?: string } })?.diagnostic;
  assert.equal(diagnostic?.reason_code, "openspec-archive-apply-conflict");
  assert.equal(
    diagnostic?.evidence_key,
    `openspec-archive-apply-conflict:${BETA}:archive_active_change_remains`,
  );
  // Alpha may be mentioned as archived for clarity, but beta must not be presented as archived-only success.
  assert.ok(archiveCalls.includes(ALPHA) && archiveCalls.includes(BETA));
});

// ---------------------------------------------------------------------------
// 3.3 worktree behind reviewed head: PR-active stacked id is still a candidate
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: stacked id only on PR tip is archived after base sync (#714)", async (t) => {
  const STALE_ID = "own-change";
  const STACKED_ID = "foreign-from-merge";
  const archiveCalls: string[] = [];
  const activeDirs = new Set([STALE_ID, STACKED_ID]); // present after FF
  let ffApplied = false;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    // PR tip carries both (stacked merge introduced foreign-from-merge).
    getPrDiff: async () => prDiffFor(STALE_ID, STACKED_ID),
    gitInWorktree: (async (_p, args) => {
      if (args[0] === "status") {
        return archiveCalls.length > 0
          ? { stdout: " M openspec/specs/x/spec.md", stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "rev-parse") {
        if (args[1] === "HEAD") {
          return { stdout: ffApplied ? HEAD : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", stderr: "", code: 0 };
        }
        return { stdout: HEAD, stderr: "", code: 0 };
      }
      if (args[0] === "merge" && args[1] === "--ff-only") {
        ffApplied = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      // Stale local git-diff would only see own-change — must not drive candidates.
      if (args[0] === "diff") {
        return {
          stdout: ffApplied
            ? `openspec/changes/${STALE_ID}/proposal.md\nopenspec/changes/${STACKED_ID}/proposal.md`
            : `openspec/changes/${STALE_ID}/proposal.md`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "add" || args[0] === "commit" || args[0] === "push") {
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      activeDirs.delete(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {
      throw new Error("must not block");
    },
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.ok(ffApplied, "must fast-forward before finalizing archive candidates");
  assert.ok(archiveCalls.includes(STACKED_ID), "stacked/foreign id from PR tip must be an archive candidate");
  assert.ok(archiveCalls.includes(STALE_ID));
  assert.equal((out as { status: string })?.status, "waiting");
});

// ---------------------------------------------------------------------------
// Archive no-op with non-empty shared set must not skip as no-candidates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #714 review 1: reintroduced active after prior archive must not be masked
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: prior archive path in PR diff does not mask reintroduced active dir (#714 cb86b57e)", async (t) => {
  // Cumulative PR list has both archive/…-foo/ and reintroduced openspec/changes/foo/.
  // Path-subtraction helper yields []; tip-tree membership must still archive foo.
  const CHANGE_ID = "foo";
  const archiveCalls: string[] = [];
  const activeDirs = new Set([CHANGE_ID]);
  const appended: string[] = [];

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () =>
      `diff --git a/openspec/changes/${CHANGE_ID}/proposal.md b/openspec/changes/${CHANGE_ID}/proposal.md\n` +
      `diff --git a/openspec/changes/archive/2026-07-30-${CHANGE_ID}/proposal.md b/openspec/changes/archive/2026-07-30-${CHANGE_ID}/proposal.md\n`,
    gitInWorktree: syncedGitFake({
      archived: () => archiveCalls.length > 0,
    }),
    listChangeDirs: () => [...activeDirs],
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      archiveCalls.push(id);
      activeDirs.delete(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async () => {
      throw new Error("must not block when reintroduced active dir is present on tip");
    },
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-reintro",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const events = gateResults(appended);
  assert.equal(events.length, 1);
  assert.notEqual(events[0].result, "skipped", "must not skip/no-candidates when tip has reintroduced active dir");
  assert.notEqual(events[0].reason, "no-candidates");
  assert.deepEqual(archiveCalls, [CHANGE_ID]);
  assert.equal(events[0].result, "pass");
  assert.equal(events[0].reason, CHANGE_ID);
  assert.equal((out as { status: string })?.status, "waiting");
});

// ---------------------------------------------------------------------------
// #714 review 1: empty PR path list must not skip before archive-base sync
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: empty PR paths still sync; sync failure blocks (not no-candidates) (#714 50c7af06)", async (t) => {
  const appended: string[] = [];
  const blocked: Array<{ reason: string; kind?: string }> = [];
  let fetchCalled = false;

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    // Empty cumulative PR file list — old code skipped before sync.
    getPrDiff: async () => "",
    gitInWorktree: (async (_p, args) => {
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "fetch") {
        fetchCalled = true;
        return { stdout: "", stderr: "network unreachable", code: 128 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    listChangeDirs: () => [],
    changeDirExists: () => false,
    openspecArchive: async () => {
      throw new Error("must not archive");
    },
    setBlocked: (async (_c, _n, reason, _s, kind) => {
      blocked.push({ reason, kind });
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-empty-presync",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.equal(fetchCalled, true, "must attempt archive-base fetch even when PR paths are empty");
  const events = gateResults(appended);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "fail");
  assert.notEqual(events[0].reason, "no-candidates");
  assert.equal((out as { status: string })?.status, "blocked");
  assert.equal(blocked[0]?.kind, "needs-human");
  assert.match(blocked[0]?.reason ?? "", /fetch|sync|origin/i);
});

test("maybeArchiveOpenspec: clean status after non-empty archive set fails closed (not no-candidates)", async (t) => {
  const CHANGE_ID = "noop-change";
  const appended: string[] = [];
  const blocked: string[] = [];
  const activeDirs = new Set([CHANGE_ID]);

  const deps: AdvancePreMergeDeps = {
    getForIssue: (async () => ({ path: "/wt", slug: SLUG, branch: BRANCH })) as AdvancePreMergeDeps["getForIssue"],
    openspecIsActive: () => true,
    getPrDiff: async () => prDiffFor(CHANGE_ID),
    gitInWorktree: (async (_p, args) => {
      // Always clean — even after archive — reproduces the old false skip path.
      if (args[0] === "status") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "fetch" || args[0] === "rev-parse" || args[0] === "add") {
        return { stdout: args[0] === "rev-parse" ? HEAD : "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    changeDirExists: (_d, id) => activeDirs.has(id),
    openspecArchive: (async (_w, id) => {
      activeDirs.delete(id);
      return { success: true, unavailable: false, output: "" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: (async (_c, _n, reason) => {
      blocked.push(reason);
    }) as AdvancePreMergeDeps["setBlocked"],
    getIssueDetail: (async () => ({ comments: [] })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    runDir: "/runs/714-noop",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  await quiet(t, async () => {
    await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  const events = gateResults(appended);
  assert.equal(events.length, 1);
  assert.notEqual(events[0].result, "skipped");
  assert.notEqual(events[0].reason, "no-candidates");
  assert.equal(events[0].result, "fail");
  assert.match(blocked[0] ?? "", /no worktree changes|still active|openspec archive/i);
});
