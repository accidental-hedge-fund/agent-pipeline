// #1274 — bound merge-result proof for park-release / automatic remove.
// Injected I/O only: no live network, git, or subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalize as finalizeReadyToDeploy } from "../scripts/stages/deploy_ready.ts";
import { maybeReleaseWorktreeOnPark } from "../scripts/pipeline-run.ts";
import {
  boundProofMatches,
  checkLocalOnlyCommits,
  createVerifiedMergeProof,
  proveMergeResultInBase,
  releaseWorktreeForParkedIssue,
  removeManagedWorktreeSafely,
  type GitCmd,
  type ParkReleaseDeps,
  type SafeRemoveDeps,
  type VerifiedMergeProof,
  type WorktreeRecord,
} from "../scripts/worktree.ts";
import type { PipelineConfig, PrDetail } from "../scripts/types.ts";

const ISSUE = 42;
const PR = 7;
const OID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_OID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const AUTH_ERR = "commit verification failed (git/network/auth error)";
const CONNECTIVITY = "check connectivity";

function makeCfg(base = "main"): PipelineConfig {
  return {
    repo: "owner/repo",
    repo_dir: "/repo",
    worktree_root: ".worktrees",
    base_branch: base,
    domain: "test",
    max_concurrent_worktrees: 4,
    marker_footer: "",
    harnesses: { implementer: "claude", reviewer: "codex", implementerSource: "config", reviewerSource: "config" },
  } as unknown as PipelineConfig;
}

function makeRec(issueNumber = ISSUE, slug = "feat"): WorktreeRecord {
  return {
    path: `/repo/.worktrees/pipeline-${issueNumber}-${slug}`,
    branch: `pipeline/${issueNumber}-${slug}`,
    issueNumber,
    slug,
    underManagedRoot: true,
  };
}

function proof(over: Partial<{ issue: number; pr: number; base: string; mergeResultOid: string }> = {}): VerifiedMergeProof {
  return createVerifiedMergeProof({
    issue: over.issue ?? ISSUE,
    pr: over.pr ?? PR,
    base: over.base ?? "main",
    mergeResultOid: over.mergeResultOid ?? OID,
  });
}

