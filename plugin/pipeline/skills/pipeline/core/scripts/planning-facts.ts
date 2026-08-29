// Planning-facts observation (#1300).
//
// Repositories declare named providers in `.github/pipeline.yml`. The engine
// observes mutable repository state immediately before planning, plan-revision,
// and plan-review. Agent Pipeline stays repository-neutral: repository-specific
// schemas are fixtures, not built-in fact logic.
//
// Security: trusted-base config and executable bytes, argv-only spawn,
// constructed env (no inherited credentials), clean-tree mutation detection.

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
  | "config";

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
}

export interface SpawnProviderRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  timeoutMs: number;
}

export interface SpawnProviderResult {
  exit_code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timed_out: boolean;
  duration_ms: number;
  spawn_error?: boolean;
}

export interface PlanningFactsDeps {
  readTrustedBlob?: (sha: string, repoRelPath: string) => Promise<Buffer | null>;
  resolveIntegrationBaseSha?: () => Promise<string>;
  worktreeSnapshot?: () => Promise<WorktreeSnapshot>;
  spawnProvider?: (req: SpawnProviderRequest) => Promise<SpawnProviderResult>;
  now?: () => Date;
  updateWorktreeOntoBase?: (sha: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  materializeTrustedExecutable?: (bytes: Buffer, basename: string) => string;
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

function defaultMaterializeTrustedExecutable(bytes: Buffer, basename: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-planning-facts-"));
  const dest = path.join(dir, basename.replace(/[^A-Za-z0-9._-]/g, "_") || "provider");
  fs.writeFileSync(dest, bytes, { mode: 0o755 });
  return dest;
}

function defaultSpawnProvider(req: SpawnProviderRequest): Promise<SpawnProviderResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (partial: Omit<SpawnProviderResult, "duration_ms">) => {
      if (settled) return;
      settled = true;
      resolve({ ...partial, duration_ms: Date.now() - start });
    };
    let child: ChildProcess;
    try {
      child = spawn(req.command, req.args, {
        cwd: req.cwd,
        env: req.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 200).unref?.();
      finish({
        exit_code: child.exitCode,
        stdout,
        stderr,
        timed_out: true,
      });
    }, req.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        exit_code: -1,
        stdout,
        stderr: Buffer.concat([stderr, Buffer.from(err.message)]),
        timed_out: false,
        spawn_error: true,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exit_code: code,
        stdout,
        stderr,
        timed_out: false,
      });
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
  executables: Array<{ id: string; bytes: Buffer }>,
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

async function defaultWorktreeSnapshot(worktreeDir: string): Promise<WorktreeSnapshot> {
  const porcelain = await gitInWorktree(worktreeDir, ["status", "--porcelain=v1"], { ignoreFailure: true });
  const head = await gitInWorktree(worktreeDir, ["rev-parse", "HEAD"], { ignoreFailure: true });
  const tree = await gitInWorktree(worktreeDir, ["rev-parse", "HEAD^{tree}"], { ignoreFailure: true });
  return {
    porcelain: porcelain.stdout,
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
  const materialize = deps.materializeTrustedExecutable ?? defaultMaterializeTrustedExecutable;
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

  const execBytes: Array<{ id: string; bytes: Buffer; absPath: string }> = [];
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
    const absPath = materialize(bytes, path.basename(provider.executable));
    execBytes.push({ id: provider.id, bytes, absPath });

    const preSpawn = await snapshotFn();
    if (preSpawn.porcelain.trim().length > 0) {
      return fail("dirty-worktree", "planning worktree is not clean", provider.id, {
        porcelain: preSpawn.porcelain,
      });
    }

    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pf-home-"));
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-pf-tmp-"));
    const env = constructProviderEnv(homeDir, tmpDir);
    const spawned = await spawnFn({
      command: absPath,
      args: [...provider.args],
      cwd: worktreeDir,
      env,
      shell: false,
      timeoutMs: trustedCfg.timeout_ms,
    });

    const post = await snapshotFn();
    const mutated =
      post.head !== preSpawn.head ||
      post.tree !== preSpawn.tree ||
      post.porcelain !== preSpawn.porcelain;
    if (mutated) {
      return fail("mutation", "provider mutated HEAD, tree, or porcelain", provider.id, {
        stdout: truncateUtf8(spawned.stdout, trustedCfg.max_stdout_bytes),
        stderr: truncateUtf8(spawned.stderr, trustedCfg.max_stderr_bytes),
        porcelain: post.porcelain,
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
    execBytes.map((e) => ({ id: e.id, bytes: e.bytes })),
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
