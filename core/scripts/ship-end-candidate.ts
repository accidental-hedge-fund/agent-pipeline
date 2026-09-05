// Candidate-engine resolution and ship-end spawn argv (#1151).
//
// Closed contract: SHA is data (exact 40-hex). Allowed roots are a clean
// REPO_DIR HEAD, $REPO_DIR/.worktrees/ship-candidate-<sha>, or
// PIPELINE_CANDIDATE_ENGINE_ROOT. Entrypoint is
// node "$ENGINE_ROOT/scripts/pipeline-launcher.mjs". No eval of train JSON.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_CORE_LOCKFILE_REL,
  candidateReadyRecordPath,
  defaultPrepareCandidateEngineDeps,
  prepareCandidateEngine,
  revalidatePreparedCandidateEngineForSpawn,
  type PrepareCandidateEngineDeps,
  type ResolveAndPrepareDeps,
} from "./candidate-engine-readiness.ts";
import { parseExactGitSha } from "./ship-end-identity.ts";

export const CANDIDATE_WORKTREE_PREFIX = "ship-candidate-";
export const PIPELINE_TS_REL = path.join("core", "scripts", "pipeline.ts");
export const LAUNCHER_REL = path.join("scripts", "pipeline-launcher.mjs");
export const CANDIDATE_PROCESS_GUARD_REL = path.join("scripts", "candidate-process-guard.mjs");

export interface CandidateEngine {
  engineRoot: string;
  launcherPath: string;
  commitSha: string;
  consumer?: CandidateEngineRoute;
  /** Prepared proof is intentionally single-use at the spawn boundary. */
  revalidateBeforeSpawn?: () => CandidateEngineResult;
  /** Shared host-local lease held from final validation through process life. */
  acquireProcessLock?: () => CandidateProcessLease | null;
}

export const CANDIDATE_PROCESS_GUARD_ENV = {
  required: "PIPELINE_CANDIDATE_PROCESS_GUARD",
  root: "PIPELINE_CANDIDATE_PROCESS_ROOT",
  sha: "PIPELINE_CANDIDATE_PROCESS_SHA",
  readyRecord: "PIPELINE_CANDIDATE_PROCESS_READY_RECORD",
  lockfileDigest: "PIPELINE_CANDIDATE_PROCESS_LOCKFILE_DIGEST",
  processLock: "PIPELINE_CANDIDATE_PROCESS_LOCK",
  processLockDigest: "PIPELINE_CANDIDATE_PROCESS_LOCK_DIGEST",
} as const;

export interface CandidateProcessGuardProof {
  engineRoot: string;
  commitSha: string;
  readyRecordPath: string;
  lockfileDigest: string;
  processLockPath: string;
  processLockDigest: string;
}

export interface CandidateProcessLease {
  proof: CandidateProcessGuardProof;
  release(): void;
  /** Rewrite the held lock to a detached supervisor. Missing keeps parent ownership. */
  transferTo?(owner: { pid: number; starttime: string | null }): boolean;
}

/** Environment consumed by the candidate's child-side first-operation guard. */
export function candidateProcessGuardEnv(
  proof: CandidateProcessGuardProof,
  source: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...source,
    [CANDIDATE_PROCESS_GUARD_ENV.required]: "1",
    [CANDIDATE_PROCESS_GUARD_ENV.root]: proof.engineRoot,
    [CANDIDATE_PROCESS_GUARD_ENV.sha]: proof.commitSha,
    [CANDIDATE_PROCESS_GUARD_ENV.readyRecord]: proof.readyRecordPath,
    [CANDIDATE_PROCESS_GUARD_ENV.lockfileDigest]: proof.lockfileDigest,
    [CANDIDATE_PROCESS_GUARD_ENV.processLock]: proof.processLockPath,
    [CANDIDATE_PROCESS_GUARD_ENV.processLockDigest]: proof.processLockDigest,
  };
}

