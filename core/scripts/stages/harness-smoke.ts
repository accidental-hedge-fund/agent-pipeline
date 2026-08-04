// Role-aware, treatment-exact dynamic harness smoke (#780).
//
// Opt-in via `pipeline doctor --harness-smoke`. For each unique configured
// {adapter, role, model, effort} coordinate, runs:
//   1. adapter-declared runtimeSmoke / readiness (no model call when possible)
//   2. a cheap role-shaped canned prompt in a throwaway scratch git repo
// and asserts implementer vs reviewer contracts (trailers + mutation vs
// read-only verdict). Unit tests inject HarnessSmokeDeps — no real
// network/git/subprocess in the unit suite. Live I/O lives only in
// realHarnessSmokeDeps().

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PipelineConfig } from "../types.ts";
import {
  materializeCompatibilityAdapter,
  resolveAdapter,
} from "../harness-adapters/index.ts";
import type {
  AdapterPreflightDeps,
  AdapterPreflightResult,
  AdapterRole,
  HarnessAdapter,
  HarnessTelemetry,
} from "../harness-adapters/types.ts";
import { isJsonRecord, parseJsonLine } from "../harness-adapters/types.ts";
import {
  HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID,
  HARNESS_SMOKE_REVIEWER_CONTRACT_ID,
  validateStageOutput,
  type ContractValidateResult,
} from "../stage-output-contract.ts";
import { ISSUE_TRAILER_KEY, RUN_TRAILER_KEY } from "../traceability.ts";
import { invoke, type HarnessResult } from "../harness.ts";
import type { CheckOutcome, CheckResult, DoctorDeps } from "./doctor.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Throwaway trailer values used only inside scratch smoke repos. */
export const SMOKE_ISSUE_TRAILER = `${ISSUE_TRAILER_KEY}: #0`;
export const SMOKE_RUN_TRAILER = `${RUN_TRAILER_KEY}: harness-smoke/0`;

/** Contract ids the smoke path asserts — drift-guarded in unit tests. */
export const HARNESS_SMOKE_CONTRACT_IDS = {
  implementer: HARNESS_SMOKE_IMPLEMENTER_CONTRACT_ID,
  reviewer: HARNESS_SMOKE_REVIEWER_CONTRACT_ID,
} as const;

/** Default wall-clock timeout for one canned smoke spawn (seconds). */
export const HARNESS_SMOKE_TIMEOUT_SEC = 180;

// ---------------------------------------------------------------------------
// Treatment plan
// ---------------------------------------------------------------------------

export type SmokeRole = AdapterRole;

export interface SmokeTreatment {
  adapter: string;
  role: SmokeRole;
  /** Resolved model when configured; omitted when unset (no ambient default invented). */
  model?: string;
  /** Resolved effort when configured; omitted when unset. */
  effort?: string;
}

export function treatmentKey(t: SmokeTreatment): string {
  return [
    t.adapter,
    t.role,
    t.model ?? "",
    t.effort ?? "",
  ].join("\0");
}

export function treatmentLabel(t: SmokeTreatment): string {
  const parts = [t.adapter, t.role];
  if (t.model) parts.push(`model=${t.model}`);
  if (t.effort) parts.push(`effort=${t.effort}`);
  return parts.join("/");
}

export function smokeCheckId(t: SmokeTreatment): string {
  // Stable, human-readable id for doctor summary / --json
  const bits = ["harness-smoke", t.adapter, t.role];
  if (t.model) bits.push(t.model);
  if (t.effort) bits.push(t.effort);
  return bits.join(":");
}

/**
 * Build the unique configured treatment plan from active config.
 * Includes built-in and externally registered adapters when assigned.
 * Unassigned registered adapters are omitted. Duplicate coordinates collapse.
 */