function squashGitCmd(opts: { logCode: number; logStdout?: string; lsCode?: number }): GitCmd {
  return async (_cfg, _cwd, args) => {
    if (args[0] === "ls-remote") {
      return { code: opts.lsCode ?? 0, stdout: "", stderr: opts.lsCode ? "auth" : "" };
    }
    if (args[0] === "log") {
      return {
        code: opts.logCode,
        stdout: opts.logStdout ?? "",
        stderr: opts.logCode !== 0 ? "fatal" : "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

function parkBase(over: Partial<ParkReleaseDeps> = {}): ParkReleaseDeps {
  const rec = makeRec();
  return {
    listOnDisk: async () => [rec],
    hasDirtyWorkdir: async () => false,
    pathExists: () => true,
    hasRemoteBranchTip: async () => false,
    resolveOpenPrHeadForBranch: async () => null,
    removeWorktree: async () => {},
    ...over,
  };
}

function boundPark(over: Partial<ParkReleaseDeps> = {}): ParkReleaseDeps {
  const p = proof();
  return parkBase({
    verifiedMergeProof: p,
    prNumber: PR,
    expectedMergeResultOid: OID,
    ...over,
  });
}

function prDetail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    number: PR,
    title: "T",
    body: "B",
    state: "merged",
    url: `https://example.test/pull/${PR}`,
    head_ref: `pipeline/${ISSUE}-feat`,
    head_sha: "c".repeat(40),
    base_ref: "main",
    mergeable: true,
    mergeable_state: "CLEAN",
    draft: false,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    merge_commit_sha: OID,
    ...over,
  };
}

function denyAuth(text: string): void {
  assert.doesNotMatch(text, new RegExp(AUTH_ERR.replace(/[()]/g, "\\$&")));
  assert.doesNotMatch(text, /check connectivity/i);
}

// ---------------------------------------------------------------------------
// 1.7 createVerifiedMergeProof runtime validation
// ---------------------------------------------------------------------------

test("createVerifiedMergeProof: rejects non-positive issue/PR, empty base, non-40-char OID", () => {
  assert.throws(() => createVerifiedMergeProof({ issue: 0, pr: PR, base: "main", mergeResultOid: OID }), /issue/);
  assert.throws(() => createVerifiedMergeProof({ issue: -1, pr: PR, base: "main", mergeResultOid: OID }), /issue/);
  assert.throws(() => createVerifiedMergeProof({ issue: ISSUE, pr: 0, base: "main", mergeResultOid: OID }), /pr/);
  assert.throws(() => createVerifiedMergeProof({ issue: ISSUE, pr: PR, base: "", mergeResultOid: OID }), /base/);
  assert.throws(() => createVerifiedMergeProof({ issue: ISSUE, pr: PR, base: "   ", mergeResultOid: OID }), /base/);
  assert.throws(
    () => createVerifiedMergeProof({ issue: ISSUE, pr: PR, base: "main", mergeResultOid: "abc" }),
    /mergeResultOid/,
  );
});

test("boundProofMatches: raw object or log/label string is not proof", () => {
  const expected = { issue: ISSUE, pr: PR, base: "main", mergeResultOid: OID };
  assert.equal(boundProofMatches({ issue: ISSUE, pr: PR, base: "main", mergeResultOid: OID }, expected), false);
  assert.equal(boundProofMatches(`train_merge_proven ${OID}`, expected), false);
  assert.equal(boundProofMatches("pipeline:ready-to-deploy", expected), false);
  assert.equal(boundProofMatches(proof(), expected), true);
});

test("proveMergeResultInBase: mints proof only after isAncestor succeeds", async () => {
  let ancestorCalls = 0;
  const minted = await proveMergeResultInBase(
    { issue: ISSUE, pr: PR, base: "main", mergeResultOid: OID },
    {
      fetchBase: async () => {},
      baseTip: async () => "d".repeat(40),
      isAncestor: async () => {
        ancestorCalls += 1;
        return true;
      },
    },
  );
  assert.equal(ancestorCalls, 1);
  assert.ok(minted);
  assert.equal(minted!.mergeResultOid, OID);
  const missed = await proveMergeResultInBase(
    { issue: ISSUE, pr: PR, base: "main", mergeResultOid: OID },
    {
      fetchBase: async () => {},
      baseTip: async () => "d".repeat(40),
      isAncestor: async () => false,
    },
  );
  assert.equal(missed, null);
});

// ---------------------------------------------------------------------------
// 1.5 classifier: observed-absent remote is unverifiable, not git/network/auth
// ---------------------------------------------------------------------------

test("checkLocalOnlyCommits: ls-remote empty + log non-empty → unverifiable", async () => {
  const result = await checkLocalOnlyCommits(makeCfg(), "/repo/.worktrees/pipeline-42-feat", "pipeline/42-feat", {
    gitCmd: squashGitCmd({ logCode: 0, logStdout: "deadbeef squash leftover\n" }),
  });
  assert.equal(result, "unverifiable");
});

test("checkLocalOnlyCommits: ls-remote empty + log exit 1 → unverifiable (not null)", async () => {
  const result = await checkLocalOnlyCommits(makeCfg(), "/repo/.worktrees/pipeline-42-feat", "pipeline/42-feat", {
    gitCmd: squashGitCmd({ logCode: 1 }),
  });
  assert.equal(result, "unverifiable");
});

test("checkLocalOnlyCommits: ls-remote empty + log exit 128 → unverifiable (not null)", async () => {
  const result = await checkLocalOnlyCommits(makeCfg(), "/repo/.worktrees/pipeline-42-feat", "pipeline/42-feat", {
    gitCmd: squashGitCmd({ logCode: 128 }),
  });
  assert.equal(result, "unverifiable");
});

test("checkLocalOnlyCommits: ls-remote transport failure → null", async () => {
  const result = await checkLocalOnlyCommits(makeCfg(), "/repo/.worktrees/pipeline-42-feat", "pipeline/42-feat", {
    gitCmd: squashGitCmd({ logCode: 0, lsCode: 128 }),
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// 1.1 bound proof + clean post-squash tree is released (not git/network/auth)
// ---------------------------------------------------------------------------

test("park-release: bound proof + clean tree + unverifiable local-only → released", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "released");
  assert.equal(removed, true);
  denyAuth(result.reason);
});

test("park-release: bound proof + clean tree + localOnly null → released (leftover misclass)", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      hasLocalOnlyCommits: async () => null,
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "released");
  assert.equal(removed, true);
  denyAuth(result.reason);
});

test("removeManagedWorktreeSafely: bound proof + clean + unverifiable → removed", async () => {
  let removed = false;
  const rec = makeRec();
  const result = await removeManagedWorktreeSafely(makeCfg(), ISSUE, "feat", rec.path, {
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => "unverifiable",
    pathExists: () => true,
    verifiedMergeProof: proof(),
    prNumber: PR,
    expectedMergeResultOid: OID,
    removeWorktree: async () => {
      removed = true;
    },
  } satisfies SafeRemoveDeps);
  assert.equal(result.removed, true);
  assert.equal(removed, true);
});

// ---------------------------------------------------------------------------
// 1.2 no proof: retain with squash-merge / not-reachable wording, not git/network/auth
// ---------------------------------------------------------------------------

test("park-release: no proof + classifier unverifiable → retain not-reachable, not git/network/auth", async () => {
  let removed = false;
  const rec = makeRec();
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    parkBase({
      gitCmd: squashGitCmd({ logCode: 1 }),
      pathExists: () => true,
      listOnDisk: async () => [rec],
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
  assert.match(result.reason, /not reachable from base/i);
  denyAuth(result.reason);
});

test("park-release: no proof + injected unverifiable → retain squash-merge wording", async () => {
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    parkBase({ hasLocalOnlyCommits: async () => "unverifiable" }),
  );
  assert.equal(result.action, "retained");
  assert.match(result.reason, /not reachable from base|--force/i);
  denyAuth(result.reason);
});

// ---------------------------------------------------------------------------
// 1.3 dirty retain; filesystem cleanup retain
// ---------------------------------------------------------------------------

test("park-release: bound proof + dirty tree → retain dirty, remove not called", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      hasDirtyWorkdir: async () => true,
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
  assert.match(result.reason, /dirty/i);
  denyAuth(result.reason);
});

test("park-release: bound proof + remove throws → retain that tree with cleanup error", async () => {
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.match(result.reason, /ENOSPC|no space left/i);
  denyAuth(result.reason);
});

test("removeManagedWorktreeSafely: bound proof + remove throws → retain with cleanup error", async () => {
  const rec = makeRec();
  const result = await removeManagedWorktreeSafely(makeCfg(), ISSUE, "feat", rec.path, {
    hasDirtyWorkdir: async () => false,
    hasLocalOnlyCommits: async () => "unverifiable",
    pathExists: () => true,
    verifiedMergeProof: proof(),
    prNumber: PR,
    expectedMergeResultOid: OID,
    removeWorktree: async () => {
      throw new Error("git worktree remove failed: directory busy");
    },
  });
  assert.equal(result.removed, false);
  assert.match(result.reason ?? "", /directory busy/i);
  denyAuth(result.reason ?? "");
});

// ---------------------------------------------------------------------------
// 1.4 identity mismatch
// ---------------------------------------------------------------------------

test("park-release: wrong-issue proof does not release this worktree", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      verifiedMergeProof: proof({ issue: 99 }),
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
});

test("park-release: wrong-PR proof does not release this worktree", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      verifiedMergeProof: proof({ pr: 99 }),
      prNumber: PR,
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
});

