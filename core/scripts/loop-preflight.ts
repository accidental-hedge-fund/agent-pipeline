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
import { LOOP_CONTRACT_SCHEMA, LOOP_LEDGER_SCHEMA } from "./loop/types.ts";

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
// In-repo durable loop store schema-compatibility check (#512, capability
// `durable-loop-supervisor`, design.md decision 6). Replaces the run-start
// preflight's former `loop:contract-coherence` external goal-loop discovery:
// the in-repo durable loop store is now the sole authoritative engine, so
// the run-start gate is a self-check that this build's own contract/ledger
// schema constants are well-formed — never a discovery of, or dependency on,
// an externally installed goal-loop skill. checkLoopContractCoherence /
// discoverGoalLoop above are retained only for `pipeline doctor` and the
// installer, which still support the legacy external-skill install
// independently of the loop run-start path.
// ---------------------------------------------------------------------------

const SCHEMA_ID_RE = /^[a-z0-9/_-]+@\d+$/i;

/** `loop:store-schema-compatibility`: verifies this build's own durable loop
 *  store contract/ledger schema ids are well-formed — always passes for a
 *  healthy build. Performs no filesystem, network, or subprocess access and
 *  discovers no external install, so the run-start preflight never fails for
 *  a host with no goal-loop skill installed at any root. */
export function checkLoopStoreSchemaCompatibility(): CheckResult {
  if (!SCHEMA_ID_RE.test(LOOP_CONTRACT_SCHEMA) || !SCHEMA_ID_RE.test(LOOP_LEDGER_SCHEMA)) {
    return fail(
      `the in-repo durable loop store's schema ids are malformed (${LOOP_CONTRACT_SCHEMA} / ${LOOP_LEDGER_SCHEMA})`,
      "This indicates a corrupted Agent Pipeline install — reinstall the pipeline skill.",
    );
  }
  return pass(`in-repo durable loop store implements ${LOOP_CONTRACT_SCHEMA} / ${LOOP_LEDGER_SCHEMA}`);
}

// ---------------------------------------------------------------------------
// Native `/goal` autonomous-mode capability check (#506)
//
// `/goal` is an interactive slash command, not a CLI flag: it is structurally
// absent from `<bin> --help` on every real Claude Code build, so a `--help`
// grep can only ever accept (a positive marker means something advertises the
// capability); its ABSENCE is not evidence of absence and must never fail the
// probe on its own (design.md decision 1). Resolution order: operator
// attestation (config, authoritative both ways) -> positive `--help` marker
// (additive-only) -> documented per-engine version floor -> fail closed.
// ---------------------------------------------------------------------------

const NATIVE_GOAL_MARKER = /\/goal\b|\bgoal[\s-]?mode\b/i;

export const NATIVE_GOAL_ATTESTATION_CONFIG_KEY = "loop.native_goal_attestation";

export type NativeGoalAttestation = "auto" | "available" | "unavailable";

interface EngineFloor {
  /** Lowest version we have positive evidence for — not the lowest that might
   *  work. Raising this bar reintroduces false negatives; lowering it without
   *  evidence risks a false positive, which is worse (a run that starts and
   *  cannot finish durably). */
  floor: string;
  verifiedOn: string;
  note: string;
}

/** Per-engine version floor table (design.md decision 2). `null` means no
 *  native goal mode is known for that engine at any version — represented
 *  explicitly rather than guessed, so the probe fails closed instead of
 *  silently passing an engine we have no evidence for. */
const NATIVE_GOAL_VERSION_FLOOR: Record<LoopEngine, EngineFloor | null> = {
  // Evidence (#506 reproduction, 2026-07-22): `claude --version` reported
  // "2.1.216 (Claude Code)"; `claude --help | grep -i goal` returned nothing;
  // a native six-milestone `/goal` run had completed on the same host the
  // previous day (2026-07-21).
  claude: {
    floor: "2.1.216",
    verifiedOn: "2026-07-22",
    note: "lowest version with a confirmed completed native /goal run (#506)",
  },
  // Evidence (2026-07-22): `codex --version` reported "codex-cli 0.144.6" with
  // no known native autonomous goal-mode equivalent at that or any version.
  codex: null,
};

