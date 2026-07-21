// pipeline:loop deterministic preflight (#451).
//
// Two read-only checks, shared verbatim by `pipeline doctor`, the installer,
// and the `pipeline:loop` run-start preflight (design.md decision 4 — "refuse
// before mutating"):
//
//   - `loop:contract-coherence` — discover the installed goal-loop skill and
//     verify its contract/ledger schema ids are within Pipeline's supported
//     set.
//   - native-`/goal` capability — verify the active engine's built-in
//     autonomous goal mode is available.
//
// Both reuse the existing `DoctorDeps` seam (core/scripts/stages/doctor.ts) so
// there is exactly one injectable-I/O contract across doctor, the installer,
// and the CLI — no divergent copies (design.md decision 4; tasks.md #4.3).
//
// Also implements pure argument normalization for `pipeline:loop` — parsing
// the selector/mode arguments with no I/O at all.

import * as path from "node:path";
import { homedir } from "node:os";
import type { CheckResult, DoctorDeps } from "./stages/doctor.ts";

// ---------------------------------------------------------------------------
// Supported goal-loop contract/ledger schema ids (#451 — the "supported set").
// A newer-than-supported id fails just as loudly as an older one: silently
// proceeding against an unrecognized schema is how a durable store gets
// corrupted, not a compatibility win.
// ---------------------------------------------------------------------------

export const GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS: readonly string[] = ["goal-loop/contract@2"];
export const GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS: readonly string[] = ["goal-loop/ledger@2"];

export type LoopEngine = "claude" | "codex";

// ---------------------------------------------------------------------------
// goal-loop discovery
// ---------------------------------------------------------------------------

export interface GoalLoopManifest {
  package?: string;
  version?: string;
}

export interface GoalLoopDiscovery {
  root: string;
  manifest: GoalLoopManifest;
  contractSchema: string | null;
  ledgerSchema: string | null;
}

/** Candidate install roots for the goal-loop skill, honoring the same
 *  CLAUDE_CONFIG_DIR / CODEX_HOME overrides scripts/install.mjs already uses.
 *
 *  When `engine` is given (the `pipeline:loop` facade always knows its active
 *  engine), discovery is scoped to that engine's own host store — plus the
 *  shared `~/.agents` install — so a stale install under the *other* host can
 *  neither mask an incompatible active install nor block a compatible one
 *  (#451 review 2, finding 1). Doctor and the installer don't know which host
 *  is invoking them, so they call this with no `engine` and keep the prior
 *  host-agnostic order (Claude, then Codex, then shared). */
export function goalLoopDiscoveryRoots(engine?: LoopEngine, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  const claudeBase = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
  const codexBase = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, ".codex");
  const agentsBase = path.join(home, ".agents");
  const claudeRoot = path.join(claudeBase, "skills", "goal-loop");
  const codexRoot = path.join(codexBase, "skills", "goal-loop");
  const sharedRoot = path.join(agentsBase, "skills", "goal-loop");
  if (engine === "claude") return [claudeRoot, sharedRoot];
  if (engine === "codex") return [codexRoot, sharedRoot];
  return [claudeRoot, codexRoot, sharedRoot];
}

function extractSchemaConstant(statePy: string, constName: string): string | null {
  const match = new RegExp(`${constName}\\s*=\\s*["']([^"']+)["']`).exec(statePy);
  return match ? match[1] : null;
}

/** Discover the installed goal-loop skill (first candidate root whose
 *  ownership manifest exists) and read its manifest + contract/ledger schema
 *  ids out of `state.py`. Returns null when no install is discoverable. */
export async function discoverGoalLoop(
  deps: DoctorDeps,
  roots: string[] = goalLoopDiscoveryRoots(),
): Promise<GoalLoopDiscovery | null> {
  let root: string | null = null;
  for (const candidate of roots) {
    if (await deps.fsExists(path.join(candidate, ".goal-loop-manifest.json"))) {
      root = candidate;
      break;
    }
  }
  if (!root) return null;

  const manifestText = await deps.readTextFile(path.join(root, ".goal-loop-manifest.json"));
  let manifest: GoalLoopManifest = {};
  if (manifestText) {
    try {
      manifest = JSON.parse(manifestText) as GoalLoopManifest;
    } catch {
      manifest = {};
    }
  }

  const statePy = await deps.readTextFile(path.join(root, "state.py"));
  const contractSchema = statePy ? extractSchemaConstant(statePy, "CONTRACT_SCHEMA") : null;
  const ledgerSchema = statePy ? extractSchemaConstant(statePy, "LEDGER_SCHEMA") : null;

  return { root, manifest, contractSchema, ledgerSchema };
}