test("park-release: wrong-base proof does not release this worktree", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg("main"),
    ISSUE,
    boundPark({
      verifiedMergeProof: proof({ base: "develop" }),
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
});

test("park-release: wrong-OID proof does not release this worktree", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      verifiedMergeProof: proof({ mergeResultOid: OTHER_OID }),
      expectedMergeResultOid: OID,
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.equal(removed, false);
});

// ---------------------------------------------------------------------------
// 1.6 ordering: proof does not bypass managed-root, dirty, or local-only
// ---------------------------------------------------------------------------

test("park-release: matching proof does not bypass underManagedRoot === false", async () => {
  let removed = false;
  const rec = makeRec();
  rec.underManagedRoot = false;
  rec.path = "/home/dev/checkout";
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      listOnDisk: async () => [rec],
      hasLocalOnlyCommits: async () => "unverifiable",
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.notEqual(result.action, "released");
  assert.equal(removed, false);
});

test("park-release: matching proof does not bypass localOnly === true", async () => {
  let removed = false;
  const result = await releaseWorktreeForParkedIssue(
    makeCfg(),
    ISSUE,
    boundPark({
      hasLocalOnlyCommits: async () => true,
      removeWorktree: async () => {
        removed = true;
      },
    }),
  );
  assert.equal(result.action, "retained");
  assert.match(result.reason, /local-only/i);
  assert.equal(removed, false);
});

// ---------------------------------------------------------------------------
// 3.1 deploy_ready.finalize caller seam
// ---------------------------------------------------------------------------

