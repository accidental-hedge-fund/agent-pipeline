// Regression tests for post-tag generator-owned docs refresh (#978).
// Injectable seams only — no real network, git, or subprocess as the sole pass path.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERATOR_OWNED_PATHS,
  isGeneratorOwnedPath,
  postTagDocsCommitMessage,
  refreshPostTagDocs,
  waitForLocalTag,
  type ReleaseDocsRefreshDeps,
  type ReleaseDocsRefreshResult,
} from "../scripts/release-docs-refresh.ts";
import { renderChangelogMarkdown, type ChangelogRelease } from "../scripts/docs-generate.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("postTagDocsCommitMessage: stable greppable subject for version", () => {
  assert.equal(postTagDocsCommitMessage("1.34.0"), "docs: regenerate CHANGELOG for v1.34.0");
  assert.equal(postTagDocsCommitMessage("v1.34.0"), "docs: regenerate CHANGELOG for v1.34.0");
});

test("isGeneratorOwnedPath: CHANGELOG and co-owned generator outputs only", () => {
  assert.equal(isGeneratorOwnedPath("CHANGELOG.md"), true);
  assert.equal(isGeneratorOwnedPath("docs/cli.md"), true);
  assert.equal(isGeneratorOwnedPath("hosts/claude/SKILL.md"), true);
  assert.equal(isGeneratorOwnedPath("ROADMAP.md"), false);
  assert.equal(isGeneratorOwnedPath("package.json"), false);
  assert.equal(isGeneratorOwnedPath("core/package.json"), false);
  assert.ok(GENERATOR_OWNED_PATHS.includes("CHANGELOG.md"));
});

// ---------------------------------------------------------------------------
// Fake deps harness
// ---------------------------------------------------------------------------

type Harness = {
  deps: ReleaseDocsRefreshDeps;
  generates: number;
  commits: Array<{ message: string }>;
  added: string[][];
  pushes: number;
  /** When true, generate "writes" so listDirtyPaths reports CHANGELOG dirt. */
  dirtyAfterGenerate: boolean;
  generateCode: number;
  generateThrow?: Error;
  commitThrow?: Error;
  pushThrow?: Error;
  /** Extra non-owned dirt to prove it is not staged. */
  extraDirty: string[];
  /** Injected release list used by generate to prove tag→CHANGELOG linkage. */
  releases: ChangelogRelease[];
  writtenChangelog: string | null;
};

function makeHarness(over: Partial<Harness> = {}): Harness {
  const h: Harness = {
    deps: null as unknown as ReleaseDocsRefreshDeps,
    generates: 0,
    commits: [],
    added: [],
    pushes: 0,
    dirtyAfterGenerate: true,
    generateCode: 0,
    extraDirty: ["ROADMAP.md"],
    releases: [
      { version: "1.34.0", date: "2026-08-10", subject: "release: 1.34.0 — Durable factory" },
      { version: "1.33.0", date: "2026-08-01", subject: "release: 1.33.0 — Scoped factory" },
    ],
    writtenChangelog: null,
    ...over,
  };

  h.deps = {
    log() {},
    generateDocs: async () => {
      h.generates++;
      if (h.generateThrow) throw h.generateThrow;
      // Simulate write path: produce CHANGELOG from injected tag/release list.
      h.writtenChangelog = renderChangelogMarkdown(h.releases);
      return {
        code: h.generateCode,
        output: h.generateCode === 0 ? "generate-docs: done" : "generate failed",
      };
    },
    listDirtyPaths: async () => {
      if (!h.dirtyAfterGenerate) return [...h.extraDirty.filter(() => false)];
      const paths = ["CHANGELOG.md", ...h.extraDirty];
      return paths;
    },
    gitAdd: async (_dir, paths) => {
      h.added.push([...paths]);
    },
    gitCommit: async (_dir, message) => {
      if (h.commitThrow) throw h.commitThrow;
      h.commits.push({ message });
    },
    gitPush: async () => {
      if (h.pushThrow) throw h.pushThrow;
      h.pushes++;
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// refreshPostTagDocs
// ---------------------------------------------------------------------------

test("refreshPostTagDocs: injected new tag regenerates and commits CHANGELOG.md", async () => {
  const h = makeHarness({
    releases: [
      { version: "1.34.0", date: "2026-08-10", subject: "release: 1.34.0 — Durable factory" },
    ],
    dirtyAfterGenerate: true,
  });

  const result = await refreshPostTagDocs("/fake/repo", "1.34.0", h.deps);

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  if (result.ok && result.committed) {
    assert.deepEqual(result.paths, ["CHANGELOG.md"]);
    assert.equal(result.commitMessage, "docs: regenerate CHANGELOG for v1.34.0");
  }
  assert.equal(h.generates, 1, "generate write must run");
  assert.equal(h.commits.length, 1);
  assert.equal(h.commits[0]!.message, "docs: regenerate CHANGELOG for v1.34.0");
  assert.deepEqual(h.added[0], ["CHANGELOG.md"], "only generator-owned paths staged");
  assert.equal(h.pushes, 1);
  assert.ok(h.writtenChangelog?.includes("## [1.34.0]"), "generator saw injected tag list");
});

test("refreshPostTagDocs: stages co-owned generator dirt with CHANGELOG, not ROADMAP", async () => {
  const h = makeHarness();
  // listDirtyPaths returns CHANGELOG + docs/cli + ROADMAP; only owned paths commit.
  h.deps.listDirtyPaths = async () => ["CHANGELOG.md", "docs/cli.md", "ROADMAP.md", "package.json"];

  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  if (result.ok && result.committed) {
    assert.deepEqual(result.paths, ["CHANGELOG.md", "docs/cli.md"]);
  }
  assert.deepEqual(h.added[0], ["CHANGELOG.md", "docs/cli.md"]);
});

test("refreshPostTagDocs: no dirt after generate → no commit, success", async () => {
  const h = makeHarness({ dirtyAfterGenerate: false, extraDirty: [] });
  h.deps.listDirtyPaths = async () => [];

  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.deepEqual(result, { ok: true, committed: false, reason: "clean" });
  assert.equal(h.generates, 1);
  assert.equal(h.commits.length, 0);
  assert.equal(h.added.length, 0);
  assert.equal(h.pushes, 0);
});

test("refreshPostTagDocs: generate failure → error, no commit, no tag deletion surface", async () => {
  const h = makeHarness({ generateCode: 1 });

  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  if (!result.ok) {
    assert.match(result.error, /docs generator failed/);
    assert.match(result.error, /tag is left unchanged/);
  }
  assert.equal(h.commits.length, 0);
  assert.equal(h.pushes, 0);
});

test("refreshPostTagDocs: generate throw → fail closed, no commit", async () => {
  const h = makeHarness({ generateThrow: new Error("boom") });
  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /threw/);
  assert.equal(h.commits.length, 0);
});

test("refreshPostTagDocs: commit failure → fail closed without push", async () => {
  const h = makeHarness({ commitThrow: new Error("index locked") });
  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /commit failed/);
    assert.match(result.error, /tag is left unchanged/);
  }
  assert.equal(h.pushes, 0);
});