export function hasCandidateProcessGuardEnv(env: NodeJS.ProcessEnv | undefined): boolean {
  return Boolean(
    env?.[CANDIDATE_PROCESS_GUARD_ENV.required] === "1" &&
    env[CANDIDATE_PROCESS_GUARD_ENV.root] &&
    env[CANDIDATE_PROCESS_GUARD_ENV.sha] &&
    env[CANDIDATE_PROCESS_GUARD_ENV.readyRecord] &&
    env[CANDIDATE_PROCESS_GUARD_ENV.lockfileDigest] &&
    env[CANDIDATE_PROCESS_GUARD_ENV.processLock] &&
    env[CANDIDATE_PROCESS_GUARD_ENV.processLockDigest]
  );
}

export interface CandidateEngineConsumerRoute {
  consumer: string;
  gate: "resolve-and-prepare";
  exact_sha: true;
  approved_canonical_root: true;
  sha_lockfile_readiness: true;
  clean_before_bootstrap: true;
  clean_after_bootstrap: true;
  revalidate_before_spawn: true;
  child_side_guard: true;
  /** Executable production boundary used by this consumer. */
  execute<T>(input: CandidateEngineStartInput<T>): Promise<CandidateEngineProcessResult<T>>;
}

const EXPECTED_CANDIDATE_ENGINE_CONSUMERS = [
  "factory-release.pack-loop.start",
  "factory-release.pack-loop.resume",
  "factory-gate.hybrid-v2",
  "ship.stage-adapter",
] as const;
export type CandidateEngineConsumer = (typeof EXPECTED_CANDIDATE_ENGINE_CONSUMERS)[number];
export type CandidateEngineRoute = CandidateEngineConsumer | "pipeline.candidate-leaf";

export const CANDIDATE_ENGINE_CONSUMERS: readonly CandidateEngineConsumerRoute[] =
  EXPECTED_CANDIDATE_ENGINE_CONSUMERS.map((consumer) => ({
    consumer,
    gate: "resolve-and-prepare" as const,
    exact_sha: true as const,
    approved_canonical_root: true as const,
    sha_lockfile_readiness: true as const,
    clean_before_bootstrap: true as const,
    clean_after_bootstrap: true as const,
    revalidate_before_spawn: true as const,
    child_side_guard: true as const,
    execute: <T>(input: CandidateEngineStartInput<T>) =>
      runBoundCandidateEngineProcess(consumer, input),
  }));

export function candidateEngineConsumerInventoryGaps(
  routes: readonly CandidateEngineConsumerRoute[] = CANDIDATE_ENGINE_CONSUMERS,
): string[] {
  const gaps: string[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (seen.has(route.consumer)) gaps.push(`duplicate consumer ${route.consumer}`);
    seen.add(route.consumer);
    if (!(EXPECTED_CANDIDATE_ENGINE_CONSUMERS as readonly string[]).includes(route.consumer)) {
      gaps.push(`unknown consumer ${route.consumer}`);
    }
    for (const proof of [
      "exact_sha",
      "approved_canonical_root",
      "sha_lockfile_readiness",
      "clean_before_bootstrap",
      "clean_after_bootstrap",
      "revalidate_before_spawn",
      "child_side_guard",
    ] as const) {
      if (route[proof] !== true) gaps.push(`${route.consumer} missing ${proof}`);
    }
    if (route.gate !== "resolve-and-prepare") gaps.push(`${route.consumer} bypasses resolve-and-prepare`);
    if (typeof route.execute !== "function") gaps.push(`${route.consumer} missing executable boundary`);
  }
  for (const consumer of EXPECTED_CANDIDATE_ENGINE_CONSUMERS) {
    if (!seen.has(consumer)) gaps.push(`missing consumer ${consumer}`);
  }
  return gaps;
}

export function assertCandidateEngineConsumerInventoryComplete(
  routes: readonly CandidateEngineConsumerRoute[] = CANDIDATE_ENGINE_CONSUMERS,
): void {
  const gaps = candidateEngineConsumerInventoryGaps(routes);
  if (gaps.length) throw new Error(`candidate-engine consumer inventory invalid: ${gaps.join("; ")}`);
}

export function assertCandidateEngineConsumerRoute(consumer: CandidateEngineConsumer): void {
  assertCandidateEngineConsumerInventoryComplete();
  const matches = CANDIDATE_ENGINE_CONSUMERS.filter((route) => route.consumer === consumer);
  if (matches.length !== 1 || matches[0]!.gate !== "resolve-and-prepare") {
    throw new Error(`candidate-engine consumer is not bound exactly once to resolve-and-prepare: ${consumer}`);
  }
}

