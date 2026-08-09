// Tests for pipeline release finish (Phase 3). No network/subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  finishReleasePr,
  parseReleasePrTitle,
  RELEASE_PR_TITLE_RE,
  type ReleaseFinishDeps,
} from "../scripts/stages/release-finish.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeDeps(over: Partial<ReleaseFinishDeps> = {}): ReleaseFinishDeps & {
  merges: Array<{ pr: number; head: string }>;
} {
  const merges: Array<{ pr: number; head: string }> = [];
  let merged = false;
  const base: ReleaseFinishDeps = {
    log() {},
    async ghPrView(_pr, fields) {
      if (merged && fields.includes("state")) {
        return {
          title: "release: 1.34.0 — test",
          state: "MERGED",
          mergeable: "UNKNOWN",
          mergeStateStatus: "UNKNOWN",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          mergedAt: "2026-08-09T00:00:00Z",
          mergeCommit: { oid: "b".repeat(40) },
        };
      }
      return {
        title: "release: 1.34.0 — test",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "a".repeat(40),
        baseRefName: "main",
        mergedAt: null,
        mergeCommit: null,
      };
    },
    async ghPrChecksRequired() {
      return [{ name: "test", bucket: "pass" }];
    },
    async ghPrChecksAll() {
      return [{ name: "test", bucket: "pass" }];
    },
    async ghPrMerge(pr, head) {
      merges.push({ pr, head });
      merged = true;
    },
    ...over,
  };
  return Object.assign(base, { merges });
}

test("parseReleasePrTitle accepts release.ts format", () => {
  const p = parseReleasePrTitle("release: 1.33.0 — Scoped factory");
  assert.deepEqual(p, { version: "1.33.0" });
  assert.equal(parseReleasePrTitle("feat: something"), null);
  assert.ok(RELEASE_PR_TITLE_RE.test("release: 0.1.0 — x"));
});

test("finishReleasePr: happy path merges exact head", async () => {
  const deps = makeDeps();
  const result = await finishReleasePr(99, deps);
  assert.equal(result.version, "1.34.0");
  assert.equal(result.alreadyMerged, false);
  assert.equal(deps.merges.length, 1);
  assert.equal(deps.merges[0]!.pr, 99);
  assert.equal(deps.merges[0]!.head, "a".repeat(40));
  assert.equal(result.mergeCommitOid, "b".repeat(40));
});

test("finishReleasePr: rejects non-release title", async () => {
  const deps = makeDeps({
    async ghPrView() {
      return {
        title: "feat: not a release",
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        headRefOid: "a".repeat(40),
      };
    },
  });
  await assert.rejects(() => finishReleasePr(1, deps), /not a pipeline release PR/);
  assert.equal(deps.merges.length, 0);
});

test("finishReleasePr: refuses dirty PR", async () => {
  const deps = makeDeps({
    async ghPrView() {
      return {
        title: "release: 1.0.0 — x",
        state: "OPEN",
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
        headRefOid: "a".repeat(40),
      };
    },
  });
  await assert.rejects(() => finishReleasePr(1, deps), /not mergeable|CONFLICTING/);
  assert.equal(deps.merges.length, 0);
});

test("finishReleasePr: refuses failing checks", async () => {
  const deps = makeDeps({
    async ghPrChecksRequired() {
      return [{ name: "ci", bucket: "fail" }];
    },
  });
  await assert.rejects(() => finishReleasePr(1, deps), /failing or pending/);
  assert.equal(deps.merges.length, 0);
});

test("finishReleasePr: already merged is idempotent", async () => {
  const deps = makeDeps({
    async ghPrView() {
      return {
        title: "release: 1.34.0 — test",
        state: "MERGED",
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        headRefOid: "a".repeat(40),
        mergedAt: "2026-08-09T00:00:00Z",
        mergeCommit: { oid: "c".repeat(40) },
      };
    },
  });
  const result = await finishReleasePr(5, deps);
  assert.equal(result.alreadyMerged, true);
  assert.equal(deps.merges.length, 0);
  assert.equal(result.mergeCommitOid, "c".repeat(40));
});

test("release finish isolation: advance stages do not import release-finish", () => {
  const stagesDir = path.join(__dirname, "..", "scripts", "stages");
  const exempt = new Set([
    "release-finish.ts",
    "release.ts",
    "merge.ts",
    "merge-queue.ts",
    "merge_queue.ts",
    "merge-queue-release-when-complete.ts",
    "merge_queue_hold.ts",
    "train.ts",
  ]);
  for (const f of fs.readdirSync(stagesDir).filter((x) => x.endsWith(".ts"))) {
    if (exempt.has(f)) continue;
    const content = fs.readFileSync(path.join(stagesDir, f), "utf8");
    assert.ok(
      !content.includes("release-finish") && !content.includes("finishReleasePr"),
      `${f} must not import release finish`,
    );
  }
});
