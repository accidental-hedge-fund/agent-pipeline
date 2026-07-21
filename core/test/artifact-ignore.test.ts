// Tests for the engine artifact ignore contract (#452): the contract itself,
// the deterministic renderer, and ensureArtifactIgnoreBlock's create/append/
// refresh/no-write cases. All fs access is injected in-memory — no real
// filesystem, git, or subprocess calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ARTIFACT_CONTRACT,
  RUNS_ARTIFACT,
  ROADMAP_ARTIFACT,
  HISTORY_ARTIFACT,
  artifactSubdir,
  renderArtifactIgnoreBlock,
  ensureArtifactIgnoreBlock,
  writeAllSync,
  type ArtifactIgnoreDeps,
} from "../scripts/artifact-ignore.ts";
import { runsDir, issueHistoryDir } from "../scripts/run-store.ts";

/** In-memory fs fake: a single file at a fixed path. No real fs, git, or
 *  subprocess calls — the unauthenticated/no-network path this repo's
 *  injectable-dep convention requires. */
function makeFakeFs(initial: string | null): { deps: ArtifactIgnoreDeps; get(): string | null } {
  let content = initial;
  const deps: ArtifactIgnoreDeps = {
    readFile: () => content,
    writeFile: (_fp, data) => {
      content = data;
    },
  };
  return { deps, get: () => content };
}

// ---------------------------------------------------------------------------
// Contract (drift guard, #5.1/#5.3)
// ---------------------------------------------------------------------------

test("ARTIFACT_CONTRACT: contains exactly runs/, roadmap/, history/, and evals/ with non-empty comments", () => {
  const names = ARTIFACT_CONTRACT.map((e) => e.name);
  assert.deepEqual(names, ["runs", "roadmap", "history", "evals"]);
  for (const entry of ARTIFACT_CONTRACT) {
    assert.ok(entry.comment.length > 0, `entry ${entry.name} must have a non-empty comment`);
  }
});

test("ARTIFACT_CONTRACT: includes .agent-pipeline/history/ (regression for #452)", () => {
  // This is the exact bug: the pre-fix contract/gitignore covered only runs/
  // and roadmap/, so history/ files left the protected branch dirty.
  assert.ok(
    ARTIFACT_CONTRACT.some((e) => e.name === "history"),
    "contract must include the history artifact directory",
  );
});

test("drift guard: every engine-written .agent-pipeline/ directory helper resolves from a contract entry", () => {
  const repoDir = "/repo";
  assert.equal(runsDir(repoDir), artifactSubdir(repoDir, RUNS_ARTIFACT));
  assert.equal(issueHistoryDir(repoDir), artifactSubdir(repoDir, HISTORY_ARTIFACT));

  // The rendered block must contain every contract entry's ignore path,
  // including the ones derived above.
  const block = renderArtifactIgnoreBlock();
  for (const entry of ARTIFACT_CONTRACT) {
    assert.ok(
      block.includes(`.agent-pipeline/${entry.name}/`),
      `rendered block must contain .agent-pipeline/${entry.name}/`,
    );
  }
});

test("artifactSubdir: resolves <repoDir>/.agent-pipeline/<name> for each contract entry", () => {
  assert.equal(artifactSubdir("/repo", RUNS_ARTIFACT), "/repo/.agent-pipeline/runs");
  assert.equal(artifactSubdir("/repo", ROADMAP_ARTIFACT), "/repo/.agent-pipeline/roadmap");
  assert.equal(artifactSubdir("/repo", HISTORY_ARTIFACT), "/repo/.agent-pipeline/history");
});

// ---------------------------------------------------------------------------
// renderArtifactIgnoreBlock
// ---------------------------------------------------------------------------

test("renderArtifactIgnoreBlock: begins/ends with sentinels, lists every entry in contract order", () => {
  const block = renderArtifactIgnoreBlock();
  const lines = block.split("\n");
  assert.ok(lines[0].startsWith("# >>> agent-pipeline artifacts"));
  assert.ok(block.trimEnd().endsWith("# <<< agent-pipeline artifacts (managed by `pipeline init`) <<<"));

  // Order: contract order preserved.
  const runsIdx = block.indexOf(".agent-pipeline/runs/");
  const roadmapIdx = block.indexOf(".agent-pipeline/roadmap/");
  const historyIdx = block.indexOf(".agent-pipeline/history/");
  assert.ok(runsIdx > -1 && roadmapIdx > runsIdx && historyIdx > roadmapIdx);

  for (const entry of ARTIFACT_CONTRACT) {
    assert.ok(block.includes(entry.comment), `block must contain comment for ${entry.name}`);
  }
});