export function buildSmokePlan(config: PipelineConfig): SmokeTreatment[] {
  const seen = new Set<string>();
  const plan: SmokeTreatment[] = [];

  const push = (t: SmokeTreatment) => {
    const k = treatmentKey(t);
    if (seen.has(k)) return;
    seen.add(k);
    plan.push(t);
  };

  const implementer = config.harnesses.implementer;
  if (implementer) {
    // Role-level + stage-distinct model/effort pairs used with the implementer
    // adapter (planning / implementing / fix / intake / sweep).
    const implStages: Array<{ model?: string; effort?: string }> = [
      { model: config.models.implementing, effort: config.effort.implementing },
      { model: config.models.planning, effort: config.effort.planning },
      { model: config.models.fix, effort: config.effort.fix },
      { model: config.models.intake, effort: config.effort.intake },
      { model: config.models.sweep, effort: config.effort.sweep },
    ];
    for (const s of implStages) {
      push({
        adapter: implementer,
        role: "implementer",
        ...(s.model ? { model: s.model } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
      });
    }
  }

  const reviewer = config.harnesses.reviewer;
  if (reviewer) {
    const reviewModel =
      config.harnesses.reviewerModel ?? config.models.review;
    const reviewEffort =
      config.harnesses.reviewerEffort ?? config.effort.review;
    push({
      adapter: reviewer,
      role: "reviewer",
      ...(reviewModel ? { model: reviewModel } : {}),
      ...(reviewEffort ? { effort: reviewEffort } : {}),
    });
    // Plan-review uses the reviewer role with plan_review_effort when distinct.
    if (config.plan_review_effort && config.plan_review_effort !== reviewEffort) {
      push({
        adapter: reviewer,
        role: "reviewer",
        ...(reviewModel ? { model: reviewModel } : {}),
        effort: config.plan_review_effort,
      });
    }
  }

  return plan;
}

// ---------------------------------------------------------------------------
// Canned prompts
// ---------------------------------------------------------------------------

export function implementerSmokePrompt(): string {
  return [
    "You are running a cheap harness readiness smoke in a throwaway git repository.",
    "Do exactly the following and nothing else:",
    "1. Create or overwrite a single file named SMOKE.md containing one short line of text.",
    "2. Stage and commit it with a commit message whose body includes these exact git trailers",
    "   on their own lines after a blank line (standard git trailer format):",
    `   ${SMOKE_ISSUE_TRAILER}`,
    `   ${SMOKE_RUN_TRAILER}`,
    "3. Print ONLY a JSON object (no surrounding prose) of the form:",
    '   {"ok":true,"smoke":"implementer"}',
    "Do not push, do not create branches, do not modify files other than SMOKE.md.",
  ].join("\n");
}

export function reviewerSmokePrompt(): string {
  return [
    "You are running a cheap harness readiness smoke as a read-only reviewer.",
    "Do NOT create commits, do NOT modify any files, and do NOT run destructive git commands.",
    "Emit ONLY a single JSON object matching the review verdict schema (no surrounding prose):",
    '{"verdict":"approve","summary":"harness smoke ok","findings":[],"next_steps":[]}',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Deps seam
// ---------------------------------------------------------------------------

export interface SmokeInvokeRequest {
  adapter: string;
  role: SmokeRole;
  model?: string;
  effort?: string;
  worktreeDir: string;
  prompt: string;
  /** Prompt delivery for unregistered reviewer compatibility adapters. */
  promptDelivery?: "argv" | "stdin";
}

export interface SmokeInvokeResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Raw captured stream before product-text reconstruction (for telemetry). */
  rawStdout?: string;
  timedOut?: boolean;
  preflightFailed?: boolean;
}

export interface ScratchRepoSnapshot {
  head: string | null;
  /** `git rev-list --count HEAD` when a HEAD exists; else 0. */
  commitCount: number;
  /**
   * `git status --porcelain=v1` (tracked + untracked). Used to detect
   * uncommitted file mutations on reviewer smoke (read-only contract).
   */
  statusPorcelain: string;
}

/** True when HEAD, commit count, or working-tree porcelain differs. */
export function scratchRepoMutated(
  before: ScratchRepoSnapshot,
  after: ScratchRepoSnapshot,
): boolean {
  return (
    before.head !== after.head ||
    before.commitCount !== after.commitCount ||
    before.statusPorcelain !== after.statusPorcelain
  );
}

export interface HarnessSmokeDeps {
  /** Resolve a registered adapter, or null when unregistered. */
  resolveAdapter(name: string): HarnessAdapter | null;
  /** Materialize the #40 compatibility adapter for an unregistered reviewer CLI. */
  materializeCompatibilityAdapter(
    name: string,
    opts?: { promptDelivery?: "argv" | "stdin" },
  ): HarnessAdapter;
  /** Create an isolated throwaway git repo; returns absolute root path. */
  createScratchRepo(): Promise<string>;
  /** Best-effort cleanup of a scratch root. */
  cleanupScratchRepo(root: string): Promise<void>;
  /** Snapshot HEAD + commit count + working-tree status before a smoke turn. */
  snapshotRepo(root: string): Promise<ScratchRepoSnapshot>;
  /** List full commit messages for commits after `beforeHead` (exclusive). */
  newCommitMessages(root: string, beforeHead: string | null): Promise<string[]>;
  /** Invoke adapter.runtimeSmoke (readiness, no model call). */
  runtimeSmoke(
    adapter: HarnessAdapter,
    preflightDeps: AdapterPreflightDeps,
  ): Promise<AdapterPreflightResult>;
  /** Optional treatment-aware preflight before the canned spawn. */
  preflight(
    adapter: HarnessAdapter,
    preflightDeps: AdapterPreflightDeps,
    req: { model?: string; effort?: string },
  ): Promise<AdapterPreflightResult>;
  /** Spawn the role-aware canned prompt (real subprocess on production path). */
  invokeSmoke(req: SmokeInvokeRequest): Promise<SmokeInvokeResult>;
  /** Validate product output through the central stage-output-contract registry. */
  validateContract(id: string, input: string): ContractValidateResult;
  /** Adapter telemetry parse — must not throw; returns empty/nulls on failure. */
  parseTelemetry(adapter: HarnessAdapter, capturedStdout: string): HarnessTelemetry;
  /** Thin exec/fs seam for adapter readiness (shared shape with DoctorDeps). */
  adapterPreflightDeps: AdapterPreflightDeps;
}

export interface RunHarnessSmokeOptions {
  /** Stop after the first failing treatment (doctor --fail-fast). */
  failFast?: boolean;
  /** Prompt delivery for unregistered reviewer CLIs. */
  reviewerPromptDelivery?: "argv" | "stdin";
}

// ---------------------------------------------------------------------------
// Real deps (subprocess / git I/O — not used by unit tests)
// ---------------------------------------------------------------------------

async function gitExec(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

export function realHarnessSmokeDeps(
  doctorDeps?: Pick<DoctorDeps, "exec" | "execCheck" | "fsExists" | "fsExecutable">,
): HarnessSmokeDeps {
  const adapterPreflightDeps: AdapterPreflightDeps = doctorDeps
    ? {
        exec: doctorDeps.exec,
        execCheck: doctorDeps.execCheck,
        fsExists: doctorDeps.fsExists,
        fsExecutable: doctorDeps.fsExecutable,
      }
    : {
        exec: async (file, args) => {
          try {
            const { stdout, stderr } = await execFileAsync(file, args, {
              timeout: 30_000,
              maxBuffer: 10 * 1024 * 1024,
            });
            return { ok: true, stdout: stdout ?? "", stderr: stderr ?? "" };
          } catch (err) {
            const e = err as { stdout?: string; stderr?: string; message?: string };
            return {
              ok: false,
              stdout: e.stdout ?? "",
              stderr: e.stderr ?? e.message ?? "",
            };
          }
        },
        execCheck: async (file, args) => {
          try {
            await execFileAsync(file, args, { timeout: 30_000 });
            return true;
          } catch {
            return false;
          }
        },
        fsExists: async (p) => {
          try {
            await fs.promises.access(p);
            return true;
          } catch {
            return false;
          }
        },
        fsExecutable: async (p) => {
          try {
            await fs.promises.access(p, fs.constants.X_OK);
            const st = await fs.promises.stat(p);
            return st.isFile();
          } catch {
            return false;
          }
        },
      };

  return {
    resolveAdapter,
    materializeCompatibilityAdapter: (name, opts) =>
      materializeCompatibilityAdapter(name, {
        promptDelivery: opts?.promptDelivery ?? "argv",
      }),
    createScratchRepo: async () => {
      const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "pipeline-harness-smoke-"),
      );
      const init = await gitExec(root, ["init"]);
      if (!init.ok) {
        throw new Error(`scratch git init failed: ${init.stderr}`);
      }
      // Deterministic identity so commits do not depend on operator git config.
      await gitExec(root, ["config", "user.email", "harness-smoke@localhost"]);
      await gitExec(root, ["config", "user.name", "Harness Smoke"]);
      // Seed a trivial tracked file so the repo has a defined tree before the
      // implementer turn; no initial commit required — implementer creates one.
      await fs.promises.writeFile(
        path.join(root, "README.md"),
        "harness-smoke scratch\n",
        "utf8",
      );
      return root;
    },
    cleanupScratchRepo: async (root) => {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
      } catch {
        // best-effort — cleanup failure does not flip assertion results
      }
    },
    snapshotRepo: async (root) => {
      const statusRes = await gitExec(root, ["status", "--porcelain=v1"]);
      const statusPorcelain = statusRes.ok ? statusRes.stdout : "";
      const headRes = await gitExec(root, ["rev-parse", "HEAD"]);
      if (!headRes.ok) {
        return { head: null, commitCount: 0, statusPorcelain };
      }
      const countRes = await gitExec(root, ["rev-list", "--count", "HEAD"]);
      const commitCount = countRes.ok
        ? Number.parseInt(countRes.stdout.trim(), 10) || 0
        : 0;
      return {
        head: headRes.stdout.trim() || null,
        commitCount,
        statusPorcelain,
      };
    },
    newCommitMessages: async (root, beforeHead) => {
      const range = beforeHead ? `${beforeHead}..HEAD` : "HEAD";
      // %B = full message; use null-byte separators for multi-commit safety.
      const res = await gitExec(root, [
        "log",
        "--format=%B%x00",
        ...(beforeHead ? [range] : ["--all"]),
      ]);
      if (!res.ok || !res.stdout.trim()) {
        // Empty repo or no new commits
        if (!beforeHead) {
          // List all commits when there was no prior HEAD
          const all = await gitExec(root, ["log", "--format=%B%x00", "--all"]);
          if (!all.ok || !all.stdout.trim()) return [];
          return all.stdout
            .split("\0")
            .map((m) => m.trim())
            .filter(Boolean);
        }
        return [];
      }
      return res.stdout
        .split("\0")
        .map((m) => m.trim())
        .filter(Boolean);
    },
    runtimeSmoke: (adapter, deps) => adapter.runtimeSmoke(deps),
    preflight: (adapter, deps, req) => adapter.preflight(deps, req),
    invokeSmoke: async (req) => {
      const result: HarnessResult = await invoke(req.adapter, req.worktreeDir, req.prompt, {
        stream: false,
        timeoutSec: HARNESS_SMOKE_TIMEOUT_SEC,
        model: req.model,
        reasoningEffort: req.effort,
        lean: req.role === "implementer" ? true : undefined,
        role: req.role,
        promptDelivery: req.promptDelivery,
      });
      return {
        success: result.success,
        exitCode: result.exit_code,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        timedOut: result.timed_out,
        preflightFailed: result.preflight_failed,
      };
    },
    validateContract: (id, input) => validateStageOutput(id, input),
    parseTelemetry: (adapter, captured) => adapter.parseTelemetry(captured),
    adapterPreflightDeps,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function pass(detail: string): CheckResult {
  return { status: "pass", detail };
}

function fail(detail: string, remediation: string): CheckResult {
  return { status: "fail", detail, remediation };
}

function commitHasRequiredTrailers(message: string): boolean {
  // Match trailer lines anywhere in the message (standard git trailer form).
  const hasIssue = new RegExp(`^${ISSUE_TRAILER_KEY}:\\s*#0\\s*$`, "m").test(message);
  const hasRun = new RegExp(
    `^${RUN_TRAILER_KEY}:\\s*harness-smoke/0\\s*$`,
    "m",
  ).test(message);
  return hasIssue && hasRun;
}

function adapterDeclaresTelemetry(adapter: HarnessAdapter): boolean {
  return (
    adapter.capabilities.telemetry === "jsonl" ||
    adapter.declaration.telemetry === "jsonl"
  );
}

/**
 * Collect JSON objects from a CLI capture (JSONL lines and/or a whole-capture
 * JSON object). Used only for provenance checks — not for product parsing.
 */
function collectJsonRecords(capturedStdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (obj: Record<string, unknown>) => {
    // De-dupe identical line vs whole-capture parses of the same object.
    let key: string;
    try {
      key = JSON.stringify(obj);
    } catch {
      key = String(records.length);
    }
    if (seen.has(key)) return;
    seen.add(key);
    records.push(obj);
  };
  for (const line of capturedStdout.split("\n")) {
    const obj = parseJsonLine(line);
    if (obj) push(obj);
  }
  const trimmed = capturedStdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isJsonRecord(parsed)) push(parsed);
    } catch {
      // not a single JSON document — fine
    }
  }
  return records;
}

