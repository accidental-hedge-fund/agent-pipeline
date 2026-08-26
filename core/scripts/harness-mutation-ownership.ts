/**
 * Durable harness mutation ownership (#1246).
 *
 * Product-mutating harness attempts persist a host-local record (pre-HEAD,
 * pre-porcelain, in-flight, last-known/post) so a later process can tell
 * pipeline-owned leftovers from unknown product dirt, checkpoint the owned
 * set, and resume without an operator reconstructing authorship.
 *
 * All I/O is behind {@link OwnershipDeps}. Unit tests inject fake porcelain,
 * storage, and git — no real network, git, or subprocess.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { artifactSubdir, HARNESS_OWNERSHIP_ARTIFACT } from "./artifact-ignore.ts";
import { gitInWorktree } from "./worktree.ts";
import {
  salvageUncommittedWork,
  type SalvageDeps,
} from "./salvage-harness-work.ts";
import {
  classifyOwnedWorktreeDirt,
  isNonProductScratchPath,
  parsePorcelainEntries,
  type PorcelainEntry,
  type TernaryDirtClassification,
} from "./worktree-dirt.ts";
import { appendEvent, RUN_SCHEMA_VERSION, type RunStoreDeps } from "./run-store.ts";

export const HARNESS_MUTATION_OWNERSHIP_SCHEMA_VERSION = 1;

/** Bounded in-flight last-known porcelain refresh. Tests inject a fake clock. */
export const OWNERSHIP_HEARTBEAT_MS = 15_000;

export type HarnessMutationResultClass =
  | "timeout"
  | "crash"
  | "success"
  | "interrupted";

export type OwnershipDisposition = "recovered" | "checkpointed" | "resumed" | "rejected";

export interface PorcelainSnapshotEntry {
  path: string;
  xy: string;
  /** Optional content identity (hash). Path + xy still detect add/delete. */
  identity?: string;
}

export interface OwnershipTerminalEvidence {
  disposition: OwnershipDisposition;
  issue: number;
  attempt_id: string;
  owned_path_count: number;
  unknown_paths?: string[];
  at: string;
}

export interface HarnessMutationOwnershipRecord {
  schema_version: number;
  issue: number;
  domain: string;
  stage: string;
  attempt_id: string;
  worktree_path: string;
  pre_head: string;
  pre_porcelain: PorcelainSnapshotEntry[];
  in_flight: boolean;
  last_known_porcelain?: PorcelainSnapshotEntry[];
  post_porcelain?: PorcelainSnapshotEntry[];
  result_class?: HarnessMutationResultClass;
  last_evidence?: OwnershipTerminalEvidence;
  updated_at: string;
}

export interface OwnershipStoreDeps {
  readFile?: (p: string) => Promise<string | null>;
  writeFileAtomic?: (p: string, content: string) => Promise<void>;
  mkdirp?: (p: string) => Promise<void>;
}

export interface OwnershipClockDeps {
  now?: () => Date;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  heartbeatMs?: number;
}

export interface OwnershipGitDeps {
  gitStatusPorcelain?: (wtPath: string) => Promise<string>;
  gitHead?: (wtPath: string) => Promise<string>;
  hashFile?: (wtPath: string, relPath: string) => Promise<string | undefined>;
}

export interface OwnershipDeps
  extends OwnershipStoreDeps, OwnershipClockDeps, OwnershipGitDeps {
  salvage?: typeof salvageUncommittedWork;
  salvageGit?: SalvageDeps;
  appendEvent?: typeof appendEvent;
  runStoreDeps?: RunStoreDeps;
}

export class OwnershipSnapshotFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipSnapshotFailedError";
  }
}

