// Visual-gate stage (#395): run the repo's E2E/visual suite after pre-merge,
// before eval-gate, and capture its declared artifacts (screenshots, diffs,
// traces) as PR-visible evidence.
//
// This mirrors eval.ts's lifecycle deliberately (see openspec/changes/
// add-visual-gate/design.md decision 1): opt-in, `sh -c` execution in the
// issue worktree, exit-code-only verdict, gate/advisory modes, bounded
// fix-round recovery, tooling failures always block. The one addition is the
// artifact bundle: after each run the stage enumerates `artifacts_dir`
// (bounded count/size, deterministic order), copies the files into the run
// directory, and records the manifest in the `## Visual Gate` comment and the
// evidence bundle. Exit code alone decides pass/fail — the pipeline never
// parses output or diffs images.
//
// Unlike eval-gate (which is the last of the optional gate chain and must
// pick between shipcheck-gate/ready-to-deploy), visual-gate always advances
// to eval-gate — disabled-skip and ordinary pass both target it.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  branchName,
  getOnDiskForIssue as defaultGetForIssue,
  gitInWorktree,
} from "../worktree.ts";
import {
  getGhActor as defaultGetGhActor,
  getIssueDetail as defaultGetIssueDetail,
  getPrCommits as defaultGetPrCommits,
  getPrForIssue as defaultGetPrForIssue,
  postComment as defaultPostComment,
  setBlocked as defaultSetBlocked,
  silentTransition as defaultSilentTransition,
  transition as defaultTransition,
} from "../gh.ts";
import { invoke as defaultInvoke, runCapped, type HarnessResult, type InvokeOptions } from "../harness.ts";
import { buildVisualFixPrompt } from "../prompts/index.ts";
import { extractReviewedSha } from "./review-parsing.ts";
import {
  verifyHarnessCommits,
  type VerifyDeps,
  type VerifyResult,
} from "../verify-harness-commits.ts";
import { makePipelineRunId, validateCommitTrailers } from "../traceability.ts";
import { trySalvageUncommittedWork } from "../salvage-harness-work.ts";
import { makeCommandRecord, makePromptRecord, recordCommand, recordPrompt } from "../evidence-bundle.ts";
import { redactSecrets } from "../artifact-sanitize.ts";
import type { BlockerKind, Harness, Outcome, PipelineConfig, Stage } from "../types.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "../run-store.ts";
import { buildStageAccountingRecord } from "../accounting.ts";
import { emitStageAccounting } from "../run-store.ts";
import { truncate } from "./eval.ts";

/** Visual-gate always advances to eval-gate — it is not the last of the
 *  optional gate chain (unlike eval-gate, which must pick between
 *  shipcheck-gate/ready-to-deploy). */
const NEXT_STAGE: Stage = "eval-gate";

const MAX_COMMENT_OUTPUT = 2000;
/** Bounds on artifact enumeration so a runaway trace directory cannot blow up
 *  the run directory or the comment (design.md risk: artifact volume). */
const MAX_ARTIFACT_FILES = 100;
const MAX_ARTIFACT_TOTAL_BYTES = 50 * 1024 * 1024; // 50MB

// ---------------------------------------------------------------------------
// Artifact publishing (#463): committing captured artifacts to the PR branch
// so a human can open them from the PR without runner-filesystem access.
// Publish bounds are deliberately tighter than the enumeration bounds above —
// committed blobs enter permanent git history, unlike the run-store copy.
// ---------------------------------------------------------------------------

const PUBLISH_MAX_FILES = 20;
const PUBLISH_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB per file
const PUBLISH_MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10MB total

/** Dedicated worktree-relative path for published evidence — distinct from
 *  `artifacts_dir` so a repo-gitignored scratch directory is never swept into
 *  the publish commit by `git add -f`. */
const PUBLISH_EVIDENCE_DIR = ".pipeline-visual-evidence";

/** Commit-subject prefix for the artifact-publish commit. Recognized by
 *  `isPipelineInternalCommit` (pre_merge.ts) so it does not invalidate a
 *  recorded review verdict; must NOT match `visualFixCommitPattern` so it is
 *  never mistaken for a visual-fix commit. */
export const VISUAL_PUBLISH_COMMIT_PREFIX = "chore: publish visual-gate evidence for #";

export interface AdvanceVisualOpts {
  dryRun?: boolean;
  /** Evidence-bundle run/state dir (#147); when set, the visual command is
   *  recorded under the "visual-gate" stage. Undefined → recording disabled. */
  stateDir?: string;
  /** Run directory for JSONL event log + artifact copies. Undefined → event
   *  appends and artifact copies are disabled. */
  runDir?: string;
  /** Run-store deps carrying `stdoutWrite` for streaming events. */
  runStoreDeps?: RunStoreDeps;
  /** Dispatch-wide run id for the visual-fix commit traceability trailers.
   *  Defaults to a fresh id so direct/unit-test callers that don't thread it
   *  still produce valid trailers. */
  pipelineRunId?: string;
}

export interface VisualRunResult {
  passed: boolean;
  output: string;
  durationSec: number;
  /** True when the command hit the timeout budget (distinct from an ordinary harness failure). */
  timedOut: boolean;
  /** True when the process could not be spawned at all (missing binary, permission error, etc.). */
  spawnError: boolean;
}

/** One captured artifact file, relative to `artifacts_dir`. */
export interface ArtifactManifest {
  /** False when the directory was absent or contained no files. */
  captured: boolean;
  /** Relative paths of files successfully copied into the run directory
   *  (sorted, deterministic), bounded by MAX_ARTIFACT_FILES / MAX_ARTIFACT_TOTAL_BYTES.
   *  A file whose copy failed is excluded and listed in `copyFailed` instead —
   *  a file is reported captured only once it has actually been persisted. */
  files: string[];
  /** True when the full listing exceeded the count or size bound. */
  truncated: boolean;
  /** Total files found before bounding (for the truncation note). */
  totalFound: number;
  /** Relative paths whose copy into the run directory failed. Never counted
   *  as captured and never published. */
  copyFailed: string[];
}

/** `ArtifactManifest` plus the byte size of each captured file, used
 *  internally to select which captured files fit the publish bounds. */
interface CapturedManifest extends ArtifactManifest {
  fileSizes: Record<string, number>;
}

function emptyManifest(): CapturedManifest {
  return { captured: false, files: [], truncated: false, totalFound: 0, copyFailed: [], fileSizes: {} };
}

/** Signature of the harness `invoke` — injectable so the visual-fix loop is unit-testable. */
export type InvokeFn = (
  harness: Harness,
  worktreeDir: string,
  prompt: string,
  opts?: InvokeOptions,
) => Promise<HarnessResult>;

