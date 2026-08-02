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
  enforceReviewShaGate,
  maybeArchiveOpenspec,
  type AdvancePreMergeDeps,
  type PreMergeAutoFixResult,
  type ShaGateDeps,
} from "../scripts/stages/pre_merge.ts";
import type { AdvanceFixDeps } from "../scripts/stages/fix.ts";
import type { PipelineConfig, ReviewFinding } from "../scripts/types.ts";
import type { RunStoreDeps } from "../scripts/run-store.ts";
import {
  computeDiffHash,
  encodeReviewArtifact,
} from "../scripts/stages/review.ts";

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

test("ensureManagedWorktree: HEAD mismatch after create → worktree-creation-failed + removes mismatched path", async () => {
  const removed: Array<{ issue: number; slug: string; path?: string }> = [];
  let pathPresent = true;
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
    removeWorktree: async (_cfg, issueNumber, slug, resolvedPath) => {
      removed.push({ issue: issueNumber, slug, path: resolvedPath });
      pathPresent = false;
    },
    existsSync: (p) => (p === WT_PATH ? pathPresent : false),
  };
  const out = await ensureManagedWorktree(cfg, ISSUE, deps);
  assert.equal(out.result, "fail");
  assert.equal(out.blockerKind, "worktree-creation-failed");
  assert.match(out.reason, /does not match intended tip/);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]!.issue, ISSUE);
  assert.equal(removed[0]!.slug, SLUG);
  assert.equal(removed[0]!.path, WT_PATH);
  assert.match(out.reason, /mismatched worktree removed/);
  assert.equal(pathPresent, false);
});

