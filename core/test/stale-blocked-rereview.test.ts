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

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "o/r", repo_dir: "/repo", base_branch: "main" };
}

function reviewComment(sha: string): string {
  return `## Review 2 (Adversarial) — request-changes\n\n<!-- reviewed-sha: ${sha} -->\n<!-- pipeline-blocking-keys: foo -->`;
}

test("stageEligibleForStaleBlockedResume: pre-merge and fix stages", () => {
  assert.equal(stageEligibleForStaleBlockedResume("pre-merge"), true);
  assert.equal(stageEligibleForStaleBlockedResume("fix-1"), true);
  assert.equal(stageEligibleForStaleBlockedResume("implementing"), false);
  assert.equal(stageEligibleForStaleBlockedResume("ready"), false);
});

test("tryResumeStaleBlocked: non-internal H clears block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    {
      labels: ["blocked", "pipeline:pre-merge"],
      comments: [{ body: reviewComment(SHA_S), author: "bot", createdAt: "2020-01-01T00:00:00Z" }],
    },
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
  }
});

test("tryResumeStaleBlocked: HEAD still S keeps block", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    {
      labels: ["blocked", "pipeline:pre-merge"],
      comments: [{ body: reviewComment(SHA_S), author: "bot", createdAt: "2020-01-01T00:00:00Z" }],
    },
    {
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_S } as never),
      clearBlocked: async () => {
        cleared++;
      },
    },
  );
  assert.equal(result.kind, "keep");
  assert.equal(cleared, 0);
  assert.match(result.reason, /still at reviewed-sha/);
});

test("tryResumeStaleBlocked: pipeline-internal-only reuses verdict (#98)", async () => {
  let cleared = 0;
  const result = await tryResumeStaleBlocked(
    cfg(),
    16,
    {
      labels: ["blocked", "pipeline:pre-merge"],
      comments: [{ body: reviewComment(SHA_S), author: "bot", createdAt: "2020-01-01T00:00:00Z" }],
    },
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