test("renderArtifactIgnoreBlock: deterministic — two calls produce byte-identical output", () => {
  assert.equal(renderArtifactIgnoreBlock(), renderArtifactIgnoreBlock());
});

// ---------------------------------------------------------------------------
// ensureArtifactIgnoreBlock — created / appended / refreshed / unchanged
// ---------------------------------------------------------------------------

test("ensureArtifactIgnoreBlock: no .gitignore -> creates one containing only the rendered block", () => {
  const fake = makeFakeFs(null);
  const result = ensureArtifactIgnoreBlock("/repo", fake.deps);
  assert.equal(result.outcome, "created");
  assert.equal(fake.get(), renderArtifactIgnoreBlock());
});

test("ensureArtifactIgnoreBlock: existing .gitignore without the block -> appends, preserving prior bytes", () => {
  const existing = "node_modules/\n*.log\n";
  const fake = makeFakeFs(existing);
  const result = ensureArtifactIgnoreBlock("/repo", fake.deps);
  assert.equal(result.outcome, "updated");
  const after = fake.get()!;
  assert.ok(after.startsWith(existing), "pre-existing bytes must be preserved byte-identical");
  assert.ok(after.includes(renderArtifactIgnoreBlock()), "appended content must be the rendered block");
});

test("ensureArtifactIgnoreBlock: existing .gitignore with no trailing newline -> appends without touching the last line", () => {
  const existing = "node_modules/";
  const fake = makeFakeFs(existing);
  ensureArtifactIgnoreBlock("/repo", fake.deps);
  const after = fake.get()!;
  assert.ok(after.startsWith(existing), "the operator's last line must not be mutated");
});

test("ensureArtifactIgnoreBlock: block present and current -> no write, reports unchanged", () => {
  const existing = `node_modules/\n\n${renderArtifactIgnoreBlock()}`;
  const fake = makeFakeFs(existing);
  const result = ensureArtifactIgnoreBlock("/repo", fake.deps);
  assert.equal(result.outcome, "unchanged");
  assert.equal(fake.get(), existing, "no write must occur when the block already matches the contract");
});

test("ensureArtifactIgnoreBlock: block present and stale -> rewrites only the sentinel span", () => {
  const staleBlock = [
    "# >>> agent-pipeline artifacts (managed by `pipeline init`) >>>",
    "# Per-run evidence bundles written by the engine; local-only, never committed.",
    ".agent-pipeline/runs/",
    "# <<< agent-pipeline artifacts (managed by `pipeline init`) <<<",
    "",
  ].join("\n");
  const before = "node_modules/\n\n";
  const after = "\n*.tgz\n";
  const existing = `${before}${staleBlock}${after}`;
  const fake = makeFakeFs(existing);

  const result = ensureArtifactIgnoreBlock("/repo", fake.deps);
  assert.equal(result.outcome, "updated");

  const written = fake.get()!;
  assert.ok(written.startsWith(before), "content before the opening sentinel must be byte-identical");
  assert.ok(written.endsWith(after), "content after the closing sentinel must be byte-identical");
  assert.ok(
    written.includes(".agent-pipeline/history/"),
    "the refreshed block must list the new history/ entry",
  );
  // No duplicate block: exactly one opening sentinel.
  const openCount = written.split("# >>> agent-pipeline artifacts").length - 1;
  assert.equal(openCount, 1, "the block must not be duplicated");
});