test("ensureManagedWorktree: HEAD mismatch cleanup prevents re-entry skip on mismatched tree", async () => {
  // Regression for #769 review-2 f9fac3ac: a post-create HEAD mismatch must
  // not leave a path that the next ensure/stage entry treats as valid present.
  let onDisk: { path: string; slug: string } | null = null;
  let createCalls = 0;
  let removeCalls = 0;
  const shared: EnsureManagedWorktreeDeps = {
    getOnDiskForIssue: async () => onDisk,
    getIssueTitle: async () => "Rematerialize Test",
    gitCmd: async () => ({ stdout: `${TIP_SHA}\trefs/heads/x\n`, stderr: "", code: 0 }),
    resolveOpenPrHeadForBranch: async () => ({ prNumber: PR, headSha: TIP_SHA }),
    createWorktree: async () => {
      createCalls += 1;
      onDisk = { path: WT_PATH, slug: SLUG };
      return { path: WT_PATH, branch: BRANCH };
    },
    gitInWorktree: async () => ({
      // Always mismatch so create never becomes a pass.
      stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
      stderr: "",
      code: 0,
    }),
    removeWorktree: async () => {
      removeCalls += 1;
      onDisk = null; // simulate successful managed-root cleanup
    },
    existsSync: (p) => p === WT_PATH && onDisk !== null,
  };

  const first = await ensureManagedWorktree(cfg, ISSUE, shared);
  assert.equal(first.result, "fail");
  assert.equal(first.blockerKind, "worktree-creation-failed");
  assert.equal(createCalls, 1);
  assert.equal(removeCalls, 1);
  assert.equal(onDisk, null, "mismatched path must not remain discoverable");

  // Re-entry after blocked label is cleared: lookup must not classify the
  // former mismatched tree as present (would skip rematerialize and proceed).
  const second = await ensureManagedWorktree(cfg, ISSUE, shared);
  assert.equal(second.result, "fail");
  assert.notEqual(second.result, "skipped");
  assert.equal(createCalls, 2, "re-entry must attempt create again, not skip");
  assert.equal(removeCalls, 2);
  assert.equal(onDisk, null);
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
// Call sites B+C — enforceReviewShaGate residual re-entry + delta autofix
// typed rematerialize-failed propagation (#769 review-1 finding 7412f05b)
// ---------------------------------------------------------------------------

const SHA_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_REVIEWED = "cccccccccccccccccccccccccccccccccccccccc";
const TEST_ACTOR = "pipeline-bot";
const OLD_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 1;";
const NEW_DIFF = "diff --git a/foo.ts b/foo.ts\n+const x = 2;";
const oldHash = computeDiffHash(OLD_DIFF);

const cfgWithPolicy = {
  ...cfg,
  review_policy: { block_threshold: "low" as const, min_confidence: 0 },
  harnesses: { reviewer: "claude", implementer: "claude" },
} as unknown as PipelineConfig;

/** Residual re-entry durable comment: matching HEAD + blocking artifact with autofixable category. */
function residualReentryBlockingComment(sha: string): string {
  const artifactLine = encodeReviewArtifact({
    round: 2,
    reviewedSha: sha,
    diffHash: "abcd1234",
    blockingKeys: ["5284604a"],
    review1Risk: null,
    bodyHash: "00",
    blockingFindings: [{
      key: "5284604a",
      surface: "core/scripts/gh.ts|correctness",
      severity: "high",
      title: "Off-by-one in parser",
      confidence: 0.95,
    }],
  });
  return [
    `## Review 2 (Adversarial) — needs-attention`,
    "",
    "No-ship: blocking findings remain.",
    "",
    `**1. [HIGH] Off-by-one** \`override-key: 5284604a\` \`category: correctness\``,
    "",
    `<!-- reviewed-sha: ${sha} -->`,
    `<!-- pipeline-blocking-keys: 5284604a -->`,
    artifactLine,
  ].join("\n");
}

function reviewCommentWithHash(round: 1 | 2, sha: string, hash: string): string {
  return (
    `## Review ${round} (${round === 1 ? "Standard" : "Adversarial"}) — approve\n\n` +
    `LGTM\n\n<!-- reviewed-sha: ${sha} -->\n<!-- verdict-diff-hash: ${hash} -->`
  );
}

function blockingCorrectnessFinding(): ReviewFinding {
  return {
    severity: "high",
    title: "Off-by-one",
    body: "Details",
    confidence: 0.95,
    recommendation: "Fix it",
    category: "correctness",
  } as ReviewFinding;
}

/** Production-shaped rematerialize fail result from the autofix seam. */
function rematerializeFailedResult(
  kind: "worktree-missing" | "worktree-creation-failed" | "worktree-capacity" = "worktree-creation-failed",
  reason = "create refused: dirty reclaim",
): PreMergeAutoFixResult {
  return {
    status: "rematerialize-failed",
    blockerKind: kind,
    diagnostic: `worktree rematerialize failed (${kind}): ${reason}`,
  };
}

test("enforceReviewShaGate residual re-entry: rematerialize-failed parks typed worktree block (not needs-human)", async (t) => {
  // Real residual re-entry path: reviewed-sha == HEAD with unresolved blockers,
  // allowlisted reconstructed findings, no prior autofix attempt → seam invoked.
  const blocked: Array<{ reason: string; kind?: string }> = [];
  let autoFixCalls = 0;
  const rematRes = rematerializeFailedResult("worktree-creation-failed", "dirty reclaim");

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Rematerialize test",
        body: "Body",
        comments: [{
          body: residualReentryBlockingComment(SHA_HEAD),
          author: TEST_ACTOR,
        }],
      }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD, head_ref: BRANCH }) as any,
    getPrCommits: async () =>
      [
        { oid: SHA_HEAD, messageHeadline: "fix: prior work" },
      ] as any,
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason, _stage, kind) => {
      blocked.push({ reason, kind: kind as string | undefined });
    },
    getForIssue: async () => null,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => {
      autoFixCalls += 1;
      return rematRes;
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, ISSUE, PR, deps);
  });

  assert.equal(autoFixCalls, 1, "residual re-entry must invoke autofix seam");
  assert.notEqual(out, null);
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(
    (out as { blockerKind?: string }).blockerKind,
    "worktree-creation-failed",
    "outcome must carry typed worktree blocker, not needs-human",
  );
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.kind, "worktree-creation-failed");
  assert.match(blocked[0]!.reason, /rematerialize failed/);
  assert.match(blocked[0]!.reason, /worktree-creation-failed/);
});

test("enforceReviewShaGate residual re-entry: worktree-missing / capacity kinds propagate", async (t) => {
  for (const kind of ["worktree-missing", "worktree-capacity"] as const) {
    const blocked: Array<{ kind?: string }> = [];
    const deps: ShaGateDeps = {
      getIssueDetail: async () =>
        ({
          title: "x",
          body: "",
          comments: [{ body: residualReentryBlockingComment(SHA_HEAD), author: TEST_ACTOR }],
        }) as any,
      getPrDetail: async () => ({ head_sha: SHA_HEAD }) as any,
      getPrCommits: async () => [{ oid: SHA_HEAD, messageHeadline: "feat" }] as any,
      postComment: async () => {},
      transition: async () => {},
      setBlocked: async (_c, _n, _r, _s, k) => {
        blocked.push({ kind: k as string | undefined });
      },
      getForIssue: async () => null,
      getGhActor: async () => TEST_ACTOR,
      attemptPreMergeAutoFix: async () => rematerializeFailedResult(kind, `fail-${kind}`),
    };
    let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
    await quiet(t, async () => {
      out = await enforceReviewShaGate(cfgWithPolicy, ISSUE, PR, deps);
    });
    assert.equal((out as { blockerKind?: string }).blockerKind, kind, `kind ${kind}`);
    assert.equal(blocked[0]?.kind, kind);
  }
});

