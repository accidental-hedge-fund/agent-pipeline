// Evidence bundle (#147) — the per-run audit artifact writer.
//
// A single JSON file per run at `<stateDir>/<issue>/evidence.json`, built up
// incrementally as stages execute and finalized when the run ends. The module is
// PURE I/O: it does not call `gh`, post comments, or read config — the
// orchestrator owns those side effects. All writes are atomic (`.tmp` + rename)
// and the read-modify-write is safe for the pipeline's serial, per-issue loop.
//
// SENSITIVE-VALUE RULE: a `CommandRecord` is reconstructed here from exactly four
// fields (cmd / exitCode / durationMs / outputExcerpt), with the excerpt capped
// at 500 chars. Even if a caller hands over an object with extra fields, only the
// four allowed fields survive — so raw env vars, tokens, or secrets can never
// reach the bundle through this path.

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  EVIDENCE_SCHEMA_VERSION,
  type CommandRecord,
  type EvidenceBundle,
  type OverrideRecord,
  type PromptRecord,
  type RecoveryRecord,
  type ReviewRecord,
  type StageRecord,
  type StageUpdate,
} from "./types.ts";
import { redactSecrets, sanitize } from "./artifact-sanitize.ts";

/** Bundle filename written under `<stateDir>/<issue>/`. */
export const EVIDENCE_FILE = "evidence.json";

/** Hard cap on a recorded command's combined stdout/stderr excerpt. */
export const OUTPUT_EXCERPT_CAP = 500;

/** I/O seam (mirrors the `Deps` pattern elsewhere). Defaults to `fs/promises`;
 *  unit tests inject in-memory fakes so no real filesystem is touched. */
export interface BundleDeps {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (p: string, opts: { recursive: boolean }) => Promise<void>;
}

const defaultDeps: BundleDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  rename: (from, to) => fsp.rename(from, to),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
};

/** Absolute path of the evidence bundle for an issue under `stateDir`. */
export function bundlePath(stateDir: string, issue: number): string {
  return path.join(stateDir, String(issue), EVIDENCE_FILE);
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** A fresh, empty bundle skeleton — used to recreate the file if it is missing
 *  or unreadable when an incremental record call runs (#147, supplement rule:
 *  a deleted/corrupt bundle must never break the pipeline). */
function emptyBundle(issue: number): EvidenceBundle {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: "",
    issue,
    pr: null,
    branch: null,
    harnesses: [],
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState: null,
    finalizedAt: null,
    notifiedAt: null,
  };
}

/** Atomic write: ensure the issue dir exists, write a `.tmp` sibling, rename.
 *  Non-fatal: I/O errors are caught, logged, and do not propagate (#161). The
 *  serialized content is passed through the injection denylist before writing. */