// Injectable seams — default to real implementations in prod; replaced in unit tests.
export interface VisualGateDeps {
  runVisual?: (
    shellCmd: string,
    cwd: string,
    timeoutSec: number,
    env: NodeJS.ProcessEnv,
  ) => Promise<VisualRunResult>;
  getForIssue?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ path: string; slug: string } | null>;
  transition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
    reason: string,
  ) => Promise<void>;
  /** Swap labels without posting a comment. Used for the disabled/skip path. */
  silentTransition?: (
    cfg: PipelineConfig,
    issueNumber: number,
    from: Stage,
    to: Stage,
  ) => Promise<void>;
  setBlocked?: (
    cfg: PipelineConfig,
    issueNumber: number,
    reason: string,
    stage: Stage | null,
    kind?: BlockerKind,
  ) => Promise<void>;
  postComment?: (
    cfg: PipelineConfig,
    issueNumber: number,
    body: string,
  ) => Promise<void>;
  /** Implementer harness invoker for the visual-fix round. Defaults to `invoke`
   *  from harness.ts. Injectable so the fix loop is unit-testable with no real harness. */
  invoke?: InvokeFn;
  /** Current HEAD SHA in the worktree. */
  gitHead?: (cwd: string) => Promise<string>;
  /** Whether the worktree has uncommitted changes. */
  gitDirty?: (cwd: string) => Promise<boolean>;
  /** `git push origin <branch>` after a visual-fix commit. */
  gitPush?: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
  /** Full commit messages for commits reachable from HEAD but not `baseRef`. */
  gitCommitMessages?: (cwd: string, baseRef: string) => Promise<string[]>;
  /** Salvage uncommitted visual-fix work into a commit. `salvaged` is true
   *  when a salvage commit was created; `failureReason` is set when a salvage
   *  was attempted and its git operation failed (#521). */
  salvage?: (
    wtPath: string,
    issueNumber: number,
    pipelineRunId: string,
    stageLabel: string,
  ) => Promise<{ salvaged: boolean; failureReason?: string }>;
  /** Verify the visual-fix commit message format. Injectable for tests. */
  verifyVisualFix?: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
  /** Authenticated gh actor login, used to trust-filter review comments when
   *  deriving whether a visual-fix commit still needs review. */
  getGhActor?: () => Promise<string | null>;
  /** Issue comments, used to extract the last reviewed SHA. */
  getIssueDetail?: (
    cfg: PipelineConfig,
    issueNumber: number,
  ) => Promise<{ comments: { author: string; body: string }[] }>;
  /** Resolve the open PR for this issue, to read its commit history. */
  getPrForIssue?: (cfg: PipelineConfig, issueNumber: number) => Promise<number | null>;
  /** PR commits (oldest-first), used to detect a visual-fix commit landed since
   *  the last reviewed SHA. */
  getPrCommits?: (
    cfg: PipelineConfig,
    prNumber: number,
  ) => Promise<{ oid: string; messageHeadline: string }[]>;
  /** Enumerate artifact files under the resolved `artifacts_dir`. Bounded,
   *  deterministic order. Injectable so tests use an in-memory fake instead of
   *  real fs. Returns [] when the directory is absent. */
  listArtifacts?: (absArtifactsDir: string) => Promise<{ rel: string; size: number }[]>;
  /** Copy the bounded artifact file list into `destDir` (creating parent dirs
   *  as needed). Returns a per-file result — a file whose copy fails is
   *  reported `ok: false` rather than silently swallowed (d50013b8). A
   *  successful result's `size` is the byte size actually persisted at
   *  `destDir` (not the pre-copy enumeration size), so a file that grows
   *  between enumeration and copy is bounded by what was really captured
   *  (#463 review 2). Injectable for tests. */
  copyArtifacts?: (
    absArtifactsDir: string,
    files: string[],
    destDir: string,
  ) => Promise<{ rel: string; ok: boolean; size?: number }[]>;
  /** Copy the selected published files from the run-directory attempt copy
   *  into the worktree evidence path (`PUBLISH_EVIDENCE_DIR`). Injectable
   *  for tests. */
  copyForPublish?: (srcDir: string, files: string[], destDir: string) => Promise<void>;
  /** Remove the worktree evidence dir, replacing any prior published set
   *  before the new one is written. Resolves `true` when a directory was
   *  actually present (and removed), `false` when there was nothing there.
   *  Injectable for tests. */
  removeEvidenceDir?: (destDir: string) => Promise<boolean>;
  /** `git add -f <relPath>` in the worktree — force-adds only the evidence
   *  path so a gitignored `artifacts_dir` is never swept in. Injectable for tests. */
  gitAddForce?: (cwd: string, relPath: string) => Promise<{ code: number; stderr: string }>;
  /** `git commit -m <message> -- <relPath>` in the worktree for the publish commit —
   *  pathspec-scoped so any other staged/dirty content in the worktree is left
   *  staged and untouched rather than swept into the publish commit. Injectable for tests. */
  gitCommit?: (cwd: string, message: string, relPath: string) => Promise<{ code: number; stderr: string }>;
}

// ---------------------------------------------------------------------------
// Artifact capture (#395): declared directory, enumerated by the pipeline,
// never interpreted. A path escaping the worktree root is rejected outright.
// ---------------------------------------------------------------------------

/** Resolve `artifacts_dir` (worktree-relative) against the worktree root and
 *  reject anything that escapes it. Returns the absolute path on success. */
export function resolveArtifactsDir(
  worktreePath: string,
  artifactsDir: string,
): { ok: true; abs: string } | { ok: false; reason: string } {
  const abs = path.resolve(worktreePath, artifactsDir);
  const rel = path.relative(worktreePath, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `visual_gate.artifacts_dir ("${artifactsDir}") resolves outside the worktree root.`,
    };
  }
  return { ok: true, abs };
}

/** Canonicalize `abs` (following symlinks) and re-check containment under the
 *  canonicalized worktree root, so a symlinked `artifacts_dir` — or a symlink
 *  anywhere on its path — cannot escape the worktree despite passing the
 *  lexical check in `resolveArtifactsDir`. Returns `{ ok: true, real: null }`
 *  when the path does not exist yet (the caller's existing "no artifacts"
 *  path already handles that case). */