function safeSegment(value: string | undefined): string {
  const trimmed = (typeof value === "string" ? value : "").trim() || "_";
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

/** Absolute path of the durable ownership record for (repo, domain, issue). */
export function ownershipRecordPath(
  repoDir: string,
  domain: string,
  issue: number,
): string {
  return path.join(
    artifactSubdir(repoDir, HARNESS_OWNERSHIP_ARTIFACT),
    safeSegment(domain),
    `issue-${issue}.json`,
  );
}

async function defaultReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function defaultMkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function defaultWriteFileAtomic(p: string, content: string): Promise<void> {
  await defaultMkdirp(path.dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, p);
}

function isoNow(deps: OwnershipClockDeps): string {
  const d = deps.now ? deps.now() : new Date();
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

export function parseOwnershipRecord(raw: unknown): HarnessMutationOwnershipRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== HARNESS_MUTATION_OWNERSHIP_SCHEMA_VERSION) return null;
  if (typeof o.issue !== "number" || !Number.isSafeInteger(o.issue) || o.issue <= 0) return null;
  if (typeof o.attempt_id !== "string" || !o.attempt_id) return null;
  if (typeof o.worktree_path !== "string") return null;
  if (typeof o.pre_head !== "string") return null;
  if (typeof o.in_flight !== "boolean") return null;
  if (!Array.isArray(o.pre_porcelain)) return null;
  return o as unknown as HarnessMutationOwnershipRecord;
}

