// Planning-facts observation (#1300).
//
// Repositories declare named providers in `.github/pipeline.yml`. The engine
// observes mutable repository state immediately before planning, plan-revision,
// and plan-review. Agent Pipeline stays repository-neutral: repository-specific
// schemas are fixtures, not built-in fact logic.
//
// Security: trusted-base config and source-bundle bytes, argv-only spawn,
// constructed env (no inherited credentials), clean-tree + ignored-path
// mutation detection, cgroup containment of provider descendants.

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTrustedPlanningFactsBlock,
  resolvePlanningFactsConfig,
} from "./config.ts";
import { gitInWorktree } from "./worktree.ts";
import {
  PLANNING_FACTS_PIPELINE_CEILINGS,
  type PipelineConfig,
  type PlanningFactProviderConfig,
  type PlanningFactValueType,
  type PlanningFactsConfig,
} from "./types.ts";

export const PLANNING_FACTS_CONTRACT_TAG = "planning-facts-provider-contract" as const;

export const PLANNING_FACT_CLAIMS_SCHEMA_BLOCK = `{
    "schema_version": 1,
    "claims": [
        { "fact_id": "<id from the current bundle>", "value_digest": "<hex digest from the current bundle>" }
    ]
}`;

const CLAIMS_FIELD_GUARD: Record<"schema_version" | "claims", true> = {
  schema_version: true,
  claims: true,
};
const CLAIM_ENTRY_FIELD_GUARD: Record<"fact_id" | "value_digest", true> = {
  fact_id: true,
  value_digest: true,
};
export const PLANNING_FACT_CLAIMS_SCHEMA_FIELDS = {
  envelope: Object.keys(CLAIMS_FIELD_GUARD),
  claim: Object.keys(CLAIM_ENTRY_FIELD_GUARD),
};

export type PlanningFactsFailureClass =
  | "timeout"
  | "exit"
  | "malformed-json"
  | "undeclared-key"
  | "type"
  | "ceiling"
  | "mutation"
  | "dirty-worktree"
  | "missing-executable"
  | "base-update"
  | "claims"
  | "config"
  | "containment";

export function planningFactsReasonPrefix(
  providerId: string | undefined,
  failureClass: PlanningFactsFailureClass,
): string {
  return providerId
    ? `${PLANNING_FACTS_CONTRACT_TAG}: ${providerId}: ${failureClass}`
    : `${PLANNING_FACTS_CONTRACT_TAG}: ${failureClass}`;
}

export type PlanningFactPrimitive = string | number | boolean;
export type PlanningFactValue = PlanningFactPrimitive | PlanningFactPrimitive[];

export interface PlanningFactRecord {
  id: string;
  provider_id: string;
  required: boolean;
  value?: PlanningFactValue;
  digest?: string;
  unavailable?: { reason: string };
}

export interface PlanningFactBundle {
  repo_id: string;
  integration_base_sha: string;
  worktree_head_sha: string;
  worktree_tree_sha: string;
  providers_digest: string;
  observed_at: string;
  facts: PlanningFactRecord[];
}

export interface PlanningFactsContractFailure {
  ok: false;
  tag: typeof PLANNING_FACTS_CONTRACT_TAG;
  failureClass: PlanningFactsFailureClass;
  reason: string;
  providerId?: string;
  /** Truncated evidence retained for diagnostics. */
  evidence?: {
    stdout?: string;
    stderr?: string;
    porcelain?: string;
    ignored?: string;
    exit_code?: number | null;
    duration_ms?: number;
  };
}

export interface PlanningFactsObservationOk {
  ok: true;
  bundle: PlanningFactBundle;
  /** True when any required provider failed — callers must not invoke the model. */
  block: false;
}

export type PlanningFactsObservation = PlanningFactsObservationOk | PlanningFactsContractFailure;

export interface WorktreeSnapshot {
  head: string;
  tree: string;
  porcelain: string;
  /** Canonical ignored-path state (enumerated files + content identity). */
  ignored: string;
}

export interface SpawnProviderRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface SpawnProviderResult {
  exit_code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timed_out: boolean;
  duration_ms: number;
  spawn_error?: boolean;
  /** True when capture stopped at maxStdoutBytes and the provider was terminated. */
  stdout_exceeded?: boolean;
  /** True when capture stopped at maxStderrBytes and the provider was terminated. */
  stderr_exceeded?: boolean;
  /** True when containment still held descendant PIDs after the direct child closed. */
  descendants_remaining?: boolean;
}

export interface TrustedProviderFile {
  repoRelPath: string;
  bytes: Buffer;
}

export interface ProviderContainment {
  dir?: string;
  addPid: (pid: number) => void;
  remainingPids: () => number[];
  killRemaining: () => void;
  close: () => void;
}