test("ensureArtifactIgnoreBlock: non-ENOENT read error (default fs impl) propagates instead of clobbering operator content", { skip: process.getuid?.() === 0 }, () => {
  // Exercises the real defaultReadFile (no injected readFile): a write-only
  // (chmod 200) .gitignore raises EACCES on read while a write would still
  // succeed. Regression for #452 review finding — a non-ENOENT read failure
  // must throw, not fall through to the create-new-.gitignore path, which
  // would silently overwrite operator-authored content.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-ignore-test-"));
  const gitignorePath = path.join(repoDir, ".gitignore");
  const operatorContent = "secret-operator-content\n";
  fs.writeFileSync(gitignorePath, operatorContent, "utf8");
  fs.chmodSync(gitignorePath, 0o200);
  try {
    assert.throws(() => ensureArtifactIgnoreBlock(repoDir), /EACCES/);
    fs.chmodSync(gitignorePath, 0o644);
    assert.equal(
      fs.readFileSync(gitignorePath, "utf8"),
      operatorContent,
      "operator content must survive a non-ENOENT read failure",
    );
  } finally {
    fs.chmodSync(gitignorePath, 0o644);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("ensureArtifactIgnoreBlock: unmatched opening sentinel (no closing) -> throws instead of silently appending a second block", () => {
  // Regression for #452 review round 2 finding 1: an opening sentinel with no
  // closing sentinel must fail closed, not be treated as "block absent". If it
  // were treated as absent, a second run would pair this orphaned opener with
  // the closer of a newly-appended block and delete everything between them.
  const existing = [
    "node_modules/",
    "# >>> agent-pipeline artifacts (managed by `pipeline init`) >>>",
    "operator line that must never be deleted",
  ].join("\n");
  const fake = makeFakeFs(existing);
  assert.throws(() => ensureArtifactIgnoreBlock("/repo", fake.deps), /malformed managed block/);
  assert.equal(fake.get(), existing, "no write must occur when the sentinel span is malformed");
});

test("ensureArtifactIgnoreBlock: duplicate opening sentinels -> throws instead of pairing the wrong markers", () => {
  const oneBlock = renderArtifactIgnoreBlock();
  const existing = `${oneBlock}\noperator line\n${oneBlock}`;
  const fake = makeFakeFs(existing);
  assert.throws(() => ensureArtifactIgnoreBlock("/repo", fake.deps), /malformed managed block/);
  assert.equal(fake.get(), existing, "no write must occur when the block is duplicated");
});

test("ensureArtifactIgnoreBlock: operator already hand-ignores a contract path outside the block -> left untouched, block still lists it", () => {
  const existing = ".agent-pipeline/runs/\nnode_modules/\n";
  const fake = makeFakeFs(existing);
  const result = ensureArtifactIgnoreBlock("/repo", fake.deps);
  assert.equal(result.outcome, "updated");
  const after = fake.get()!;
  assert.ok(after.startsWith(existing), "the operator's hand-authored line must remain unmodified");
  assert.ok(after.includes(".agent-pipeline/runs/"), "the managed block must still list runs/");
});

test("writeAllSync: 4-byte short writes are retried until every byte lands (delta review c08a516e)", () => {
  // Regression for the #452 pre-merge delta finding: fs.writeSync may legally
  // write fewer bytes than requested (ENOSPC/EIO-class pressure); ignoring the
  // return value fsyncs+renames a truncated temp file over the operator-owned
  // .gitignore. Simulate a writer capped at 4 bytes per call and require every
  // byte to land, in order.
  const content = Buffer.from(renderArtifactIgnoreBlock(), "utf8");
  const landed: Buffer[] = [];
  const cappedWriteSync = (_fd: number, buf: Buffer, offset: number, length: number): number => {
    const n = Math.min(4, length);
    landed.push(Buffer.from(buf.subarray(offset, offset + n)));
    return n;
  };
  writeAllSync(99, content, cappedWriteSync);
  assert.equal(Buffer.concat(landed).toString("utf8"), content.toString("utf8"));
  assert.ok(landed.length >= Math.ceil(content.length / 4), "the writer must have looped");
});

test("writeAllSync: a zero-progress write throws instead of silently truncating", () => {
  const stalled = (_fd: number, _buf: Buffer, _offset: number, _length: number): number => 0;
  assert.throws(() => writeAllSync(99, Buffer.from("content", "utf8"), stalled), /no progress/);
});

test("ensureArtifactIgnoreBlock: default writer (real fs) writes via temp file + rename, no leftover temp file, mode preserved", () => {
  // Regression for #452 review round 2 finding 2: writes must not truncate the
  // target in place. Exercises the real defaultWriteFile (no injected
  // writeFile) against a real directory.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-ignore-test-"));
  const gitignorePath = path.join(repoDir, ".gitignore");
  const operatorContent = "node_modules/\n";
  fs.writeFileSync(gitignorePath, operatorContent, "utf8");
  fs.chmodSync(gitignorePath, 0o640);
  try {
    const result = ensureArtifactIgnoreBlock(repoDir);
    assert.equal(result.outcome, "updated");
    assert.equal(fs.statSync(gitignorePath).mode & 0o777, 0o640, "original file mode must be preserved");

    const leftovers = fs
      .readdirSync(repoDir)
      .filter((name) => name !== ".gitignore" && name.includes(".gitignore"));
    assert.deepEqual(leftovers, [], "no temp file should remain after a successful write");
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
