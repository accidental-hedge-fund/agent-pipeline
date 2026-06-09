// Shared post-harness verification helpers (#68).
//
// Provides a single `verifyHarnessCommits` entry point that each harness-instruction
// step calls after the harness exits to enforce the invariants its prompt prescribes.
// Invariant categories:
//   - issueNumber:    at least one new commit references #<N> in subject or body
//   - messagePattern: at least one new commit subject/body matches the given pattern
//   - requireTrailers: every new commit carries the listed Git trailer keys
//   - docsOnly:       all changed files (committed + uncommitted) are documentation-only
//
// A `VerifyDeps` seam is accepted so tests can inject fake git outputs without
// spawning real git processes.

import { gitInWorktree } from "./worktree.ts";

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export interface VerifyConfig {
  /** Assert at least one new commit message (subject+body) contains `#<issueNumber>` */
  issueNumber?: number;
  /** Assert at least one new commit message matches this pattern */
  messagePattern?: { pattern: RegExp; description: string };
  /**
   * Assert EVERY new commit carries these Git trailer keys (e.g. "Issue", "Pipeline-Run").
   * Per-commit check; fails on the first commit missing any required key.
   */
  requireTrailers?: string[];
  /**
   * Assert all changed files (committed in `headBefore..HEAD` + uncommitted dirty
   * paths) are documentation-only — none may match the application-code deny-list.
   */
  docsOnly?: boolean;
}

export interface VerifyDeps {
  /** Returns full commit bodies for each commit in `headBefore..HEAD`. Empty array if none. */
  gitMessages?: (wtPath: string, headBefore: string) => Promise<string[]>;
  /** Returns names of files changed in `headBefore..HEAD`. Empty array if none. */
  gitDiffFiles?: (wtPath: string, headBefore: string) => Promise<string[]>;
  /** Returns names of uncommitted (dirty) files in the worktree. */
  gitDirtyFiles?: (wtPath: string) => Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Default git implementations
// ---------------------------------------------------------------------------

async function defaultGitMessages(wtPath: string, headBefore: string): Promise<string[]> {
  const res = await gitInWorktree(
    wtPath,
    ["log", `${headBefore}..HEAD`, "--format=%x00%B", "--reverse"],
    { ignoreFailure: true },
  );
  return res.stdout.split("\x00").map((m) => m.trim()).filter(Boolean);
}

async function defaultGitDiffFiles(wtPath: string, headBefore: string): Promise<string[]> {
  const res = await gitInWorktree(
    wtPath,
    ["diff", "--name-only", `${headBefore}..HEAD`],
    { ignoreFailure: true },
  );
  return res.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
}

async function defaultGitDirtyFiles(wtPath: string): Promise<string[]> {
  const res = await gitInWorktree(wtPath, ["status", "--porcelain"], { ignoreFailure: true });
  return parseDirtyFiles(res.stdout);
}

/** Parse `git status --porcelain` output into a list of affected file paths. Exported for tests. */
export function parseDirtyFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .filter((line) => line.length >= 3)
    .map((line) => {
      const rest = line.slice(3); // skip two-char status + space
      const arrow = rest.indexOf(" -> ");
      return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Application-code deny-list (docs-only check)
// ---------------------------------------------------------------------------

const APP_CODE_DENY_PATTERNS: RegExp[] = [
  /\.(ts|tsx|js|jsx|mts|mjs|cjs)$/,
  /^(src|core|plugin)\//,
];

/** Returns true when the file path looks like application code (not documentation). Exported for tests. */
export function isApplicationCodeFile(filePath: string): boolean {
  return APP_CODE_DENY_PATTERNS.some((re) => re.test(filePath));
}

// ---------------------------------------------------------------------------
// Main verification entry point
// ---------------------------------------------------------------------------

/**
 * Verify that the harness complied with the invariants prescribed by its prompt.
 * Call immediately after the harness exits and before advancing the stage.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on the first
 * violated invariant. The caller should block (not advance) on a non-ok result.
 */
export async function verifyHarnessCommits(
  wtPath: string,
  headBefore: string,
  config: VerifyConfig,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const getMessages = deps.gitMessages ?? defaultGitMessages;
  const getDiffFiles = deps.gitDiffFiles ?? defaultGitDiffFiles;
  const getDirtyFiles = deps.gitDirtyFiles ?? defaultGitDirtyFiles;

  // Commit-based checks
  if (config.issueNumber !== undefined || config.messagePattern || config.requireTrailers?.length) {
    const messages = await getMessages(wtPath, headBefore);
    if (messages.length > 0) {
      if (config.issueNumber !== undefined) {
        const ref = `#${config.issueNumber}`;
        if (!messages.some((m) => m.includes(ref))) {
          return {
            ok: false,
            reason: `Implementation commits are missing issue reference ${ref}`,
          };
        }
      }

      if (config.messagePattern) {
        const { pattern, description } = config.messagePattern;
        if (!messages.some((m) => pattern.test(m))) {
          return { ok: false, reason: description };
        }
      }

      if (config.requireTrailers?.length) {
        for (const msg of messages) {
          for (const key of config.requireTrailers) {
            const re = new RegExp(`^${escapeRegex(key)}:\\s*.+`, "m");
            if (!re.test(msg)) {
              return {
                ok: false,
                reason: `A commit is missing required trailer "${key}:"`,
              };
            }
          }
        }
      }
    }
  }

  // Docs-only file constraint
  if (config.docsOnly) {
    const [diffFiles, dirtyFiles] = await Promise.all([
      getDiffFiles(wtPath, headBefore),
      getDirtyFiles(wtPath),
    ]);
    const allFiles = [...new Set([...diffFiles, ...dirtyFiles])];
    const denied = allFiles.filter(isApplicationCodeFile);
    if (denied.length > 0) {
      return {
        ok: false,
        reason: `Docs-update commit modified non-documentation files: ${denied.join(", ")}`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Plan-revision output check (pure — no git calls needed)
// ---------------------------------------------------------------------------

/**
 * Verify that the plan-revision harness output includes a machine-readable
 * `## Feedback Incorporated` section with at least one `[ADDRESSED]` or
 * `[DEFERRED]` item. Exported for direct unit testing.
 */
export function verifyPlanRevisionOutput(stdout: string): VerifyResult {
  if (!/^##\s+Feedback\s+Incorporated/im.test(stdout)) {
    return {
      ok: false,
      reason: "Plan revision output is missing required ## Feedback Incorporated section",
    };
  }
  if (!/\[(ADDRESSED|DEFERRED)\]/i.test(stdout)) {
    return {
      ok: false,
      reason:
        "Plan revision ## Feedback Incorporated section has no [ADDRESSED] or [DEFERRED] items",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