export interface PlanningFactsDeps {
  readTrustedBlob?: (sha: string, repoRelPath: string) => Promise<Buffer | null>;
  listTrustedPrefix?: (sha: string, prefix: string) => Promise<string[]>;
  resolveIntegrationBaseSha?: () => Promise<string>;
  worktreeSnapshot?: () => Promise<WorktreeSnapshot>;
  spawnProvider?: (req: SpawnProviderRequest) => Promise<SpawnProviderResult>;
  now?: () => Date;
  updateWorktreeOntoBase?: (sha: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  materializeTrustedProviderBundle?: (files: TrustedProviderFile[], entryRepoRelPath: string) => string;
  overlayTrustedProviderFiles?: (worktreeDir: string, files: TrustedProviderFile[]) => { restore: () => void };
  mkdirp?: (dir: string) => void;
  previousIntegrationBaseSha?: string;
}

const TRUSTED_PIPELINE_YML = ".github/pipeline.yml";
const ARRAY_ITEM_CAP = 32;
const CLAIMS_FENCE_RE = /```planning-fact-claims\s*\n([\s\S]*?)```/;

export function digestValue(value: PlanningFactValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function requiredFactIdentities(
  bundle: PlanningFactBundle,
): Array<{ id: string; digest: string }> {
  return bundle.facts
    .filter((f) => f.required && f.digest && !f.unavailable)
    .map((f) => ({ id: f.id, digest: f.digest as string }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function requiredFactsChanged(
  previous: PlanningFactBundle | undefined,
  current: PlanningFactBundle,
): boolean {
  const a = previous ? requiredFactIdentities(previous) : [];
  const b = requiredFactIdentities(current);
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].digest !== b[i].digest) return true;
  }
  return false;
}

export function constructProviderEnv(homeDir: string, tmpDir: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    HOME: homeDir,
    TMPDIR: tmpDir,
  };
}

function effectiveCeilings(cfg: PlanningFactsConfig): PlanningFactsConfig {
  const p = PLANNING_FACTS_PIPELINE_CEILINGS;
  return {
    ...cfg,
    timeout_ms: Math.min(cfg.timeout_ms, p.timeout_ms),
    max_stdout_bytes: Math.min(cfg.max_stdout_bytes, p.max_stdout_bytes),
    max_stderr_bytes: Math.min(cfg.max_stderr_bytes, p.max_stderr_bytes),
    max_fact_count: Math.min(cfg.max_fact_count, p.max_fact_count),
    max_key_chars: Math.min(cfg.max_key_chars, p.max_key_chars),
    max_value_chars: Math.min(cfg.max_value_chars, p.max_value_chars),
    max_prompt_chars: Math.min(cfg.max_prompt_chars, p.max_prompt_chars),
  };
}

function fail(
  failureClass: PlanningFactsFailureClass,
  detail: string,
  providerId?: string,
  evidence?: PlanningFactsContractFailure["evidence"],
): PlanningFactsContractFailure {
  const prefix = planningFactsReasonPrefix(providerId, failureClass);
  return {
    ok: false,
    tag: PLANNING_FACTS_CONTRACT_TAG,
    failureClass,
    reason: `${prefix}: ${detail}`,
    providerId,
    evidence,
  };
}

function truncateUtf8(buf: Buffer, maxBytes: number): string {
  if (buf.length <= maxBytes) return buf.toString("utf8");
  return buf.subarray(0, maxBytes).toString("utf8");
}

export function defaultMaterializeTrustedProviderBundle(
  files: TrustedProviderFile[],
  entryRepoRelPath: string,
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-planning-facts-"));
  const providerDir = path.posix.dirname(entryRepoRelPath);
  let entryAbs = "";
  for (const f of files) {
    if (f.repoRelPath.split("/").includes("..") || path.isAbsolute(f.repoRelPath)) {
      throw new Error(`refusing to materialize unsafe path ${f.repoRelPath}`);
    }
    const rel =
      providerDir === "." ? path.posix.basename(f.repoRelPath) : path.posix.relative(providerDir, f.repoRelPath);
    if (!rel || rel.split(/[/\\]/).includes("..")) {
      throw new Error(`refusing to materialize path ${f.repoRelPath} outside provider directory`);
    }
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const mode = f.repoRelPath === entryRepoRelPath ? 0o755 : 0o644;
    fs.writeFileSync(dest, f.bytes, { mode });
    if (f.repoRelPath === entryRepoRelPath) entryAbs = dest;
  }
  if (!entryAbs) {
    throw new Error(`trusted provider bundle is missing entry ${entryRepoRelPath}`);
  }
  return entryAbs;
}

function pathIsInsideRoot(root: string, candidate: string): boolean {
  const rootAbs = path.resolve(root);
  const dest = path.resolve(candidate);
  return dest === rootAbs || dest.startsWith(rootAbs + path.sep);
}

export function defaultOverlayTrustedProviderFiles(
  worktreeDir: string,
  files: TrustedProviderFile[],
): { restore: () => void } {
  const root = path.resolve(worktreeDir);
  const backups: Array<{
    dest: string;
    existed: boolean;
    original?: Buffer;
    mode?: number;
    wrote: Buffer;
  }> = [];
  const createdDirs: string[] = [];
  for (const f of files) {
    if (f.repoRelPath.split("/").includes("..") || path.isAbsolute(f.repoRelPath)) {
      throw new Error(`refusing to overlay unsafe path ${f.repoRelPath}`);
    }
    const dest = path.resolve(root, f.repoRelPath);
    if (!pathIsInsideRoot(root, dest)) {
      throw new Error(`refusing to overlay outside worktree ${f.repoRelPath}`);
    }
    let parent = path.dirname(dest);
    const toCreate: string[] = [];
    while (parent.startsWith(root + path.sep) && !fs.existsSync(parent)) {
      toCreate.push(parent);
      parent = path.dirname(parent);
    }
    for (const d of toCreate.reverse()) {
      fs.mkdirSync(d);
      createdDirs.push(d);
    }
    const existed = fs.existsSync(dest);
    backups.push({
      dest,
      existed,
      original: existed ? fs.readFileSync(dest) : undefined,
      mode: existed ? fs.statSync(dest).mode : undefined,
      wrote: f.bytes,
    });
    fs.writeFileSync(dest, f.bytes, { mode: existed ? backups[backups.length - 1].mode : 0o644 });
  }
  return {
    restore() {
      for (const b of [...backups].reverse()) {
        try {
          if (!fs.existsSync(b.dest)) continue;
          const current = fs.readFileSync(b.dest);
          if (!current.equals(b.wrote)) continue;
          if (b.existed && b.original) {
            fs.writeFileSync(b.dest, b.original, { mode: b.mode });
          } else {
            fs.unlinkSync(b.dest);
          }
        } catch {
          /* leave dest for mutation evidence */
        }
      }
      for (const d of createdDirs.sort((a, b) => b.length - a.length)) {
        try {
          fs.rmdirSync(d);
        } catch {
          /* not empty — mutation evidence */
        }
      }
    },
  };
}

/** Canonical ignored-path state: enumerated paths plus per-file content identity. */
export function canonicalizeIgnoredListing(
  nulSeparated: string,
  readFile: (repoRelPath: string) => Buffer | null,
): string {
  const paths = nulSeparated
    .split("\0")
    .map((p) => p.replace(/^\0/, "").trim())
    .filter((p) => p.length > 0 && !p.split("/").includes("..") && !path.isAbsolute(p))
    .sort();
  const hash = createHash("sha256");
  for (const p of paths) {
    hash.update(p);
    hash.update("\0");
    const buf = readFile(p);
    if (buf) hash.update(buf);
    hash.update("\n");
  }
  return `${paths.join("\n")}\n${hash.digest("hex")}`;
}

export function worktreeSnapshotsDiffer(pre: WorktreeSnapshot, post: WorktreeSnapshot): boolean {
  return (
    post.head !== pre.head ||
    post.tree !== pre.tree ||
    post.porcelain !== pre.porcelain ||
    post.ignored !== pre.ignored
  );
}

const PROVIDER_KILL_GRACE_MS = 200;
const PROVIDER_KILL_FOLLOWUP_MS = 200;

function asBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function appendBounded(current: Buffer, chunk: Buffer, maxBytes: number): { buf: Buffer; exceeded: boolean } {
  if (maxBytes <= 0) return { buf: Buffer.alloc(0), exceeded: true };
  if (current.length >= maxBytes) return { buf: current.subarray(0, maxBytes), exceeded: true };
  const room = maxBytes - current.length;
  if (chunk.length <= room) return { buf: Buffer.concat([current, chunk]), exceeded: false };
  return { buf: Buffer.concat([current, chunk.subarray(0, room)]), exceeded: true };
}

function killProviderProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid != null && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* group missing or process is not a group leader */
    }
  }
  try {
    child.kill(signal);
  } catch {
    /* ignore */
  }
}