// ---------------------------------------------------------------------------
// Result constructors (mirrors doctor.ts's terse pass/fail helpers)
// ---------------------------------------------------------------------------

const pass = (detail: string): CheckResult => ({ status: "pass", detail });
const fail = (detail: string, remediation: string): CheckResult => ({ status: "fail", detail, remediation });

/** `loop:contract-coherence`: the one check shared by `pipeline doctor`, the
 *  installer, and the `pipeline:loop` run-start preflight. Fails when no
 *  goal-loop install is discoverable, when its manifest/schema ids cannot be
 *  read, or when either schema id is outside Pipeline's supported set
 *  (including a schema id newer than any supported id). */
export async function checkLoopContractCoherence(
  deps: DoctorDeps,
  roots: string[] = goalLoopDiscoveryRoots(),
): Promise<CheckResult> {
  const discovered = await discoverGoalLoop(deps, roots);
  if (!discovered) {
    return fail(
      "no installed goal-loop skill could be discovered",
      "Install goal-loop before running pipeline:loop — see https://github.com/comamitc/goal-loop.",
    );
  }

  const { manifest, contractSchema, ledgerSchema, root } = discovered;
  if (!manifest.version || !contractSchema || !ledgerSchema) {
    return fail(
      `goal-loop manifest or contract/ledger schema ids at ${root} could not be read`,
      "Reinstall goal-loop so its .goal-loop-manifest.json and state.py are present and readable.",
    );
  }

  const supportedContracts = GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS.join(", ");
  const supportedLedgers = GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS.join(", ");
  const contractOk = GOAL_LOOP_SUPPORTED_CONTRACT_SCHEMAS.includes(contractSchema);
  const ledgerOk = GOAL_LOOP_SUPPORTED_LEDGER_SCHEMAS.includes(ledgerSchema);
  if (!contractOk || !ledgerOk) {
    return fail(
      `installed goal-loop v${manifest.version} at ${root} implements ${contractSchema} / ${ledgerSchema}, ` +
        `outside Pipeline's supported set (${supportedContracts} / ${supportedLedgers})`,
      "Align the goal-loop and Pipeline versions so their contract/ledger schema ids match — " +
        "update whichever side is behind (or ahead).",
    );
  }

  return pass(`goal-loop v${manifest.version} at ${root} implements ${contractSchema} / ${ledgerSchema}`);
}

// ---------------------------------------------------------------------------
// Native `/goal` autonomous-mode capability check
// ---------------------------------------------------------------------------

const NATIVE_GOAL_MARKER = /\/goal\b|\bgoal[\s-]?mode\b/i;

/** Best-effort capability probe: the engine binary's own `--help` output is
 *  asked whether it advertises a built-in autonomous goal mode. Deliberately
 *  does not guess at an undocumented internal file or API — it introspects
 *  the installed CLI the same way a user would (`<bin> --help`). */
export async function checkNativeGoalCapability(deps: DoctorDeps, engine: LoopEngine): Promise<CheckResult> {
  const bin = engine === "claude" ? "claude" : "codex";
  const res = await deps.exec(bin, ["--help"]);
  if (res.ok && NATIVE_GOAL_MARKER.test(res.stdout)) {
    return pass(`${engine}'s built-in /goal autonomous mode is available`);
  }
  return fail(
    `${engine}'s built-in /goal autonomous mode was not detected`,
    `Update ${bin} to a version with native /goal support before running pipeline:loop — ` +
      "it refuses to fall back to a non-durable or manually-supervised loop.",
  );
}

// ---------------------------------------------------------------------------
// Argument normalization (pure — no I/O)
// ---------------------------------------------------------------------------

export type LoopSelector =
  | { type: "milestone"; value: string }
  | { type: "label"; value: string }
  | { type: "roadmap-slice"; value: string }
  | { type: "work-list"; value: string[] };

export interface LoopArgs {
  selector?: LoopSelector;
  resumeRunId?: string;
  audit: boolean;
}

export class LoopArgError extends Error {}

export interface RawLoopArgs {
  milestone?: string;
  /** May be repeated by Commander's collectRepeatable; only one label selector
   *  is accepted at a time — a second occurrence is a hard error, not a
   *  silent override, since it would otherwise run an unintended backlog. */
  label?: string[];
  range?: string;
  roadmapSlice?: string;
  /** Explicit issue-number positional list. */
  issues?: string[];
  resume?: string;
  audit?: boolean;
}

