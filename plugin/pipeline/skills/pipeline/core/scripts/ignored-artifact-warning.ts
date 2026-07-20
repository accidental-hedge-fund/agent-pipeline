// Ignored-artifact detection after a harness commit step (#445).
//
// When an implementing/fix-round harness creates a file that the target repo's
// .gitignore excludes, the commit step silently drops it — the run looks green
// locally while the pushed change is missing a file it depends on, and CI fails
// downstream with a mysterious "missing committed file" error far from the cause.
//
// This module detects that situation right after the harness commit step: it
// lists untracked-but-ignored files in the worktree, keeps only the ones
// referenced by name in the text of the commit(s) the harness just produced
// (the change-relevance heuristic — this is what keeps routine ignored clutter
// like node_modules/ or __pycache__/ from warning on every run), and resolves
// each surviving file's matching ignore rule via `git check-ignore -v`.
//
// Detection is advisory only: it never blocks, never mutates the worktree, and
// any git error is swallowed so the calling stage proceeds exactly as if no
// ignored artifact were present. A `deps` seam is accepted so tests can inject
// fake git operations without spawning real git processes (mirrors `SalvageDeps`).

import * as path from "node:path";
import { gitInWorktree } from "./worktree.ts";

export interface IgnoredArtifactFile {
  path: string;
  source: string | null;
  line: number | null;
  pattern: string | null;
}

export interface IgnoredArtifactDeps {
  /** repo-relative paths of untracked files excluded by gitignore. */
  gitListIgnored?: (wtPath: string) => Promise<string[]>;
  /** raw text of the diff between headBefore and headAfter. */
  gitDiffText?: (wtPath: string, headBefore: string, headAfter: string) => Promise<string>;
  /** matching ignore rule for a path, or null when none is resolvable. */
  gitCheckIgnore?: (
    wtPath: string,
    filePath: string,
  ) => Promise<{ source: string; line: number; pattern: string } | null>;
  /** Invoked with the surviving files when detection finds at least one. */
  emitEvent?: (files: IgnoredArtifactFile[]) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Default git implementations
// ---------------------------------------------------------------------------

async function defaultGitListIgnored(wtPath: string): Promise<string[]> {
  const res = await gitInWorktree(
    wtPath,
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    { ignoreFailure: true },
  );
  return res.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function defaultGitDiffText(
  wtPath: string,
  headBefore: string,
  headAfter: string,
): Promise<string> {
  const res = await gitInWorktree(wtPath, ["diff", headBefore, headAfter], { ignoreFailure: true });
  return res.stdout;
}

async function defaultGitCheckIgnore(
  wtPath: string,
  filePath: string,
): Promise<{ source: string; line: number; pattern: string } | null> {
  const res = await gitInWorktree(
    wtPath,
    ["check-ignore", "-v", "--no-index", "--", filePath],
    { ignoreFailure: true },
  );
  const line = res.stdout.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const match = line.match(/^(.+):(\d+):(.*)\t/);
  if (!match) return null;
  return { source: match[1], line: Number.parseInt(match[2], 10), pattern: match[3] };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect gitignored files left uncommitted by a harness commit step that are
 * referenced by name in the committed diff. Returns the surviving files (empty
 * when none, when the harness range is empty, or when any git call fails).
 *
 * Never throws — a failure at any step (listing ignored files, reading the
 * diff, resolving an ignore rule) is swallowed and treated as "no warnings",
 * exactly as if no ignored artifact were present.
 */
export async function detectIgnoredArtifacts(
  wtPath: string,
  headBefore: string,
  headAfter: string,
  deps: IgnoredArtifactDeps = {},
): Promise<IgnoredArtifactFile[]> {
  if (!headBefore || !headAfter || headBefore === headAfter) return [];

  try {
    const listIgnored = deps.gitListIgnored ?? defaultGitListIgnored;
    const diffText = deps.gitDiffText ?? defaultGitDiffText;
    const checkIgnore = deps.gitCheckIgnore ?? defaultGitCheckIgnore;

    const ignored = await listIgnored(wtPath);
    if (ignored.length === 0) return [];

    const diff = await diffText(wtPath, headBefore, headAfter);
    if (!diff.trim()) return [];

    const referenced = ignored.filter(
      (p) => diff.includes(p) || diff.includes(path.basename(p)),
    );
    if (referenced.length === 0) return [];

    const files: IgnoredArtifactFile[] = [];
    for (const p of referenced) {
      const rule = await checkIgnore(wtPath, p);
      files.push({
        path: p,
        source: rule?.source ?? null,
        line: rule?.line ?? null,
        pattern: rule?.pattern ?? null,
      });
    }

    console.warn(
      `[pipeline] gitignored artifact(s) referenced by the committed diff were left uncommitted:\n` +
        files
          .map((f) => {
            const rule = f.source
              ? `${f.source}${f.line !== null ? `:${f.line}` : ""}${f.pattern ? ` "${f.pattern}"` : ""}`
              : "unknown rule";
            return `  - ${f.path} (ignored by ${rule})`;
          })
          .join("\n"),
    );

    if (deps.emitEvent) {
      await deps.emitEvent(files);
    }

    return files;
  } catch (err) {
    console.warn(
      `[pipeline] ignored-artifact detection failed (non-fatal): ${(err as Error).message}`,
    );
    return [];
  }
}
