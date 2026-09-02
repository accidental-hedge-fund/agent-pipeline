// Candidate-engine readiness: SHA-plus-lockfile-digest proof and child-safe
// nested-core install (#1344). Locks and records live outside the tracked tree.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatProcessIdentityMarker, getProcessStartTime } from "./lock.ts";
import { parseExactGitSha } from "./ship-end-identity.ts";

const PIPELINE_TS_REL = path.join("core", "scripts", "pipeline.ts");
const LAUNCHER_REL = path.join("scripts", "pipeline-launcher.mjs");

export interface PreparedCandidateEngine {
  engineRoot: string;
  launcherPath: string;
  commitSha: string;
}

export type PreparedCandidateResult =
  | { ok: true; engine: PreparedCandidateEngine }
  | { ok: false; error: string; kind?: "identity" | "readiness" | "lock" };

export interface CandidateRevalidateDeps {
  fileExists(p: string): boolean;
  revParseHead(cwd: string): string | null;
  porcelain(cwd: string): string | null;
}

export const CANDIDATE_CORE_LOCKFILE_REL = path.join("core", "package-lock.json");
export const CANDIDATE_CORE_REL = "core";
export const READY_RECORD_SCHEMA = "pipeline-candidate-readiness/v1";
export const SETUP_LOCK_SCHEMA = "pipeline-candidate-setup-lock/v1";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_HEARTBEAT_STALE_MS = 15_000;
const DEFAULT_WAITER_POLL_MS = 200;
const DEFAULT_WAITER_MAX_MS = 6 * 60 * 1_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1_000;

export interface CandidateSetupLock {
  schema: typeof SETUP_LOCK_SCHEMA;
  engineRoot: string;
  commitSha: string;
  parentPid: number;
  parentStarttime: string | null;
  childPgid: number | null;
  childStarttime: string | null;
  heartbeatAt: number;
}

export interface CandidateReadyRecord {
  schema: typeof READY_RECORD_SCHEMA;
  engineRoot: string;
  commitSha: string;
  lockfileDigest: string;
}

export interface InstallerHandle {
  pgid: number;
  starttime: string | null;
  done: Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface PrepareCandidateEngineDeps {
  readFile(p: string): Buffer;
  readText(p: string): string | null;
  writeText(p: string, body: string, flag: "wx" | "w"): boolean;
  remove(p: string): void;
  digest(buf: Buffer): string;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  tmpDir(): string;
  parentIdentity(): { pid: number; starttime: string | null };
  processAlive(pid: number, starttime: string | null): boolean;
  processGroupAlive(pgid: number): boolean;
  /** Follows symlinks. Null if the root cannot be canonicalized. */
  realpath(root: string): string | null;
  startInstall(opts: { cwd: string; lockfilePath: string }): InstallerHandle;
  heartbeatIntervalMs?: number;
  heartbeatStaleMs?: number;
  waiterPollMs?: number;
  waiterMaxMs?: number;
}

export type ResolveAndPrepareDeps = CandidateRevalidateDeps & PrepareCandidateEngineDeps;

function nestedCoreDir(root: string): string {
  return path.join(root, CANDIDATE_CORE_REL);
}

function nestedLockfilePath(root: string): string {
  return path.join(root, CANDIDATE_CORE_LOCKFILE_REL);
}

/** `root` must already be the injected-realpath canonical checkout. */
export function candidateStateKey(root: string, sha: string): string {
  return createHash("sha256").update(`${path.resolve(root)}\n${sha}`).digest("hex").slice(0, 32);
}

export function candidateSetupLockPath(root: string, sha: string, tmpDir = "/tmp"): string {
  return path.join(tmpDir, `pipeline-candidate-setup-${candidateStateKey(root, sha)}.lock`);
}

export function candidateReadyRecordPath(root: string, sha: string, tmpDir = "/tmp"): string {
  return path.join(tmpDir, `pipeline-candidate-ready-${candidateStateKey(root, sha)}.json`);
}

export function defaultDigest(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function candidateLocalRemediation(root: string): string {
  const coreDir = nestedCoreDir(root);
  return (
    `Run npm ci in ${coreDir} using ${nestedLockfilePath(root)}. ` +
    "Do not run a global package reinstall."
  );
}

function closedError(
  kind: "readiness" | "lock",
  root: string,
  detail: string,
  extra = "",
): PreparedCandidateResult {
  const owner = extra ? ` ${extra}` : "";
  return {
    ok: false,
    kind,
    error:
      `candidate engine at ${root} is not ready: ${detail}.${owner} ` +
      candidateLocalRemediation(root),
  };
}

function parseReadyRecord(raw: string | null): CandidateReadyRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CandidateReadyRecord>;
    if (v.schema !== READY_RECORD_SCHEMA) return null;
    if (typeof v.engineRoot !== "string" || typeof v.commitSha !== "string") return null;
    if (typeof v.lockfileDigest !== "string" || !v.lockfileDigest) return null;
    return {
      schema: READY_RECORD_SCHEMA,
      engineRoot: v.engineRoot,
      commitSha: v.commitSha,
      lockfileDigest: v.lockfileDigest,
    };
  } catch {
    return null;
  }
}

