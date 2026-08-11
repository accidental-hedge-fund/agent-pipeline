// Post-tag generator-owned docs refresh (#978).
//
// After annotated version tag vX.Y.Z exists, regenerate docs (CHANGELOG is
// tag-derived) and commit dirt limited to generator-owned paths. Primary live
// invoker: auto-tag-release workflow. Optional secondary: release finish heal.
//
// Never creates, rewrites, or deletes version tags. Fail closed on generate or
// commit/push errors after a tag already exists.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { runCapped } from "./harness.ts";
import { gitInWorktree } from "./worktree.ts";

/** Relative path of the docs generator write entry. */
export const DOCS_GENERATE_COMMAND = "node scripts/generate-docs.mjs";

/**
 * Paths the docs generator owns (write mode). Staging is restricted to these
 * so unrelated worktree dirt is never folded into the post-tag commit.
 */
export const GENERATOR_OWNED_PATHS: readonly string[] = [
  "CHANGELOG.md",
  "docs/cli.md",
  "docs/config.md",
  "hosts/claude/SKILL.md",
  "hosts/codex/SKILL.md",
];

const DOCS_TIMEOUT_SEC = 5 * 60;

/** Conventional subject for the post-tag CHANGELOG refresh commit. */
export function postTagDocsCommitMessage(version: string): string {
  const ver = String(version ?? "").replace(/^v/, "").trim();
  return `docs: regenerate CHANGELOG for v${ver}`;
}

/** True when a relative path is generator-owned (exact match only). */
export function isGeneratorOwnedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (GENERATOR_OWNED_PATHS as readonly string[]).includes(normalized);
}

export interface ReleaseDocsRefreshDeps {
  log?: (msg: string) => void;
  /**
   * Run docs generator write mode (same contract as `node scripts/generate-docs.mjs`).
   * Injectable so unit tests never need a live generator/subprocess.
   */
  generateDocs: (repoDir: string) => Promise<{ code: number; output: string }>;
  /** List dirty worktree-relative paths after generate (any dirt). */
  listDirtyPaths: (repoDir: string) => Promise<string[]>;
  /** Stage the given relative paths (`git add -- <paths>`). */
  gitAdd: (repoDir: string, paths: string[]) => Promise<void>;
  /** Create a new commit with the given message (not amend). */
  gitCommit: (repoDir: string, message: string) => Promise<void>;
  /**
   * Optional push of the current branch after a docs commit.
   * When omitted, commit-only success is still ok (caller may push).
   */
  gitPush?: (repoDir: string) => Promise<void>;
  /** Override path ownership filter (defaults to {@link isGeneratorOwnedPath}). */
  isGeneratorOwnedPath?: (relPath: string) => boolean;
}

export type ReleaseDocsRefreshResult =
  | { ok: true; committed: false; reason: "clean" }
  | { ok: true; committed: true; paths: string[]; commitMessage: string }
  | { ok: false; committed: false; error: string };

/**
 * Regenerate docs after a version tag exists and commit generator-owned dirt.
 *
 * - Generate failure → fail closed, no commit, no tag mutation.
 * - No generator-owned dirt → success no-op (no empty commit).
 * - Dirt present → stage only generator-owned paths, commit, optional push.
 * - Commit/push failure → fail closed; never deletes tags.
 */
export async function refreshPostTagDocs(
  repoDir: string,
  version: string,
  deps: ReleaseDocsRefreshDeps,
): Promise<ReleaseDocsRefreshResult> {
  const ver = String(version ?? "").replace(/^v/, "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    return {
      ok: false,
      committed: false,
      error: `release-docs-refresh: invalid version ${JSON.stringify(version)} (expected X.Y.Z)`,
    };
  }

  const log = deps.log ?? (() => {});
  const owned = deps.isGeneratorOwnedPath ?? isGeneratorOwnedPath;
  const commitMessage = postTagDocsCommitMessage(ver);

  log(`[release-docs-refresh] v${ver}: regenerating generator-owned docs…`);
  let genRes: { code: number; output: string };
  try {
    genRes = await deps.generateDocs(repoDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      committed: false,
      error:
        `release-docs-refresh: docs generator threw while regenerating for v${ver}: ${msg}. ` +
        `The version tag is left unchanged — re-run after fixing the generator.`,
    };
  }

  if (genRes.code !== 0) {
    const body = (genRes.output || "(no output)").trim();
    return {
      ok: false,
      committed: false,
      error:
        `release-docs-refresh: docs generator failed for v${ver} (exit ${genRes.code}). ` +
        `No docs commit was created; the version tag is left unchanged.\n${body}`,
    };
  }

  let dirty: string[];
  try {
    dirty = await deps.listDirtyPaths(repoDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      committed: false,
      error:
        `release-docs-refresh: failed to inspect worktree dirt after generate for v${ver}: ${msg}`,
    };
  }

  const ownedDirty = [...new Set(dirty.map((p) => p.replace(/\\/g, "/")).filter(owned))].sort();
  if (ownedDirty.length === 0) {
    log(`[release-docs-refresh] v${ver}: generator tree already fresh — no commit`);
    return { ok: true, committed: false, reason: "clean" };
  }

  log(
    `[release-docs-refresh] v${ver}: committing generator-owned dirt: ${ownedDirty.join(", ")}`,
  );

  try {
    await deps.gitAdd(repoDir, ownedDirty);
    await deps.gitCommit(repoDir, commitMessage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      committed: false,
      error:
        `release-docs-refresh: commit failed for v${ver}: ${msg}. ` +
        `The version tag is left unchanged — heal with: node scripts/release-docs-refresh.mjs --version ${ver}`,
    };
  }

  if (deps.gitPush) {
    try {
      await deps.gitPush(repoDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        committed: false,
        error:
          `release-docs-refresh: push failed after local docs commit for v${ver}: ${msg}. ` +
          `Local commit may exist; the version tag is left unchanged. Push or re-run heal.`,
      };
    }
  }

  log(`[release-docs-refresh] v${ver}: committed ${commitMessage}`);
  return { ok: true, committed: true, paths: ownedDirty, commitMessage };
}