test("refreshPostTagDocs: push failure after commit → fail closed, tag unchanged message", async () => {
  const h = makeHarness({ pushThrow: new Error("permission denied") });
  const result = await refreshPostTagDocs("/fake", "1.34.0", h.deps);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /push failed/);
    assert.match(result.error, /tag is left unchanged/);
  }
  assert.equal(h.commits.length, 1, "local commit may exist before push fails");
});

test("refreshPostTagDocs: invalid version → fail closed without generate", async () => {
  const h = makeHarness();
  const result = await refreshPostTagDocs("/fake", "not-a-version", h.deps);
  assert.equal(result.ok, false);
  assert.equal(h.generates, 0);
});

test("refreshPostTagDocs: push optional — omit gitPush still commits", async () => {
  const h = makeHarness();
  const { gitPush: _p, ...noPush } = h.deps;
  const result = await refreshPostTagDocs("/fake", "1.34.0", noPush);
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(h.commits.length, 1);
  assert.equal(h.pushes, 0);
});

/**
 * Regression bite (#978): if regenerate-and-commit is removed / short-circuited
 * while the rest of the harness still "passes", this test must fail.
 *
 * We prove the contract by asserting the ordered side effects that define the
 * path: generate → stage CHANGELOG → commit with the post-tag subject.
 */
test("regression bite: happy path requires generate + CHANGELOG commit (fails if path removed)", async () => {
  const h = makeHarness();
  const result: ReleaseDocsRefreshResult = await refreshPostTagDocs(
    "/fake",
    "1.34.0",
    h.deps,
  );

  // These three assertions are the bite: stripping regenerate-and-commit from
  // refreshPostTagDocs while leaving a trivial {ok:true} return would fail here.
  assert.equal(h.generates, 1, "bite: generateDocs must be invoked");
  assert.equal(h.commits.length, 1, "bite: commit must be requested when dirt exists");
  assert.ok(
    h.added.some((paths) => paths.includes("CHANGELOG.md")),
    "bite: CHANGELOG.md must be among staged paths",
  );
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.match(h.commits[0]!.message, /^docs: regenerate CHANGELOG for v1\.34\.0$/);
});

// ---------------------------------------------------------------------------
// waitForLocalTag (injectable)
// ---------------------------------------------------------------------------

test("waitForLocalTag: returns true when tag appears on a later attempt", async () => {
  let n = 0;
  const ok = await waitForLocalTag("/fake", "1.34.0", {
    attempts: 3,
    delayMs: 1,
    fetchTags: async () => {},
    tagExists: () => {
      n++;
      return n >= 2;
    },
    sleep: async () => {},
  });
  assert.equal(ok, true);
  assert.ok(n >= 2);
});

test("waitForLocalTag: returns false when tag never appears", async () => {
  const ok = await waitForLocalTag("/fake", "1.34.0", {
    attempts: 2,
    delayMs: 1,
    fetchTags: async () => {},
    tagExists: () => false,
    sleep: async () => {},
  });
  assert.equal(ok, false);
});