/** Extracts the first `major.minor.patch` run from a version string (e.g.
 *  `"2.1.216 (Claude Code)"` -> `[2, 1, 216]`, `"codex-cli 0.144.6"` ->
 *  `[0, 144, 6]`). Returns null when no such run is present — callers must
 *  treat that as fail-closed, never as "recent enough" (design.md decision 3). */
function parseVersion(raw: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric, component-wise comparison; pre-release/build suffixes are already
 *  dropped by {@link parseVersion}. Returns true when `version >= floor`. */
function versionAtLeast(version: [number, number, number], floor: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] > floor[i]) return true;
    if (version[i] < floor[i]) return false;
  }
  return true;
}

function remediationFor(engine: LoopEngine, bin: string, detectedVersion: string | null): string {
  const engineFloor = NATIVE_GOAL_VERSION_FLOOR[engine];
  const versionPart = detectedVersion
    ? `detected ${bin} version "${detectedVersion}"`
    : `${bin}'s version could not be read`;
  const floorPart = engineFloor
    ? `the required floor is ${engineFloor.floor} or above`
    : `no native goal mode is known for ${bin} at any version`;
  return (
    `${versionPart}; ${floorPart}. Set "${NATIVE_GOAL_ATTESTATION_CONFIG_KEY}" to "available" in ` +
    `.github/pipeline.yml if this host has native /goal support despite this check, or "unavailable" ` +
    "to make the refusal explicit. pipeline:loop refuses to fall back to a non-durable or " +
    "manually-supervised loop."
  );
}

/** Capability probe built on signals that actually carry slash-command
 *  availability (#506) — never on `--help` absence. Resolution order:
 *  operator attestation -> positive `--help` marker -> version floor -> fail
 *  closed. Deliberately does not start an engine session or read undocumented
 *  engine-internal files (design.md non-goals). */
