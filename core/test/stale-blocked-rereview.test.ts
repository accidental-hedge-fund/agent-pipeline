// #1025 / #1028 stale blocked resume on enter

import assert from "node:assert/strict";
import test from "node:test";
import {
  stageEligibleForStaleBlockedResume,
  tryResumeStaleBlocked,
} from "../scripts/stages/stale-blocked-rereview.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const SHA_S = "a".repeat(40);
const SHA_H = "b".repeat(40);
const SHA_INTERNAL = "c".repeat(40);
const SHA_REBASED = "d".repeat(40);

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "o/r", repo_dir: "/repo", base_branch: "main" };
}

function reviewComment(sha: string): string {
  return `## Review 2 (Adversarial) — request-changes\n\n<!-- reviewed-sha: ${sha} -->\n<!-- pipeline-blocking-keys: a84c3494,7995aedb -->`;
}

function detailWithReview(sha: string, labels: string[] = ["blocked", "pipeline:pre-merge"]) {
  return {
    labels,
    comments: [{ body: reviewComment(sha), author: "bot", createdAt: "2020-01-01T00:00:00Z" }],
  };
}

test("stageEligibleForStaleBlockedResume: pre-merge, fix, and review stages", () => {
  assert.equal(stageEligibleForStaleBlockedResume("pre-merge"), true);
  assert.equal(stageEligibleForStaleBlockedResume("fix-1"), true);
  assert.equal(stageEligibleForStaleBlockedResume("fix-2"), true);
  assert.equal(stageEligibleForStaleBlockedResume("review-1"), true);
  assert.equal(stageEligibleForStaleBlockedResume("review-2"), true);
  assert.equal(stageEligibleForStaleBlockedResume("implementing"), false);
  assert.equal(stageEligibleForStaleBlockedResume("ready"), false);
  assert.equal(stageEligibleForStaleBlockedResume("needs-human"), false);
  assert.equal(stageEligibleForStaleBlockedResume(null), false);
});

test("tryResumeStaleBlocked: non-internal H clears block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      getPrCommits: async () => [
        { oid: SHA_S, messageHeadline: "feat: base" },
        { oid: SHA_H, messageHeadline: "fix: address review findings (#16)" },
      ] as never,
      clearBlocked: async () => {
        cleared++;
      },
      resolveCurrency: async () => ({ status: "superseded", headSha: SHA_H }),
    },
  );
  assert.equal(result.kind, "cleared");
  assert.equal(cleared, 1);
  if (result.kind === "cleared") {
    assert.equal(result.headSha, SHA_H);
    assert.equal(result.reviewedSha, SHA_S);
    assert.match(result.reason, /non-pipeline-internal/);
  }
});

test("tryResumeStaleBlocked: HEAD still S keeps block", async () => {
  let cleared = 0;
  let currencyCalls = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_S } as never),
      clearBlocked: async () => {
        cleared++;
      },
      resolveCurrency: async () => {
        currencyCalls++;
        return { status: "current" };
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.equal(currencyCalls, 0, "same-head must short-circuit before currency");
  assert.match(result.reason, /still at reviewed-sha/);
});

test("tryResumeStaleBlocked: pipeline-internal-only reuses verdict (#98)", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_INTERNAL } as never),
      clearBlocked: async () => {
        cleared++;
      },
      resolveCurrency: async () => ({ status: "current" }),
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /pipeline-internal/);
});

test("tryResumeStaleBlocked: S absent after rebase (currency unknown, H ≠ S) clears", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    691,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 1022,
      getPrDetail: async () => ({ number: 1022, head_sha: SHA_REBASED } as never),
      // Commit list no longer contains S (rebase/squash).
      getPrCommits: async () => [
        { oid: SHA_REBASED, messageHeadline: "fix: address pre-merge review findings" },
      ] as never,
      clearBlocked: async () => {
        cleared++;
      },
      // Shared helper returns unknown when candidate is absent from history.
      resolveCurrency: async () => ({ status: "unknown" }),
    },
  );
  assert.equal(result.kind, "cleared");
  assert.equal(cleared, 1);
  if (result.kind === "cleared") {
    assert.equal(result.headSha, SHA_REBASED);
    assert.equal(result.reviewedSha, SHA_S);
    assert.match(result.reason, /rebase|unclassifiable/i);
  }
});

test("tryResumeStaleBlocked: unreadable PR keeps block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => {
        throw new Error("network down");
      },
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /cannot resolve PR/);
});

test("tryResumeStaleBlocked: no linked PR keeps block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => null,
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /no linked open PR/);
});

test("tryResumeStaleBlocked: unreadable head keeps block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => {
        throw new Error("head unavailable");
      },
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /cannot read PR head/);
});

test("tryResumeStaleBlocked: clearBlocked failure keeps block", async () => {
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      resolveCurrency: async () => ({ status: "superseded", headSha: SHA_H }),
      clearBlocked: async () => {
        throw new Error("label edit denied");
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.match(result.reason, /clearBlocked failed/);
});

test("tryResumeStaleBlocked: no reviewed-sha is no-op", async () => {
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    {
      labels: ["blocked"],
      comments: [{ body: "no sha here", author: "bot", createdAt: "2020-01-01T00:00:00Z" }],
    },
    {
      clearBlocked: async () => {
        assert.fail("must not clear");
      },
    },
  );
  assert.equal(result.kind, "no-op");
});

test("tryResumeStaleBlocked: never invents --override (only clearBlocked)", async () => {
  const calls: string[] = [];
  const result = await tryResumeStaleBlocked(
    cfg(),
    691,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => {
        calls.push("getPrForIssue");
        return 1022;
      },
      getPrDetail: async () => {
        calls.push("getPrDetail");
        return { number: 1022, head_sha: SHA_H } as never;
      },
      clearBlocked: async () => {
        calls.push("clearBlocked");
      },
      resolveCurrency: async () => {
        calls.push("resolveCurrency");
        return { status: "superseded", headSha: SHA_H };
      },
    },
  );
  assert.equal(result.kind, "cleared");
  assert.deepEqual(calls, ["getPrForIssue", "getPrDetail", "resolveCurrency", "clearBlocked"]);
  // Resume surface has no override / disposition write seam — only clearBlocked.
  assert.ok(!calls.some((c) => /override|disposition|postComment/i.test(c)));
});

test("tryResumeStaleBlocked: uses real resolveReviewedShaCurrency for rebase absence", async () => {
  // Integration with the shared helper (no resolveCurrency override): S missing
  // from PR commits → unknown → clear when H ≠ S.
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_REBASED } as never),
      getPrCommits: async () => [
        { oid: SHA_REBASED, messageHeadline: "feat: rebased tip" },
      ] as never,
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "cleared");
  assert.equal(cleared, 1);
});

test("tryResumeStaleBlocked: uses real resolveReviewedShaCurrency for internal-only", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_INTERNAL } as never),
      getPrCommits: async () => [
        { oid: SHA_S, messageHeadline: "feat: base" },
        {
          oid: SHA_INTERNAL,
          messageHeadline: "chore: archive OpenSpec change(s) for #16",
        },
      ] as never,
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /pipeline-internal/);
});