const RANGE_RE = /^(\d+)-(\d+)$/;

/** Expands a validated `<start>-<end>` range into the inclusive list of issue
 *  numbers it denotes — the required `work-list` normalization target (#451
 *  review 2, finding 3: the active spec has no standalone `range` selector
 *  type). */
function expandRange(range: string): string[] {
  const match = RANGE_RE.exec(range);
  if (!match) {
    throw new LoopArgError(`pipeline:loop: --range must be "<start>-<end>", got "${range}"`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end) {
    throw new LoopArgError(`pipeline:loop: --range start must be <= end, got "${range}"`);
  }
  const issues: string[] = [];
  for (let n = start; n <= end; n++) issues.push(String(n));
  return issues;
}

/** Pure normalization of `pipeline:loop` arguments into exactly one selector
 *  form (or none, when resuming or auditing), rejecting a selector combined
 *  with `--resume` and requiring at least one of selector/`--resume`/`--audit`
 *  (standalone `--audit` reports on the canonical run goal-loop resolves for
 *  this repo). No I/O. */
export function normalizeLoopArgs(raw: RawLoopArgs): LoopArgs {
  if (raw.label && raw.label.length > 1) {
    throw new LoopArgError(
      `pipeline:loop accepts only one --label selector at a time — got ${raw.label.join(", ")}`,
    );
  }
  const label = raw.label && raw.label.length > 0 ? raw.label[0] : undefined;
  const issues = raw.issues ?? [];
  for (const issue of issues) {
    if (!/^\d+$/.test(issue)) {
      throw new LoopArgError(`pipeline:loop: expected an issue number, got "${issue}"`);
    }
  }

  const selectorCandidates: Array<[string, LoopSelector | undefined]> = [
    ["--milestone", raw.milestone ? { type: "milestone", value: raw.milestone } : undefined],
    ["--label", label ? { type: "label", value: label } : undefined],
    ["--range", raw.range ? { type: "work-list", value: expandRange(raw.range) } : undefined],
    ["--roadmap-slice", raw.roadmapSlice ? { type: "roadmap-slice", value: raw.roadmapSlice } : undefined],
    ["issue list", issues.length > 0 ? { type: "work-list", value: issues } : undefined],
  ];
  const present = selectorCandidates.filter(([, sel]) => sel !== undefined);

  if (present.length > 1) {
    throw new LoopArgError(
      `pipeline:loop accepts only one selector at a time — got ${present.map(([name]) => name).join(", ")}`,
    );
  }
  if (raw.resume && present.length > 0) {
    throw new LoopArgError(
      `pipeline:loop --resume cannot be combined with a selector (got ${present[0][0]} and --resume)`,
    );
  }
  if (!raw.resume && !raw.audit && present.length === 0) {
    throw new LoopArgError(
      "pipeline:loop requires a selector (--milestone, --label, --range, --roadmap-slice, or an issue list), --resume <run-id>, or --audit",
    );
  }

  return {
    selector: present[0]?.[1],
    resumeRunId: raw.resume,
    audit: !!raw.audit,
  };
}

// ---------------------------------------------------------------------------
// Fixed preflight order (design.md decision 4): normalize -> contract-coherence
// -> native-goal. Every step here is read-only; a failure exits with zero
// external mutation.
// ---------------------------------------------------------------------------

export type LoopPreflightOutcome =
  | { ok: true; args: LoopArgs }
  | { ok: false; failedCheck: "args" | "loop:contract-coherence" | "native-goal"; detail: string; remediation?: string };

export async function runLoopPreflight(
  raw: RawLoopArgs,
  engine: LoopEngine,
  deps: DoctorDeps,
  roots: string[] = goalLoopDiscoveryRoots(engine),
): Promise<LoopPreflightOutcome> {
  let args: LoopArgs;
  try {
    args = normalizeLoopArgs(raw);
  } catch (err) {
    return { ok: false, failedCheck: "args", detail: (err as Error).message };
  }

  const coherence = await checkLoopContractCoherence(deps, roots);
  if (coherence.status === "fail") {
    return {
      ok: false,
      failedCheck: "loop:contract-coherence",
      detail: coherence.detail,
      remediation: coherence.remediation,
    };
  }

  const nativeGoal = await checkNativeGoalCapability(deps, engine);
  if (nativeGoal.status === "fail") {
    return { ok: false, failedCheck: "native-goal", detail: nativeGoal.detail, remediation: nativeGoal.remediation };
  }

  return { ok: true, args };
}