// ---------------------------------------------------------------------------
// Production deps (used by scripts/release-docs-refresh.mjs and release finish)
// ---------------------------------------------------------------------------

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}

async function defaultGenerateDocs(repoDir: string): Promise<{ code: number; output: string }> {
  const res = await runCapped(
    "bash",
    ["-c", `set -o pipefail\n${DOCS_GENERATE_COMMAND}`],
    repoDir,
    DOCS_TIMEOUT_SEC,
    false,
    "release-docs-refresh",
    { killProcessGroup: true },
  );
  let output = combineOutput(res);
  if (res.timed_out) {
    output = `${output}\n\n[docs generate timed out after ${DOCS_TIMEOUT_SEC}s]`;
  }
  return { code: res.success ? 0 : (res.exit_code || 1), output };
}

function parsePorcelainPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3);
    if (pathPart.includes(" -> ")) {
      const dst = pathPart.slice(pathPart.indexOf(" -> ") + 4).trim();
      if (dst) paths.push(dst);
    } else {
      const trimmed = pathPart.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}

async function defaultListDirtyPaths(repoDir: string): Promise<string[]> {
  const res = await gitInWorktree(repoDir, ["status", "--porcelain"], { ignoreFailure: true });
  return parsePorcelainPaths(res.stdout);
}

async function defaultGitAdd(repoDir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await gitInWorktree(repoDir, ["add", "--", ...paths]);
}

async function defaultGitCommit(repoDir: string, message: string): Promise<void> {
  await gitInWorktree(repoDir, ["commit", "-m", message]);
}

async function defaultGitPush(repoDir: string): Promise<void> {
  const res = await gitInWorktree(repoDir, ["push"], { ignoreFailure: true });
  if (res.code !== 0) {
    throw new Error((res.stderr || res.stdout || "git push failed").trim());
  }
}

/**
 * Build production deps for a repo checkout. When `push` is true, includes git push.
 */
export function realReleaseDocsRefreshDeps(opts: {
  push?: boolean;
  log?: (msg: string) => void;
} = {}): ReleaseDocsRefreshDeps {
  return {
    log: opts.log ?? ((msg) => console.error(msg)),
    generateDocs: defaultGenerateDocs,
    listDirtyPaths: defaultListDirtyPaths,
    gitAdd: defaultGitAdd,
    gitCommit: defaultGitCommit,
    ...(opts.push ? { gitPush: defaultGitPush } : {}),
  };
}

/**
 * True when local or origin has annotated-style ref `refs/tags/vX.Y.Z`.
 * Used by optional release-finish heal; injectable via callers in tests.
 */
export function localTagExists(repoDir: string, version: string): boolean {
  const ver = String(version).replace(/^v/, "");
  const res = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/v${ver}`], {
    cwd: repoDir,
    encoding: "utf8",
  });
  return res.status === 0;
}

/**
 * Best-effort poll for tag presence (release finish optional heal).
 * Returns true when the tag becomes visible locally within the budget.
 */
export async function waitForLocalTag(
  repoDir: string,
  version: string,
  opts: {
    attempts?: number;
    delayMs?: number;
    fetchTags?: () => Promise<void> | void;
    tagExists?: (dir: string, ver: string) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 6;
  const delayMs = opts.delayMs ?? 5_000;
  const exists = opts.tagExists ?? localTagExists;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchTags =
    opts.fetchTags ??
    (async () => {
      spawnSync("git", ["fetch", "--tags", "--quiet", "origin"], {
        cwd: repoDir,
        encoding: "utf8",
      });
    });

  for (let i = 0; i < attempts; i++) {
    try {
      await fetchTags();
    } catch {
      // fetch is best-effort
    }
    if (exists(repoDir, version)) return true;
    if (i + 1 < attempts) await sleep(delayMs);
  }
  return exists(repoDir, version);
}

/** Guard used by the CLI entry: generator file must exist. */
export function docsGeneratorPresent(repoDir: string): boolean {
  return fs.existsSync(path.join(repoDir, "scripts", "generate-docs.mjs"));
}