export function assertCandidateEnginePreparationRoute(route: CandidateEngineRoute): void {
  if (route === "pipeline.candidate-leaf") return;
  assertCandidateEngineConsumerRoute(route);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Collect spawn/exec callees, including `const start = spawn` aliases. */
function candidateProcessStartCallees(source: string): readonly string[] {
  const names = new Set(["spawn", "spawnSync", "execFile", "execFileSync"]);
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]*\.)?(spawn(?:Sync)?|execFile(?:Sync)?)\b/g,
  )) {
    names.add(match[1]!);
  }
  for (const match of source.matchAll(
    /\b(?:spawn(?:Sync)?|execFile(?:Sync)?)\s+as\s+([A-Za-z_$][\w$]*)\b/g,
  )) {
    names.add(match[1]!);
  }
  return [...names];
}

function sourceHasRawCandidateProcessStart(source: string): boolean {
  const callees = candidateProcessStartCallees(source).map(escapeRegExp).join("|");
  return new RegExp(
    String.raw`\b(?:${callees})\s*\(\s*[^,\n;]{0,160}(?:\.launcherPath|candidateInvocation\.executable)\b`,
  ).test(source);
}

/** Discover actual production resolve/start bindings; declarations alone do not satisfy CI. */
export function candidateEngineRuntimeBindingGaps(
  sources: Readonly<Record<string, string>>,
): string[] {
  const resolved = new Set<string>();
  const started = new Set<string>();
  const gaps: string[] = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/resolveAndPrepareCandidateEngine\)?\s*\(\s*\{[\s\S]{0,500}?consumer:\s*["']([^"']+)["']/g)) {
      resolved.add(match[1]!);
    }
    for (const match of source.matchAll(/runCandidateEngineProcess\(\s*\{[\s\S]{0,240}?consumer:\s*["']([^"']+)["']/g)) {
      started.add(match[1]!);
    }
    if (
      file !== "ship-end-candidate.ts" &&
      /\brevalidateCandidateEngineBeforeSpawn\s*\(/.test(source)
    ) {
      gaps.push(`raw parent-only candidate revalidation in ${file}`);
    }
    if (file !== "ship-end-candidate.ts" && sourceHasRawCandidateProcessStart(source)) {
      gaps.push(`raw candidate process start in ${file}`);
    }
  }
  for (const consumer of EXPECTED_CANDIDATE_ENGINE_CONSUMERS) {
    if (!resolved.has(consumer)) gaps.push(`missing production resolve ${consumer}`);
    if (!started.has(consumer)) gaps.push(`missing production start ${consumer}`);
  }
  for (const consumer of started) {
    if (!(EXPECTED_CANDIDATE_ENGINE_CONSUMERS as readonly string[]).includes(consumer)) {
      gaps.push(`unknown production start ${consumer}`);
    }
  }
  for (const consumer of resolved) {
    if (
      consumer !== "pipeline.candidate-leaf" &&
      !(EXPECTED_CANDIDATE_ENGINE_CONSUMERS as readonly string[]).includes(consumer)
    ) {
      gaps.push(`unknown production resolve ${consumer}`);
    }
  }
  return gaps;
}

export type CandidateEngineFailureKind = "identity" | "readiness" | "lock";

export type CandidateEngineResult =
  | { ok: true; engine: CandidateEngine }
  | { ok: false; error: string; kind?: CandidateEngineFailureKind };

export interface ResolveCandidateEngineDeps {
  isDirectory(p: string): boolean;
  fileExists(p: string): boolean;
  /** `git -C cwd rev-parse --verify HEAD` → 40-hex or null. */
  revParseHead(cwd: string): string | null;
  /** `git -C cwd status --porcelain` → "" if clean, non-empty if dirty, null on error. */
  porcelain(cwd: string): string | null;
  /** Optional: `git -C repoDir fetch origin sha`. */
  fetchSha?(repoDir: string, sha: string): boolean;
  /** Optional: `git -C repoDir worktree add --detach dest sha`. */
  worktreeAdd?(repoDir: string, dest: string, sha: string): boolean;
}

function isSafeAbsoluteDir(p: string): boolean {
  if (typeof p !== "string" || !p.trim()) return false;
  if (!path.isAbsolute(p)) return false;
  if (/[\u0000-\u001f]/.test(p)) return false;
  return true;
}

function engineRootOk(
  root: string,
  wantSha: string,
  deps: ResolveCandidateEngineDeps,
): CandidateEngine | null {
  if (!isSafeAbsoluteDir(root)) return null;
  if (!deps.isDirectory(root)) return null;
  if (!deps.fileExists(path.join(root, PIPELINE_TS_REL))) return null;
  const launcherPath = path.join(root, LAUNCHER_REL);
  if (!deps.fileExists(launcherPath)) return null;
  if (!deps.fileExists(path.join(root, CANDIDATE_PROCESS_GUARD_REL))) return null;
  const head = parseExactGitSha(deps.revParseHead(root));
  if (head !== wantSha) return null;
  const porcelain = deps.porcelain(root);
  if (porcelain !== "") return null;
  return { engineRoot: root, launcherPath, commitSha: wantSha };
}

/**
 * Resolve the candidate engine for ship-end verbs. First match wins:
 * 1. clean REPO_DIR HEAD == sha
 * 2. existing .worktrees/ship-candidate-<sha>
 * 3. PIPELINE_CANDIDATE_ENGINE_ROOT (absolute, same checks)
 * 4. create the worktree (fetch + worktree add) when deps allow
 *
 * Never resets operator REPO_DIR HEAD. Never falls back to PATH `pipeline`.
 */
export function resolveCandidateEngine(
  opts: {
    repoDir: string;
    candidateSha: string;
    candidateEngineRootEnv?: string | null;
    consumer: CandidateEngineRoute;
  },
  deps: ResolveCandidateEngineDeps,
): CandidateEngineResult {
  const sha = parseExactGitSha(opts.candidateSha);
  if (!sha) {
    return { ok: false, kind: "identity", error: "candidate SHA is not an exact 40-hex git OID" };
  }
  if (!isSafeAbsoluteDir(opts.repoDir)) {
    return { ok: false, kind: "identity", error: "REPO_DIR must be an absolute directory" };
  }
  const repoDir = path.resolve(opts.repoDir);
  const worktree = path.join(repoDir, ".worktrees", `${CANDIDATE_WORKTREE_PREFIX}${sha}`);
  const explicit = opts.candidateEngineRootEnv?.trim() || "";

  const roots: string[] = [repoDir, worktree];
  if (explicit) {
    if (!isSafeAbsoluteDir(explicit)) {
      return {
        ok: false,
        kind: "identity",
        error: "PIPELINE_CANDIDATE_ENGINE_ROOT must be an absolute directory",
      };
    }
    roots.push(path.resolve(explicit));
  }

  for (const root of roots) {
    const hit = engineRootOk(root, sha, deps);
    if (hit) return { ok: true, engine: hit };
  }

  if (deps.fetchSha && deps.worktreeAdd) {
    if (deps.fetchSha(repoDir, sha) && deps.worktreeAdd(repoDir, worktree, sha)) {
      const hit = engineRootOk(worktree, sha, deps);
      if (hit) return { ok: true, engine: hit };
    }
  }

  return {
    ok: false,
    kind: "identity",
    error:
      `cannot resolve candidate engine at ${sha}: need a clean checkout at that SHA ` +
      `(REPO_DIR, ${worktree}, or PIPELINE_CANDIDATE_ENGINE_ROOT)`,
  };
}

export type ResolveAndPrepareCandidateEngineDeps = ResolveCandidateEngineDeps &
  PrepareCandidateEngineDeps;

/**
 * Shared resolve-and-prepare seam (#1344). Selects an exact-SHA clean root,
 * proves nested-core readiness, revalidates SHA and porcelain, then returns a
 * spawnable engine. Identity-only {@link resolveCandidateEngine} does not
 * authorize spawn.
 */
export async function resolveAndPrepareCandidateEngine(
  opts: {
    repoDir: string;
    candidateSha: string;
    candidateEngineRootEnv?: string | null;
    /** Executable inventory identity checked before any resolution I/O. */
    consumer: CandidateEngineConsumer;
  },
  deps: ResolveAndPrepareCandidateEngineDeps,
): Promise<CandidateEngineResult> {
  assertCandidateEnginePreparationRoute(opts.consumer);
  const resolved = resolveCandidateEngine(opts, deps);
  if (!resolved.ok) return resolved;
  const prepared = await prepareCandidateEngine(resolved.engine, deps as ResolveAndPrepareDeps);
  if (!prepared.ok) return prepared;
  const bindRevalidation = (engine: CandidateEngine): CandidateEngine => ({
    ...engine,
    consumer: opts.consumer,
    revalidateBeforeSpawn: () => {
      const checked = revalidatePreparedCandidateEngineForSpawn(
        engine,
        deps as ResolveAndPrepareDeps,
      );
      if (!checked.ok) return checked;
      return { ok: true, engine: bindRevalidation(checked.engine) };
    },
    acquireProcessLock: () => {
      const stateDir = (deps as ResolveAndPrepareDeps).tmpDir();
      const lockPath = path.join(
        stateDir,
        `pipeline-candidate-process-${createHash("sha256")
          .update(engine.engineRoot)
          .digest("hex")
          .slice(0, 32)}.lock`,
      );
      const d = deps as ResolveAndPrepareDeps;
      // The lock does not exist on the uncontended path, so it cannot be
      // trusted before exclusive creation. Trust the private parent first,
      // then verify the created file before treating it as ownership.
      if (!d.ensureStateDir(stateDir) || !d.statePathTrusted(stateDir)) return null;
      const owner = d.parentIdentity();
      const lockRecord = (holder: { pid: number; starttime: string | null }) =>
        `${JSON.stringify({
          schema: "pipeline-candidate-process-lock/v1",
          engineRoot: engine.engineRoot,
          commitSha: engine.commitSha,
          pid: holder.pid,
          starttime: holder.starttime,
        })}\n`;
      let body = lockRecord(owner);
      if (!d.writeText(lockPath, body, "wx")) {
        try {
          const existing = JSON.parse(d.readText(lockPath) ?? "null") as {
            pid?: unknown;
            starttime?: unknown;
          } | null;
          if (
            !existing ||
            typeof existing.pid !== "number" ||
            d.processAlive(
              existing.pid,
              typeof existing.starttime === "string" ? existing.starttime : null,
            )
          ) return null;
          d.remove(lockPath);
        } catch {
          return null;
        }
        if (!d.writeText(lockPath, body, "wx")) return null;
      }
      if (!d.statePathTrusted(lockPath) || d.readText(lockPath) !== body) return null;
      try {
        const lockfileDigest = d.digest(d.readFile(path.join(engine.engineRoot, CANDIDATE_CORE_LOCKFILE_REL)));
        return {
          proof: {
            engineRoot: engine.engineRoot,
            commitSha: engine.commitSha,
            readyRecordPath: candidateReadyRecordPath(engine.engineRoot, engine.commitSha, stateDir),
            lockfileDigest,
            processLockPath: lockPath,
            processLockDigest: createHash("sha256").update(body).digest("hex"),
          },
          release: () => {
            if (d.statePathTrusted(lockPath) && d.readText(lockPath) === body) {
              d.remove(lockPath);
            }
          },
          transferTo: (nextOwner) => {
            if (!d.statePathTrusted(lockPath) || d.readText(lockPath) !== body) return false;
            const next = lockRecord(nextOwner);
            if (!d.writeText(lockPath, next, "w")) return false;
            if (!d.statePathTrusted(lockPath) || d.readText(lockPath) !== next) return false;
            body = next;
            return true;
          },
        };
      } catch {
        if (d.statePathTrusted(lockPath) && d.readText(lockPath) === body) d.remove(lockPath);
        return null;
      }
    },
  });
  return { ok: true, engine: bindRevalidation(prepared.engine) };
}

export type CandidateEngineProcessResult<T> =
  | { ok: true; value: T; engine: CandidateEngine }
  | { ok: false; error: string; kind?: CandidateEngineFailureKind };

export interface CandidateEngineStartInput<T> {
  engine: CandidateEngine;
  start: (engine: CandidateEngine, childEnv: NodeJS.ProcessEnv) => Promise<T>;
  /**
   * When start() hands off a live detached supervisor, transfer and retain the
   * root lease until that child exits. Awaited starts omit this and release on return.
   */
  detachedSupervisor?: (value: T) => { pid: number; starttime?: string | null } | null;
}

/**
 * The sole candidate-process start boundary. Revalidation happens inside the
 * start operation, after all caller bookkeeping, and the prepared proof is
 * bound to the inventoried consumer before the injected spawn seam is called.
 */
export async function runCandidateEngineProcess<T>(input: {
  consumer: CandidateEngineConsumer;
  engine: CandidateEngine;
  start: (engine: CandidateEngine, childEnv: NodeJS.ProcessEnv) => Promise<T>;
  detachedSupervisor?: (value: T) => { pid: number; starttime?: string | null } | null;
}): Promise<CandidateEngineProcessResult<T>> {
  const route = CANDIDATE_ENGINE_CONSUMERS.find((row) => row.consumer === input.consumer);
  if (!route) {
    assertCandidateEngineConsumerRoute(input.consumer);
    throw new Error(`candidate-engine consumer has no executable boundary: ${input.consumer}`);
  }
  return route.execute({
    engine: input.engine,
    start: input.start,
    detachedSupervisor: input.detachedSupervisor,
  });
}

async function runBoundCandidateEngineProcess<T>(
  consumer: CandidateEngineConsumer,
  input: CandidateEngineStartInput<T>,
): Promise<CandidateEngineProcessResult<T>> {
  assertCandidateEngineConsumerRoute(consumer);
  if (input.engine.consumer !== consumer) {
    return {
      ok: false,
      kind: "identity",
      error: `candidate engine proof belongs to ${input.engine.consumer ?? "no consumer"}, not ${consumer}`,
    };
  }
  const lease = input.engine.acquireProcessLock?.() ?? null;
  if (!lease) {
    return { ok: false, kind: "lock", error: "candidate process-start lock is unavailable" };
  }
  let retainLease = false;
  try {
    const checked = revalidateCandidateEngineBeforeSpawn(input.engine);
    if (!checked.ok) return checked;
    // Invoke the process-start seam in the same turn as the synchronous final
    // check while retaining the shared lease through process completion, or
    // through detached-child lifetime after a verified supervisor handoff.
    const started = input.start(checked.engine, candidateProcessGuardEnv(lease.proof));
    const value = await started;
    const supervisor = input.detachedSupervisor?.(value) ?? null;
    if (supervisor && Number.isInteger(supervisor.pid) && supervisor.pid > 0) {
      if (
        typeof lease.transferTo === "function" &&
        !lease.transferTo({
          pid: supervisor.pid,
          starttime: supervisor.starttime ?? null,
        })
      ) {
        retainLease = true;
        return {
          ok: false,
          kind: "lock",
          error: "failed to transfer candidate lease to detached supervisor",
        };
      }
      retainLease = true;
    }
    return {
      ok: true,
      value,
      engine: checked.engine,
    };
  } finally {
    if (!retainLease) lease.release();
  }
}

/** Consume the prepared proof immediately before an inventoried spawn. */
export function revalidateCandidateEngineBeforeSpawn(
  engine: CandidateEngine,
): CandidateEngineResult {
  if (!engine.revalidateBeforeSpawn) {
    return {
      ok: false,
      kind: "readiness",
      error: "candidate engine has no final pre-spawn revalidation proof",
    };
  }
  const checked = engine.revalidateBeforeSpawn();
  if (!checked.ok) return checked;
  if (
    checked.engine.commitSha !== engine.commitSha ||
    checked.engine.engineRoot !== engine.engineRoot ||
    checked.engine.launcherPath !== engine.launcherPath
  ) {
    return {
      ok: false,
      kind: "identity",
      error: "candidate identity changed during final pre-spawn revalidation",
    };
  }
  return checked;
}

export function defaultResolveAndPrepareDeps(): ResolveAndPrepareCandidateEngineDeps {
  return {
    ...defaultResolveCandidateEngineDeps(),
    ...defaultPrepareCandidateEngineDeps(),
  };
}

/** Production git/fs deps for {@link resolveCandidateEngine}. Tests inject fakes. */
export function defaultResolveCandidateEngineDeps(): ResolveCandidateEngineDeps {
  return {
    isDirectory: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    revParseHead: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "rev-parse", "--verify", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return parseExactGitSha(String(out).trim());
      } catch {
        return null;
      }
    },
    porcelain: (cwd) => {
      try {
        const out = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5_000,
        });
        return String(out);
      } catch {
        return null;
      }
    },
    fetchSha: (dir, sha) => {
      try {
        execFileSync("git", ["-C", dir, "fetch", "--quiet", "origin", sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
    worktreeAdd: (dir, dest, sha) => {
      try {
        execFileSync("git", ["-C", dir, "worktree", "add", "--detach", dest, sha], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function shipEndCliPrefix(
  engine: CandidateEngine,
  nodeBin = "node",
): string[] {
  return [nodeBin, engine.launcherPath];
}

export type ShipEndLeafVerb =
  | "factory-release-prepare"
  | "factory-gate"
  | "release"
  | "release-finish"
  | "ensure-tag";

const BARE_VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Leaf argv after the launcher. Never `ship` / `train`. */
export function shipEndLeafArgv(
  verb: ShipEndLeafVerb,
  args: {
    requestPath?: string;
    version?: string;
    loopRunId?: string;
    pr?: number;
    mergeCommitOid?: string;
    packedCandidate?: string;
  } = {},
): string[] {
  switch (verb) {
    case "factory-release-prepare":
      if (!args.requestPath || !path.isAbsolute(args.requestPath)) {
        throw new Error("factory-release prepare requires an absolute --request path");
      }
      return ["factory-release", "prepare", "--request", args.requestPath, "--json"];
    case "factory-gate":
      if (!args.version || !args.loopRunId) {
        throw new Error("factory-gate requires --for <version> --from-run <id>");
      }
      return ["factory-gate", "--for", args.version, "--from-run", args.loopRunId];
    case "release":
      if (!args.version) throw new Error("release requires a bare X.Y.Z version");
      return ["release", args.version, "--no-edit"];
    case "release-finish":
      if (!args.pr || args.pr <= 0) throw new Error("release finish requires a PR number");
      return ["release", "finish", String(args.pr), "--json"];
    case "ensure-tag": {
      if (!args.version || !BARE_VERSION_RE.test(args.version)) {
        throw new Error("ensure-tag requires a bare X.Y.Z version");
      }
      const oid = parseExactGitSha(args.mergeCommitOid);
      if (!oid) throw new Error("ensure-tag requires a 40-hex merge commit OID");
      const packed = parseExactGitSha(args.packedCandidate);
      if (!packed) throw new Error("ensure-tag requires a 40-hex --packed-candidate");
      return ["release", "ensure-tag", args.version, oid, "--packed-candidate", packed];
    }
    default: {
      const _exhaustive: never = verb;
      throw new Error(`unknown ship-end verb: ${_exhaustive}`);
    }
  }
}

export function assertShipEndLeafArgv(argv: readonly string[]): void {
  if (argv.includes("ship")) {
    throw new Error("ship-end spawn argv must not re-enter pipeline ship --milestone");
  }
  const first = argv.find(
    (a) =>
      a === "train" ||
      a === "factory-release" ||
      a === "factory-gate" ||
      a === "release",
  );
  if (first === "train") {
    throw new Error("ship-end spawn argv must not rerun train");
  }
}

export const FRG_ATTESTATION_KEY_ENV_NAME = "PIPELINE_FRG_ATTESTATION_KEY";
export const FRG_ATTESTATION_KEY_FILE_ENV_NAME = "PIPELINE_FRG_ATTESTATION_KEY_FILE";

export type PresentFrgAttestorCredentialReason =
  | "missing_attestor_credential"
  | "unreadable_attestor_key_file";

export type PresentFrgAttestorCredentialResult =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; reason: PresentFrgAttestorCredentialReason };

export interface PresentFrgAttestorCredentialDeps {
  /** Read KEY_FILE bytes. Throw to signal unreadable. Tests inject. */
  readFile?(path: string): Buffer;
}

function readAttestorKeyFile(
  filePath: string,
  deps?: PresentFrgAttestorCredentialDeps,
): Buffer {
  if (typeof deps?.readFile === "function") return deps.readFile(filePath);
  return fs.readFileSync(filePath);
}

/**
 * Present KEY_FILE as KEY for HMAC-verify children (Tugboat five-branch recipe).
 * Copies `env`; does not mutate the parent.
 */
export function presentFrgAttestorCredential(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): PresentFrgAttestorCredentialResult {
  const next = { ...env };
  const key = next[FRG_ATTESTATION_KEY_ENV_NAME];
  if (typeof key === "string" && key !== "") {
    delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
    return { ok: true, env: next };
  }
  const keyFile = next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  if (typeof keyFile !== "string" || keyFile === "") {
    return { ok: false, reason: "missing_attestor_credential" };
  }
  let body: Buffer;
  try {
    body = readAttestorKeyFile(keyFile, deps);
  } catch {
    return { ok: false, reason: "unreadable_attestor_key_file" };
  }
  if (body.length === 0) {
    return { ok: false, reason: "missing_attestor_credential" };
  }
  // Tugboat KEY="$(cat -- "$KEY_FILE")" drops trailing LF via command substitution.
  next[FRG_ATTESTATION_KEY_ENV_NAME] = body.toString("utf8").replace(/\n+$/, "");
  delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  return { ok: true, env: next };
}

/** Fail closed with the Tugboat named reason. Returns presented KEY. */
export function requirePresentedFrgAttestationKey(
  env: NodeJS.ProcessEnv = process.env,
  deps?: PresentFrgAttestorCredentialDeps,
): string {
  const presented = presentFrgAttestorCredential(env, deps);
  if (!presented.ok) {
    throw new Error(presented.reason);
  }
  const key = presented.env[FRG_ATTESTATION_KEY_ENV_NAME];
  if (typeof key !== "string" || key === "") {
    throw new Error("missing_attestor_credential");
  }
  return key;
}

/** Prepare child: KEY and KEY_FILE unset. Parent env is not mutated. */
export function uncredentialedPrepareEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[FRG_ATTESTATION_KEY_ENV_NAME];
  delete next[FRG_ATTESTATION_KEY_FILE_ENV_NAME];
  return next;
}

/**
 * HMAC-verify child (attestor and ensure-tag): KEY_FILE presented as KEY.
 * Fails closed with a named reason and does not return a spawn env.
 */
export function hmacVerifyChildEnv(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): NodeJS.ProcessEnv {
  const presented = presentFrgAttestorCredential(env, deps);
  if (!presented.ok) {
    throw new Error(presented.reason);
  }
  return presented.env;
}

/** Same recipe as {@link hmacVerifyChildEnv} (attestor spawn). */
export function attestorChildEnv(
  env: NodeJS.ProcessEnv,
  deps?: PresentFrgAttestorCredentialDeps,
): NodeJS.ProcessEnv {
  return hmacVerifyChildEnv(env, deps);
}

export function pinShaDiffersFromCandidate(
  pinCommitSha: string | null,
  candidateSha: string,
): boolean {
  const pin = parseExactGitSha(pinCommitSha);
  const cand = parseExactGitSha(candidateSha);
  if (!cand) return true;
  return pin !== cand;
}

function cliArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

function isDirectResolveAndPrepareCli(): boolean {
  if (!process.argv.includes("--resolve-and-prepare")) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
  } catch {
    return false;
  }
}

/** Pin-side Tugboat invoke. Not a pipeline CLI verb. */
export async function runResolveAndPrepareCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  deps: ResolveAndPrepareCandidateEngineDeps = defaultResolveAndPrepareDeps(),
): Promise<CandidateEngineResult> {
  const repoDir = cliArg(argv, "--repo-dir");
  const sha = cliArg(argv, "--sha");
  if (!repoDir || !sha) {
    return {
      ok: false,
      kind: "identity",
      error: "resolve-and-prepare requires --repo-dir and --sha",
    };
  }
  return resolveAndPrepareCandidateEngine(
    {
      repoDir,
      candidateSha: sha,
      candidateEngineRootEnv: env.PIPELINE_CANDIDATE_ENGINE_ROOT ?? null,
      consumer: "pipeline.candidate-leaf",
    },
    deps,
  );
}

if (isDirectResolveAndPrepareCli()) {
  void runResolveAndPrepareCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 1);
  });
}
