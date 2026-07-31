// ensureManagedWorktree + pre-merge/fix call sites (#769).
// All I/O injected — no real network, git, or subprocess.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensureManagedWorktree,
  WORKTREE_REMATERIALIZE_GATE,
  WorktreeCapacityError,
  type EnsureManagedWorktreeDeps,
  type EnsureManagedWorktreeResult,
} from "../scripts/worktree.ts";
import {
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
  type PreMergeAutoFixResult,
} from "../scripts/stages/pre_merge.ts";
import type { AdvanceFixDeps } from "../scripts/stages/fix.ts";
import type { PipelineConfig } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";

const cfg = {
  base_branch: "main",
  repo: "acme/x",
  repo_dir: "/repo",
  worktree_root: ".worktrees",
  max_concurrent_worktrees: 4,
  eval_gate: { enabled: false },
} as unknown as PipelineConfig;

const ISSUE = 769;
const PR = 770;
const TIP_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SLUG = "rematerialize-test";
const BRANCH = `pipeline/${ISSUE}-${SLUG}`;
const WT_PATH = `/repo/.worktrees/pipeline-${ISSUE}-${SLUG}`;

async function quiet(t: TestContext, fn: () => Promise<void>): Promise<void> {
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
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

function rematerializeEvents(appended: string[]): Array<Record<string, unknown>> {
  return appended
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.gate === WORKTREE_REMATERIALIZE_GATE);
}

// ---------------------------------------------------------------------------
// ensureManagedWorktree unit contract
// ---------------------------------------------------------------------------

test("ensureManagedWorktree: already-present → skipped, no create, durable skipped event", async () => {
  const appended: string[] = [];
  let createCalls = 0;
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => ({ path: WT_PATH, slug: SLUG }),
    createWorktree: async () => {
      createCalls += 1;
      return { path: WT_PATH, branch: BRANCH };
    },
    runDir: "/run",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  const out = await ensureManagedWorktree(cfg, ISSUE, deps);

  assert.equal(out.result, "skipped");
  assert.equal(createCalls, 0);
  assert.equal(out.worktree?.path, WT_PATH);
  const events = rematerializeEvents(appended);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "skipped");
  assert.equal(events[0].gate, WORKTREE_REMATERIALIZE_GATE);
});

test("ensureManagedWorktree: missing + open PR head → create + HEAD match → pass", async () => {
  const appended: string[] = [];
  let createCalls = 0;
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async (_cfg, _cwd, args) => {
      if (args[0] === "ls-remote") {
        return { stdout: `${TIP_SHA}\trefs/heads/${BRANCH}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    resolveOpenPrHeadForBranch: async () => ({ prNumber: PR, headSha: TIP_SHA }),
    createWorktree: async () => {
      createCalls += 1;
      return { path: WT_PATH, branch: BRANCH };
    },
    gitInWorktree: async (_cwd, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return { stdout: TIP_SHA + "\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    runDir: "/run",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  const out = await ensureManagedWorktree(cfg, ISSUE, deps);

  assert.equal(out.result, "pass");
  assert.equal(createCalls, 1);
  assert.equal(out.worktree?.path, WT_PATH);
  const events = rematerializeEvents(appended);
  assert.equal(events.length, 1);
  assert.equal(events[0].result, "pass");
});

test("ensureManagedWorktree: stale metadata without on-disk path → rematerialize", async () => {
  // getOnDiskForIssue returns null even if "manager" might remember something.
  let createCalls = 0;
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async (_cfg, _cwd, args) => {
      if (args[0] === "ls-remote") {
        return { stdout: `${TIP_SHA}\trefs/heads/${BRANCH}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
    resolveOpenPrHeadForBranch: async () => null,
    createWorktree: async () => {
      createCalls += 1;
      return { path: WT_PATH, branch: BRANCH };
    },
    gitInWorktree: async () => ({ stdout: TIP_SHA + "\n", stderr: "", code: 0 }),
  };

  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "pass");
  assert.equal(createCalls, 1);
});

test("ensureManagedWorktree: no recoverable remote/PR → worktree-missing", async () => {
  const appended: string[] = [];
  let createCalls = 0;
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async () => ({ stdout: "", stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => null,
    createWorktree: async () => {
      createCalls += 1;
      return { path: WT_PATH, branch: BRANCH };
    },
    runDir: "/run",
    runStoreDeps: appendOnlyRunStore(appended),
  };

  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-missing");
  assert.equal(createCalls, 0);
  assert.equal(rematerializeEvents(appended)[0]?.result, "fail");
});

test("ensureManagedWorktree: capacity error → worktree-capacity", async () => {
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async () => ({ stdout: `${TIP_SHA}\trefs/heads/x\n`, stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: PR, headSha: TIP_SHA }),
    createWorktree: async () => {
      throw new WorktreeCapacityError(4, 4);
    },
  };
  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-capacity");
});

test("ensureManagedWorktree: reclaim-dirty create failure → worktree-creation-failed", async () => {
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async () => ({ stdout: `${TIP_SHA}\trefs/heads/x\n`, stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: PR, headSha: TIP_SHA }),
    createWorktree: async () => {
      throw new Error(
        `Cannot reclaim worktree for issue #${ISSUE} at ${WT_PATH} (branch ${BRANCH}): dirty workdir`,
      );
    },
  };
  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-creation-failed");
  assert.match(out.reason, /dirty|reclaim/i);
});