export const NOOP_PROVIDER_CONTAINMENT: ProviderContainment = {
  addPid() {},
  remainingPids: () => [],
  killRemaining() {},
  close() {},
};

function selfCgroupV2Dir(): string {
  const text = fs.readFileSync("/proc/self/cgroup", "utf8");
  const line = text.split("\n").find((l) => l.startsWith("0::"));
  if (!line) throw new Error("cgroup v2 not available");
  const rel = line.slice(3).trim();
  return path.join("/sys/fs/cgroup", rel);
}

export function createCgroupContainment(): ProviderContainment {
  const parent = selfCgroupV2Dir();
  const id = `pipeline-pf-${process.pid}-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const dir = path.join(parent, id);
  fs.mkdirSync(dir);
  const readPids = (): number[] => {
    try {
      return fs
        .readFileSync(path.join(dir, "cgroup.procs"), "utf8")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => Number(p))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return [];
    }
  };
  return {
    dir,
    addPid(pid: number) {
      if (pid <= 0) return;
      try {
        fs.writeFileSync(path.join(dir, "cgroup.procs"), String(pid));
      } catch {
        /* process already exited */
      }
    },
    remainingPids: readPids,
    killRemaining() {
      const killFile = path.join(dir, "cgroup.kill");
      try {
        if (fs.existsSync(killFile)) {
          fs.writeFileSync(killFile, "1");
          return;
        }
      } catch {
        /* fall through to per-pid kill */
      }
      for (const pid of readPids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
    close() {
      try {
        fs.rmdirSync(dir);
      } catch {
        /* still busy; leftover empty dirs are host-local */
      }
    },
  };
}

function waitUntilPidInCgroup(pid: number, cgroupDir: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const text = fs.readFileSync(path.join(cgroupDir, "cgroup.procs"), "utf8");
      const pids = text.trim().split(/\s+/).filter(Boolean);
      if (pids.includes(String(pid))) return;
    } catch {
      /* retry */
    }
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) {
      /* admission poll */
    }
  }
  throw new Error(`containment: pid ${pid} was not admitted to ${cgroupDir}`);
}

export async function runPlanningFactsContainmentChild(argv: string[] = process.argv): Promise<void> {
  const flag = argv.indexOf("--containment-child");
  if (flag < 0) {
    throw new Error("containment child missing --containment-child");
  }
  const cgroupDir = argv[flag + 1];
  const dash = argv.indexOf("--", flag + 1);
  if (!cgroupDir || dash < 0 || dash + 1 >= argv.length) {
    throw new Error("containment child argv is malformed");
  }
  const command = argv[dash + 1];
  const args = argv.slice(dash + 2);
  waitUntilPidInCgroup(process.pid, cgroupDir, 1000);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (c) => resolve(c));
  });
  process.exit(code ?? 1);
}

const thisModulePath = fileURLToPath(import.meta.url);

export function planningFactsContainmentArgv(req: SpawnProviderRequest, cgroupDir: string): {
  command: string;
  args: string[];
} {
  const stripTypes = thisModulePath.endsWith(".ts") ? ["--experimental-strip-types"] : [];
  return {
    command: process.execPath,
    args: [
      ...stripTypes,
      thisModulePath,
      "--containment-child",
      cgroupDir,
      "--",
      req.command,
      ...req.args,
    ],
  };
}

function resolveContainment(spawnImpl: typeof spawn): ProviderContainment {
  return spawnImpl === spawn ? createCgroupContainment() : NOOP_PROVIDER_CONTAINMENT;
}

/**
 * Spawn a planning-facts provider with streaming byte caps, cgroup
 * containment, and awaited termination. `spawnImpl` is injectable so tests
 * can drive the real timeout/ceiling wiring without a live subprocess.
 */
export function defaultSpawnProvider(
  req: SpawnProviderRequest,
  spawnImpl: typeof spawn = spawn,
  containmentArg?: ProviderContainment,
): Promise<SpawnProviderResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let containment: ProviderContainment;
    try {
      containment = containmentArg ?? resolveContainment(spawnImpl);
    } catch (err) {
      resolve({
        exit_code: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
        timed_out: false,
        duration_ms: Date.now() - start,
        spawn_error: true,
        descendants_remaining: false,
      });
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutExceeded = false;
    let stderrExceeded = false;
    let timedOut = false;
    let terminating = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let followupTimer: NodeJS.Timeout | undefined;
    const finish = (partial: Omit<SpawnProviderResult, "duration_ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(followupTimer);
      try {
        containment.close();
      } catch {
        /* ignore */
      }
      resolve({ ...partial, duration_ms: Date.now() - start });
    };
    const snapshotResult = (extra: {
      exit_code: number | null;
      timed_out: boolean;
      spawn_error?: boolean;
      descendants_remaining?: boolean;
    }): Omit<SpawnProviderResult, "duration_ms"> => ({
      exit_code: extra.exit_code,
      stdout,
      stderr,
      timed_out: extra.timed_out,
      spawn_error: extra.spawn_error,
      stdout_exceeded: stdoutExceeded,
      stderr_exceeded: stderrExceeded,
      descendants_remaining: extra.descendants_remaining,
    });
    const reapContainment = async (): Promise<boolean> => {
      const remaining = containment.remainingPids();
      // Always send cgroup.kill (or per-pid SIGKILL). A setsid grandchild can
      // sit in the nested cgroup while cgroup.procs looks empty for a tick.
      // The empty-procs short-circuit skipped kill on GitHub Actions (#1300 CI).
      containment.killRemaining();
      const deadline = Date.now() + PROVIDER_KILL_GRACE_MS + PROVIDER_KILL_FOLLOWUP_MS;
      while (Date.now() < deadline && containment.remainingPids().length > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return remaining.length > 0 || containment.remainingPids().length > 0;
    };
    let child: ChildProcess;
    const wrap = spawnImpl === spawn && containment.dir;
    const command = wrap ? process.execPath : req.command;
    const args = wrap ? planningFactsContainmentArgv(req, containment.dir as string).args : req.args;
    try {
      child = spawnImpl(command, args, {
        cwd: req.cwd,
        env: req.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      finish({
        exit_code: -1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
        timed_out: false,
        spawn_error: true,
      });
      return;
    }
    if (child.pid != null && child.pid > 0) {
      containment.addPid(child.pid);
    }
    const beginTerminate = (reason: "timeout" | "ceiling") => {
      if (settled || terminating) return;
      terminating = true;
      if (reason === "timeout") timedOut = true;
      containment.killRemaining();
      killProviderProcess(child, "SIGTERM");
      killTimer = setTimeout(() => {
        containment.killRemaining();
        killProviderProcess(child, "SIGKILL");
        followupTimer = setTimeout(() => {
          try {
            child.stdout?.destroy?.();
            child.stderr?.destroy?.();
          } catch {
            /* ignore */
          }
          void (async () => {
            const descendants_remaining = await reapContainment();
            finish(snapshotResult({ exit_code: child.exitCode, timed_out: timedOut, descendants_remaining }));
          })();
        }, PROVIDER_KILL_FOLLOWUP_MS);
      }, PROVIDER_KILL_GRACE_MS);
    };
    const onChunk = (which: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const max = which === "stdout" ? req.maxStdoutBytes : req.maxStderrBytes;
      const current = which === "stdout" ? stdout : stderr;
      const already = which === "stdout" ? stdoutExceeded : stderrExceeded;
      if (already) return;
      const next = appendBounded(current, asBuffer(chunk), max);
      if (which === "stdout") {
        stdout = next.buf;
        if (next.exceeded) stdoutExceeded = true;
      } else {
        stderr = next.buf;
        if (next.exceeded) stderrExceeded = true;
      }
      if (next.exceeded) beginTerminate("ceiling");
    };
    child.stdout?.on("data", (chunk: Buffer | string) => onChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => onChunk("stderr", chunk));
    timeoutTimer = setTimeout(() => {
      beginTerminate("timeout");
    }, req.timeoutMs);
    child.on("error", (err) => {
      void (async () => {
        const descendants_remaining = await reapContainment();
        finish({
          exit_code: -1,
          stdout,
          stderr: Buffer.concat([stderr, Buffer.from(err.message)]).subarray(0, Math.max(req.maxStderrBytes, 0)),
          timed_out: timedOut,
          spawn_error: true,
          stdout_exceeded: stdoutExceeded,
          stderr_exceeded: stderrExceeded,
          descendants_remaining,
        });
      })();
    });
    child.on("close", (code) => {
      void (async () => {
        const descendants_remaining = await reapContainment();
        finish(snapshotResult({ exit_code: code, timed_out: timedOut, descendants_remaining }));
      })();
    });
  });
}

function matchesDeclaredType(value: unknown, declared: PlanningFactValueType): value is PlanningFactValue {
  const isPrim = (v: unknown, t: "string" | "number" | "boolean"): boolean => typeof v === t;
  if (declared === "string" || declared === "number" || declared === "boolean") {
    return isPrim(value, declared);
  }
  if (!Array.isArray(value)) return false;
  const inner = declared.slice(0, -2) as "string" | "number" | "boolean";
  return value.every((item) => isPrim(item, inner));
}

function isNestedObject(value: unknown): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.some((item) => item !== null && typeof item === "object");
  return typeof value === "object";
}

function canonicalProvidersPayload(
  providers: PlanningFactProviderConfig[],
  executables: Array<{ id: string; bytes: Buffer; helpers?: TrustedProviderFile[] }>,
): Buffer {
  const cfgJson = JSON.stringify(
    providers.map((p) => ({
      id: p.id,
      executable: p.executable,
      args: p.args,
      required: p.required,
      facts: p.facts,
    })),
  );
  const hash = createHash("sha256");
  hash.update(cfgJson);
  for (const exec of [...executables].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(exec.id);
    hash.update(exec.bytes);
    for (const helper of [...(exec.helpers ?? [])].sort((a, b) => a.repoRelPath.localeCompare(b.repoRelPath))) {
      hash.update(helper.repoRelPath);
      hash.update(helper.bytes);
    }
  }
  return hash.digest();
}

export function emptyPlanningFactBundle(
  repoId: string,
  integrationBaseSha: string,
  snapshot: WorktreeSnapshot,
  observedAt: string,
): PlanningFactBundle {
  return {
    repo_id: repoId,
    integration_base_sha: integrationBaseSha,
    worktree_head_sha: snapshot.head,
    worktree_tree_sha: snapshot.tree,
    providers_digest: createHash("sha256").update("[]").digest("hex"),
    observed_at: observedAt,
    facts: [],
  };
}

export function planningFactsSection(
  bundle: PlanningFactBundle | undefined | null,
  opts: { previousIdentities?: Array<{ id: string; digest: string }>; role?: "planner" | "reviewer" | "reviser" } = {},
): string {
  if (!bundle) return "";
  const hasContent = bundle.facts.length > 0;
  if (!hasContent) return "";
  const lines: string[] = [
    "## Planning Facts (engine-observed)",
    "",
    "These values were observed by the engine from trusted repository providers immediately before this invocation. They supersede issue-body, carry-forward, and remembered values for the same keys. Do not replace them with triage-time numbers.",
    "",
    `Provenance: repo=${bundle.repo_id} integration_base=${bundle.integration_base_sha} worktree_head=${bundle.worktree_head_sha} worktree_tree=${bundle.worktree_tree_sha} providers_digest=${bundle.providers_digest} observed_at=${bundle.observed_at}`,
    "",
  ];
  for (const fact of bundle.facts) {
    if (fact.unavailable) {
      lines.push(`- \`${fact.id}\` (provider \`${fact.provider_id}\`, ${fact.required ? "required" : "optional"}): UNAVAILABLE — ${fact.unavailable.reason}`);
    } else {
      lines.push(
        `- \`${fact.id}\` (provider \`${fact.provider_id}\`, ${fact.required ? "required" : "optional"}): ${JSON.stringify(fact.value)} digest=${fact.digest}`,
      );
    }
  }
  lines.push("");
  lines.push("Engine-verified claims MUST use the typed claims artifact below. Prose such as \"verified by ls\" is not engine-verified. A claim is engine-verified only when it names a fact id from this bundle with the current value digest.");
  if (opts.role === "reviewer") {
    lines.push("Treat unmatched prose verification as untrusted.");
  }
  if (opts.previousIdentities && opts.previousIdentities.length > 0) {
    const current = requiredFactIdentities(bundle);
    lines.push("");
    lines.push("Required fact identities changed since the plan was bound. Revise the plan against the current bundle; do not send the stale plan to review.");
    lines.push(`Previous: ${JSON.stringify(opts.previousIdentities)}`);
    lines.push(`Current: ${JSON.stringify(current)}`);
  }
  if (opts.role !== "reviewer") {
    lines.push("");
    lines.push("If you assert an engine-verified fact, emit this artifact (and only this envelope) in a `planning-fact-claims` fence. Missing claims mean no engine-verified facts. Malformed claims fail closed.");
    lines.push("");
    lines.push("```planning-fact-claims");
    lines.push(PLANNING_FACT_CLAIMS_SCHEMA_BLOCK);
    lines.push("```");
  }
  return "\n\n" + lines.join("\n");
}