async function writeBundle(
  stateDir: string,
  issue: number,
  bundle: EvidenceBundle,
  deps: BundleDeps,
): Promise<void> {
  try {
    const finalPath = bundlePath(stateDir, issue);
    await deps.mkdir(path.dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.tmp`;
    const serialized = sanitize(redactSecrets(`${JSON.stringify(bundle, null, 2)}\n`));
    await deps.writeFile(tmp, serialized);
    await deps.rename(tmp, finalPath);
  } catch (err) {
    console.warn(
      `[pipeline] evidence-bundle: write failed (non-fatal): ${(err as Error).message}`,
    );
  }
}

/** Read + parse the bundle. Returns `null` when the file is absent (ENOENT);
 *  rethrows other read/parse errors so a caller (e.g. `--summary`) can report a
 *  corrupt bundle rather than silently masking it. */
export async function readBundle(
  stateDir: string,
  issue: number,
  deps: BundleDeps = defaultDeps,
): Promise<EvidenceBundle | null> {
  let raw: string;
  try {
    raw = await deps.readFile(bundlePath(stateDir, issue));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as EvidenceBundle;
}

/** Load the existing bundle for an incremental update, tolerating a missing or
 *  unreadable file by starting from an empty skeleton (recreate-if-missing). */
async function loadForUpdate(
  stateDir: string,
  issue: number,
  deps: BundleDeps,
): Promise<EvidenceBundle> {
  const existing = await readBundle(stateDir, issue, deps).catch(() => null);
  return existing ?? emptyBundle(issue);
}

export interface CreateBundleArgs {
  runId: string;
  issue: number;
  pr: number | null;
  branch: string | null;
  harnesses: string[];
}

/** Create (or overwrite) the run's bundle with its identity fields. A new run on
 *  the same issue starts fresh — re-runs overwrite, they do not accumulate. */
export async function createBundle(
  stateDir: string,
  args: CreateBundleArgs,
  deps: BundleDeps = defaultDeps,
): Promise<EvidenceBundle> {
  const bundle: EvidenceBundle = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    runId: args.runId,
    issue: args.issue,
    pr: args.pr,
    branch: args.branch,
    harnesses: args.harnesses,
    stages: [],
    reviews: [],
    overrides: [],
    recoveries: [],
    finalState: null,
    finalizedAt: null,
    notifiedAt: null,
  };
  await writeBundle(stateDir, args.issue, bundle, deps);
  return bundle;
}

/** Upsert a stage entry: create or update the currently-open entry for the stage.
 *
 * "Open" means the entry has no `exitedAt` yet. On a second visit to the same
 * stage (e.g. review-1 → fix-1 → review-1), the first visit's entry is already
 * closed, so a new entry is appended for the second visit. This preserves the
 * full convergence history instead of overwriting the earlier transition. */
export async function recordStage(
  stateDir: string,
  issue: number,
  update: StageUpdate,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  // Find the last open (exitedAt === null) entry for this stage name.
  let entry: StageRecord | undefined;
  for (let i = bundle.stages.length - 1; i >= 0; i--) {
    if (bundle.stages[i].stage === update.stage && bundle.stages[i].exitedAt === null) {
      entry = bundle.stages[i];
      break;
    }
  }
  if (!entry) {
    entry = {
      stage: update.stage,
      enteredAt: null,
      exitedAt: null,
      outcome: null,
      commits: [],
      commands: [],
      prompts: [],
    };
    bundle.stages.push(entry);
  }
  if (update.enteredAt !== undefined) entry.enteredAt = update.enteredAt;
  if (update.exitedAt !== undefined) entry.exitedAt = update.exitedAt;
  if (update.outcome !== undefined) entry.outcome = update.outcome;
  if (update.commits !== undefined) entry.commits = update.commits;
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Build a sanitized `CommandRecord` — the single chokepoint that enforces the
 *  four-field shape and the 500-char output cap (sensitive-value exclusion). */
export function makeCommandRecord(
  cmd: string,
  exitCode: number,
  durationMs: number,
  output: string,
): CommandRecord {
  return {
    cmd: redactSecrets(cmd),
    exitCode,
    durationMs: Math.round(durationMs),
    outputExcerpt: redactSecrets(output ?? "").slice(0, OUTPUT_EXCERPT_CAP),
  };
}

/** Append a command to a stage entry (creating the entry if it does not exist).
 *  Uses the same last-open entry lookup as {@link recordPrompt}: on a re-entered
 *  stage there are multiple entries with the same name; we target the last one
 *  whose `exitedAt` is still null (the currently active visit). The record is
 *  re-sanitized through {@link makeCommandRecord} defensively. */
export async function recordCommand(
  stateDir: string,
  issue: number,
  stageName: string,
  cmd: CommandRecord,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  let entry: StageRecord | undefined;
  for (let i = bundle.stages.length - 1; i >= 0; i--) {
    if (bundle.stages[i].stage === stageName && bundle.stages[i].exitedAt === null) {
      entry = bundle.stages[i];
      break;
    }
  }
  if (!entry) {
    entry = {
      stage: stageName,
      enteredAt: null,
      exitedAt: null,
      outcome: null,
      commits: [],
      commands: [],
      prompts: [],
    };
    bundle.stages.push(entry);
  }
  entry.commands.push(
    makeCommandRecord(cmd.cmd, cmd.exitCode, cmd.durationMs, cmd.outputExcerpt),
  );
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Build a sanitized `PromptRecord`. The prompt content is passed through the
 *  same secret-redaction path as `CommandRecord`, and then hashed (SHA-1 prefix)
 *  and excerpted so no raw secret can survive in the bundle. */
export function makePromptRecord(kind: string, harness: string, prompt: string): PromptRecord {
  const redacted = redactSecrets(prompt);
  return {
    kind,
    harness,
    hash: createHash("sha1").update(redacted).digest("hex").slice(0, 8),
    excerpt: redacted.slice(0, OUTPUT_EXCERPT_CAP),
  };
}

/** Append a prompt record to the currently-open stage entry (creating the entry
 *  if absent). Mirrors the "last-open" logic of {@link recordStage}. */
export async function recordPrompt(
  stateDir: string,
  issue: number,
  stageName: string,
  record: PromptRecord,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  let entry: StageRecord | undefined;
  for (let i = bundle.stages.length - 1; i >= 0; i--) {
    if (bundle.stages[i].stage === stageName && bundle.stages[i].exitedAt === null) {
      entry = bundle.stages[i];
      break;
    }
  }
  if (!entry) {
    entry = {
      stage: stageName,
      enteredAt: null,
      exitedAt: null,
      outcome: null,
      commits: [],
      commands: [],
      prompts: [],
    };
    bundle.stages.push(entry);
  }
  entry.prompts.push(record);
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Append a review-round verdict summary. */
export async function recordReview(
  stateDir: string,
  issue: number,
  review: ReviewRecord,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  bundle.reviews.push(review);
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Append an operator override disposition. */
export async function recordOverride(
  stateDir: string,
  issue: number,
  override: OverrideRecord,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  bundle.overrides.push(override);
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Append an auto-recovery event. */
export async function recordRecovery(
  stateDir: string,
  issue: number,
  recovery: RecoveryRecord,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  bundle.recoveries.push(recovery);
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Finalize the run: set the terminal state and the finalized timestamp. */
export async function finalizeBundle(
  stateDir: string,
  issue: number,
  finalState: string,
  deps: BundleDeps = defaultDeps,
): Promise<EvidenceBundle> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  bundle.finalState = finalState;
  bundle.finalizedAt = nowIso();
  await writeBundle(stateDir, issue, bundle, deps);
  return bundle;
}

/** Refresh identity fields that may have been null at bundle creation (e.g. `pr`
 *  and `branch` are unknown before planning creates the worktree and PR).
 *  Only the supplied fields are touched; everything else is preserved. */
export async function patchBundleIdentity(
  stateDir: string,
  issue: number,
  patch: { pr?: number | null; branch?: string | null },
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  if (patch.pr !== undefined) bundle.pr = patch.pr;
  if (patch.branch !== undefined) bundle.branch = patch.branch;
  await writeBundle(stateDir, issue, bundle, deps);
}

/** Stamp the bundle with the path-notification timestamp (orchestrator calls this
 *  after posting the path comment, so a re-finalize does not re-post). */
export async function markNotified(
  stateDir: string,
  issue: number,
  deps: BundleDeps = defaultDeps,
): Promise<void> {
  const bundle = await loadForUpdate(stateDir, issue, deps);
  bundle.notifiedAt = nowIso();
  await writeBundle(stateDir, issue, bundle, deps);
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

function formatDuration(enteredAt: string | null, exitedAt: string | null): string {
  if (!enteredAt || !exitedAt) return "—";
  const ms = Date.parse(exitedAt) - Date.parse(enteredAt);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Format the bundle as human-readable text (pure; exported for tests). */
export function formatSummary(bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push(`Evidence bundle — issue #${bundle.issue}`);
  lines.push(`  Run ID:      ${bundle.runId || "(none)"}`);
  lines.push(`  PR:          ${bundle.pr !== null ? `#${bundle.pr}` : "(none)"}`);
  lines.push(`  Branch:      ${bundle.branch ?? "(none)"}`);
  lines.push(`  Harnesses:   ${bundle.harnesses.length ? bundle.harnesses.join(", ") : "(none)"}`);
  lines.push(
    `  Final state: ${bundle.finalState ?? "(partial run — not finalized)"}` +
      (bundle.finalizedAt ? ` (finalized ${bundle.finalizedAt})` : ""),
  );

  lines.push("");
  lines.push("Stages:");
  if (bundle.stages.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const s of bundle.stages) {
      lines.push(
        `  ${pad(s.stage, 16)} ${pad(s.outcome ?? "in-progress", 11)} ${formatDuration(s.enteredAt, s.exitedAt)}`,
      );
      for (const c of s.commands) {
        lines.push(`      $ ${c.cmd}  (exit ${c.exitCode}, ${c.durationMs}ms)`);
      }
    }
  }

  lines.push("");
  lines.push("Reviews:");
  if (bundle.reviews.length === 0) {
    lines.push("  (none recorded)");
  } else {
    for (const r of bundle.reviews) {
      const counts = Object.entries(r.findingCounts)
        .map(([sev, n]) => `${sev}:${n}`)
        .join(" ");
      lines.push(`  round ${r.round}  ${pad(r.verdict, 16)} ${counts}  @${r.sha.slice(0, 7)}`);
    }
  }

  if (bundle.overrides.length) {
    lines.push("");
    lines.push("Overrides:");
    for (const o of bundle.overrides) {
      lines.push(`  ${o.key}  ${o.reason}`);
    }
  }

  if (bundle.recoveries.length) {
    lines.push("");
    lines.push("Recoveries:");
    for (const rec of bundle.recoveries) {
      lines.push(`  ${rec.trigger}  round ${rec.round}  ${rec.at}`);
    }
  }

  return lines.join("\n");
}

/** Print the human-readable summary to stdout. */
export function printSummary(bundle: EvidenceBundle): void {
  console.log(formatSummary(bundle));
}