function parseLock(raw: string | null): CandidateSetupLock | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CandidateSetupLock>;
    if (v.schema !== SETUP_LOCK_SCHEMA) return null;
    if (typeof v.engineRoot !== "string" || typeof v.commitSha !== "string") return null;
    if (typeof v.parentPid !== "number" || typeof v.heartbeatAt !== "number") return null;
    return {
      schema: SETUP_LOCK_SCHEMA,
      engineRoot: v.engineRoot,
      commitSha: v.commitSha,
      parentPid: v.parentPid,
      parentStarttime: typeof v.parentStarttime === "string" ? v.parentStarttime : null,
      childPgid: typeof v.childPgid === "number" ? v.childPgid : null,
      childStarttime: typeof v.childStarttime === "string" ? v.childStarttime : null,
      heartbeatAt: v.heartbeatAt,
    };
  } catch {
    return null;
  }
}

function ownerProcessInfo(lock: CandidateSetupLock): string {
  return (
    `owner pid=${lock.parentPid} starttime=${lock.parentStarttime ?? "unknown"} ` +
    `pgid=${lock.childPgid ?? "none"} childStarttime=${lock.childStarttime ?? "unknown"}`
  );
}

function childGroupMayLive(lock: CandidateSetupLock, deps: PrepareCandidateEngineDeps): boolean {
  if (lock.childPgid == null) return false;
  return deps.processGroupAlive(lock.childPgid);
}

function childIdentityUnpublished(lock: CandidateSetupLock): boolean {
  return lock.childPgid == null;
}

function unresolvedChildIdentityError(
  root: string,
  lock: CandidateSetupLock,
): PreparedCandidateResult {
  return closedError(
    "lock",
    root,
    "setup lock is missing installer child identity after owner death; unresolved ownership does not reclaim",
    ownerProcessInfo(lock) + ". Retry only after that process group is gone.",
  );
}

function heartbeatFresh(lock: CandidateSetupLock, deps: PrepareCandidateEngineDeps): boolean {
  const staleMs = deps.heartbeatStaleMs ?? DEFAULT_HEARTBEAT_STALE_MS;
  return deps.nowMs() - lock.heartbeatAt <= staleMs;
}

function revalidateEngine(
  engine: PreparedCandidateEngine,
  deps: CandidateRevalidateDeps,
): PreparedCandidateResult {
  const head = parseExactGitSha(deps.revParseHead(engine.engineRoot));
  if (head !== engine.commitSha) {
    return closedError(
      "readiness",
      engine.engineRoot,
      `post-bootstrap HEAD ${head ?? "unknown"} does not equal ${engine.commitSha}`,
    );
  }
  const porcelain = deps.porcelain(engine.engineRoot);
  if (porcelain !== "") {
    return closedError(
      "readiness",
      engine.engineRoot,
      "post-bootstrap tracked porcelain is not empty",
    );
  }
  if (!deps.fileExists(path.join(engine.engineRoot, PIPELINE_TS_REL))) {
    return closedError("readiness", engine.engineRoot, "pipeline.ts missing after bootstrap");
  }
  if (!deps.fileExists(path.join(engine.engineRoot, LAUNCHER_REL))) {
    return closedError("readiness", engine.engineRoot, "launcher missing after bootstrap");
  }
  return { ok: true, engine };
}

function matchingReady(
  engine: PreparedCandidateEngine,
  digest: string,
  deps: PrepareCandidateEngineDeps,
): boolean {
  const record = parseReadyRecord(
    deps.readText(candidateReadyRecordPath(engine.engineRoot, engine.commitSha, deps.tmpDir())),
  );
  if (!record) return false;
  return record.commitSha === engine.commitSha && record.lockfileDigest === digest;
}

function writeReadyRecord(
  engine: PreparedCandidateEngine,
  digest: string,
  deps: PrepareCandidateEngineDeps,
): void {
  const body: CandidateReadyRecord = {
    schema: READY_RECORD_SCHEMA,
    engineRoot: engine.engineRoot,
    commitSha: engine.commitSha,
    lockfileDigest: digest,
  };
  deps.writeText(
    candidateReadyRecordPath(engine.engineRoot, engine.commitSha, deps.tmpDir()),
    `${JSON.stringify(body)}\n`,
    "w",
  );
}