export interface PlanningFactClaim {
  fact_id: string;
  value_digest: string;
  engine_verified: boolean;
}

export type ClaimsExtraction =
  | { ok: true; claims: PlanningFactClaim[]; missing: true }
  | { ok: true; claims: PlanningFactClaim[]; missing: false }
  | { ok: false; tag: typeof PLANNING_FACTS_CONTRACT_TAG; reason: string };

export function extractPlanningFactClaims(
  stdout: string,
  bundle: PlanningFactBundle,
): ClaimsExtraction {
  const factsSupplied = bundle.facts.length > 0;
  if (!factsSupplied) {
    return { ok: true, claims: [], missing: true };
  }
  const match = CLAIMS_FENCE_RE.exec(stdout);
  if (!match) {
    return { ok: true, claims: [], missing: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return {
      ok: false,
      tag: PLANNING_FACTS_CONTRACT_TAG,
      reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not valid JSON`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      tag: PLANNING_FACTS_CONTRACT_TAG,
      reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not a JSON object`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => k !== "schema_version" && k !== "claims");
  if (extra.length > 0 || obj.schema_version !== 1 || !Array.isArray(obj.claims)) {
    return {
      ok: false,
      tag: PLANNING_FACTS_CONTRACT_TAG,
      reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not valid versioned claims JSON`,
    };
  }
  const current = new Map(
    bundle.facts.filter((f) => f.digest && !f.unavailable).map((f) => [f.id, f.digest as string]),
  );
  const claims: PlanningFactClaim[] = [];
  for (const entry of obj.claims) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return {
        ok: false,
        tag: PLANNING_FACTS_CONTRACT_TAG,
        reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not valid versioned claims JSON`,
      };
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec.fact_id !== "string" || typeof rec.value_digest !== "string") {
      return {
        ok: false,
        tag: PLANNING_FACTS_CONTRACT_TAG,
        reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not valid versioned claims JSON`,
      };
    }
    const extraEntry = Object.keys(rec).filter((k) => k !== "fact_id" && k !== "value_digest");
    if (extraEntry.length > 0) {
      return {
        ok: false,
        tag: PLANNING_FACTS_CONTRACT_TAG,
        reason: `${planningFactsReasonPrefix(undefined, "claims")}: claims artifact is not valid versioned claims JSON`,
      };
    }
    const digest = current.get(rec.fact_id);
    claims.push({
      fact_id: rec.fact_id,
      value_digest: rec.value_digest,
      engine_verified: digest !== undefined && digest === rec.value_digest,
    });
  }
  return { ok: true, claims, missing: false };
}

function parseProviderStdout(
  provider: PlanningFactProviderConfig,
  stdout: Buffer,
  stderr: Buffer,
  ceilings: PlanningFactsConfig,
):
  | { ok: true; facts: Array<{ id: string; value: PlanningFactValue; digest: string }> }
  | PlanningFactsContractFailure {
  if (stdout.length > ceilings.max_stdout_bytes) {
    return fail("ceiling", `stdout exceeded ${ceilings.max_stdout_bytes} bytes`, provider.id, {
      stdout: truncateUtf8(stdout, ceilings.max_stdout_bytes),
      stderr: truncateUtf8(stderr, ceilings.max_stderr_bytes),
    });
  }
  if (stderr.length > ceilings.max_stderr_bytes) {
    return fail("ceiling", `stderr exceeded ${ceilings.max_stderr_bytes} bytes`, provider.id, {
      stdout: truncateUtf8(stdout, ceilings.max_stdout_bytes),
      stderr: truncateUtf8(stderr, ceilings.max_stderr_bytes),
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.toString("utf8"));
  } catch {
    return fail("malformed-json", "stdout is not JSON", provider.id, {
      stdout: truncateUtf8(stdout, ceilings.max_stdout_bytes),
      stderr: truncateUtf8(stderr, ceilings.max_stderr_bytes),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("malformed-json", "stdout is not a JSON object", provider.id);
  }
  const obj = parsed as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => k !== "schema_version" && k !== "facts");
  if (obj.schema_version !== 1 || extra.length > 0) {
    return fail("malformed-json", "stdout is not versioned { schema_version: 1, facts } JSON", provider.id);
  }
  if (!obj.facts || typeof obj.facts !== "object" || Array.isArray(obj.facts)) {
    return fail("malformed-json", "facts must be an object", provider.id);
  }
  const factsObj = obj.facts as Record<string, unknown>;
  const declared = provider.facts;
  const out: Array<{ id: string; value: PlanningFactValue; digest: string }> = [];
  for (const key of Object.keys(factsObj)) {
    if (!(key in declared)) {
      return fail("undeclared-key", `undeclared fact key ${JSON.stringify(key)}`, provider.id);
    }
    if (key.length > ceilings.max_key_chars) {
      return fail("ceiling", `fact key exceeds ${ceilings.max_key_chars} chars`, provider.id);
    }
    const value = factsObj[key];
    if (isNestedObject(value) && !Array.isArray(value)) {
      return fail("type", `nested object is not allowed for ${JSON.stringify(key)}`, provider.id);
    }
    if (value === null) {
      return fail("type", `null is not allowed for ${JSON.stringify(key)}`, provider.id);
    }
    const declaredType = declared[key];
    if (!matchesDeclaredType(value, declaredType)) {
      return fail("type", `fact ${JSON.stringify(key)} is not ${declaredType}`, provider.id);
    }
    if (Array.isArray(value)) {
      if (value.length > ARRAY_ITEM_CAP) {
        return fail("ceiling", `fact ${JSON.stringify(key)} array exceeds ${ARRAY_ITEM_CAP} items`, provider.id);
      }
      for (const item of value) {
        if (String(item).length > ceilings.max_value_chars) {
          return fail("ceiling", `fact ${JSON.stringify(key)} item exceeds ${ceilings.max_value_chars} chars`, provider.id);
        }
      }
    } else if (typeof value === "string" && value.length > ceilings.max_value_chars) {
      return fail("ceiling", `fact ${JSON.stringify(key)} exceeds ${ceilings.max_value_chars} chars`, provider.id);
    }
    out.push({ id: key, value, digest: digestValue(value) });
  }
  for (const key of Object.keys(declared)) {
    if (!out.some((f) => f.id === key)) {
      return fail("type", `declared fact ${JSON.stringify(key)} is missing`, provider.id);
    }
  }
  return { ok: true, facts: out };
}

async function defaultReadTrustedBlob(
  cfg: PipelineConfig,
  sha: string,
  repoRelPath: string,
): Promise<Buffer | null> {
  const r = await gitInWorktree(cfg.repo_dir, ["show", `${sha}:${repoRelPath}`], { ignoreFailure: true });
  if (r.code !== 0) return null;
  return Buffer.from(r.stdout);
}

async function defaultResolveIntegrationBaseSha(cfg: PipelineConfig): Promise<string> {
  const r = await gitInWorktree(cfg.repo_dir, ["rev-parse", `origin/${cfg.base_branch}`], {
    ignoreFailure: true,
  });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !sha) {
    throw new Error(`failed to resolve origin/${cfg.base_branch}`);
  }
  return sha;
}

async function defaultListTrustedPrefix(
  cfg: PipelineConfig,
  sha: string,
  prefix: string,
): Promise<string[]> {
  if (!prefix || prefix === "." || prefix.split("/").includes("..") || path.isAbsolute(prefix)) {
    return [];
  }
  const r = await gitInWorktree(cfg.repo_dir, ["ls-tree", "-r", "--name-only", sha, "--", prefix], {
    ignoreFailure: true,
  });
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.split("/").includes(".."));
}

async function defaultWorktreeSnapshot(worktreeDir: string): Promise<WorktreeSnapshot> {
  const porcelain = await gitInWorktree(worktreeDir, ["status", "--porcelain=v1"], { ignoreFailure: true });
  const ignoredList = await gitInWorktree(
    worktreeDir,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
    { ignoreFailure: true },
  );
  const head = await gitInWorktree(worktreeDir, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const tree = await gitInWorktree(worktreeDir, ["rev-parse", "HEAD^{tree}"], { ignoreFailure: true });
  const ignored = canonicalizeIgnoredListing(ignoredList.stdout, (repoRelPath) => {
    try {
      const abs = path.resolve(worktreeDir, repoRelPath);
      if (!pathIsInsideRoot(worktreeDir, abs)) return null;
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  });
  return {
    porcelain: porcelain.stdout,
    ignored,
    head: head.stdout.trim(),
    tree: tree.stdout.trim(),
  };
}

async function defaultUpdateWorktreeOntoBase(
  worktreeDir: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const merge = await gitInWorktree(worktreeDir, ["merge", "--no-edit", sha], { ignoreFailure: true });
  if (merge.code !== 0) {
    return { ok: false, reason: merge.stderr.trim() || merge.stdout.trim() || "git merge failed" };
  }
  return { ok: true };
}

export interface ObservePlanningFactsArgs {
  cfg: PipelineConfig;
  worktreeDir: string;
  deps?: PlanningFactsDeps;
}

/**
 * Observe planning facts for one model invocation. Empty providers is a no-op
 * (no spawn, no section, no block). Required provider contract failure returns
 * `{ ok: false }` so the caller skips the model.
 */
export async function observePlanningFacts(
  args: ObservePlanningFactsArgs,
): Promise<PlanningFactsObservation> {
  const { cfg, worktreeDir } = args;
  const deps = args.deps ?? {};
  const now = deps.now ?? (() => new Date());
  const readBlob =
    deps.readTrustedBlob ?? ((sha, p) => defaultReadTrustedBlob(cfg, sha, p));
  const resolveSha = deps.resolveIntegrationBaseSha ?? (() => defaultResolveIntegrationBaseSha(cfg));
  const snapshotFn = deps.worktreeSnapshot ?? (() => defaultWorktreeSnapshot(worktreeDir));
  const spawnFn = deps.spawnProvider ?? defaultSpawnProvider;
  const listPrefix =
    deps.listTrustedPrefix ?? ((sha: string, prefix: string) => defaultListTrustedPrefix(cfg, sha, prefix));
  const materialize = deps.materializeTrustedProviderBundle ?? defaultMaterializeTrustedProviderBundle;
  const overlayFiles = deps.overlayTrustedProviderFiles ?? defaultOverlayTrustedProviderFiles;
  const updateBase =
    deps.updateWorktreeOntoBase ?? ((sha: string) => defaultUpdateWorktreeOntoBase(worktreeDir, sha));

  let integrationBaseSha: string;
  try {
    integrationBaseSha = await resolveSha();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail("base-update", `failed to resolve integration-base SHA: ${message}`);
  }

  if (deps.previousIntegrationBaseSha && deps.previousIntegrationBaseSha !== integrationBaseSha) {
    const updated = await updateBase(integrationBaseSha);
    if (!updated.ok) {
      return fail("base-update", updated.reason);
    }
  }

  const yamlBlob = await readBlob(integrationBaseSha, TRUSTED_PIPELINE_YML);
  if (!yamlBlob) {
    const snap = await snapshotFn();
    return {
      ok: true,
      block: false,
      bundle: emptyPlanningFactBundle(cfg.repo, integrationBaseSha, snap, now().toISOString()),
    };
  }
  const parsed = parseTrustedPlanningFactsBlock(yamlBlob.toString("utf8"));
  if (!parsed.ok) {
    return fail("config", parsed.error);
  }
  const trustedCfg = effectiveCeilings(parsed.config);
  if (trustedCfg.providers.length === 0) {
    const snap = await snapshotFn();
    return {
      ok: true,
      block: false,
      bundle: emptyPlanningFactBundle(cfg.repo, integrationBaseSha, snap, now().toISOString()),
    };
  }

  const pre = await snapshotFn();
  if (pre.porcelain.trim().length > 0) {
    return fail("dirty-worktree", "planning worktree is not clean", undefined, {
      porcelain: pre.porcelain,
    });
  }

  const execBytes: Array<{ id: string; bytes: Buffer; helpers: TrustedProviderFile[] }> = [];
  const facts: PlanningFactRecord[] = [];

  for (const provider of trustedCfg.providers) {
    const bytes = await readBlob(integrationBaseSha, provider.executable);
    if (!bytes) {
      if (provider.required) {
        return fail("missing-executable", `trusted executable ${provider.executable} is absent at ${integrationBaseSha}`, provider.id);
      }
      for (const id of Object.keys(provider.facts)) {
        facts.push({
          id,
          provider_id: provider.id,
          required: false,
          unavailable: { reason: `missing-executable: ${provider.executable}` },
        });
      }
      continue;
    }
    const bundleFiles: TrustedProviderFile[] = [{ repoRelPath: provider.executable, bytes }];
    const providerDir = path.posix.dirname(provider.executable);
    if (providerDir !== ".") {
      const names = await listPrefix(integrationBaseSha, providerDir);
      for (const name of names) {
        if (name === provider.executable) continue;
        if (name.split("/").includes("..") || path.isAbsolute(name)) continue;
        const helperBytes = await readBlob(integrationBaseSha, name);
        if (helperBytes) bundleFiles.push({ repoRelPath: name, bytes: helperBytes });
      }
    }
    let absPath: string;
    try {
      absPath = materialize(bundleFiles, provider.executable);
    } catch (err) {
      return fail(
        "missing-executable",
        err instanceof Error ? err.message : String(err),
        provider.id,
      );
    }
    execBytes.push({
      id: provider.id,
      bytes,
      helpers: bundleFiles.filter((f) => f.repoRelPath !== provider.executable),
    });

    const preSpawn = await snapshotFn();
    if (preSpawn.porcelain.trim().length > 0) {
      return fail("dirty-worktree", "planning worktree is not clean", provider.id, {
        porcelain: preSpawn.porcelain,
        ignored: preSpawn.ignored,
      });
    }

    let restoreOverlay = (): void => {};
    try {
      restoreOverlay = overlayFiles(worktreeDir, bundleFiles).restore;
    } catch (err) {
      return fail(
        "missing-executable",
        err instanceof Error ? err.message : String(err),
        provider.id,
      );
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pf-home-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pf-tmp-"));
    const env = constructProviderEnv(homeDir, tmpDir);
    let spawned;
    try {
      spawned = await spawnFn({
        command: absPath,
        args: [...provider.args],
        cwd: worktreeDir,
        env,
        shell: false,
        timeoutMs: trustedCfg.timeout_ms,
        maxStdoutBytes: trustedCfg.max_stdout_bytes,
        maxStderrBytes: trustedCfg.max_stderr_bytes,
      });
    } finally {
      try {
        restoreOverlay();
      } catch {
        /* keep overlay leftovers as mutation evidence */
      }
    }

    const post = await snapshotFn();
    if (worktreeSnapshotsDiffer(preSpawn, post)) {
      return fail("mutation", "provider mutated HEAD, tree, porcelain, or ignored paths", provider.id, {
        stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
        stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
        porcelain: post.porcelain,
        ignored: post.ignored,
        exit_code: spawned.exit_code,
        duration_ms: spawned.duration_ms,
      });
    }
    if (spawned.descendants_remaining) {
      return fail("containment", "escaped descendants remained after provider exit", provider.id, {
        stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
        stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
        porcelain: post.porcelain,
        ignored: post.ignored,
        exit_code: spawned.exit_code,
        duration_ms: spawned.duration_ms,
      });
    }

    if (spawned.timed_out) {
      if (provider.required) {
        return fail("timeout", `exceeded ${trustedCfg.timeout_ms}ms`, provider.id, {
          stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
          stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
          duration_ms: spawned.duration_ms,
        });
      }
      for (const id of Object.keys(provider.facts)) {
        facts.push({
          id,
          provider_id: provider.id,
          required: false,
          unavailable: { reason: `timeout: exceeded ${trustedCfg.timeout_ms}ms` },
        });
      }
      continue;
    }

    if (spawned.stdout_exceeded || spawned.stderr_exceeded) {
      const which = spawned.stdout_exceeded ? "stdout" : "stderr";
      const limit = spawned.stdout_exceeded ? trustedCfg.max_stdout_bytes : trustedCfg.max_stderr_bytes;
      if (provider.required) {
        return fail("ceiling", `${which} exceeded ${limit} bytes`, provider.id, {
          stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
          stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
          exit_code: spawned.exit_code,
          duration_ms: spawned.duration_ms,
        });
      }
      for (const id of Object.keys(provider.facts)) {
        facts.push({
          id,
          provider_id: provider.id,
          required: false,
          unavailable: { reason: `ceiling: ${which} exceeded ${limit} bytes` },
        });
      }
      continue;
    }

    if (spawned.spawn_error || spawned.exit_code !== 0) {
      const cls: PlanningFactsFailureClass = spawned.spawn_error ? "missing-executable" : "exit";
      if (provider.required) {
        return fail(cls, `exit ${spawned.exit_code}`, provider.id, {
          stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
          stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
          exit_code: spawned.exit_code,
          duration_ms: spawned.duration_ms,
        });
      }
      for (const id of Object.keys(provider.facts)) {
        facts.push({
          id,
          provider_id: provider.id,
          required: false,
          unavailable: { reason: `${cls}: exit ${spawned.exit_code}` },
        });
      }
      continue;
    }

    const parsedOut = parseProviderStdout(provider, spawned.stdout, spawned.stderr, trustedCfg);
    if (!parsedOut.ok) {
      if (provider.required) return parsedOut;
      for (const id of Object.keys(provider.facts)) {
        facts.push({
          id,
          provider_id: provider.id,
          required: false,
          unavailable: { reason: parsedOut.reason },
        });
      }
      continue;
    }
    for (const f of parsedOut.facts) {
      facts.push({
        id: f.id,
        provider_id: provider.id,
        required: provider.required,
        value: f.value,
        digest: f.digest,
      });
    }
  }

  const successful = facts.filter((f) => !f.unavailable);
  if (successful.length > trustedCfg.max_fact_count) {
    return fail("ceiling", `combined fact count ${successful.length} exceeds ${trustedCfg.max_fact_count}`);
  }

  const providersDigest = canonicalProvidersPayload(
    trustedCfg.providers,
    execBytes.map((e) => ({ id: e.id, bytes: e.bytes, helpers: e.helpers })),
  ).toString("hex");
  const postSnap = await snapshotFn();
  const bundle: PlanningFactBundle = {
    repo_id: cfg.repo,
    integration_base_sha: integrationBaseSha,
    worktree_head_sha: postSnap.head,
    worktree_tree_sha: postSnap.tree,
    providers_digest: providersDigest,
    observed_at: now().toISOString(),
    facts,
  };
  const section = planningFactsSection(bundle);
  if (section.length > trustedCfg.max_prompt_chars) {
    return fail("ceiling", `prompt contribution ${section.length} exceeds ${trustedCfg.max_prompt_chars}`);
  }
  return { ok: true, block: false, bundle };
}

/** True when the observation must skip the model invoke. */
export function isRequiredPlanningFactsBlock(
  observation: PlanningFactsObservation,
): observation is PlanningFactsContractFailure {
  return observation.ok === false;
}

export { resolvePlanningFactsConfig };

const launchedAsContainmentChild =
  process.argv[2] === "--containment-child" &&
  path.resolve(process.argv[1] ?? "") === path.resolve(thisModulePath);
if (launchedAsContainmentChild) {
  void runPlanningFactsContainmentChild(process.argv);
}
