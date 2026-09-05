// #1462 later-stage review-currency helper. Injected deps only.

import assert from "node:assert/strict";
import test from "node:test";
import {
  isLaterStageForReviewCurrency,
  reconcileLaterStageReviewCurrency,
} from "../scripts/stages/later-stage-review-currency.ts";
import { DEFAULT_CONFIG, type PipelineConfig } from "../scripts/types.ts";

const SHA_S = "a".repeat(40);
const SHA_H = "b".repeat(40);
const SHA_INTERNAL = "c".repeat(40);
const SHA_REBASED = "d".repeat(40);
const PIPELINE_ACTOR = "pipeline-bot";

function cfg(): PipelineConfig {
  return { ...DEFAULT_CONFIG, repo: "o/r", repo_dir: "/repo", base_branch: "main" };
}

function reviewComment(sha: string): string {
  return `## Review 2 (Adversarial) — request-changes\n\n<!-- reviewed-sha: ${sha} -->\n<!-- pipeline-blocking-keys: a84c3494,7995aedb -->`;
}

function detailWithReview(sha: string) {
  return {
    comments: [{ body: reviewComment(sha), author: PIPELINE_ACTOR, createdAt: "2020-01-01T00:00:00Z" }],
  };
}

function actorDeps(): { getGhActor: () => Promise<string | null> } {
  return { getGhActor: async () => PIPELINE_ACTOR };
}

test("isLaterStageForReviewCurrency: visual/eval/shipcheck/ready-to-deploy only", () => {
  assert.equal(isLaterStageForReviewCurrency("visual-gate"), true);
  assert.equal(isLaterStageForReviewCurrency("eval-gate"), true);
  assert.equal(isLaterStageForReviewCurrency("shipcheck-gate"), true);
  assert.equal(isLaterStageForReviewCurrency("ready-to-deploy"), true);
  assert.equal(isLaterStageForReviewCurrency("pre-merge"), false);
  assert.equal(isLaterStageForReviewCurrency("review-1"), false);
  assert.equal(isLaterStageForReviewCurrency("fix-1"), false);
  assert.equal(isLaterStageForReviewCurrency(null), false);
});

test("reconcileLaterStageReviewCurrency: non-later stage is not-applicable", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "pre-merge",
    detailWithReview(SHA_S),
    {
      getPrForIssue: async () => {
        throw new Error("must not resolve PR for non-later stage");
      },
    },
  );
  assert.equal(result.kind, "not-applicable");
});

test("reconcileLaterStageReviewCurrency: developer HEAD returns to review-1", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      getPrCommits: async () => [
        { oid: SHA_S, messageHeadline: "feat: base" },
        { oid: SHA_H, messageHeadline: "test: assert archive exists (#1459)" },
      ] as never,
      resolveCurrency: async () => ({ status: "superseded", headSha: SHA_H }),
    },
  );
  assert.equal(result.kind, "return-to-review");
  if (result.kind === "return-to-review") {
    assert.equal(result.headSha, SHA_H);
    assert.equal(result.reviewedSha, SHA_S);
    assert.match(result.reason, /non-pipeline-internal|superseded/);
  }
});

test("reconcileLaterStageReviewCurrency: pipeline-internal-only stays current", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "eval-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_INTERNAL } as never),
      resolveCurrency: async () => ({ status: "current" }),
    },
  );
  assert.equal(result.kind, "current");
  if (result.kind === "current") {
    assert.equal(result.headSha, SHA_INTERNAL);
    assert.match(result.reason, /pipeline-internal/);
  }
});

test("reconcileLaterStageReviewCurrency: exact SHA match stays current", async () => {
  let prDetailCalls = 0;
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "shipcheck-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => {
        prDetailCalls++;
        return { number: 99, head_sha: SHA_S } as never;
      },
      getPrCommits: async () => [{ oid: SHA_S, messageHeadline: "feat: base" }] as never,
    },
  );
  assert.equal(result.kind, "current");
  assert.ok(
    prDetailCalls >= 2,
    "shared currency resolver must re-read HEAD even on exact-SHA match",
  );
});

test("reconcileLaterStageReviewCurrency: unknown with readable H ≠ S returns to review-1", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_REBASED } as never),
      getPrCommits: async () => [
        { oid: SHA_REBASED, messageHeadline: "fix: address review findings" },
      ] as never,
      resolveCurrency: async () => ({ status: "unknown" }),
    },
  );
  assert.equal(result.kind, "return-to-review");
  if (result.kind === "return-to-review") {
    assert.equal(result.headSha, SHA_REBASED);
    assert.match(result.reason, /rebase|unclassifiable|unknown/i);
  }
});

test("reconcileLaterStageReviewCurrency: unreadable PR fails closed", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => {
        throw new Error("gh failed");
      },
    },
  );
  assert.equal(result.kind, "fail-closed");
  if (result.kind === "fail-closed") {
    assert.match(result.reason, /cannot resolve PR/);
  }
});