async function realpathContained(
  worktreePath: string,
  abs: string,
): Promise<{ ok: true; real: string | null } | { ok: false; reason: string }> {
  let realWorktree: string;
  try {
    realWorktree = await fsp.realpath(worktreePath);
  } catch {
    return { ok: true, real: null };
  }
  let realAbs: string;
  try {
    realAbs = await fsp.realpath(abs);
  } catch {
    return { ok: true, real: null };
  }
  const rel = path.relative(realWorktree, realAbs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return {
      ok: false,
      reason: `visual_gate.artifacts_dir resolves outside the worktree root once symlinks are resolved.`,
    };
  }
  return { ok: true, real: realAbs };
}

async function defaultListArtifacts(absDir: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        out.push({ rel, size: st?.size ?? 0 });
      }
    }
  }
  await walk(absDir, "");
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

async function defaultCopyArtifacts(
  absDir: string,
  files: string[],
  destDir: string,
): Promise<{ rel: string; ok: boolean; size?: number }[]> {
  await fsp.mkdir(destDir, { recursive: true });
  const results: { rel: string; ok: boolean; size?: number }[] = [];
  for (const rel of files) {
    const src = path.join(absDir, rel);
    const dest = path.join(destDir, rel);
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      // Stat the persisted copy rather than trusting the pre-copy enumeration
      // size — the source file may have grown between listing and copying.
      const st = await fsp.stat(dest);
      results.push({ rel, ok: true, size: st.size });
    } catch {
      results.push({ rel, ok: false });
    }
  }
  return results;
}

/** Bound a full artifact listing by count and cumulative size, in deterministic
 *  (sorted) order. Truncation is explicit rather than silent. */
function boundArtifacts(all: { rel: string; size: number }[]): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const f of all) {
    if (files.length >= MAX_ARTIFACT_FILES || totalBytes + f.size > MAX_ARTIFACT_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    files.push(f.rel);
    totalBytes += f.size;
  }
  return { files, truncated };
}

async function captureArtifacts(
  cfg: PipelineConfig,
  issueNumber: number,
  worktreePath: string,
  attempt: number,
  opts: AdvanceVisualOpts,
  deps: {
    listArtifacts: (absDir: string) => Promise<{ rel: string; size: number }[]>;
    copyArtifacts: (
      absDir: string,
      files: string[],
      destDir: string,
    ) => Promise<{ rel: string; ok: boolean; size?: number }[]>;
  },
): Promise<CapturedManifest & { escapeError?: string }> {
  const resolved = resolveArtifactsDir(worktreePath, cfg.visual_gate.artifacts_dir);
  if (!resolved.ok) {
    return { ...emptyManifest(), escapeError: resolved.reason };
  }
  const canonical = await realpathContained(worktreePath, resolved.abs);
  if (!canonical.ok) {
    return { ...emptyManifest(), escapeError: canonical.reason };
  }
  const absDir = canonical.real ?? resolved.abs;
  const all = await deps.listArtifacts(absDir);
  if (all.length === 0) {
    return emptyManifest();
  }
  const { files, truncated } = boundArtifacts(all);
  const sizeByRel = new Map(all.map((f) => [f.rel, f.size]));

  let capturedFiles = files;
  let copyFailed: string[] = [];
  const copiedSizeByRel = new Map<string, number>();
  if (opts.runDir) {
    const destDir = path.join(opts.runDir, "visual", `attempt-${attempt}`);
    const results = await deps
      .copyArtifacts(absDir, files, destDir)
      .catch(() => files.map((rel) => ({ rel, ok: false })));
    capturedFiles = results.filter((r) => r.ok).map((r) => r.rel);
    copyFailed = results.filter((r) => !r.ok).map((r) => r.rel);
    for (const r of results) {
      if (r.ok && r.size !== undefined) copiedSizeByRel.set(r.rel, r.size);
    }
  }

  // Prefer the size actually persisted by the copy (post-copy stat) over the
  // pre-copy enumeration size, so a file that grew between listing and
  // copying is bounded by what was really captured (#463 review 2). Falls
  // back to the enumeration size only when no copy took place (no runDir).
  const fileSizes: Record<string, number> = {};
  for (const rel of capturedFiles) fileSizes[rel] = copiedSizeByRel.get(rel) ?? sizeByRel.get(rel) ?? 0;

  return { captured: true, files: capturedFiles, truncated, totalFound: all.length, copyFailed, fileSizes };
}

/** Per-file publish-status annotation for manifest rendering. */
type PublishAnnotation =
  | { status: "published"; url: string }
  | { status: "over-bound" }
  | { status: "push-failed" };