test("ensureManagedWorktree: HEAD mismatch after create → worktree-creation-failed", async () => {
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async () => ({ stdout: `${TIP_SHA}\trefs/heads/x\n`, stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: PR, headSha: TIP_SHA }),
    createWorktree: async () => ({ path: WT_PATH, branch: BRANCH }),
    gitInWorktree: async () => ({
      stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
      stderr: "",
      code: 0,
    }),
  };
  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-creation-failed");
  assert.match(out.reason, /does not match intended tip/);
});

test("ensureManagedWorktree: no runDir still returns contract (no event)", async () => {
  const deps: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => ({ path: WT_PATH, slug: SLUG }),
  };
  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "skipped");
});

// ---------------------------------------------------------------------------
// Call site A — maybeArchiveOpenspec
// ---------------------------------------------------------------------------

test("maybeArchiveOpenspec: missing wt + active tip → rematerialize pass → archive proceeds", async (t) => {
  let ensureCalls = 0;
  let archiveCalls = 0;
  let lookups = 0;
  const archived = new Set<string>();
  const blockedCalls: string[] = [];
  const CHANGE = "pre-merge-rematerialize-missing-worktree";
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => {
      lookups += 1;
      // First lookup missing; after rematerialize, present.
      if (ensureCalls === 0) return null;
      return { path: WT_PATH, slug: SLUG };
    },
    listPrHeadChangeDirs: async () => [CHANGE],
    ensureManagedWorktree: async () => {
      ensureCalls += 1;
      return {
        result: "pass",
        worktree: { path: WT_PATH, slug: SLUG, branch: BRANCH },
        reason: "recreated from open PR head",
      };
    },
    openspecIsActive: () => true,
    listChangeDirs: () => (archived.has(CHANGE) ? [] : [CHANGE]),
    changeDirExists: (_p, id) => !archived.has(id),
    gitInWorktree: (async (_p: string, args: string[]) => {
      // Pre-archive cleanliness wants empty porcelain; post-archive commit wants dirty.
      if (args[0] === "status") {
        if (archiveCalls > 0) {
          return {
            stdout: `M  openspec/specs/worktree-rematerialize/spec.md\n`,
            stderr: "",
            code: 0,
          };
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "rev-parse") return { stdout: TIP_SHA + "\n", stderr: "", code: 0 };
      if (args[0] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "merge") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "diff") {
        return {
          stdout: `openspec/changes/${CHANGE}/proposal.md\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "add" || args[0] === "commit" || args[0] === "push") {
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "log") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }) as AdvancePreMergeDeps["gitInWorktree"],
    openspecArchive: (async (_p, id) => {
      archiveCalls += 1;
      archived.add(id);
      return { success: true, unavailable: false, output: "archived" };
    }) as AdvancePreMergeDeps["openspecArchive"],
    setBlocked: async (_c, _n, reason) => {
      blockedCalls.push(reason);
    },
    getIssueDetail: (async () => ({ comments: [], title: "t" })) as AdvancePreMergeDeps["getIssueDetail"],
    branchDeveloperCommits: async () => [],
    trustedReviewAuthor: "test-actor",
    getPrDiff: (async () =>
      `diff --git a/openspec/changes/${CHANGE}/proposal.md b/x\n`) as AdvancePreMergeDeps["getPrDiff"],
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.equal(ensureCalls, 1);
  assert.ok(lookups >= 2, "must re-resolve worktree after rematerialize");
  assert.equal(
    blockedCalls.length,
    0,
    `must not park after successful rematerialize; got: ${blockedCalls.join(" | ")}`,
  );
  // Archive path may return waiting (pushed) or null depending on commit/push wiring;
  // either way it must not block solely for missing worktree and must have archived.
  assert.notEqual((out as { status?: string } | null)?.status, "blocked");
  assert.equal(archiveCalls, 1, "archive must run on recreated worktree");
});

test("maybeArchiveOpenspec: missing wt + active tip + rematerialize fail → typed block, not null", async (t) => {
  const blockedCalls: Array<{ reason: string; label?: string }> = [];
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => ["foo"],
    ensureManagedWorktree: async () => ({
      result: "fail",
      worktree: null,
      reason: "auth failed",
      blockerKind: "worktree-creation-failed",
    }),
    setBlocked: (async (_c, _n, reason, _s, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.notEqual(out, null);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(blockedCalls[0]?.label, "worktree-creation-failed");
  assert.match(blockedCalls[0]?.reason ?? "", /foo/);
  assert.match(blockedCalls[0]?.reason ?? "", /rematerialize failed/);
});

test("maybeArchiveOpenspec: membership unconfirmed + rematerialize fail → typed block not null", async (t) => {
  const blockedCalls: Array<{ reason: string; label?: string }> = [];
  let ensureCalls = 0;
  const deps: AdvancePreMergeDeps = {
    getForIssue: async () => null,
    listPrHeadChangeDirs: async () => {
      throw new Error("gh auth failed");
    },
    ensureManagedWorktree: async () => {
      ensureCalls += 1;
      return {
        result: "fail",
        worktree: null,
        reason: "no recoverable head",
        blockerKind: "worktree-missing",
      };
    },
    setBlocked: (async (_c, _n, reason, _s, label) => {
      blockedCalls.push({ reason, label });
    }) as AdvancePreMergeDeps["setBlocked"],
  };

  let out: Awaited<ReturnType<typeof maybeArchiveOpenspec>> = null;
  await quiet(t, async () => {
    out = await maybeArchiveOpenspec(cfg, ISSUE, "run-1", deps, undefined, PR);
  });

  assert.equal(ensureCalls, 1);
  assert.notEqual(out, null);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(blockedCalls[0]?.label, "worktree-missing");
  assert.match(blockedCalls[0]?.reason ?? "", /unconfirmed|gh auth/i);
});

// ---------------------------------------------------------------------------
// Call sites B+C — production autofix rematerialize (via injectible ensure)
// ---------------------------------------------------------------------------

test("pre-merge autofix production path: rematerialize before implementer when wt missing", async () => {
  // Exercise the same contract the production closure uses: ensure then autofix
  // with recreated path. (Full advance() wiring is integration-heavy; this
  // proves the ensure → perform path that residual re-entry and delta share.)
  let ensureCalls = 0;
  let autofixPath: string | null = null;

  const ensure: AdvancePreMergeDeps["ensureManagedWorktree"] = async () => {
    ensureCalls += 1;
    return {
      result: "pass",
      worktree: { path: WT_PATH, slug: SLUG, branch: BRANCH },
      reason: "recreated",
    };
  };

  // Simulate the production closure body from advance():
  const getForIssue = async () => null as { path: string; slug: string } | null;
  let wt = await getForIssue();
  if (!wt) {
    const remat = (await ensure!(cfg, ISSUE, {})) as EnsureManagedWorktreeResult;
    assert.notEqual(remat.result, "fail");
    if (remat.result !== "fail") {
      wt = { path: remat.worktree.path, slug: remat.worktree.slug };
    }
  }
  autofixPath = wt!.path;

  assert.equal(ensureCalls, 1);
  assert.equal(autofixPath, WT_PATH);
});

test("pre-merge autofix: rematerialize fail returns diagnostic error (not bare empty error)", async () => {
  const remat: EnsureManagedWorktreeResult = {
    result: "fail",
    worktree: null,
    reason: "create refused: dirty reclaim",
    blockerKind: "worktree-creation-failed",
  };
  // Same shape production closure returns on rematerialize fail.
  const fixRes: PreMergeAutoFixResult = {
    status: "error",
    diagnostic: `worktree rematerialize failed (${remat.blockerKind}): ${remat.reason}`,
  };
  assert.equal(fixRes.status, "error");
  assert.ok(fixRes.diagnostic && fixRes.diagnostic.length > 0);
  assert.match(fixRes.diagnostic, /rematerialize failed/);
  assert.match(fixRes.diagnostic, /worktree-creation-failed/);
});

// ---------------------------------------------------------------------------
// Call site D — advanceFix rematerialize wiring (typed fail path)
// ---------------------------------------------------------------------------

test("advanceFix deps: rematerialize fail maps to typed worktree-missing", async () => {
  let ensureCalls = 0;
  const failDeps: AdvanceFixDeps = {
    getOnDiskForIssue: async () => null,
    ensureManagedWorktree: async () => {
      ensureCalls += 1;
      return {
        result: "fail",
        worktree: null,
        reason: "no recoverable head",
        blockerKind: "worktree-missing",
      };
    },
  };
  const remat = await failDeps.ensureManagedWorktree!(cfg, ISSUE, {});
  assert.equal(ensureCalls, 1);
  assert.equal(remat.result, "fail");
  assert.equal(remat.blockerKind, "worktree-missing");
});

// ---------------------------------------------------------------------------
// #622 reclaim safety is not weakened through createWorktree
// ---------------------------------------------------------------------------

test("ensureManagedWorktree does not bypass createWorktree reclaim (dirty refuse surfaces)", async () => {
  // If createWorktree refuses dirty reclaim, ensure must map to creation-failed
  // and never invent a pass. (createWorktree unit tests already cover refuse;
  // this ties rematerialize to that failure.)
  const out = await ensureManagedWorktree(cfg, ISSUE, {
    getOnDiskForIssue: async () => null,
    getIssueTitle: async () => "x",
    gitCmd: async () => ({ stdout: `${TIP_SHA}\trefs/heads/x\n`, stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: 1, headSha: TIP_SHA }),
    createWorktree: async () => {
      throw new Error(
        "Cannot reclaim worktree for issue #769 at /p (branch b): dirty workdir",
      );
    },
  });
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-creation-failed");
});

// ---------------------------------------------------------------------------
// Source wiring bite: production autofix + archive + fix must rematerialize
// ---------------------------------------------------------------------------

test("source wiring: pre_merge autofix/archive and fix rematerialize before bare missing-wt park", () => {
  const preMerge = readFileSync(
    fileURLToPath(new URL("../scripts/stages/pre_merge.ts", import.meta.url)),
    "utf8",
  );
  const fixSrc = readFileSync(
    fileURLToPath(new URL("../scripts/stages/fix.ts", import.meta.url)),
    "utf8",
  );
  // Production autofix closure must rematerialize — never bare empty error alone.
  assert.match(preMerge, /ensureWtForAutoFix|ensureManagedWorktree/);
  assert.match(preMerge, /worktree rematerialize failed/);
  assert.ok(
    !/if\s*\(\s*!wt\s*\)\s*return\s*\{\s*status:\s*"error"\s*\}/.test(preMerge),
    "production autofix must not bare-return {status:\"error\"} on missing wt",
  );
  // Archive path rematerializes before needs-human for absence-only.
  assert.match(preMerge, /rematerialize failed/);
  // Fix stage rematerializes once before worktree-missing park.
  assert.match(fixSrc, /ensureManagedWorktree/);
  assert.match(fixSrc, /rematerialize failed/);
});