/** True when `target` appears as a finite number value anywhere under `node`. */
function jsonContainsFiniteNumber(
  node: unknown,
  target: number,
  depth = 0,
): boolean {
  if (depth > 10) return false;
  if (typeof node === "number" && Number.isFinite(node) && node === target) {
    return true;
  }
  if (Array.isArray(node)) {
    return node.some((v) => jsonContainsFiniteNumber(v, target, depth + 1));
  }
  if (isJsonRecord(node)) {
    return Object.values(node).some((v) =>
      jsonContainsFiniteNumber(v, target, depth + 1),
    );
  }
  return false;
}

/**
 * True when `target` appears as an object key or string value under `node`.
 * Matches claude/grok modelUsage keys and any string model fields adapters
 * may surface without requiring a single vendor schema.
 */
function jsonContainsStringKeyOrValue(
  node: unknown,
  target: string,
  depth = 0,
): boolean {
  if (depth > 10) return false;
  if (typeof node === "string" && node === target) return true;
  if (Array.isArray(node)) {
    return node.some((v) => jsonContainsStringKeyOrValue(v, target, depth + 1));
  }
  if (isJsonRecord(node)) {
    for (const [k, v] of Object.entries(node)) {
      if (k === target) return true;
      if (jsonContainsStringKeyOrValue(v, target, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Telemetry parse check: when declared, parse must not throw and must not invent
 * a resolved model or cost the CLI did not report. Provenance is per-field:
 * a non-null costUsd/resolvedModel is only accepted when that value is present
 * in the raw capture's JSON envelope (not merely because stdout is nonempty).
 * EMPTY_TELEMETRY (all nulls) is always acceptable.
 */
function checkTelemetry(
  adapter: HarnessAdapter,
  deps: HarnessSmokeDeps,
  capturedStdout: string,
  label: string,
): CheckResult | null {
  if (!adapterDeclaresTelemetry(adapter)) return null;
  let telemetry: HarnessTelemetry;
  try {
    telemetry = deps.parseTelemetry(adapter, capturedStdout);
  } catch (err) {
    return fail(
      `${label}: telemetry parse threw — ${(err as Error).message}`,
      `Fix adapter \`${adapter.name}\` parseTelemetry so unparseable smoke output degrades to nulls instead of throwing.`,
    );
  }

  const records = collectJsonRecords(capturedStdout);
  const invented: string[] = [];

  if (
    telemetry.costUsd != null &&
    Number.isFinite(telemetry.costUsd) &&
    !records.some((r) => jsonContainsFiniteNumber(r, telemetry.costUsd as number))
  ) {
    invented.push("costUsd");
  }
  if (
    telemetry.resolvedModel != null &&
    telemetry.resolvedModel !== "" &&
    !records.some((r) =>
      jsonContainsStringKeyOrValue(r, telemetry.resolvedModel as string),
    )
  ) {
    invented.push("resolvedModel");
  }

  if (invented.length > 0) {
    return fail(
      `${label}: parseTelemetry invented ${invented.join(" and ")} without matching fields in the CLI capture`,
      `Adapter \`${adapter.name}\` must not invent resolved model or cost when the CLI did not report them. Return nulls for fields absent from the telemetry envelope.`,
    );
  }
  return null; // ok
}

async function runOneTreatment(
  treatment: SmokeTreatment,
  deps: HarnessSmokeDeps,
  opts: RunHarnessSmokeOptions,
): Promise<CheckOutcome> {
  const id = smokeCheckId(treatment);
  const description = `Harness smoke: ${treatmentLabel(treatment)}`;
  const label = treatmentLabel(treatment);

  const adapter =
    deps.resolveAdapter(treatment.adapter) ??
    (treatment.role === "reviewer"
      ? deps.materializeCompatibilityAdapter(treatment.adapter, {
          promptDelivery: opts.reviewerPromptDelivery ?? "argv",
        })
      : null);

  if (!adapter) {
    return {
      id,
      description,
      ...fail(
        `${label}: adapter is not registered and cannot use the reviewer compatibility path`,
        `Register adapter \`${treatment.adapter}\` or assign a registered implementer. Smoke does not invent a fallback adapter.`,
      ),
    };
  }

  // Role eligibility: registered adapters must declare the role.
  if (
    adapter.declaration.origin !== "compatibility" &&
    !adapter.declaration.roles.includes(treatment.role)
  ) {
    return {
      id,
      description,
      ...fail(
        `${label}: adapter does not declare role \`${treatment.role}\``,
        `Reassign the ${treatment.role} role away from \`${treatment.adapter}\`, or extend the adapter's declared roles.`,
      ),
    };
  }

  // --- Readiness phase (no model call) ---
  let readiness: AdapterPreflightResult;
  try {
    readiness = await deps.runtimeSmoke(adapter, deps.adapterPreflightDeps);
  } catch (err) {
    return {
      id,
      description,
      ...fail(
        `${label}: runtimeSmoke threw — ${(err as Error).message}`,
        `Fix adapter \`${treatment.adapter}\` runtimeSmoke readiness probe.`,
      ),
    };
  }
  if (!readiness.ok) {
    const rem =
      readiness.message ??
      `adapter \`${treatment.adapter}\` readiness failed (${readiness.failure ?? "unknown"})`;
    return {
      id,
      description,
      ...fail(
        `${label}: readiness failed — ${rem}`,
        readiness.failure === "missing-cli"
          ? `Install the \`${treatment.adapter}\` CLI and ensure it is on PATH, then re-run \`pipeline doctor --harness-smoke\`.`
          : readiness.failure === "unauthenticated"
            ? `Authenticate the \`${treatment.adapter}\` CLI, then re-run \`pipeline doctor --harness-smoke\`.`
            : `Resolve readiness for \`${treatment.adapter}\` (${treatment.role}), then re-run \`pipeline doctor --harness-smoke\`.`,
      ),
    };
  }

  // Treatment-aware preflight (model/effort) — still no model call.
  try {
    const pf = await deps.preflight(adapter, deps.adapterPreflightDeps, {
      ...(treatment.model ? { model: treatment.model } : {}),
      ...(treatment.effort ? { effort: treatment.effort } : {}),
    });
    if (!pf.ok) {
      return {
        id,
        description,
        ...fail(
          `${label}: preflight failed — ${pf.message ?? pf.failure ?? "unknown"}`,
          `Fix model/effort/settings for \`${treatment.adapter}\` ${treatment.role}` +
            (treatment.model ? ` model=${treatment.model}` : "") +
            (treatment.effort ? ` effort=${treatment.effort}` : "") +
            ` — smoke does not fall back to another adapter or ambient model.`,
        ),
      };
    }
  } catch (err) {
    return {
      id,
      description,
      ...fail(
        `${label}: preflight threw — ${(err as Error).message}`,
        `Fix adapter \`${treatment.adapter}\` preflight for the configured treatment.`,
      ),
    };
  }

  // --- Dynamic phase: scratch repo + canned prompt ---
  let scratch: string | null = null;
  try {
    scratch = await deps.createScratchRepo();
    const before = await deps.snapshotRepo(scratch);
    const prompt =
      treatment.role === "implementer"
        ? implementerSmokePrompt()
        : reviewerSmokePrompt();

    const inv = await deps.invokeSmoke({
      adapter: treatment.adapter,
      role: treatment.role,
      model: treatment.model,
      effort: treatment.effort,
      worktreeDir: scratch,
      prompt,
      promptDelivery: opts.reviewerPromptDelivery,
    });

    if (!inv.success || inv.exitCode !== 0) {
      const why = inv.preflightFailed
        ? "production preflight refused the spawn"
        : inv.timedOut
          ? "timed out"
          : `exit ${inv.exitCode}`;
      const excerpt = (inv.stderr || inv.stdout).trim().slice(0, 400);
      return {
        id,
        description,
        ...fail(
          `${label}: harness spawn failed (${why})${excerpt ? ` — ${excerpt}` : ""}`,
          `Investigate \`${treatment.adapter}\` ${treatment.role} smoke spawn for ` +
            treatmentLabel(treatment) +
            `. Smoke does not retry with a different adapter or model.`,
        ),
      };
    }

    const productOut = inv.stdout ?? "";
    const rawForTelemetry = inv.rawStdout ?? inv.stdout ?? "";

    if (treatment.role === "implementer") {
      const messages = await deps.newCommitMessages(scratch, before.head);
      const trailerCommit = messages.find(commitHasRequiredTrailers);
      if (!trailerCommit) {
        return {
          id,
          description,
          ...fail(
            `${label}: no new commit with required trailers (${SMOKE_ISSUE_TRAILER}, ${SMOKE_RUN_TRAILER})`,
            `Ensure the implementer adapter \`${treatment.adapter}\` can create a trailer-bearing commit in the scratch repo. Smoke expects Issue: #0 and Pipeline-Run: harness-smoke/0 trailers.`,
          ),
        };
      }

      const contract = deps.validateContract(
        HARNESS_SMOKE_CONTRACT_IDS.implementer,
        productOut,
      );
      if (!contract.ok) {
        return {
          id,
          description,
          ...fail(
            `${label}: stage-output-contract ${HARNESS_SMOKE_CONTRACT_IDS.implementer} failed — ${contract.reason}`,
            `Implementer smoke output must satisfy ${HARNESS_SMOKE_CONTRACT_IDS.implementer} (JSON object with ok:true).`,
          ),
        };
      }
    } else {
      // Reviewer: structured verdict + no commits and no working-tree mutation
      const messages = await deps.newCommitMessages(scratch, before.head);
      const after = await deps.snapshotRepo(scratch);
      const dirtyTree = scratchRepoMutated(before, after);
      if (messages.length > 0 || dirtyTree) {
        const why =
          messages.length > 0
            ? `${messages.length} new commit(s)`
            : "working-tree file mutation(s)";
        return {
          id,
          description,
          ...fail(
            `${label}: reviewer smoke mutated the repository (${why})`,
            `Reviewer smoke must remain read-only — do not create commits or modify tracked/untracked files. Adapter \`${treatment.adapter}\` reviewer treatment failed the no-mutation check.`,
          ),
        };
      }

      const contract = deps.validateContract(
        HARNESS_SMOKE_CONTRACT_IDS.reviewer,
        productOut,
      );
      if (!contract.ok) {
        return {
          id,
          description,
          ...fail(
            `${label}: review verdict contract ${HARNESS_SMOKE_CONTRACT_IDS.reviewer} failed — ${contract.reason}`,
            `Reviewer smoke must emit a schema-satisfying verdict JSON (review.verdict@1). This is an output-contract failure, not an empty-findings approve.`,
          ),
        };
      }
    }

    const telFail = checkTelemetry(adapter, deps, rawForTelemetry, label);
    if (telFail) {
      return { id, description, ...telFail };
    }

    return {
      id,
      description,
      ...pass(`${label}: smoke passed`),
    };
  } catch (err) {
    return {
      id,
      description,
      ...fail(
        `${label}: unexpected smoke error — ${(err as Error).message}`,
        `Investigate harness smoke for ${label}.`,
      ),
    };
  } finally {
    if (scratch) {
      try {
        await deps.cleanupScratchRepo(scratch);
      } catch {
        // warnings only — do not convert a failed assertion into silent success
      }
    }
  }
}

/**
 * Run the full harness-smoke plan and return CheckOutcome records suitable for
 * folding into the doctor summary / JSON envelope.
 */
export async function runHarnessSmoke(
  config: PipelineConfig,
  deps: HarnessSmokeDeps = realHarnessSmokeDeps(),
  opts: RunHarnessSmokeOptions = {},
): Promise<CheckOutcome[]> {
  const plan = buildSmokePlan(config);
  const outcomes: CheckOutcome[] = [];
  for (const treatment of plan) {
    const outcome = await runOneTreatment(treatment, deps, {
      failFast: opts.failFast,
      reviewerPromptDelivery:
        opts.reviewerPromptDelivery ??
        config.harnesses.reviewerPromptDelivery ??
        "argv",
    });
    outcomes.push(outcome);
    if (opts.failFast && outcome.status === "fail") break;
  }
  return outcomes;
}

/**
 * Merge smoke outcomes into a PreflightResult-like check list and compute ok.
 * Pure helper for doctor composition and unit tests.
 */
export function foldSmokeIntoChecks(
  staticChecks: CheckOutcome[],
  smokeChecks: CheckOutcome[],
): { checks: CheckOutcome[]; ok: boolean } {
  const checks = [...staticChecks, ...smokeChecks];
  const ok = !checks.some((c) => c.status === "fail");
  return { checks, ok };
}