export async function checkNativeGoalCapability(
  deps: DoctorDeps,
  engine: LoopEngine,
  attestation: NativeGoalAttestation = "auto",
): Promise<CheckResult> {
  const bin = engine === "claude" ? "claude" : "codex";

  if (attestation === "available") {
    return pass(`${engine}'s built-in /goal autonomous mode is asserted available by operator attestation`);
  }
  if (attestation === "unavailable") {
    return fail(
      `${engine}'s built-in /goal autonomous mode is asserted unavailable by operator attestation`,
      `"${NATIVE_GOAL_ATTESTATION_CONFIG_KEY}" is set to "unavailable" in .github/pipeline.yml. ` +
        `Set it to "auto" or "available" if ${bin} does support native /goal.`,
    );
  }

  const helpRes = await deps.exec(bin, ["--help"]);
  if (helpRes.ok && NATIVE_GOAL_MARKER.test(helpRes.stdout)) {
    return pass(`${engine}'s built-in /goal autonomous mode is advertised in ${bin} --help`);
  }

  const versionRes = await deps.exec(bin, ["--version"]);
  const detectedVersion = versionRes.ok ? versionRes.stdout.trim() : null;
  const engineFloor = NATIVE_GOAL_VERSION_FLOOR[engine];
  const parsedVersion = detectedVersion ? parseVersion(detectedVersion) : null;
  const parsedFloor = engineFloor ? parseVersion(engineFloor.floor) : null;

  if (parsedVersion && parsedFloor && versionAtLeast(parsedVersion, parsedFloor)) {
    return pass(
      `${engine}'s built-in /goal autonomous mode is available (detected version ${detectedVersion} ` +
        `>= documented floor ${engineFloor!.floor}, verified ${engineFloor!.verifiedOn}: ${engineFloor!.note})`,
    );
  }

  return fail(
    `${engine}'s built-in /goal autonomous mode was not detected`,
    remediationFor(engine, bin, detectedVersion),
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
  /** `--new-run` (#568, capability `loop-run-supersession`): start a fresh run superseding the
   *  canonical run for `selector` once it is terminally stopped. Always paired with a selector —
   *  {@link normalizeLoopArgs} refuses it alongside `--resume` or with no selector present. */
  newRun: boolean;
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
  newRun?: boolean;
}

const RANGE_RE = /^(\d+)-(\d+)$/;

/** Hard ceiling on how many issue numbers a `--range` may denote (#451 delta
 *  finding 95357c6b): expansion materializes the inclusive list, so an
 *  unbounded span (e.g. `1-99999999999`) would loop and allocate effectively
 *  forever before any preflight check can reject it. No real batch approaches
 *  this bound — the factory's own limits cap concurrent work far lower. */
export const MAX_RANGE_SPAN = 1000;

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
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new LoopArgError(`pipeline:loop: --range endpoints must be safe integers, got "${range}"`);
  }
  if (start > end) {
    throw new LoopArgError(`pipeline:loop: --range start must be <= end, got "${range}"`);
  }
  const span = end - start + 1;
  if (!Number.isSafeInteger(span) || span > MAX_RANGE_SPAN) {
    throw new LoopArgError(
      `pipeline:loop: --range spans ${Number.isSafeInteger(span) ? span : "too many"} issues — the maximum is ${MAX_RANGE_SPAN}`,
    );
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
  if (raw.newRun && raw.resume) {
    throw new LoopArgError("pipeline:loop --new-run cannot be combined with --resume");
  }
  if (raw.newRun && present.length === 0) {
    throw new LoopArgError(
      "pipeline:loop --new-run requires a selector (--milestone, --label, --range, --roadmap-slice, or an issue list) naming the run to supersede",
    );
  }

  return {
    selector: present[0]?.[1],
    resumeRunId: raw.resume,
    audit: !!raw.audit,
    newRun: !!raw.newRun,
  };
}

// ---------------------------------------------------------------------------
// Fixed preflight order (design.md decision 4): normalize -> contract-coherence
// -> native-goal. Every step here is read-only; a failure exits with zero
// external mutation.
// ---------------------------------------------------------------------------

export type LoopPreflightOutcome =
  | { ok: true; args: LoopArgs }
  | { ok: false; failedCheck: "args" | "loop:store-schema-compatibility" | "native-goal"; detail: string; remediation?: string };

export async function runLoopPreflight(
  raw: RawLoopArgs,
  engine: LoopEngine,
  deps: DoctorDeps,
  roots: string[] = goalLoopDiscoveryRoots(engine),
  attestation: NativeGoalAttestation = "auto",
): Promise<LoopPreflightOutcome> {
  let args: LoopArgs;
  try {
    args = normalizeLoopArgs(raw);
  } catch (err) {
    return { ok: false, failedCheck: "args", detail: (err as Error).message };
  }

  const schemaCompat = checkLoopStoreSchemaCompatibility();
  if (schemaCompat.status === "fail") {
    return {
      ok: false,
      failedCheck: "loop:store-schema-compatibility",
      detail: schemaCompat.detail,
      remediation: schemaCompat.remediation,
    };
  }

  // Selector-free `--audit` is a read-only report on an existing canonical
  // run: it starts and resumes nothing, so the native-goal capability gate
  // does not apply — a cross-engine operator whose CLI lacks native /goal
  // support must still be able to audit (#451 delta finding ac3bdbd2).
  const auditOnly = args.audit && args.selector === undefined && args.resumeRunId === undefined;
  if (!auditOnly) {
    const nativeGoal = await checkNativeGoalCapability(deps, engine, attestation);
    if (nativeGoal.status === "fail") {
      return { ok: false, failedCheck: "native-goal", detail: nativeGoal.detail, remediation: nativeGoal.remediation };
    }
  }

  return { ok: true, args };
}