function writeLock(
  lockPath: string,
  lock: CandidateSetupLock,
  deps: PrepareCandidateEngineDeps,
  flag: "wx" | "w",
): boolean {
  return deps.writeText(lockPath, `${JSON.stringify(lock)}\n`, flag);
}

async function runOwnedInstall(
  engine: PreparedCandidateEngine,
  lockPath: string,
  lockfilePath: string,
  digest: string,
  deps: ResolveAndPrepareDeps,
): Promise<PreparedCandidateResult> {
  const parent = deps.parentIdentity();
  let lock: CandidateSetupLock = {
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: engine.engineRoot,
    commitSha: engine.commitSha,
    parentPid: parent.pid,
    parentStarttime: parent.starttime,
    childPgid: null,
    childStarttime: null,
    heartbeatAt: deps.nowMs(),
  };
  writeLock(lockPath, lock, deps, "w");

  const installer = deps.startInstall({
    cwd: nestedCoreDir(engine.engineRoot),
    lockfilePath,
  });
  lock = {
    ...lock,
    childPgid: installer.pgid,
    childStarttime: installer.starttime,
    heartbeatAt: deps.nowMs(),
  };
  writeLock(lockPath, lock, deps, "w");

  const interval = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let settled: { code: number; stdout: string; stderr: string } | null = null;
  const pending = installer.done.then((r) => {
    settled = r;
  });
  while (settled == null) {
    lock = { ...lock, heartbeatAt: deps.nowMs() };
    writeLock(lockPath, lock, deps, "w");
    await Promise.race([pending, deps.sleep(interval)]);
  }

  if (settled.code !== 0) {
    deps.remove(lockPath);
    const detail =
      `nested-core install failed (exit ${settled.code})` +
      (settled.stderr.trim() ? `: ${settled.stderr.trim().slice(0, 500)}` : "");
    return closedError("readiness", engine.engineRoot, detail);
  }

  const revalidated = revalidateEngine(engine, deps);
  if (!revalidated.ok) {
    deps.remove(lockPath);
    return revalidated;
  }
  writeReadyRecord(engine, digest, deps);
  deps.remove(lockPath);
  return revalidated;
}

async function waitForOwner(
  engine: PreparedCandidateEngine,
  digest: string,
  lockPath: string,
  existing: CandidateSetupLock,
  deps: ResolveAndPrepareDeps,
): Promise<PreparedCandidateResult> {
  const poll = deps.waiterPollMs ?? DEFAULT_WAITER_POLL_MS;
  const maxMs = deps.waiterMaxMs ?? DEFAULT_WAITER_MAX_MS;
  const deadline = deps.nowMs() + maxMs;
  while (deps.nowMs() < deadline) {
    if (matchingReady(engine, digest, deps)) {
      return revalidateEngine(engine, deps);
    }
    const raw = deps.readText(lockPath);
    if (raw == null) {
      if (matchingReady(engine, digest, deps)) return revalidateEngine(engine, deps);
      return closedError(
        "lock",
        engine.engineRoot,
        "setup ownership disappeared without a readiness record",
        ownerProcessInfo(existing) +
          ". Retry only after that process group is gone.",
      );
    }
    const lock = parseLock(raw) ?? existing;
    if (deps.processAlive(lock.parentPid, lock.parentStarttime) || heartbeatFresh(lock, deps)) {
      await deps.sleep(poll);
      continue;
    }
    if (childIdentityUnpublished(lock)) {
      return unresolvedChildIdentityError(engine.engineRoot, lock);
    }
    if (childGroupMayLive(lock, deps)) {
      return closedError(
        "lock",
        engine.engineRoot,
        "setup lock is held by a possibly live installer child; parent death does not reclaim it",
        ownerProcessInfo(lock) + ". Retry only after that process group is gone.",
      );
    }
    return closedError(
      "lock",
      engine.engineRoot,
      "setup lock remains after the prior process group is gone; this call does not reclaim it",
      ownerProcessInfo(lock) + ". Retry after confirming that process group is gone.",
    );
  }
  return closedError(
    "lock",
    engine.engineRoot,
    "timed out waiting for a live candidate setup",
    ownerProcessInfo(existing),
  );
}

/**
 * Prove candidate readiness for an already-selected exact-SHA clean root.
 * Callers must not spawn until this returns ok.
 */