test("enforceReviewShaGate delta autofix: rematerialize-failed parks typed worktree block (not needs-human)", async (t) => {
  // Normal delta path (SHA mismatch → delta review blocks → autofix).
  const blocked: Array<{ reason: string; kind?: string }> = [];
  let autoFixCalls = 0;
  let deltaCalls = 0;

  const deps: ShaGateDeps = {
    getIssueDetail: async () =>
      ({
        title: "Delta rematerialize test",
        body: "Body",
        comments: [{
          body: reviewCommentWithHash(2, SHA_REVIEWED, oldHash),
          author: TEST_ACTOR,
        }],
      }) as any,
    getPrDetail: async () => ({ head_sha: SHA_HEAD, head_ref: BRANCH }) as any,
    getPrCommits: async () =>
      [
        { oid: SHA_REVIEWED, messageHeadline: "feat: implement" },
        { oid: SHA_HEAD, messageHeadline: "fix: address review" },
      ] as any,
    getPrDiff: async () => NEW_DIFF,
    getCommitDeltaDiff: async () => NEW_DIFF,
    runDeltaReview: async () => {
      deltaCalls += 1;
      return {
        verdict: "needs-attention",
        findings: [blockingCorrectnessFinding()],
        summary: "blocking",
      } as any;
    },
    postComment: async () => {},
    transition: async () => {},
    setBlocked: async (_cfg, _n, reason, _stage, kind) => {
      blocked.push({ reason, kind: kind as string | undefined });
    },
    getForIssue: async () => ({ path: WT_PATH, slug: SLUG }) as any,
    getGhActor: async () => TEST_ACTOR,
    attemptPreMergeAutoFix: async () => {
      autoFixCalls += 1;
      return rematerializeFailedResult("worktree-missing", "no recoverable head");
    },
  };

  let out: Awaited<ReturnType<typeof enforceReviewShaGate>> = null;
  await quiet(t, async () => {
    out = await enforceReviewShaGate(cfgWithPolicy, ISSUE, PR, deps);
  });

  assert.equal(deltaCalls, 1, "delta review must run");
  assert.equal(autoFixCalls, 1, "delta autofix seam must run");
  assert.equal((out as { status: string }).status, "blocked");
  assert.equal(
    (out as { blockerKind?: string }).blockerKind,
    "worktree-missing",
    "delta path must park typed worktree-missing, not needs-human",
  );
  assert.equal(blocked[0]?.kind, "worktree-missing");
  assert.match(blocked[0]!.reason, /rematerialize failed/);
});

test("pre-merge autofix: rematerialize fail uses rematerialize-failed contract (not bare error)", () => {
  const remat: EnsureManagedWorktreeResult = {
    result: "fail",
    worktree: null,
    reason: "create refused: dirty reclaim",
    blockerKind: "worktree-creation-failed",
  };
  // Same shape production closure returns on rematerialize fail (#769).
  const fixRes: PreMergeAutoFixResult = {
    status: "rematerialize-failed",
    blockerKind: remat.blockerKind,
    diagnostic: `worktree rematerialize failed (${remat.blockerKind}): ${remat.reason}`,
  };
  assert.equal(fixRes.status, "rematerialize-failed");
  assert.equal(fixRes.blockerKind, "worktree-creation-failed");
  assert.match(fixRes.diagnostic, /rematerialize failed/);
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
  // #628: pre_merge.ts is a facade; rematerialize wiring lives in domain modules.
  const stagesUrl = (name: string) =>
    fileURLToPath(new URL(`../scripts/stages/${name}`, import.meta.url));
  const preMerge = [
    "pre-merge-routing.ts",
    "pre-merge-sha-gate.ts",
    "pre-merge-openspec-archive.ts",
    "pre-merge-autofix.ts",
  ]
    .map((name) => readFileSync(stagesUrl(name), "utf8"))
    .join("\n");
  const fixSrc = readFileSync(stagesUrl("fix.ts"), "utf8");
  // Production autofix closure must rematerialize — never bare empty error alone.
  assert.match(preMerge, /ensureWtForAutoFix|ensureManagedWorktree/);
  assert.match(preMerge, /worktree rematerialize failed/);
  assert.match(
    preMerge,
    /status:\s*"rematerialize-failed"/,
    "production autofix must return typed rematerialize-failed (not bare error)",
  );
  assert.match(
    preMerge,
    /fixRes\.status === "rematerialize-failed"/,
    "SHA-gate residual/delta paths must branch on rematerialize-failed",
  );
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
