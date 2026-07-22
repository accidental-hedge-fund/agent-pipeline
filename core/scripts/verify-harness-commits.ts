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

export type VerifyResult = { ok: true; warning?: string } | { ok: false; reason: string };

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
  /**
   * When true, an empty commit range is not an error even when commit-based checks
   * (issueNumber, messagePattern, requireTrailers) are configured. Use ONLY for
   * steps whose spec explicitly allows no commits. Default: false (empty range blocks).
   */
  allowEmpty?: boolean;
  /**
   * Assert every file changed in `headBefore..HEAD` matches this allow-pattern.
   * Files that do not match cause a block with the provided description.
   * `allowDirtyPattern`, when set, exempts matching dirty files from the constraint
   * so that planning notes left dirty by a scoped salvage do not trip the guard.
   */
  pathConstraint?: { allowPattern: RegExp; description: string; allowDirtyPattern?: RegExp };
}

export interface VerifyDeps {
  /** Returns full commit bodies for each commit in `headBefore..HEAD`. Empty array if none. */
  gitMessages?: (wtPath: string, headBefore: string) => Promise<string[]>;
  /** Returns names of files changed in `headBefore..HEAD`. Empty array if none. */
  gitDiffFiles?: (wtPath: string, headBefore: string) => Promise<string[]>;
  /** Returns names of uncommitted (dirty) files in the worktree. */
  gitDirtyFiles?: (wtPath: string) => Promise<string[]>;
  /** Returns commit SHAs in `headBefore..HEAD` (newest-first). Empty array if none. */
  gitCommitShas?: (wtPath: string, headBefore: string) => Promise<string[]>;
  /** Returns paths of files changed in a single commit SHA via `git diff-tree`. */
  gitDiffTreeFiles?: (wtPath: string, sha: string) => Promise<string[]>;
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

async function defaultGitCommitShas(wtPath: string, headBefore: string): Promise<string[]> {
  const res = await gitInWorktree(
    wtPath,
    ["log", `${headBefore}..HEAD`, "--format=%H"],
    { ignoreFailure: true },
  );
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function defaultGitDiffTreeFiles(wtPath: string, sha: string): Promise<string[]> {
  // --diff-filter=d (lowercase) excludes deleted paths so a cleanup commit that
  // removes a previously committed node_modules entry is not blocked by the scan.
  const res = await gitInWorktree(
    wtPath,
    ["diff-tree", "--no-commit-id", "-r", "--name-only", "--diff-filter=d", sha],
    { ignoreFailure: true },
  );
  return res.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
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
// Documentation allow-list (docs-only check)
// ---------------------------------------------------------------------------

const DOCS_ALLOW_PATTERNS: RegExp[] = [
  /\.md$/i,
  /\.txt$/i,
  /\.rst$/i,
  /\.adoc$/i,
  /^docs\//i,
  /^doc\//i,
  // Common named documentation files without extension
  /^(README|CHANGELOG|LICENSE|CONTRIBUTING|AUTHORS|NOTICE|CODEOWNERS|SECURITY)$/i,
];

/**
 * Returns true when the file path looks like a documentation file.
 * Used in docsOnly mode: any file NOT matching the allow-list is denied.
 * Exported for tests.
 */
export function isDocumentationFile(filePath: string): boolean {
  return DOCS_ALLOW_PATTERNS.some((re) => re.test(filePath));
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
  const getCommitShas = deps.gitCommitShas ?? defaultGitCommitShas;
  const getDiffTreeFiles = deps.gitDiffTreeFiles ?? defaultGitDiffTreeFiles;

  // Node-modules scan runs FIRST on every non-empty range, before any other
  // check that could return early.  This guarantees the diagnostic is surfaced
  // even when commit-message, trailer, docsOnly, or pathConstraint checks would
  // also block on a different violation in the same range.
  const shas = await getCommitShas(wtPath, headBefore);
  for (const sha of shas) {
    const files = await getDiffTreeFiles(wtPath, sha);
    for (const file of files) {
      if (file.split("/")[0] === "node_modules") {
        return {
          ok: false,
          reason: `Commit ${sha} adds a node_modules entry (${file}); node_modules must not be committed`,
        };
      }
    }
  }

  // Commit-based checks
  const requiresCommits =
    config.issueNumber !== undefined || config.messagePattern || config.requireTrailers?.length;
  if (requiresCommits) {
    const messages = await getMessages(wtPath, headBefore);
    if (messages.length === 0) {
      if (!config.allowEmpty) {
        return {
          ok: false,
          reason:
            "No commits found in the range; the harness was expected to produce at least one commit",
        };
      }
    } else {
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

  // Docs-only file constraint: allow-list approach — any file not matching
  // a documentation pattern is denied (finding 4).
  if (config.docsOnly) {
    const [diffFiles, dirtyFiles] = await Promise.all([
      getDiffFiles(wtPath, headBefore),
      getDirtyFiles(wtPath),
    ]);
    const allFiles = [...new Set([...diffFiles, ...dirtyFiles])];
    const denied = allFiles.filter((f) => !isDocumentationFile(f));
    if (denied.length > 0) {
      return {
        ok: false,
        reason: `Docs-update commit modified non-documentation files: ${denied.join(", ")}`,
      };
    }
  }

  // Path constraint: every committed or dirty file must match the allow-pattern
  // (#68 review-2 finding 2: dirty files must also be checked so an authoring
  // harness cannot bypass the constraint by leaving application code uncommitted).
  // `allowDirtyPattern`, when set, exempts matching dirty paths from the check
  // so that planning notes left dirty by a scoped salvage do not trip the guard.
  if (config.pathConstraint) {
    const [diffFiles, dirtyFiles] = await Promise.all([
      getDiffFiles(wtPath, headBefore),
      getDirtyFiles(wtPath),
    ]);
    const { allowPattern, allowDirtyPattern } = config.pathConstraint;
    const filteredDirtyFiles = allowDirtyPattern
      ? dirtyFiles.filter((f) => !allowDirtyPattern.test(f))
      : dirtyFiles;
    const allFiles = [...new Set([...diffFiles, ...filteredDirtyFiles])];
    const denied = allFiles.filter((f) => !allowPattern.test(f));
    if (denied.length > 0) {
      return { ok: false, reason: config.pathConstraint.description };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Plan-revision output check (pure — no git calls needed)
// ---------------------------------------------------------------------------

/**
 * Verify that the plan-revision harness output includes a machine-readable
 * `## Feedback Incorporated` section with tagged bullet items, and optionally
 * that the number of tagged items covers the count of feedback items given.
 *
 * @param stdout - Full stdout from the plan-revision harness.
 * @param feedback - Optional: the reviewer feedback text. When provided, the
 *   number of `[ADDRESSED]`/`[DEFERRED]` tags must be ≥ the number of
 *   top-level items (numbered or bulleted) detected in the feedback.
 */
export function verifyPlanRevisionOutput(stdout: string, feedback?: string): VerifyResult {
  // 0. Neutralise code-fence delimiter lines so fenced content is scanned like
  //    ordinary text — models routinely wrap the acknowledgement section (and,
  //    when copying the prompt's format example verbatim, a *duplicated*
  //    header) inside a code fence.
  const cleaned = stdout.replace(/^[ \t]{0,3}(`{3,}|~{3,}).*$/gm, "");

  // 1. Locate every ## Feedback Incorporated header occurrence — not just the
  //    first — since a duplicated header inside a fence would otherwise be
  //    mistaken for the "next section" boundary and truncate the real one.
  const headerMatches = [...cleaned.matchAll(/^##\s+Feedback\s+Incorporated\b/gim)];
  if (headerMatches.length === 0) {
    return {
      ok: false,
      reason: "Plan revision output is missing required ## Feedback Incorporated section",
    };
  }

  // 2. For each header occurrence, extract its candidate section: from after
  //    the header to the next level-2 section or end. Require tagged bullet
  //    lines within a candidate section (not just anywhere in stdout).
  //    Tolerate a leading bullet and markdown emphasis around the tag — models
  //    routinely render it as "- **[ADDRESSED]**" or "* _[DEFERRED]_". The
  //    match stays anchored to line-start so prose mentions of "[ADDRESSED]"
  //    don't count. The requirement is satisfied if ANY occurrence's section
  //    has tagged items; the advisory coverage count is the max across
  //    occurrences so a duplicated header doesn't double-count the same bullets.
  let maxTaggedCount = 0;
  for (const headerMatch of headerMatches) {
    const afterHeader = cleaned.slice(headerMatch.index + headerMatch[0].length);
    const nextSection = afterHeader.search(/^##\s/m);
    const sectionContent = nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;
    const taggedItems = sectionContent.match(/^[\s>*_-]*\[(ADDRESSED|DEFERRED)\]/gim) ?? [];
    maxTaggedCount = Math.max(maxTaggedCount, taggedItems.length);
  }

  if (maxTaggedCount === 0) {
    return {
      ok: false,
      reason:
        "Plan revision ## Feedback Incorporated section has no [ADDRESSED] or [DEFERRED] items",
    };
  }

  // 3. When feedback is provided, a coverage shortfall is ADVISORY (not a block).
  //    `countTopLevelItems` is heuristic — it counts every bullet in the reviewer
  //    feedback, including non-actionable "Risks / Checks" lines — so hard-blocking
  //    on it false-blocks revisions that legitimately acknowledge only the
  //    actionable "Required Changes". The hard gate is the presence of the section
  //    plus at least one tagged item (checked above); coverage is surfaced as a
  //    warning for the operator, not a blocker.
  if (feedback) {
    const feedbackCount = countTopLevelItems(feedback);
    if (feedbackCount > 0 && maxTaggedCount < feedbackCount) {
      return {
        ok: true,
        warning:
          `Plan revision tags ${maxTaggedCount} of ${feedbackCount} detected feedback bullets — confirm each required change was addressed (advisory; some bullets may be non-actionable notes)`,
      };
    }
  }

  return { ok: true };
}

/** Count top-level numbered or bulleted items in reviewer feedback text. */
function countTopLevelItems(text: string): number {
  const lines = text.match(/^\s*(?:\*{0,2}\d+\.?\*{0,2}|[-*•])\s+\S/gm) ?? [];
  return lines.length;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