export async function prepareCandidateEngine(
  engine: PreparedCandidateEngine,
  deps: ResolveAndPrepareDeps,
): Promise<PreparedCandidateResult> {
  const lexical = path.resolve(engine.engineRoot);
  const root = deps.realpath(lexical);
  if (!root) {
    return closedError("readiness", lexical, "cannot canonicalize candidate root");
  }
  const prepared: PreparedCandidateEngine = { ...engine, engineRoot: root };
  const lockfilePath = nestedLockfilePath(root);
  if (!deps.fileExists(lockfilePath)) {
    return closedError(
      "readiness",
      root,
      `missing nested ${CANDIDATE_CORE_LOCKFILE_REL}`,
    );
  }
  let lockBytes: Buffer;
  try {
    lockBytes = deps.readFile(lockfilePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return closedError("readiness", root, `unreadable nested lockfile (${msg})`);
  }
  const digest = deps.digest(lockBytes);
  const tmpDir = deps.tmpDir();
  const lockPath = candidateSetupLockPath(root, prepared.commitSha, tmpDir);

  if (matchingReady(prepared, digest, deps)) {
    return revalidateEngine(prepared, deps);
  }

  const parent = deps.parentIdentity();
  const initial: CandidateSetupLock = {
    schema: SETUP_LOCK_SCHEMA,
    engineRoot: root,
    commitSha: prepared.commitSha,
    parentPid: parent.pid,
    parentStarttime: parent.starttime,
    childPgid: null,
    childStarttime: null,
    heartbeatAt: deps.nowMs(),
  };

  if (writeLock(lockPath, initial, deps, "wx")) {
    return runOwnedInstall(prepared, lockPath, lockfilePath, digest, deps);
  }

  const existing = parseLock(deps.readText(lockPath));
  if (!existing) {
    if (matchingReady(prepared, digest, deps)) return revalidateEngine(prepared, deps);
    return closedError(
      "lock",
      root,
      "setup ownership disappeared without a readiness record",
      "Retry only after the prior process group is gone.",
    );
  }

  if (matchingReady(prepared, digest, deps)) {
    return revalidateEngine(prepared, deps);
  }

  if (deps.processAlive(existing.parentPid, existing.parentStarttime)) {
    return waitForOwner(prepared, digest, lockPath, existing, deps);
  }

  if (childIdentityUnpublished(existing)) {
    return unresolvedChildIdentityError(root, existing);
  }

  if (childGroupMayLive(existing, deps)) {
    return closedError(
      "lock",
      root,
      "setup lock is held by a possibly live installer child; parent death does not reclaim it",
      ownerProcessInfo(existing) + ". Retry only after that process group is gone.",
    );
  }

  // Prior group is proven gone: unlink and acquire for this retry.
  deps.remove(lockPath);
  if (writeLock(lockPath, initial, deps, "wx")) {
    return runOwnedInstall(prepared, lockPath, lockfilePath, digest, deps);
  }
  const raced = parseLock(deps.readText(lockPath));
  if (raced && deps.processAlive(raced.parentPid, raced.parentStarttime)) {
    return waitForOwner(prepared, digest, lockPath, raced, deps);
  }
  return closedError(
    "lock",
    root,
    "could not acquire candidate setup after the prior process group was gone",
    raced ? ownerProcessInfo(raced) : "",
  );
}

export function defaultProcessAlive(pid: number, starttime: string | null): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
  }
  if (starttime == null || starttime === "") return true;
  const liveStart = getProcessStartTime(pid);
  if (liveStart == null) return false;
  return liveStart === starttime;
}

export function defaultProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function defaultStartInstall(opts: { cwd: string; lockfilePath: string }): InstallerHandle {
  const child = spawn("npm", ["ci"], {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  const pgid = child.pid ?? 0;
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (pgid > 0) process.kill(-pgid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }, DEFAULT_INSTALL_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
  });
  return {
    pgid,
    starttime: pgid > 0 ? getProcessStartTime(pgid) : null,
    done,
  };
}

export function defaultPrepareCandidateEngineDeps(): PrepareCandidateEngineDeps {
  return {
    readFile: (p) => fs.readFileSync(p),
    readText: (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    writeText: (p, body, flag) => {
      try {
        const fd = fs.openSync(p, flag);
        try {
          fs.writeFileSync(fd, body);
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (flag === "wx" && code === "EEXIST") return false;
        throw err;
      }
    },
    remove: (p) => {
      try {
        fs.unlinkSync(p);
      } catch {
        /* already gone */
      }
    },
    digest: defaultDigest,
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    tmpDir: () => "/tmp",
    parentIdentity: () => {
      const pid = process.pid;
      const marker = formatProcessIdentityMarker(pid);
      const parts = marker.split(" ");
      return { pid, starttime: parts.length > 1 ? parts.slice(1).join(" ") : null };
    },
    processAlive: defaultProcessAlive,
    processGroupAlive: defaultProcessGroupAlive,
    realpath: (root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        return null;
      }
    },
    startInstall: defaultStartInstall,
  };
}