export async function loadOwnershipRecord(
  input: { repoDir: string; domain: string; issue: number },
  deps: OwnershipStoreDeps = {},
): Promise<HarnessMutationOwnershipRecord | null> {
  const p = ownershipRecordPath(input.repoDir, input.domain, input.issue);
  const read = deps.readFile ?? defaultReadFile;
  const text = await read(p);
  if (text == null) return null;
  try {
    return parseOwnershipRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function saveOwnershipRecord(
  input: { repoDir: string; domain: string; issue: number },
  record: HarnessMutationOwnershipRecord,
  deps: OwnershipStoreDeps = {},
): Promise<void> {
  const p = ownershipRecordPath(input.repoDir, input.domain, input.issue);
  const write = deps.writeFileAtomic ?? defaultWriteFileAtomic;
  await write(p, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Ownership snapshots and current-status reads must list untracked files
 * individually. Default porcelain collapses an untracked directory to
 * `?? dir/`, which would own the directory and later stage operator files
 * created under it (#1246 review 2).
 */
export const OWNERSHIP_GIT_STATUS_ARGS = [
  "status",
  "--porcelain",
  "--untracked-files=all",
] as const;

async function defaultGitStatusPorcelain(wtPath: string): Promise<string> {
  const r = await gitInWorktree(wtPath, [...OWNERSHIP_GIT_STATUS_ARGS], { ignoreFailure: true });
  return r.stdout;
}

async function defaultGitHead(wtPath: string): Promise<string> {
  const r = await gitInWorktree(wtPath, ["rev-parse", "HEAD"], { ignoreFailure: true });
  return r.stdout.trim();
}

async function capturePorcelain(
  wtPath: string,
  extraGlobs: readonly string[],
  deps: OwnershipGitDeps,
): Promise<PorcelainSnapshotEntry[]> {
  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const status = await statusFn(wtPath);
  const entries = parsePorcelainEntries(status);
  const out: PorcelainSnapshotEntry[] = [];
  for (const e of entries) {
    if (isNonProductScratchPath(e.path, extraGlobs)) {
      out.push({ path: e.path, xy: e.xy });
      continue;
    }
    let identity: string | undefined;
    if (deps.hashFile) {
      try {
        identity = await deps.hashFile(wtPath, e.path);
      } catch {
        identity = undefined;
      }
    }
    out.push(identity ? { path: e.path, xy: e.xy, identity } : { path: e.path, xy: e.xy });
  }
  return out;
}

function entryKey(e: PorcelainSnapshotEntry): string {
  return `${e.path}\0${e.xy}\0${e.identity ?? ""}`;
}

function snapshotMap(entries: readonly PorcelainSnapshotEntry[]): Map<string, PorcelainSnapshotEntry> {
  const m = new Map<string, PorcelainSnapshotEntry>();
  for (const e of entries) m.set(e.path, e);
  return m;
}

/**
 * Product-path porcelain delta: paths in `post` that are not scratch and that
 * were absent from `pre` or changed xy/identity.
 */
export function porcelainProductDelta(
  pre: readonly PorcelainSnapshotEntry[],
  post: readonly PorcelainSnapshotEntry[],
  extraGlobs: readonly string[] = [],
): string[] {
  const preMap = snapshotMap(pre);
  const owned: string[] = [];
  const seen = new Set<string>();
  for (const e of post) {
    if (isNonProductScratchPath(e.path, extraGlobs)) continue;
    if (seen.has(e.path)) continue;
    const prev = preMap.get(e.path);
    if (!prev || entryKey(prev) !== entryKey(e)) {
      owned.push(e.path);
      seen.add(e.path);
    }
  }
  return owned;
}

/**
 * Owned leftover path set for a record vs current porcelain.
 *
 * - No record ⇒ empty owned set (fail closed).
 * - Not in-flight ⇒ empty owned set (later dirt is unknown).
 * - Last-known or post present ⇒ product delta vs pre, intersected with current product dirt.
 * - In-flight with no last-known/post (hard kill) ⇒ current product porcelain
 *   minus pre-attempt product paths. Pre-existing dirt stays unknown unless a
 *   later snapshot proves a content/status delta.
 */
export function ownedLeftoverPathsFromRecord(
  record: HarnessMutationOwnershipRecord | null,
  currentPaths: readonly string[],
  extraGlobs: readonly string[] = [],
): string[] {
  if (!record || !record.in_flight) return [];
  const currentProduct = currentPaths.filter((p) => !isNonProductScratchPath(p, extraGlobs));
  const hasReference =
    record.post_porcelain !== undefined || record.last_known_porcelain !== undefined;
  if (hasReference) {
    const reference = record.post_porcelain ?? record.last_known_porcelain ?? [];
    const delta = new Set(porcelainProductDelta(record.pre_porcelain, reference, extraGlobs));
    return currentProduct.filter((p) => delta.has(p));
  }
  // Hard-kill: durable pre-snapshot exists, no last-known refresh yet.
  // Path names alone cannot prove a pre-existing file changed, so those
  // paths stay unknown. Newly dirty product paths are attributable as owned.
  const preProduct = new Set(
    record.pre_porcelain
      .filter((e) => !isNonProductScratchPath(e.path, extraGlobs))
      .map((e) => e.path),
  );
  return currentProduct.filter((p) => !preProduct.has(p));
}

export function classifyHarnessMutationDirt(input: {
  porcelain: string;
  record: HarnessMutationOwnershipRecord | null;
  extraGlobs?: readonly string[];
}): TernaryDirtClassification {
  const extra = input.extraGlobs ?? [];
  const paths = parsePorcelainEntries(input.porcelain).map((e) => e.path);
  const owned = ownedLeftoverPathsFromRecord(input.record, paths, extra);
  return classifyOwnedWorktreeDirt(paths, owned, extra);
}

export function harnessResultClass(result: unknown): HarnessMutationResultClass {
  if (!result || typeof result !== "object") return "success";
  const r = result as Record<string, unknown>;
  const inner =
    r.result && typeof r.result === "object"
      ? (r.result as Record<string, unknown>)
      : r;
  if (inner.timed_out === true) return "timeout";
  if (inner.spawn_error === true) return "crash";
  if (inner.success === false) return "crash";
  return "success";
}

export async function emitOwnershipEvidence(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    record: HarnessMutationOwnershipRecord;
    disposition: OwnershipDisposition;
    ownedPathCount: number;
    unknownPaths?: readonly string[];
    runDir?: string;
  },
  deps: OwnershipDeps = {},
): Promise<OwnershipTerminalEvidence> {
  const evidence: OwnershipTerminalEvidence = {
    disposition: input.disposition,
    issue: input.issue,
    attempt_id: input.record.attempt_id,
    owned_path_count: input.ownedPathCount,
    ...(input.unknownPaths && input.unknownPaths.length > 0
      ? { unknown_paths: [...input.unknownPaths] }
      : {}),
    at: isoNow(deps),
  };
  const next: HarnessMutationOwnershipRecord = {
    ...input.record,
    last_evidence: evidence,
    updated_at: evidence.at,
  };
  await saveOwnershipRecord(
    { repoDir: input.repoDir, domain: input.domain, issue: input.issue },
    next,
    deps,
  );
  if (input.runDir) {
    const append = deps.appendEvent ?? appendEvent;
    await append(
      input.runDir,
      {
        schema_version: RUN_SCHEMA_VERSION,
        type: "harness_mutation_ownership",
        at: evidence.at,
        disposition: evidence.disposition,
        issue: evidence.issue,
        attempt_id: evidence.attempt_id,
        owned_path_count: evidence.owned_path_count,
        ...(evidence.unknown_paths ? { unknown_paths: evidence.unknown_paths } : {}),
      },
      deps.runStoreDeps,
    ).catch(() => {});
  }
  return evidence;
}

export async function beginOwnershipAttempt(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    stage: string;
    wtPath: string;
    extraGlobs?: readonly string[];
  },
  deps: OwnershipDeps = {},
): Promise<{ ok: true; record: HarnessMutationOwnershipRecord } | { ok: false; reason: string }> {
  const extra = input.extraGlobs ?? [];
  try {
    const headFn = deps.gitHead ?? defaultGitHead;
    const preHead = await headFn(input.wtPath);
    const prePorcelain = await capturePorcelain(input.wtPath, extra, deps);
    const at = isoNow(deps);
    const attemptId = `${input.issue}-${input.stage}-${(preHead || "nohead").slice(0, 12)}-${at}`;
    const record: HarnessMutationOwnershipRecord = {
      schema_version: HARNESS_MUTATION_OWNERSHIP_SCHEMA_VERSION,
      issue: input.issue,
      domain: input.domain,
      stage: input.stage,
      attempt_id: attemptId,
      worktree_path: input.wtPath,
      pre_head: preHead,
      pre_porcelain: prePorcelain,
      in_flight: true,
      updated_at: at,
    };
    await saveOwnershipRecord(
      { repoDir: input.repoDir, domain: input.domain, issue: input.issue },
      record,
      deps,
    );
    // Hydrate to prove the write is durable before spawn.
    const loaded = await loadOwnershipRecord(
      { repoDir: input.repoDir, domain: input.domain, issue: input.issue },
      deps,
    );
    if (!loaded || loaded.attempt_id !== record.attempt_id) {
      return { ok: false, reason: "ownership record did not hydrate after durable write" };
    }
    return { ok: true, record: loaded };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function refreshLastKnownPorcelain(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    wtPath: string;
    extraGlobs?: readonly string[];
  },
  deps: OwnershipDeps = {},
): Promise<void> {
  const rec = await loadOwnershipRecord(input, deps);
  if (!rec || !rec.in_flight) return;
  try {
    const lastKnown = await capturePorcelain(input.wtPath, input.extraGlobs ?? [], deps);
    // Skip a clean-as-pre snapshot so a first heartbeat cannot void the
    // hard-kill rule (new product porcelain vs pre is owned when no last-known).
    const extra = input.extraGlobs ?? [];
    const delta = porcelainProductDelta(rec.pre_porcelain, lastKnown, extra);
    if (delta.length === 0 && lastKnown.length === rec.pre_porcelain.length) return;
    await saveOwnershipRecord(input, {
      ...rec,
      last_known_porcelain: lastKnown,
      updated_at: isoNow(deps),
    }, deps);
  } catch {
    // Heartbeat is fail-open: pre-snapshot still exists.
  }
}

export function startOwnershipHeartbeat(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    wtPath: string;
    extraGlobs?: readonly string[];
  },
  deps: OwnershipDeps = {},
): { stop: () => void } {
  const ms = deps.heartbeatMs ?? OWNERSHIP_HEARTBEAT_MS;
  const setI = deps.setIntervalFn ?? setInterval;
  const clearI = deps.clearIntervalFn ?? clearInterval;
  const id = setI(() => {
    void refreshLastKnownPorcelain(input, deps);
  }, ms);
  return { stop: () => clearI(id) };
}

export async function checkpointOwnedHarnessDirt(
  input: {
    wtPath: string;
    issueNumber: number;
    pipelineRunId: string;
    stageLabel?: string;
    ownedPaths: readonly string[];
  },
  deps: OwnershipDeps = {},
): Promise<{ checkpointed: boolean; failureReason?: string }> {
  if (input.ownedPaths.length === 0) return { checkpointed: false };
  const salvage = deps.salvage ?? salvageUncommittedWork;
  const salvageGit: SalvageDeps = { ...(deps.salvageGit ?? {}) };
  if (!salvageGit.gitStatus) {
    const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
    salvageGit.gitStatus = async (p) => statusFn(p);
  }
  try {
    const result = await salvage(
      input.wtPath,
      input.issueNumber,
      input.pipelineRunId,
      input.stageLabel ?? "owned-harness-leftover",
      { ...salvageGit, onlyPaths: input.ownedPaths },
    );
    return { checkpointed: result.salvaged };
  } catch (err) {
    return {
      checkpointed: false,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function finishOwnershipAttempt(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    wtPath: string;
    pipelineRunId: string;
    extraGlobs?: readonly string[];
    resultClass: HarnessMutationResultClass;
    runDir?: string;
    checkpoint?: boolean;
  },
  deps: OwnershipDeps = {},
): Promise<{
  record: HarnessMutationOwnershipRecord | null;
  classified: TernaryDirtClassification;
  checkpointed: boolean;
  evidence?: OwnershipTerminalEvidence;
}> {
  const extra = input.extraGlobs ?? [];
  const rec = await loadOwnershipRecord(input, deps);
  const empty: TernaryDirtClassification = { scratch: [], ownedLeftover: [], unknownProduct: [] };
  if (!rec) {
    return { record: null, classified: empty, checkpointed: false };
  }
  let post: PorcelainSnapshotEntry[] = rec.last_known_porcelain ?? rec.pre_porcelain;
  try {
    post = await capturePorcelain(input.wtPath, extra, deps);
  } catch {
    // Keep last-known when post capture fails.
  }
  let next: HarnessMutationOwnershipRecord = {
    ...rec,
    post_porcelain: post,
    last_known_porcelain: post,
    result_class: input.resultClass,
    updated_at: isoNow(deps),
  };
  await saveOwnershipRecord(input, next, deps);

  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const porcelain = await statusFn(input.wtPath);
  let classified = classifyHarnessMutationDirt({ porcelain, record: next, extraGlobs: extra });

  let checkpointed = false;
  const shouldCheckpoint = input.checkpoint !== false && classified.ownedLeftover.length > 0;
  if (shouldCheckpoint) {
    const ck = await checkpointOwnedHarnessDirt(
      {
        wtPath: input.wtPath,
        issueNumber: input.issue,
        pipelineRunId: input.pipelineRunId,
        stageLabel: next.stage,
        ownedPaths: classified.ownedLeftover,
      },
      deps,
    );
    checkpointed = ck.checkpointed;
    if (checkpointed) {
      const after = statusFn ? await statusFn(input.wtPath) : "";
      // After a successful owned-path checkpoint those leftovers are authored.
      next = {
        ...next,
        in_flight: false,
        updated_at: isoNow(deps),
      };
      await saveOwnershipRecord(input, next, deps);
      classified = classifyHarnessMutationDirt({
        porcelain: after,
        record: next,
        extraGlobs: extra,
      });
      const disposition: OwnershipDisposition =
        classified.unknownProduct.length > 0 ? "checkpointed" : "recovered";
      const evidence = await emitOwnershipEvidence(
        {
          repoDir: input.repoDir,
          domain: input.domain,
          issue: input.issue,
          record: next,
          disposition,
          ownedPathCount: classified.ownedLeftover.length,
          unknownPaths: classified.unknownProduct,
          runDir: input.runDir,
        },
        deps,
      );
      return { record: { ...next, last_evidence: evidence }, classified, checkpointed: true, evidence };
    }
  }

  if (classified.ownedLeftover.length === 0) {
    next = { ...next, in_flight: false, updated_at: isoNow(deps) };
    await saveOwnershipRecord(input, next, deps);
  }

  if (classified.unknownProduct.length > 0) {
    const evidence = await emitOwnershipEvidence(
      {
        repoDir: input.repoDir,
        domain: input.domain,
        issue: input.issue,
        record: next,
        disposition: "rejected",
        ownedPathCount: classified.ownedLeftover.length,
        unknownPaths: classified.unknownProduct,
        runDir: input.runDir,
      },
      deps,
    );
    return { record: { ...next, last_evidence: evidence }, classified, checkpointed, evidence };
  }

  return { record: next, classified, checkpointed };
}

/**
 * Wrap a product-mutating harness invoke: durable pre-snapshot before spawn,
 * heartbeat while in-flight, post-snapshot + optional checkpoint after.
 * Does not spawn when the pre-snapshot cannot be made durable.
 */
function withTestStore(deps: OwnershipDeps): OwnershipDeps {
  if (!process.env.NODE_TEST_CONTEXT) return deps;
  const files = new Map<string, string>();
  return {
    ...deps,
    gitHead: deps.gitHead ?? (async () => ""),
    gitStatusPorcelain: deps.gitStatusPorcelain ?? (async () => ""),
    mkdirp: deps.mkdirp ?? (async () => {}),
    readFile: deps.readFile ?? (async (p) => files.get(p) ?? null),
    writeFileAtomic:
      deps.writeFileAtomic ??
      (async (p, c) => {
        files.set(p, c);
      }),
  };
}

export async function runWithMutationOwnership<T>(
  input: {
    repoDir: string;
    domain: string;
    issue: number;
    stage: string;
    wtPath: string;
    pipelineRunId: string;
    extraGlobs?: readonly string[];
    runDir?: string;
    invoke: () => Promise<T>;
    resultClass?: (result: T) => HarnessMutationResultClass;
    checkpointOnFinish?: boolean;
    onFinished?: (info: { checkpointed: boolean }) => void;
  },
  deps: OwnershipDeps = {},
): Promise<T> {
  deps = withTestStore(deps);
  const started = await beginOwnershipAttempt(input, deps);
  if (!started.ok) {
    throw new OwnershipSnapshotFailedError(
      `harness mutation ownership pre-snapshot failed; not spawning: ${started.reason}`,
    );
  }
  const beat = startOwnershipHeartbeat(input, deps);
  let result: T;
  let resultClass: HarnessMutationResultClass = "interrupted";
  try {
    result = await input.invoke();
    resultClass = (input.resultClass ?? harnessResultClass)(result);
  } catch (err) {
    beat.stop();
    const finished = await finishOwnershipAttempt(
      {
        ...input,
        resultClass: "crash",
        checkpoint: input.checkpointOnFinish !== false,
      },
      deps,
    ).catch(() => ({ checkpointed: false }));
    input.onFinished?.({ checkpointed: Boolean(finished && "checkpointed" in finished && finished.checkpointed) });
    throw err;
  }
  beat.stop();
  const finished = await finishOwnershipAttempt(
    {
      ...input,
      resultClass,
      checkpoint: input.checkpointOnFinish !== false,
    },
    deps,
  );
  input.onFinished?.({ checkpointed: finished.checkpointed });
  return result;
}

export function interruptedIncompleteImplement(
  record: HarnessMutationOwnershipRecord | null,
  classified: TernaryDirtClassification,
): boolean {
  if (!record) return false;
  if (!record.in_flight && classified.ownedLeftover.length === 0) return false;
  const interrupted =
    record.in_flight ||
    record.result_class === "timeout" ||
    record.result_class === "crash" ||
    record.result_class === "interrupted";
  return interrupted && (classified.ownedLeftover.length > 0 || record.in_flight);
}

/**
 * Re-entry helper: checkpoint owned leftovers for an interrupted implement.
 * Returns whether the implementer must be re-invoked (deliverable unsatisfied)
 * or post-implement may continue.
 */
export async function recoverInterruptedImplement(input: {
  repoDir: string;
  domain: string;
  issue: number;
  wtPath: string;
  pipelineRunId: string;
  extraGlobs?: readonly string[];
  runDir?: string;
  deliverablePresent: boolean;
}, deps: OwnershipDeps = {}): Promise<{
  action: "reinvoke" | "post-implement" | "none" | "blocked";
  classified: TernaryDirtClassification;
  checkpointed: boolean;
  evidence?: OwnershipTerminalEvidence;
  record: HarnessMutationOwnershipRecord | null;
  failureReason?: string;
}> {
  const rec = await loadOwnershipRecord(input, deps);
  const statusFn = deps.gitStatusPorcelain ?? defaultGitStatusPorcelain;
  const porcelain = await statusFn(input.wtPath);
  let classified = classifyHarnessMutationDirt({
    porcelain,
    record: rec,
    extraGlobs: input.extraGlobs,
  });
  if (!interruptedIncompleteImplement(rec, classified)) {
    return { action: "none", classified, checkpointed: false, record: rec };
  }
  let checkpointed = false;
  let evidence: OwnershipTerminalEvidence | undefined;
  if (classified.ownedLeftover.length > 0) {
    const ck = await checkpointOwnedHarnessDirt(
      {
        wtPath: input.wtPath,
        issueNumber: input.issue,
        pipelineRunId: input.pipelineRunId,
        stageLabel: rec?.stage ?? "implement",
        ownedPaths: classified.ownedLeftover,
      },
      deps,
    );
    checkpointed = ck.checkpointed;
    if (rec && checkpointed) {
      const next: HarnessMutationOwnershipRecord = {
        ...rec,
        in_flight: false,
        updated_at: isoNow(deps),
      };
      await saveOwnershipRecord(input, next, deps);
      const after = statusFn ? await statusFn(input.wtPath) : "";
      classified = classifyHarnessMutationDirt({
        porcelain: after,
        record: next,
        extraGlobs: input.extraGlobs,
      });
      const disposition: OwnershipDisposition = input.deliverablePresent
        ? (classified.unknownProduct.length > 0 ? "checkpointed" : "recovered")
        : "resumed";
      evidence = await emitOwnershipEvidence(
        {
          ...input,
          record: next,
          disposition,
          ownedPathCount: 0,
          unknownPaths: classified.unknownProduct,
        },
        deps,
      );
      if (!input.deliverablePresent) {
        return {
          action: "reinvoke",
          classified,
          checkpointed: true,
          evidence,
          record: { ...next, last_evidence: evidence },
        };
      }
      if (classified.unknownProduct.length === 0) {
        return {
          action: "post-implement",
          classified,
          checkpointed: true,
          evidence,
          record: { ...next, last_evidence: evidence },
        };
      }
      return {
        action: "post-implement",
        classified,
        checkpointed: true,
        evidence,
        record: { ...next, last_evidence: evidence },
      };
    }
    // Checkpoint failed with remaining owned leftovers: preserve the record
    // and stay engine-owned. Re-invoke would begin a new ownership attempt
    // and place the leftovers in pre_porcelain (#1246 review 2).
    return {
      action: "blocked",
      classified,
      checkpointed: false,
      record: rec,
      failureReason: ck.failureReason,
    };
  }
  if (!input.deliverablePresent) {
    if (rec) {
      evidence = await emitOwnershipEvidence(
        {
          ...input,
          record: rec,
          disposition: "resumed",
          ownedPathCount: classified.ownedLeftover.length,
          unknownPaths: classified.unknownProduct,
        },
        deps,
      );
    }
    return { action: "reinvoke", classified, checkpointed, evidence, record: rec };
  }
  return { action: "post-implement", classified, checkpointed, evidence, record: rec };
}
