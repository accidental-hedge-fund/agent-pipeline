// Engine artifact ignore contract (#452): the single source of truth for every
// `.agent-pipeline/` directory the engine writes at runtime, the renderer that
// turns it into a sentinel-delimited `.gitignore` block, and the idempotent
// operation that ensures that block exists in a repo's root `.gitignore`
// without clobbering operator-authored lines.
//
// Directory helpers (`runsDir`, `issueHistoryDir` in run-store.ts; the roadmap
// output dir in roadmap/index.ts) derive their `.agent-pipeline/<name>`
// segment from the entries below, so a new artifact directory cannot exist
// without a declared ignore entry — see the drift-guard test.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ArtifactContractEntry {
  /** Directory name under `.agent-pipeline/` (no slashes, no leading/trailing slash). */
  name: string;
  /** Human-readable line describing what the directory holds, rendered as a
   *  comment immediately above this entry's ignore path. */
  comment: string;
}

export const RUNS_ARTIFACT: ArtifactContractEntry = {
  name: "runs",
  comment: "Per-run evidence bundles written by the engine; local-only, never committed.",
};

export const ROADMAP_ARTIFACT: ArtifactContractEntry = {
  name: "roadmap",
  comment: "Generated roadmap artifacts; delivered through a PR by `pipeline roadmap --apply`.",
};

export const HISTORY_ARTIFACT: ArtifactContractEntry = {
  name: "history",
  comment: "Per-issue evidence history (issue-<N>.jsonl); local-only, never committed.",
};

/** Ordered contract of every `.agent-pipeline/` directory the engine writes.
 *  No other module SHALL independently define an `.agent-pipeline/` artifact
 *  directory path — derive it from an entry here instead. */
export const ARTIFACT_CONTRACT: readonly ArtifactContractEntry[] = [
  RUNS_ARTIFACT,
  ROADMAP_ARTIFACT,
  HISTORY_ARTIFACT,
];

/** Resolve `<repoDir>/.agent-pipeline/<entry.name>` for a contract entry. */
export function artifactSubdir(repoDir: string, entry: ArtifactContractEntry): string {
  return path.join(repoDir, ".agent-pipeline", entry.name);
}

function ignorePathFor(entry: ArtifactContractEntry): string {
  return `.agent-pipeline/${entry.name}/`;
}

const SENTINEL_OPEN = "# >>> agent-pipeline artifacts (managed by `pipeline init`) >>>";
const SENTINEL_CLOSE = "# <<< agent-pipeline artifacts (managed by `pipeline init`) <<<";

/** Render the sentinel-delimited managed `.gitignore` block from the artifact
 *  contract. Deterministic: the same contract always produces byte-identical
 *  text, always ending in exactly one trailing newline. */
export function renderArtifactIgnoreBlock(): string {
  const lines = [SENTINEL_OPEN];
  for (const entry of ARTIFACT_CONTRACT) {
    lines.push(`# ${entry.comment}`);
    lines.push(ignorePathFor(entry));
  }
  lines.push(SENTINEL_CLOSE);
  return `${lines.join("\n")}\n`;
}

interface SentinelSpan {
  openIdx: number;
  /** Index immediately after the block, including the sentinel-close line's
   *  own trailing newline (if present). */
  blockEnd: number;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Parse the sentinel span strictly: a malformed managed block (unmatched or
 *  duplicated opening/closing sentinels) throws rather than being silently
 *  treated as absent, which would let a later run pair an orphaned sentinel
 *  with the wrong counterpart and delete operator-authored lines between
 *  them (#452 review round 2). */
function findSentinelSpan(content: string): SentinelSpan | null {
  const openCount = countOccurrences(content, SENTINEL_OPEN);
  const closeCount = countOccurrences(content, SENTINEL_CLOSE);
  if (openCount === 0 && closeCount === 0) return null;
  const openIdx = content.indexOf(SENTINEL_OPEN);
  const closeIdx = content.indexOf(SENTINEL_CLOSE);
  if (openCount !== 1 || closeCount !== 1 || closeIdx < openIdx) {
    throw new Error(
      "agent-pipeline: malformed managed block in .gitignore " +
        `(found ${openCount} opening and ${closeCount} closing sentinel(s)); ` +
        "refusing to write — fix or remove the managed block by hand and re-run.",
    );
  }
  let blockEnd = closeIdx + SENTINEL_CLOSE.length;
  if (content[blockEnd] === "\n") blockEnd += 1;
  return { openIdx, blockEnd };
}

export interface ArtifactIgnoreDeps {
  /** Read file contents; return null if the file does not exist. Defaults to fs.readFileSync. */
  readFile?: (filePath: string) => string | null;
  /** Write file contents. Defaults to fs.writeFileSync. */
  writeFile?: (filePath: string, content: string) => void;
}

export type ArtifactIgnoreOutcome = "created" | "updated" | "unchanged";

export interface EnsureArtifactIgnoreResult {
  outcome: ArtifactIgnoreOutcome;
  gitignorePath: string;
}

const defaultReadFile = (fp: string): string | null => {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
};

/** Write via a temp file + rename in the same directory so an interrupted or
 *  failed write (ENOSPC/EIO/process kill) cannot leave a truncated,
 *  operator-owned .gitignore (#452 review round 2). Preserves the original
 *  file's mode when overwriting. */
const defaultWriteFile = (fp: string, content: string): void => {
  const dir = path.dirname(fp);
  const tmpPath = path.join(dir, `.${path.basename(fp)}.${crypto.randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = fs.statSync(fp).mode;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
  try {
    const fd = fs.openSync(tmpPath, "wx");
    try {
      fs.writeSync(fd, content, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (mode !== undefined) fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, fp);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup; the original error is what matters */
    }
    throw err;
  }
};

/** Ensure the engine-managed artifact ignore block exists (and is current) in
 *  `<repoDir>/.gitignore`, without ever touching lines outside the sentinels.
 *
 *  - No `.gitignore` → create one containing only the rendered block.
 *  - `.gitignore` exists, block absent → append the block, preserving every
 *    pre-existing byte.
 *  - `.gitignore` exists, block present and current → no write, `unchanged`.
 *  - `.gitignore` exists, block present and stale → rewrite only the span
 *    between the sentinels; content before/after is preserved byte-identical. */
export function ensureArtifactIgnoreBlock(
  repoDir: string,
  deps: ArtifactIgnoreDeps = {},
): EnsureArtifactIgnoreResult {
  const readFile = deps.readFile ?? defaultReadFile;
  const writeFile = deps.writeFile ?? defaultWriteFile;
  const gitignorePath = path.join(repoDir, ".gitignore");
  const block = renderArtifactIgnoreBlock();
  const current = readFile(gitignorePath);

  if (current === null) {
    writeFile(gitignorePath, block);
    return { outcome: "created", gitignorePath };
  }

  const span = findSentinelSpan(current);
  if (!span) {
    const prefix =
      current.length === 0
        ? ""
        : current.endsWith("\n\n")
          ? current
          : current.endsWith("\n")
            ? `${current}\n`
            : `${current}\n\n`;
    writeFile(gitignorePath, `${prefix}${block}`);
    return { outcome: "updated", gitignorePath };
  }

  const existingBlock = current.slice(span.openIdx, span.blockEnd);
  if (existingBlock === block) {
    return { outcome: "unchanged", gitignorePath };
  }

  const before = current.slice(0, span.openIdx);
  const after = current.slice(span.blockEnd);
  writeFile(gitignorePath, `${before}${block}${after}`);
  return { outcome: "updated", gitignorePath };
}