test("deploy_ready.finalize: passes bound proof into shared wrapper; no git/network/auth log", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  let passedProof: VerifiedMergeProof | undefined;
  let setBlockedCalled = false;
  try {
    const minted = proof();
    const out = await finalizeReadyToDeploy(makeCfg(), ISSUE, undefined, undefined, {
      getIssueDetail: async () => ({
        number: ISSUE,
        type: "issue",
        title: "t",
        body: "",
        state: "open",
        url: "",
        labels: ["pipeline:ready-to-deploy"],
        comments: [],
      }),
      getPrForIssue: async () => PR,
      getPrDetail: async () => prDetail(),
      addLabelToPr: async () => {},
      postComment: async () => {},
      postPrComment: async () => {},
      getOnDiskForIssue: async () => makeRec(),
      proveMergeResultInBase: async () => minted,
      setBlocked: async () => {
        setBlockedCalled = true;
      },
      removeManagedWorktreeSafely: async (_cfg, _n, _slug, _path, safeDeps) => {
        passedProof = safeDeps?.verifiedMergeProof;
        return { removed: true, path: makeRec().path, branch: makeRec().branch! };
      },
    });
    assert.equal(out.status, "finalized");
    assert.equal(passedProof, minted);
    assert.equal(setBlockedCalled, false);
    denyAuth(logs.join("\n"));
    assert.doesNotMatch(logs.join("\n"), /worktree retained after ready-to-deploy/);
  } finally {
    console.log = origLog;
  }
});

test("deploy_ready.finalize: cleanup failure does not drop ready-to-deploy or call setBlocked", async () => {
  let setBlockedCalled = false;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const out = await finalizeReadyToDeploy(makeCfg(), ISSUE, undefined, undefined, {
      getIssueDetail: async () => ({
        number: ISSUE,
        type: "issue",
        title: "t",
        body: "",
        state: "open",
        url: "",
        labels: ["pipeline:ready-to-deploy"],
        comments: [{ author: "bot", body: "## Pipeline Complete\nalready", createdAt: "2026-01-01T00:00:00Z" }],
      }),
      getPrForIssue: async () => PR,
      getPrDetail: async () => prDetail(),
      addLabelToPr: async () => {},
      postComment: async () => {
        throw new Error("must not re-post");
      },
      getOnDiskForIssue: async () => makeRec(),
      proveMergeResultInBase: async () => proof(),
      setBlocked: async () => {
        setBlockedCalled = true;
      },
      safeRemoveDeps: {
        hasDirtyWorkdir: async () => false,
        hasLocalOnlyCommits: async () => "unverifiable",
        pathExists: () => true,
        removeWorktree: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
    });
    assert.equal(out.status, "finalized");
    assert.equal(setBlockedCalled, false);
    const joined = logs.join("\n");
    assert.match(joined, /EACCES|permission denied/i);
    denyAuth(joined);
  } finally {
    console.log = origLog;
  }
});

test("deploy_ready.finalize: dirty + proof retains dirty, not git/network/auth", async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    const out = await finalizeReadyToDeploy(makeCfg(), ISSUE, undefined, undefined, {
      getIssueDetail: async () => ({
        number: ISSUE,
        type: "issue",
        title: "t",
        body: "",
        state: "open",
        url: "",
        labels: ["pipeline:ready-to-deploy"],
        comments: [{ author: "bot", body: "## Pipeline Complete\nalready", createdAt: "2026-01-01T00:00:00Z" }],
      }),
      getPrForIssue: async () => PR,
      getPrDetail: async () => prDetail(),
      addLabelToPr: async () => {},
      postComment: async () => {},
      getOnDiskForIssue: async () => makeRec(),
      proveMergeResultInBase: async () => proof(),
      safeRemoveDeps: {
        hasDirtyWorkdir: async () => true,
        hasLocalOnlyCommits: async () => "unverifiable",
        pathExists: () => true,
        removeWorktree: async () => {
          throw new Error("must not remove dirty");
        },
      },
    });
    assert.equal(out.status, "finalized");
    const joined = logs.join("\n");
    assert.match(joined, /uncommitted changes|dirty/i);
    denyAuth(joined);
  } finally {
    console.log = origLog;
  }
});

// ---------------------------------------------------------------------------
// 3.2 maybeReleaseWorktreeOnPark passes proof into the shared gate
// ---------------------------------------------------------------------------

test("maybeReleaseWorktreeOnPark: passes minted proof into releaseWorktreeForParkedIssue", async () => {
  const minted = proof();
  let captured: VerifiedMergeProof | undefined;
  let released = false;
  const result = await maybeReleaseWorktreeOnPark(
    makeCfg(),
    ISSUE,
    { advanced: false, status: "finalized", reason: "ready-to-deploy" },
    false,
    {
      verifiedMergeProof: minted,
      releaseParkedWorktree: async (_cfg, n, parkDeps) => {
        assert.equal(n, ISSUE);
        captured = parkDeps?.verifiedMergeProof;
        released = true;
        return {
          action: "released",
          reason: "released managed worktree for #42 (clean + bound merge-result proof)",
          branch: "pipeline/42-feat",
          worktree: makeRec().path,
        };
      },
    },
  );
  assert.equal(result?.action, "released");
  assert.equal(captured, minted);
  assert.equal(released, true);
  denyAuth(result?.reason ?? "");
});