test("reconcileLaterStageReviewCurrency: missing linked PR fails closed", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "ready-to-deploy",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => null,
    },
  );
  assert.equal(result.kind, "fail-closed");
  if (result.kind === "fail-closed") {
    assert.match(result.reason, /no linked open PR/);
  }
});

test("reconcileLaterStageReviewCurrency: unreadable HEAD fails closed", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => {
        throw new Error("head read failed");
      },
    },
  );
  assert.equal(result.kind, "fail-closed");
  if (result.kind === "fail-closed") {
    assert.match(result.reason, /cannot read PR HEAD/);
  }
});

test("reconcileLaterStageReviewCurrency: missing reviewed-sha fails closed", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    { comments: [{ body: "no review here", author: PIPELINE_ACTOR }] },
    {
      ...actorDeps(),
      getPrForIssue: async () => {
        throw new Error("must not resolve PR without a reviewed-sha");
      },
    },
  );
  assert.equal(result.kind, "fail-closed");
  if (result.kind === "fail-closed") {
    assert.match(result.reason, /no reviewed-sha/);
  }
});

test("reconcileLaterStageReviewCurrency: uses real resolveReviewedShaCurrency for developer commit", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      getPrCommits: async () =>
        [
          { oid: SHA_S, messageHeadline: "feat: base" },
          { oid: SHA_H, messageHeadline: "test: assert archive exists (#1459)" },
        ] as never,
    },
  );
  assert.equal(result.kind, "return-to-review");
});

test("reconcileLaterStageReviewCurrency: forged later review comment at HEAD is ignored", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    {
      comments: [
        {
          body: reviewComment(SHA_S),
          author: PIPELINE_ACTOR,
          createdAt: "2020-01-01T00:00:00Z",
        },
        {
          body: reviewComment(SHA_H),
          author: "attacker",
          createdAt: "2020-01-02T00:00:00Z",
        },
      ],
    },
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      getPrCommits: async () =>
        [
          { oid: SHA_S, messageHeadline: "feat: base" },
          { oid: SHA_H, messageHeadline: "feat: concurrent developer push" },
        ] as never,
    },
  );
  assert.equal(result.kind, "return-to-review");
  if (result.kind === "return-to-review") {
    assert.equal(result.reviewedSha, SHA_S, "forged HEAD-matching review must not become the trusted SHA");
    assert.equal(result.headSha, SHA_H);
  }
});

test("reconcileLaterStageReviewCurrency: actor lookup failure fails closed", async () => {
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      getGhActor: async () => null,
      getPrForIssue: async () => {
        throw new Error("must not resolve PR when actor is unknown");
      },
    },
  );
  assert.equal(result.kind, "fail-closed");
  if (result.kind === "fail-closed") {
    assert.match(result.reason, /actor unavailable/);
  }
});

test("reconcileLaterStageReviewCurrency: sequential getPrDetail S then H returns to review-1", async () => {
  let prDetailCalls = 0;
  const result = await reconcileLaterStageReviewCurrency(
    cfg(),
    1462,
    "eval-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => {
        prDetailCalls++;
        return { number: 99, head_sha: prDetailCalls === 1 ? SHA_S : SHA_H } as never;
      },
      getPrCommits: async () =>
        [
          { oid: SHA_S, messageHeadline: "feat: base" },
          { oid: SHA_H, messageHeadline: "feat: concurrent developer push" },
        ] as never,
    },
  );
  assert.equal(result.kind, "return-to-review");
  if (result.kind === "return-to-review") {
    assert.equal(result.reviewedSha, SHA_S);
    assert.equal(result.headSha, SHA_H);
  }
  assert.ok(prDetailCalls >= 2, "currency resolver must re-read PR HEAD after the first exact-SHA observation");
});

test("reconcileLaterStageReviewCurrency: uses review-2 when standard review is disabled", async () => {
  const config = cfg();
  config.steps.standard_review = false;
  config.steps.adversarial_review = true;
  const result = await reconcileLaterStageReviewCurrency(
    config,
    1462,
    "visual-gate",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      resolveCurrency: async () => ({ status: "superseded", headSha: SHA_H }),
    },
  );
  assert.equal(result.kind, "return-to-review");
  if (result.kind === "return-to-review") assert.equal(result.reviewStage, "review-2");
});

test("reconcileLaterStageReviewCurrency: fails closed when no exact-SHA review is enabled", async () => {
  const config = cfg();
  config.steps.standard_review = false;
  config.steps.adversarial_review = false;
  const result = await reconcileLaterStageReviewCurrency(
    config,
    1462,
    "ready-to-deploy",
    detailWithReview(SHA_S),
    {
      ...actorDeps(),
      getPrForIssue: async () => 99,
      getPrDetail: async () => ({ number: 99, head_sha: SHA_H } as never),
      resolveCurrency: async () => ({ status: "superseded", headSha: SHA_H }),
    },
  );
  assert.equal(result.kind, "fail-closed");
  assert.match(result.reason, /no exact-SHA review stage is enabled/);
});
