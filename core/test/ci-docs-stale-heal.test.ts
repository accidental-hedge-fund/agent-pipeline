// #1081 generate-docs heal — injected I/O only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCiDocsStaleHeal } from "../scripts/ci-docs-stale-heal.ts";
import type { PipelineConfig } from "../scripts/types.ts";

const cfg = { base_branch: "main" } as unknown as PipelineConfig;

test("runCiDocsStaleHeal: no worktree fails closed", async () => {
  const out = await runCiDocsStaleHeal(cfg, 1081, {
    prNumber: 1,
    headSha: "abc",
    logExcerpt: null,
  }, {
    getForIssue: async () => null,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /no managed worktree/);
});

test("runCiDocsStaleHeal: fetch tags, heal, push", async () => {
  const rec = { fetches: 0, pushes: 0 };
  const out = await runCiDocsStaleHeal(cfg, 1081, {
    prNumber: 1,
    headSha: "abc",
    logExcerpt: null,
  }, {
    getForIssue: async () => ({ path: "/wt", slug: "s", branch: "pipeline/1081-s" }),
    fetchTags: async () => {
      rec.fetches++;
    },
    enforceDocsFreshness: async () => ({
      ok: true,
      ran: true,
      healed: true,
      paths: ["CHANGELOG.md"],
    }),
    gitPush: async () => {
      rec.pushes++;
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(rec.fetches, 1);
  assert.equal(rec.pushes, 1);
});

test("runCiDocsStaleHeal: local already-green refuses to claim a heal", async () => {
  const out = await runCiDocsStaleHeal(cfg, 1081, {
    prNumber: 1,
    headSha: "abc",
    logExcerpt: null,
  }, {
    getForIssue: async () => ({ path: "/wt", slug: "s" }),
    fetchTags: async () => {},
    enforceDocsFreshness: async () => ({ ok: true, ran: true, healed: false }),
    gitPush: async () => {
      throw new Error("must not push");
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /already green|no commit/i);
});

test("runCiDocsStaleHeal: generate failure surfaces generator reason", async () => {
  const out = await runCiDocsStaleHeal(cfg, 1081, {
    prNumber: 1,
    headSha: "abc",
    logExcerpt: null,
  }, {
    getForIssue: async () => ({ path: "/wt", slug: "s" }),
    fetchTags: async () => {},
    enforceDocsFreshness: async () => ({
      ok: false,
      ran: true,
      reason: "docs generator failed while attempting to heal stale generated docs",
      stalePaths: ["CHANGELOG.md"],
    }),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason ?? "", /docs generator failed/);
});