function formatArtifactManifest(
  manifest: ArtifactManifest,
  annotations?: Map<string, PublishAnnotation>,
): string {
  if (!manifest.captured) return "(no artifacts captured)";
  const lines: string[] = [];
  for (const f of manifest.files) {
    const ann = annotations?.get(f);
    if (ann?.status === "published") {
      lines.push(`- [${f}](${ann.url})`);
    } else if (ann?.status === "over-bound") {
      lines.push(`- ${f} (not published: exceeds bound)`);
    } else if (ann?.status === "push-failed") {
      lines.push(`- ${f} (not published: publish failed)`);
    } else {
      lines.push(`- ${f}`);
    }
  }
  for (const f of manifest.copyFailed) {
    lines.push(`- ${f} (copy failed)`);
  }
  if (manifest.truncated) {
    lines.push(`- … (${manifest.totalFound} files found; listing truncated)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Artifact publishing (#463): opt-in commit of the deciding run's captured
// artifacts to the PR branch so a human can open them from the PR itself.
// ---------------------------------------------------------------------------

/** Partition `files` (in their existing deterministic order) into what fits
 *  the publish bounds and what exceeds them — over-bound files are never
 *  committed, and their manifest entry says so explicitly. Pure function,
 *  exported for unit testing. */
export function selectPublishFiles(
  files: string[],
  fileSizes: Record<string, number>,
): { toPublish: string[]; overBound: string[] } {
  const toPublish: string[] = [];
  const overBound: string[] = [];
  let totalBytes = 0;
  for (const rel of files) {
    const size = fileSizes[rel] ?? 0;
    if (toPublish.length >= PUBLISH_MAX_FILES || size > PUBLISH_MAX_FILE_BYTES || totalBytes + size > PUBLISH_MAX_TOTAL_BYTES) {
      overBound.push(rel);
      continue;
    }
    toPublish.push(rel);
    totalBytes += size;
  }
  return { toPublish, overBound };
}

/** Branch-relative blob URL for a published file — survives worktree cleanup
 *  and keeps resolving as the branch head advances. */
export function publishBlobUrl(repo: string, branch: string, rel: string): string {
  return `https://github.com/${repo}/blob/${branch}/${PUBLISH_EVIDENCE_DIR}/${rel}`;
}

interface PublishGitDeps {
  copyForPublish: (srcDir: string, files: string[], destDir: string) => Promise<void>;
  removeEvidenceDir: (destDir: string) => Promise<boolean>;
  gitAddForce: (cwd: string, relPath: string) => Promise<{ code: number; stderr: string }>;
  gitCommit: (cwd: string, message: string, relPath: string) => Promise<{ code: number; stderr: string }>;
  gitDirty: (cwd: string) => Promise<boolean>;
  gitPush: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
}

interface PublishResult {
  /** True when publishing was actually attempted (enabled, files captured, and at
   *  least one fit the bounds). */
  attempted: boolean;
  ok: boolean;
  failureReason?: string;
  published: Set<string>;
  overBound: Set<string>;
}

/**
 * Best-effort: any git/push failure is surfaced via `failureReason` and
 * degrades that run's manifest to non-published bare paths — it never blocks
 * an otherwise-passing gate (design.md decision 4).
 */
async function publishVisualArtifacts(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  slug: string,
  attempt: number,
  manifest: CapturedManifest,
  opts: AdvanceVisualOpts,
  deps: PublishGitDeps,
): Promise<PublishResult> {
  if (!cfg.visual_gate.publish || manifest.files.length === 0) {
    return { attempted: false, ok: false, published: new Set(), overBound: new Set() };
  }

  const { toPublish, overBound } = selectPublishFiles(manifest.files, manifest.fileSizes);
  const overBoundSet = new Set(overBound);

  if (toPublish.length > 0 && !opts.runDir) {
    return {
      attempted: true,
      ok: false,
      failureReason: "no run directory available to publish artifacts from",
      published: new Set(),
      overBound: overBoundSet,
    };
  }

  const evidenceAbsDir = path.join(wtPath, PUBLISH_EVIDENCE_DIR);

  try {
    const priorEvidenceExisted = await deps.removeEvidenceDir(evidenceAbsDir);
    if (toPublish.length === 0 && !priorEvidenceExisted) {
      // Nothing captured fits the publish bounds, and there is no stale
      // evidence set on the branch to replace — a true no-op (#463 review 1).
      return { attempted: false, ok: false, published: new Set(), overBound: overBoundSet };
    }

    if (toPublish.length > 0) {
      const srcDir = path.join(opts.runDir!, "visual", `attempt-${attempt}`);
      await deps.copyForPublish(srcDir, toPublish, evidenceAbsDir);
    }

    const addRes = await deps.gitAddForce(wtPath, PUBLISH_EVIDENCE_DIR);
    if (addRes.code !== 0) {
      return {
        attempted: true,
        ok: false,
        failureReason: `git add failed: ${addRes.stderr.trim()}`,
        published: new Set(),
        overBound: overBoundSet,
      };
    }

    const dirty = await deps.gitDirty(wtPath);
    if (dirty) {
      const commitRes = await deps.gitCommit(wtPath, `${VISUAL_PUBLISH_COMMIT_PREFIX}${issueNumber}`, PUBLISH_EVIDENCE_DIR);
      if (commitRes.code !== 0) {
        return {
          attempted: true,
          ok: false,
          failureReason: `git commit failed: ${commitRes.stderr.trim()}`,
          published: new Set(),
          overBound: overBoundSet,
        };
      }
    }
    // Always push, even when the worktree wasn't dirty this round: a prior
    // invocation may have committed the evidence locally and then failed to
    // push it, leaving the local branch ahead of the PR branch. Files are
    // only reported published once the push actually succeeds (#463 review 2).
    const branch = branchName(issueNumber, slug);
    const pushRes = await deps.gitPush(wtPath, branch);
    if (pushRes.code !== 0) {
      return {
        attempted: true,
        ok: false,
        failureReason: `git push failed: ${pushRes.stderr.trim()}`,
        published: new Set(),
        overBound: overBoundSet,
      };
    }

    return { attempted: true, ok: true, published: new Set(toPublish), overBound: overBoundSet };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      failureReason: err instanceof Error ? err.message : String(err),
      published: new Set(),
      overBound: overBoundSet,
    };
  }
}

async function defaultCopyForPublish(srcDir: string, files: string[], destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  for (const rel of files) {
    const src = path.join(srcDir, rel);
    const dest = path.join(destDir, rel);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

async function defaultRemoveEvidenceDir(destDir: string): Promise<boolean> {
  const existed = await fsp
    .access(destDir)
    .then(() => true)
    .catch(() => false);
  await fsp.rm(destDir, { recursive: true, force: true });
  return existed;
}

async function defaultGitAddForce(cwd: string, relPath: string): Promise<{ code: number; stderr: string }> {
  const res = await gitInWorktree(cwd, ["add", "-f", "--", relPath], { ignoreFailure: true });
  return { code: res.code, stderr: res.stderr };
}

async function defaultGitCommit(
  cwd: string,
  message: string,
  relPath: string,
): Promise<{ code: number; stderr: string }> {
  // Pathspec-scoped: commits only `relPath`, regardless of whatever else is
  // staged in the worktree's index, and leaves other staged content staged
  // rather than sweeping it into the publish commit (#463 review 2).
  const res = await gitInWorktree(cwd, ["commit", "-m", message, "--", relPath], { ignoreFailure: true });
  return { code: res.code, stderr: res.stderr };
}

// ---------------------------------------------------------------------------
// Visual-fix round: a gate-mode ordinary failure with attempts remaining
// invokes the implementer harness with the visual output + artifact manifest
// as context, verifies and pushes the resulting commit, then lets the caller
// re-run the visual command. Mirrors eval.ts's runEvalFixRound exactly.
// ---------------------------------------------------------------------------

/** Cap on the visual output injected into the visual-fix prompt. */
const MAX_FIX_PROMPT_OUTPUT = 16_000;

/** Stage label for a salvaged visual-fix commit — mirrors evalFixSalvageStageLabel. */
export function visualFixSalvageStageLabel(issueNumber: number): string {
  return `visual-fix (prescribed commit: "fix: resolve visual-gate failures (#${issueNumber})")`;
}

function visualFixCommitPattern(issueNumber: number): RegExp {
  return new RegExp(`fix:\\s+resolve visual-gate failures \\(#${issueNumber}\\)`, "i");
}

/** Verifies that at least one commit in `headBefore..HEAD` matches the expected
 *  visual-fix commit message format. */
export async function enforceVisualFixCommitFormat(
  issueNumber: number,
  wtPath: string,
  headBefore: string,
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  return verifyHarnessCommits(
    wtPath,
    headBefore,
    {
      messagePattern: {
        pattern: visualFixCommitPattern(issueNumber),
        description: "Visual-fix commit message does not match prescribed format",
      },
    },
    deps,
  );
}

/**
 * Durable replacement for an in-memory "a fix round ran this invocation" flag,
 * mirroring eval.ts's evalFixCommitPendingReview: re-derives, purely from
 * GitHub PR state, whether a visual-fix commit has landed since the last
 * reviewed SHA and so still needs to clear pre-merge review before this pass
 * may advance directly. Fails closed (returns `true`) on any lookup error.
 */
async function visualFixCommitPendingReview(
  cfg: PipelineConfig,
  issueNumber: number,
  deps: {
    getGhActor: () => Promise<string | null>;
    getIssueDetail: (cfg: PipelineConfig, issueNumber: number) => Promise<{ comments: { author: string; body: string }[] }>;
    getPrForIssue: (cfg: PipelineConfig, issueNumber: number) => Promise<number | null>;
    getPrCommits: (cfg: PipelineConfig, prNumber: number) => Promise<{ oid: string; messageHeadline: string }[]>;
  },
): Promise<boolean> {
  try {
    const prNumber = await deps.getPrForIssue(cfg, issueNumber);
    if (!prNumber) return false;
    const commits = await deps.getPrCommits(cfg, prNumber);
    const pattern = visualFixCommitPattern(issueNumber);
    if (!commits.some((c) => pattern.test(c.messageHeadline))) return false;
    const actor = await deps.getGhActor();
    const detail = await deps.getIssueDetail(cfg, issueNumber);
    const trusted = actor ? detail.comments.filter((c) => c.author === actor) : [];
    const reviewed = extractReviewedSha(trusted);
    if (!reviewed) return true;
    const reviewedIdx = reviewed.sha ? commits.findIndex((c) => c.oid === reviewed.sha) : -1;
    const landedSince = reviewedIdx !== -1 ? commits.slice(reviewedIdx + 1) : commits;
    return landedSince.some((c) => pattern.test(c.messageHeadline));
  } catch {
    return true;
  }
}

interface VisualFixRoundDeps {
  invoke: InvokeFn;
  gitHead: (cwd: string) => Promise<string>;
  gitDirty: (cwd: string) => Promise<boolean>;
  gitPush: (cwd: string, branch: string) => Promise<{ code: number; stderr: string }>;
  gitCommitMessages: (cwd: string, baseRef: string) => Promise<string[]>;
  salvage: (wtPath: string, issueNumber: number, pipelineRunId: string, stageLabel: string) => Promise<{ salvaged: boolean; failureReason?: string }>;
  verifyVisualFix: (wtPath: string, headBefore: string) => Promise<VerifyResult>;
}

type VisualFixRoundResult =
  | { ok: true }
  | { ok: false; reason: string; blockerKind: "harness-failure" | "push-failed" };

/**
 * Run a single visual-fix round. Returns `{ ok: true }` only once a verified
 * fix commit has been pushed — the caller re-runs the visual command in that
 * case. Never pushes a partial fix. Mirrors eval.ts's runEvalFixRound.
 */
async function runVisualFixRound(
  cfg: PipelineConfig,
  issueNumber: number,
  wtPath: string,
  slug: string,
  attempt: number,
  maxAttempts: number,
  visualOutput: string,
  artifactManifest: ArtifactManifest,
  pipelineRunId: string,
  opts: AdvanceVisualOpts,
  deps: VisualFixRoundDeps,
): Promise<VisualFixRoundResult> {
  const harness = cfg.harnesses.implementer;
  console.log(
    `[pipeline] #${issueNumber}: visual-gate failed; fix round ${attempt}/${maxAttempts - 1} (${harness})`,
  );

  const excerpt = truncate(visualOutput, MAX_FIX_PROMPT_OUTPUT);
  const prompt = buildVisualFixPrompt({
    cfg,
    issueNumber,
    command: cfg.visual_gate.command!,
    attempt,
    maxAttempts,
    output: excerpt,
    artifacts: formatArtifactManifest(artifactManifest),
    pipelineRunId,
  });
  if (opts.stateDir) {
    await recordPrompt(
      opts.stateDir,
      issueNumber,
      "visual-gate",
      makePromptRecord(`visual-fix-${attempt}`, harness, prompt),
    ).catch(() => {});
  }

  const headBefore = await deps.gitHead(wtPath);
  const fixModel = cfg.models.fix;
  const fixRes = await deps.invoke(harness, wtPath, prompt, {
    timeoutSec: cfg.fix_timeout,
    model: fixModel,
    sandbox: cfg.harness_sandbox,
    accounting: opts.runDir
      ? {
          runDir: opts.runDir,
          runStoreDeps: opts.runStoreDeps,
          issue: issueNumber,
          stage: "visual-gate",
          modelSlot: "fix",
          model: fixModel,
        }
      : undefined,
  });

  if (!fixRes.success) {
    const reason = fixRes.timed_out
      ? `Fix harness (${harness}) timed out after ${fixRes.duration.toFixed(0)}s on visual-gate fix round ${attempt}.`
      : `Fix harness (${harness}) failed (exit ${fixRes.exit_code}) on visual-gate fix round ${attempt}.`;
    return { ok: false, reason, blockerKind: "harness-failure" };
  }

  let headAfter = await deps.gitHead(wtPath);
  if (headBefore && headAfter && headBefore === headAfter) {
    const { salvaged, failureReason } = await deps.salvage(wtPath, issueNumber, pipelineRunId, visualFixSalvageStageLabel(issueNumber));
    if (!salvaged) {
      // #521: disclose why nothing was salvaged so the operator can see that
      // recoverable work may still exist without reading terminal.log.
      const reason = failureReason
        ? `visual-gate fix round ${attempt} reported success but produced no new commits. ` +
          `Salvage of uncommitted work also failed: ${failureReason}`
        : `visual-gate fix round ${attempt} reported success but produced no new commits.`;
      return {
        ok: false,
        reason,
        blockerKind: "harness-failure",
      };
    }
    headAfter = await deps.gitHead(wtPath);
  }

  if (await deps.gitDirty(wtPath)) {
    return {
      ok: false,
      reason:
        `visual-gate fix round ${attempt} left uncommitted changes in the working tree. ` +
        "Visual gate results can't be trusted — stage and commit the fix before re-running.",
      blockerKind: "harness-failure",
    };
  }

  if (headBefore) {
    const commitCheck = await deps.verifyVisualFix(wtPath, headBefore);
    if (!commitCheck.ok) {
      return { ok: false, reason: commitCheck.reason, blockerKind: "harness-failure" };
    }

    const newMessages = await deps.gitCommitMessages(wtPath, headBefore);
    const trailerErr = validateCommitTrailers(newMessages, issueNumber, pipelineRunId);
    if (trailerErr) {
      return { ok: false, reason: trailerErr, blockerKind: "harness-failure" };
    }
  }

  const branch = branchName(issueNumber, slug);
  const push = await deps.gitPush(wtPath, branch);
  if (push.code !== 0) {
    return {
      ok: false,
      reason: `Git push failed after visual-gate fix: ${push.stderr.trim()}`,
      blockerKind: "push-failed",
    };
  }

  return { ok: true };
}

function eventTimestamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function recordGateResult(
  opts: AdvanceVisualOpts,
  result: "pass" | "fail" | "skipped",
  mode: PipelineConfig["visual_gate"]["mode"],
  reason?: string,
): Promise<void> {
  if (!opts.runDir) return;
  await appendEvent(
    opts.runDir,
    {
      schema_version: RUN_SCHEMA_VERSION,
      type: "gate_result",
      at: eventTimestamp(),
      gate: "visual-gate",
      result,
      mode,
      reason,
    },
    opts.runStoreDeps,
  ).catch(() => {});
}

export async function advanceVisual(
  cfg: PipelineConfig,
  issueNumber: number,
  opts: AdvanceVisualOpts = {},
  deps: VisualGateDeps = {},
): Promise<Outcome> {
  console.log(`[pipeline] #${issueNumber}: visual-gate`);

  const transitionFn = deps.transition ?? defaultTransition;
  const silentTransitionFn = deps.silentTransition ?? defaultSilentTransition;
  const setBlockedFn = deps.setBlocked ?? defaultSetBlocked;
  const postCommentFn = deps.postComment ?? defaultPostComment;
  const getForIssueFn = deps.getForIssue ?? defaultGetForIssue;
  const runFn = deps.runVisual ?? defaultRunVisual;
  const invokeFn = deps.invoke ?? defaultInvoke;
  const gitHeadFn = deps.gitHead ?? defaultGitHead;
  const gitDirtyFn = deps.gitDirty ?? defaultGitDirty;
  const gitPushFn = deps.gitPush ?? defaultGitPush;
  const gitCommitMessagesFn = deps.gitCommitMessages ?? defaultGitCommitMessages;
  const salvageFn = deps.salvage ?? trySalvageUncommittedWork;
  const verifyVisualFixFn =
    deps.verifyVisualFix ?? ((wtPath: string, headBefore: string) => enforceVisualFixCommitFormat(issueNumber, wtPath, headBefore));
  const getGhActorFn = deps.getGhActor ?? defaultGetGhActor;
  const getIssueDetailFn = deps.getIssueDetail ?? defaultGetIssueDetail;
  const getPrForIssueFn = deps.getPrForIssue ?? defaultGetPrForIssue;
  const getPrCommitsFn = deps.getPrCommits ?? defaultGetPrCommits;
  const listArtifactsFn = deps.listArtifacts ?? defaultListArtifacts;
  const copyArtifactsFn = deps.copyArtifacts ?? defaultCopyArtifacts;
  const copyForPublishFn = deps.copyForPublish ?? defaultCopyForPublish;
  const removeEvidenceDirFn = deps.removeEvidenceDir ?? defaultRemoveEvidenceDir;
  const gitAddForceFn = deps.gitAddForce ?? defaultGitAddForce;
  const gitCommitFn = deps.gitCommit ?? defaultGitCommit;
  const pipelineRunId = opts.pipelineRunId ?? makePipelineRunId(issueNumber);

  // Dry-run: no GitHub writes, no command execution.
  if (opts.dryRun) {
    const cmdNote = cfg.visual_gate.enabled && cfg.visual_gate.command
      ? cfg.visual_gate.command
      : "(visual-gate disabled or no command configured)";
    console.log(`[pipeline] #${issueNumber}: [dry-run] would run visual gate: ${cmdNote}`);
    return { advanced: true, from: "visual-gate", to: NEXT_STAGE, summary: "[dry-run]" };
  }

  // Skip path — enabled=false → swap labels silently, no comment posted, no
  // child process spawned, no artifacts recorded (#395 acceptance criteria).
  if (!cfg.visual_gate.enabled) {
    console.log(`[pipeline] #${issueNumber}: visual-gate step disabled; skipping.`);
    await silentTransitionFn(cfg, issueNumber, "visual-gate", NEXT_STAGE);
    await recordGateResult(opts, "skipped", cfg.visual_gate.mode, "disabled");
    return { advanced: true, from: "visual-gate", to: NEXT_STAGE, summary: "visual-gate disabled" };
  }

  if (!cfg.visual_gate.command?.trim()) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "`visual_gate.enabled` is true but no `command` is configured. Set `visual_gate.command` in `.github/pipeline.yml`.",
      "visual-gate",
      "visual-gate-misconfigured",
    );
    return { advanced: false, status: "blocked", reason: "visual_gate.command not set", blockerKind: "visual-gate-misconfigured" };
  }

  const wt = await getForIssueFn(cfg, issueNumber);
  if (!wt) {
    await setBlockedFn(
      cfg,
      issueNumber,
      "visual-gate: no worktree found for this issue. The worktree may have been removed prematurely.",
      "visual-gate",
      "worktree-missing",
    );
    return { advanced: false, status: "blocked", reason: "no worktree", blockerKind: "worktree-missing" };
  }

  const maxAttempts = cfg.visual_gate.max_attempts;
  const timeoutSec = cfg.visual_gate.timeout;
  let stageDeadlineMs = Date.now() + timeoutSec * 1000;

  let lastResult: VisualRunResult | null = null;
  let lastManifest: CapturedManifest = emptyManifest();
  let lastAttempt = 1;
  let fixRoundBlocked: { reason: string; blockerKind: "harness-failure" | "push-failed" } | null = null;
  let fixCommitLandedThisInvocation = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remainingSec = Math.max(0, (stageDeadlineMs - Date.now()) / 1000);
    if (remainingSec <= 0) {
      lastResult = {
        passed: false,
        timedOut: true,
        spawnError: false,
        output: `[visual-gate stage timeout (${timeoutSec}s) exceeded before attempt ${attempt}]`,
        durationSec: timeoutSec,
      };
      if (opts.stateDir) {
        await recordCommand(
          opts.stateDir,
          issueNumber,
          "visual-gate",
          makeCommandRecord(cfg.visual_gate.command, 1, 0, lastResult.output),
        ).catch(() => {});
      }
      await recordVisualAccounting(opts, issueNumber, cfg.visual_gate.command, lastResult, new Date(), new Date());
      break;
    }

    if (attempt > 1) {
      console.log(`[pipeline] #${issueNumber}: visual-gate retrying (attempt ${attempt}/${maxAttempts})`);
    } else {
      console.log(`[pipeline] #${issueNumber}: visual-gate running \`${cfg.visual_gate.command}\``);
    }
    const startedAt = new Date();
    const runContextEnv: NodeJS.ProcessEnv = {
      PIPELINE_ISSUE: String(issueNumber),
      PIPELINE_BRANCH: branchName(issueNumber, wt.slug),
      PIPELINE_RUN_ID: pipelineRunId,
      PIPELINE_VISUAL_ARTIFACTS_DIR: path.resolve(wt.path, cfg.visual_gate.artifacts_dir),
    };
    const prNumber = await getPrForIssueFn(cfg, issueNumber).catch(() => null);
    if (prNumber) runContextEnv.PIPELINE_PR_NUMBER = String(prNumber);
    lastResult = await runFn(cfg.visual_gate.command, wt.path, remainingSec, runContextEnv);
    const endedAt = new Date();
    lastAttempt = attempt;

    lastManifest = await captureArtifacts(cfg, issueNumber, wt.path, attempt, opts, {
      listArtifacts: listArtifactsFn,
      copyArtifacts: copyArtifactsFn,
    });

    const combinedOutput = lastManifest.escapeError
      ? `${lastResult.output}\n\n[artifact capture error: ${lastManifest.escapeError}]`
      : lastResult.output;

    if (opts.stateDir) {
      await recordCommand(
        opts.stateDir,
        issueNumber,
        "visual-gate",
        makeCommandRecord(
          cfg.visual_gate.command,
          lastResult.passed ? 0 : 1,
          lastResult.durationSec * 1000,
          `${combinedOutput}\n\nArtifacts:\n${formatArtifactManifest(lastManifest)}`,
        ),
      ).catch(() => {});
    }
    await recordVisualAccounting(opts, issueNumber, cfg.visual_gate.command, lastResult, startedAt, endedAt);

    if (lastResult.passed) break;
    if (lastResult.timedOut || lastResult.spawnError) break;
    if (cfg.visual_gate.mode !== "gate") continue;
    if (attempt >= maxAttempts) break;

    const fixResult = await runVisualFixRound(
      cfg,
      issueNumber,
      wt.path,
      wt.slug,
      attempt,
      maxAttempts,
      lastResult.output,
      lastManifest,
      pipelineRunId,
      opts,
      {
        invoke: invokeFn,
        gitHead: gitHeadFn,
        gitDirty: gitDirtyFn,
        gitPush: gitPushFn,
        gitCommitMessages: gitCommitMessagesFn,
        salvage: salvageFn,
        verifyVisualFix: verifyVisualFixFn,
      },
    );
    if (!fixResult.ok) {
      fixRoundBlocked = { reason: fixResult.reason, blockerKind: fixResult.blockerKind };
      break;
    }
    fixCommitLandedThisInvocation = true;
    stageDeadlineMs = Date.now() + timeoutSec * 1000;
  }

  if (fixRoundBlocked) {
    console.log(`[pipeline] #${issueNumber}: visual-gate fix round failed; blocking`);
    if (fixRoundBlocked.blockerKind === "push-failed") {
      await setBlockedFn(cfg, issueNumber, fixRoundBlocked.reason, "visual-gate", "push-failed");
    } else {
      await setBlockedFn(cfg, issueNumber, fixRoundBlocked.reason, "visual-gate", "harness-failure");
    }
    await recordGateResult(opts, "fail", cfg.visual_gate.mode, "fix_round_failed");
    return {
      advanced: false,
      status: "blocked",
      reason: fixRoundBlocked.reason,
      blockerKind: fixRoundBlocked.blockerKind,
    };
  }

  const result = lastResult!;
  const manifest = lastManifest;
  const outcome = result.passed ? "PASS" : "FAIL";
  const excerpt = truncate(result.output, MAX_COMMENT_OUTPUT);

  const publishResult = await publishVisualArtifacts(cfg, issueNumber, wt.path, wt.slug, lastAttempt, manifest, opts, {
    copyForPublish: copyForPublishFn,
    removeEvidenceDir: removeEvidenceDirFn,
    gitAddForce: gitAddForceFn,
    gitCommit: gitCommitFn,
    gitDirty: gitDirtyFn,
    gitPush: gitPushFn,
  });
  const publishAnnotations = new Map<string, PublishAnnotation>();
  if (cfg.visual_gate.publish) {
    const branch = branchName(issueNumber, wt.slug);
    for (const f of manifest.files) {
      if (publishResult.published.has(f)) {
        publishAnnotations.set(f, { status: "published", url: publishBlobUrl(cfg.repo, branch, f) });
      } else if (publishResult.overBound.has(f)) {
        publishAnnotations.set(f, { status: "over-bound" });
      } else if (publishResult.attempted && !publishResult.ok) {
        publishAnnotations.set(f, { status: "push-failed" });
      }
    }
  }

  const commentBody = redactSecrets(buildVisualComment({
    outcome,
    mode: cfg.visual_gate.mode,
    durationSec: result.durationSec,
    excerpt,
    manifest,
    publishAnnotations,
    publishFailure: publishResult.attempted && !publishResult.ok ? publishResult.failureReason : undefined,
  }));
  await postCommentFn(cfg, issueNumber, commentBody);

  if (result.passed) {
    console.log(`[pipeline] #${issueNumber}: visual-gate passed in ${result.durationSec.toFixed(1)}s`);

    const pendingReview =
      cfg.visual_gate.mode === "gate" &&
      (fixCommitLandedThisInvocation ||
        (await visualFixCommitPendingReview(cfg, issueNumber, {
          getGhActor: getGhActorFn,
          getIssueDetail: getIssueDetailFn,
          getPrForIssue: getPrForIssueFn,
          getPrCommits: getPrCommitsFn,
        })));
    if (pendingReview) {
      await transitionFn(
        cfg,
        issueNumber,
        "visual-gate",
        "pre-merge",
        `Visual gate passed in ${result.durationSec.toFixed(1)}s after a visual-fix commit. Routing back through pre-merge for review before advancing.`,
      );
      await recordGateResult(opts, "pass", cfg.visual_gate.mode, "fix_commit_needs_review");
      return {
        advanced: true,
        from: "visual-gate",
        to: "pre-merge",
        summary: `visual gate passed after fix round in ${result.durationSec.toFixed(1)}s; routed to pre-merge for review`,
      };
    }

    await transitionFn(cfg, issueNumber, "visual-gate", NEXT_STAGE, `Visual gate passed. Advancing to ${NEXT_STAGE}.`);
    await recordGateResult(opts, "pass", cfg.visual_gate.mode);
    return {
      advanced: true,
      from: "visual-gate",
      to: NEXT_STAGE,
      summary: `visual gate passed in ${result.durationSec.toFixed(1)}s`,
    };
  }

  const attempts = maxAttempts > 1 ? ` after ${maxAttempts} attempts` : "";

  if (result.timedOut) {
    console.log(`[pipeline] #${issueNumber}: visual-gate timed out${attempts}; blocking`);
    await setBlockedFn(
      cfg,
      issueNumber,
      `Visual gate timed out${attempts} (${timeoutSec}s limit).\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
      "visual-gate",
      "harness-failure",
    );
    await recordGateResult(opts, "fail", cfg.visual_gate.mode, "timeout");
    return { advanced: false, status: "blocked", reason: `visual gate timed out${attempts}`, blockerKind: "harness-failure" };
  }

  if (result.spawnError) {
    console.log(`[pipeline] #${issueNumber}: visual-gate runner error${attempts}; blocking`);
    await setBlockedFn(
      cfg,
      issueNumber,
      `Visual gate runner/tooling error${attempts} — the visual command could not be executed.\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
      "visual-gate",
      "harness-failure",
    );
    await recordGateResult(opts, "fail", cfg.visual_gate.mode, "spawn_error");
    return { advanced: false, status: "blocked", reason: `visual gate runner error${attempts}`, blockerKind: "harness-failure" };
  }

  if (cfg.visual_gate.mode === "advisory") {
    console.log(`[pipeline] #${issueNumber}: visual-gate failed${attempts} (advisory mode); advancing`);
    await transitionFn(cfg, issueNumber, "visual-gate", NEXT_STAGE, `Visual gate failed${attempts} (advisory mode); advancing to ${NEXT_STAGE}.`);
    await recordGateResult(opts, "fail", cfg.visual_gate.mode, "advisory_failure");
    return { advanced: true, from: "visual-gate", to: NEXT_STAGE, summary: `visual gate failed (advisory)` };
  }

  console.log(`[pipeline] #${issueNumber}: visual-gate failed${attempts} (gate mode); blocking`);
  const visualFailDetail = `Visual gate failed${attempts}.`;
  await setBlockedFn(
    cfg,
    issueNumber,
    `${visualFailDetail}\n\n\`\`\`\n${truncate(result.output, MAX_COMMENT_OUTPUT)}\n\`\`\``,
    "visual-gate",
    "visual-gate-failed",
  );
  await recordGateResult(opts, "fail", cfg.visual_gate.mode, "gate_failure");
  return { advanced: false, status: "blocked", reason: `visual gate failed${attempts}`, blockerKind: "visual-gate-failed" };
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function buildVisualComment(opts: {
  outcome: "PASS" | "FAIL";
  mode: "gate" | "advisory";
  durationSec: number;
  excerpt: string;
  manifest: ArtifactManifest;
  publishAnnotations?: Map<string, PublishAnnotation>;
  /** Set when publishing was attempted and failed — surfaced explicitly;
   *  never blocks the gate (best-effort evidence). */
  publishFailure?: string;
}): string {
  return [
    "## Visual Gate",
    "",
    `**Outcome**: ${opts.outcome}`,
    `**Mode**: ${opts.mode}`,
    `**Elapsed**: ${opts.durationSec.toFixed(1)}s`,
    "",
    "### Output",
    "```",
    opts.excerpt,
    "```",
    "",
    "### Artifacts",
    formatArtifactManifest(opts.manifest, opts.publishAnnotations),
    ...(opts.publishFailure ? ["", `**Publish**: failed — ${opts.publishFailure}`] : []),
    "",
    "---",
    "*Automated by Claude Code Pipeline Skill*",
  ].join("\n");
}

async function recordVisualAccounting(
  opts: AdvanceVisualOpts,
  issueNumber: number,
  command: string,
  result: VisualRunResult,
  startedAt: Date,
  endedAt: Date,
): Promise<void> {
  if (!opts.runDir) return;
  await emitStageAccounting(
    opts.runDir,
    buildStageAccountingRecord({
      runId: path.basename(opts.runDir),
      issue: issueNumber,
      stage: "visual-gate",
      harness: "visual-gate",
      modelSlot: null,
      model: null,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: result.durationSec * 1000,
      commandCount: 1,
      subprocessCount: 1,
      outcome: result.passed ? "success" : result.timedOut ? "timeout" : result.spawnError ? "spawn_error" : "failure",
      blockerKind: result.passed
        ? null
        : result.timedOut || result.spawnError
          ? "harness-failure"
          : "visual-gate-failed",
      usage: { command },
    }),
    opts.runStoreDeps,
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// Default command runner (injectable for tests).
// ---------------------------------------------------------------------------

async function defaultRunVisual(
  shellCmd: string,
  cwd: string,
  timeoutSec: number,
  env: NodeJS.ProcessEnv,
): Promise<VisualRunResult> {
  const res = await runCapped("sh", ["-c", shellCmd], cwd, timeoutSec, false, `visual-gate`, {
    killProcessGroup: true,
    env,
  });
  let output = combineOutput(res);
  if (res.timed_out) {
    output += `\n\n[visual-gate timed out after ${timeoutSec}s]`;
  }
  return {
    passed: res.success,
    timedOut: res.timed_out,
    spawnError: res.spawn_error ?? false,
    output,
    durationSec: res.duration,
  };
}

// ---------------------------------------------------------------------------
// Default git implementations for the visual-fix round (injectable for tests).
// ---------------------------------------------------------------------------

async function defaultGitHead(cwd: string): Promise<string> {
  const res = await gitInWorktree(cwd, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return res.stdout.trim();
}

async function defaultGitDirty(cwd: string): Promise<boolean> {
  const res = await gitInWorktree(cwd, ["status", "--porcelain"], { ignoreFailure: true });
  return res.stdout.trim().length > 0;
}

async function defaultGitPush(cwd: string, branch: string): Promise<{ code: number; stderr: string }> {
  const res = await gitInWorktree(cwd, ["push", "origin", branch], { ignoreFailure: true });
  return { code: res.code, stderr: res.stderr };
}

async function defaultGitCommitMessages(cwd: string, baseRef: string): Promise<string[]> {
  const res = await gitInWorktree(
    cwd,
    ["log", `--format=%x00%B`, `${baseRef}..HEAD`],
    { ignoreFailure: true },
  );
  if (!res.stdout.trim()) return [];
  return res.stdout.split("\x00").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function combineOutput(res: { stdout: string; stderr: string }): string {
  const parts = [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean);
  return parts.join("\n").trim() || "(no output captured)";
}
