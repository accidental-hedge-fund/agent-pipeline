// `pipeline evals harvest` (#535, openspec/changes/eval-fixture-harvest): a
// human-approved workflow that turns sanitized run/correction evidence into a
// reviewable eval fixture draft. Draft-only by default — a repository write
// requires an explicit apply/promote action (harvest.ts never calls gh.ts;
// it has no GitHub write path at all, structurally stronger than a refusal
// surface). It authors a candidate fixture; it never queues, advances,
// overrides, merges, or deploys anything, and it never grants itself the
// authority to define success unilaterally — promotion always re-validates
// with the same loader a hand-authored fixture goes through.

import * as path from "node:path";
import { createHash } from "node:crypto";
import { redactSecrets, sanitize, sanitizeDeep } from "../artifact-sanitize.ts";
import { FixtureValidationError, validateFixture } from "./fixture.ts";
import { expandPlan, stableStringify } from "./manifest.ts";
import type {
  AcceptanceCriterion,
  CapabilitySurfaceInventory,
  EnvironmentDependency,
  EnvironmentDependencyMode,
  EvalStageName,
  ExperimentManifest,
  Fixture,
  GraderRef,
  RunPlan,
} from "./types.ts";
import type { ClusterEntry, ControlLevel } from "../improve.ts";
import type { CorrectionEvent } from "../correction.ts";

export class HarvestValidationError extends Error {
  constructor(field: string, detail: string) {
    super(`Harvest: invalid field "${field}" — ${detail}`);
    this.name = "HarvestValidationError";
  }
}

export class HarvestMissingEvidenceError extends Error {
  constructor() {
    super("Harvest: no usable evidence reference was supplied (run artifact, improve cluster, or correction_event/control proposal)");
    this.name = "HarvestMissingEvidenceError";
  }
}

// ---------------------------------------------------------------------------
// Evidence intake
// ---------------------------------------------------------------------------

/** A sanitized excerpt from a normal pipeline run artifact describing a
 *  recurring failure. */
export interface RunArtifactEvidence {
  kind: "run-artifact";
  run_id: string;
  stage: string;
  excerpt: string;
  affected_items?: string[];
  recurrence_count?: number;
}

/** A `pipeline improve` cluster (#303/#500) offered as harvest evidence. */
export interface ImproveClusterEvidence {
  kind: "improve-cluster";
  cluster: ClusterEntry;
}

/** A `correction_event` / control proposal (#499/#500) offered as harvest
 *  evidence. */
export interface CorrectionEventEvidence {
  kind: "correction-event";
  event: CorrectionEvent;
}

export type HarvestEvidence = RunArtifactEvidence | ImproveClusterEvidence | CorrectionEventEvidence;

/** Route every string field of an evidence reference through the existing
 *  secret-redaction + injection-denylist pipeline before it can enter a
 *  proposal body or draft — belt-and-suspenders even when the evidence's
 *  origin (correction.ts, improve.ts) already sanitized it once. */
export function sanitizeEvidence(evidence: HarvestEvidence): HarvestEvidence {
  const clean = (s: string): string => sanitize(redactSecrets(s));
  switch (evidence.kind) {
    case "run-artifact":
      return {
        ...evidence,
        excerpt: clean(evidence.excerpt),
        affected_items: evidence.affected_items?.map(clean),
      };
    case "improve-cluster":
      return { kind: "improve-cluster", cluster: sanitizeDeep(evidence.cluster) };
    case "correction-event":
      return { kind: "correction-event", event: sanitizeDeep(evidence.event) };
  }
}

/** Short, stable content signature so two distinct run-artifact excerpts in
 *  the same stage are never conflated into one evidence signal (review 1
 *  finding 0a961a53) — stage alone previously grouped unrelated failures. */
function excerptSignature(excerpt: string): string {
  return createHash("sha1").update(excerpt).digest("hex").slice(0, 12);
}

function evidenceSignal(evidence: HarvestEvidence): string {
  switch (evidence.kind) {
    case "run-artifact":
      return `run-artifact:${evidence.stage}:${excerptSignature(evidence.excerpt)}`;
    case "improve-cluster":
      return `improve-cluster:${evidence.cluster.category}:${evidence.cluster.signal}`;
    case "correction-event":
      return `correction-event:${evidence.event.correction_key}`;
  }
}

function evidenceExcerpt(evidence: HarvestEvidence): string {
  switch (evidence.kind) {
    case "run-artifact":
      return evidence.excerpt;
    case "improve-cluster":
      return evidence.cluster.excerpt;
    case "correction-event":
      return evidence.event.correction;
  }
}

function evidenceStage(evidence: HarvestEvidence): string | null {
  switch (evidence.kind) {
    case "run-artifact":
      return evidence.stage;
    case "improve-cluster":
      return evidence.cluster.correction?.stages[0] ?? null;
    case "correction-event":
      return evidence.event.stage;
  }
}

function evidenceAffectedItems(evidence: HarvestEvidence): string[] {
  switch (evidence.kind) {
    case "run-artifact":
      return evidence.affected_items ?? [evidence.run_id];
    case "improve-cluster":
      return evidence.cluster.correction?.distinctItemIds ?? evidence.cluster.runIds;
    case "correction-event":
      return [evidence.event.run_id];
  }
}

function evidenceRecurrenceCount(evidence: HarvestEvidence): number | undefined {
  switch (evidence.kind) {
    case "run-artifact":
      return evidence.recurrence_count;
    case "improve-cluster":
      return evidence.cluster.correction?.distinctRunCount ?? evidence.cluster.count;
    case "correction-event":
      return undefined;
  }
}

/** The evidence's own view of the appropriate next control level (#500's
 *  graduation ladder), when it carries one. Plain run-artifact evidence
 *  carries no compiler-derived control level of its own. */
function evidenceControlLevel(evidence: HarvestEvidence): ControlLevel | undefined {
  switch (evidence.kind) {
    case "run-artifact":
      return undefined;
    case "improve-cluster":
      return evidence.cluster.correction?.controlLevel;
    case "correction-event":
      return evidence.event.proposed_control as ControlLevel | undefined;
  }
}

// ---------------------------------------------------------------------------
// Capability-surface inventory
// ---------------------------------------------------------------------------

/** Explicit, caller-resolved surface facts to merge into the inventory.
 *  Harvest never re-derives repo/harness state on its own from live
 *  git/process state — the surface is a resolved snapshot the caller
 *  supplies (from run artifacts/config already read elsewhere), not a
 *  free-text guess (eval-fixture-harvest #535). */
export interface SurfaceHints {
  stage?: string;
  materialized_prompts?: string[];
  harness_config?: Record<string, unknown>;
  tools_hooks?: string[];
  repo_paths?: string[];
  services_data?: string[];
}

/** Resolve the capability-surface inventory for a harvest candidate: stage,
 *  materialized prompts, harness/model configuration, tools/hooks, repo
 *  paths, and referenced services/data dependencies. */
export function resolveCapabilitySurface(
  evidence: HarvestEvidence[],
  hints: SurfaceHints = {},
): CapabilitySurfaceInventory {
  const stage = hints.stage ?? evidence.map(evidenceStage).find((s): s is string => !!s);
  if (!stage) {
    throw new HarvestValidationError(
      "stage",
      "could not be resolved from the supplied evidence or surface_hints — a capability-surface inventory requires a stage",
    );
  }
  // Reject a harvest that never resolved the required agent surface rather
  // than hashing an empty placeholder inventory (review 1 finding 22ff7d0b):
  // the materialized prompt and the repository paths touched are the two
  // dimensions every real candidate has, so a caller supplying neither has
  // not actually resolved this candidate's surface.
  if (!hints.materialized_prompts || hints.materialized_prompts.length === 0) {
    throw new HarvestValidationError(
      "surface_hints.materialized_prompts",
      "must be a non-empty array of the candidate's materialized prompt(s) — omitting it silently defaults to an unresolved empty surface",
    );
  }
  if (!hints.repo_paths || hints.repo_paths.length === 0) {
    throw new HarvestValidationError(
      "surface_hints.repo_paths",
      "must be a non-empty array of the repository paths the candidate touched — omitting it silently defaults to an unresolved empty surface",
    );
  }
  return sanitizeDeep({
    stage,
    materialized_prompts: hints.materialized_prompts ?? [],
    harness_config: hints.harness_config ?? {},
    tools_hooks: hints.tools_hooks ?? [],
    repo_paths: hints.repo_paths ?? [],
    services_data: hints.services_data ?? [],
  });
}

// ---------------------------------------------------------------------------
// Single bounded ability/failure-mode proposal
// ---------------------------------------------------------------------------

export interface AbilityProposal {
  /** Exactly one bounded ability or failure mode to measure. */
  ability: string;
  control_level: ControlLevel;
  rationale: string;
  source_evidence: string[];
  affected_items: string[];
  recurrence_count?: number;
}

/** Propose exactly one bounded ability/failure mode from one or more
 *  evidence references. Refuses (rather than silently batching) when the
 *  supplied evidence spans more than one distinct ability/failure mode —
 *  a maintainer must narrow to coherent evidence for a single harvest. */
export function proposeAbility(evidence: HarvestEvidence[]): AbilityProposal {
  if (evidence.length === 0) {
    throw new HarvestMissingEvidenceError();
  }
  const sanitized = evidence.map(sanitizeEvidence);
  const signals = new Set(sanitized.map(evidenceSignal));
  if (signals.size > 1) {
    throw new HarvestValidationError(
      "evidence",
      `spans ${signals.size} distinct abilities/failure modes (${[...signals].join(", ")}) — narrow to evidence for a single bounded ability per harvest`,
    );
  }

  const affectedItems = [...new Set(sanitized.flatMap(evidenceAffectedItems))];
  const recurrenceCounts = sanitized.map(evidenceRecurrenceCount).filter((c): c is number => c !== undefined);
  const recurrenceCount = recurrenceCounts.length > 0 ? Math.max(...recurrenceCounts) : undefined;
  const controlLevel = sanitized.map(evidenceControlLevel).find((c): c is ControlLevel => !!c) ?? "eval";
  const ability = evidenceExcerpt(sanitized[0]).slice(0, 240);

  const rationale =
    controlLevel === "eval"
      ? `Evidence recurs across ${affectedItems.length} item(s)${recurrenceCount !== undefined ? ` (recurrence count ${recurrenceCount})` : ""} in a way a documented rule or skill/rubric cannot deterministically catch — a frozen regression fixture is the appropriate control.`
      : `Source evidence names "${controlLevel}" (not "eval") as the appropriate next control level — harvest records this rather than fabricating an eval fixture for evidence that does not warrant one.`;

  return {
    ability,
    control_level: controlLevel,
    rationale,
    source_evidence: sanitized.map(evidenceSignal),
    affected_items: affectedItems,
    recurrence_count: recurrenceCount,
  };
}

// ---------------------------------------------------------------------------
// Default-safe environment-fidelity modes
// ---------------------------------------------------------------------------

export interface EnvironmentDependencyInput {
  name: string;
  /** Omit to let the default-mode rule decide (`simulated` when a
   *  deterministic stand-in is possible, else `forbidden`). `live` is never
   *  chosen by default — it must be requested explicitly. */
  mode?: EnvironmentDependencyMode;
  /** Whether a deterministic simulated stand-in is possible for this
   *  dependency. Only consulted when `mode` is omitted. Defaults to true
   *  (simulate unless the caller says it can't be simulated). */
  deterministic_simulation_possible?: boolean;
  /** Required to set `mode: "live"` on a dependency that can incur cost,
   *  mutate external state, or access production data — an explicit
   *  maintainer selection, never inferred. */
  live_selected?: boolean;
  version: string;
  required_permissions: string[];
  initial_state: unknown;
  expected: { outputs?: unknown; errors?: unknown };
  setup: string;
  teardown: string;
}

/** Apply the default-safe-mode rule and the explicit-live-selection
 *  requirement (eval-fixture-contract #535): a dependency's mode defaults to
 *  `simulated`/`forbidden`, never `live`; `live` requires `live_selected:
 *  true` or rendering fails rather than silently promoting a live default. */
export function resolveEnvironmentDependencies(inputs: EnvironmentDependencyInput[]): EnvironmentDependency[] {
  return inputs.map((input) => {
    const mode: EnvironmentDependencyMode =
      input.mode ?? (input.deterministic_simulation_possible === false ? "forbidden" : "simulated");
    if (mode === "live" && !input.live_selected) {
      throw new HarvestValidationError(
        "environment",
        `dependency ${JSON.stringify(input.name)} is set to "live" without an explicit maintainer selection ("live_selected: true") — refusing to render a draft that silently defaults to live`,
      );
    }
    return {
      name: input.name,
      mode,
      version: input.version,
      required_permissions: input.required_permissions,
      initial_state: input.initial_state,
      expected: input.expected,
      setup: input.setup,
      teardown: input.teardown,
    };
  });
}

// ---------------------------------------------------------------------------
// Draft rendering + iterative revision
// ---------------------------------------------------------------------------

export interface HarvestDraftInput {
  evidence: HarvestEvidence[];
  base_commit: string;
  /** Explicit task input text; when omitted, derived from the proposed
   *  ability's excerpt. */
  task_input?: string;
  stage_entry_artifacts: Partial<Record<EvalStageName, unknown>>;
  public_checks?: string[];
  hidden_checks?: string[];
  acceptance_criteria?: AcceptanceCriterion[];
  allowed_change_paths?: string[];
  grader_refs: GraderRef[];
  category: string;
  risk: string;
  environment?: EnvironmentDependencyInput[];
  surface_hints?: SurfaceHints;
  fixture_id?: string;
}

export interface HarvestDraft {
  input: HarvestDraftInput;
  fixture: Fixture;
  raw: Record<string, unknown>;
  ability: AbilityProposal;
  surface: CapabilitySurfaceInventory;
}

function deriveFixtureId(ability: AbilityProposal, baseCommit: string): string {
  const basis = stableStringify({ ability: ability.ability, source_evidence: ability.source_evidence, base_commit: baseCommit });
  return `harvested-${createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
}

/** Render a fixture draft conforming to the #432/#433 fixture and grader
 *  contracts from one or more evidence references. Throws
 *  {@link HarvestMissingEvidenceError} / {@link HarvestValidationError} /
 *  {@link FixtureValidationError} — never emits a degraded draft. */
export function renderDraft(input: HarvestDraftInput): HarvestDraft {
  if (!input.evidence || input.evidence.length === 0) {
    throw new HarvestMissingEvidenceError();
  }
  const ability = proposeAbility(input.evidence);
  if (ability.control_level !== "eval") {
    throw new HarvestValidationError(
      "control_level",
      `evidence names "${ability.control_level}" (not "eval") as the appropriate next control level — refusing to render an eval fixture for evidence that does not warrant one (review 1 finding a0f0770d)`,
    );
  }
  const surface = resolveCapabilitySurface(input.evidence, input.surface_hints);
  const environment = input.environment ? resolveEnvironmentDependencies(input.environment) : undefined;
  const taskInput = sanitize(redactSecrets(input.task_input ?? `Reproduce and resolve: ${ability.ability}`));
  const fixtureId = input.fixture_id ?? deriveFixtureId(ability, input.base_commit);

  // Every stage-entry artifact and check is evidence-derived and can carry a
  // secret or raw production payload (review 1 finding 349ec0b4) — route them
  // through the same sanitization the task input already gets, at render
  // time, so `raw` (printed to stdout, written via --out, and promoted) is
  // sanitized before it is ever stored or emitted, not only inside
  // `promoteDraft`'s belt-and-suspenders pass.
  const stageEntryArtifacts = sanitizeDeep(input.stage_entry_artifacts);
  const publicChecks = sanitizeDeep(input.public_checks ?? []);
  const hiddenChecks = input.hidden_checks ? sanitizeDeep(input.hidden_checks) : undefined;
  const acceptanceCriteria = input.acceptance_criteria ? sanitizeDeep(input.acceptance_criteria) : undefined;

  const raw: Record<string, unknown> = {
    fixture_id: fixtureId,
    schema_version: 1,
    base_commit: input.base_commit,
    task_input: taskInput,
    stage_entry_artifacts: stageEntryArtifacts,
    public_checks: publicChecks,
    ...(hiddenChecks ? { hidden_checks: hiddenChecks } : {}),
    ...(acceptanceCriteria ? { acceptance_criteria: acceptanceCriteria } : {}),
    ...(input.allowed_change_paths ? { allowed_change_paths: input.allowed_change_paths } : {}),
    grader_refs: input.grader_refs,
    category: input.category,
    risk: input.risk,
    provenance: "harvested",
    ...(environment ? { environment } : {}),
    capability_surface: surface,
  };

  const fixture = validateFixture(raw, fixtureId);
  return { input, fixture, raw, ability, surface };
}

/** Iteratively revise a draft's proposed ability, task, dependency modes,
 *  checks, or grader, re-rendering a consistent draft after each edit. */
export function reviseDraft(draft: HarvestDraft, patch: Partial<HarvestDraftInput>): HarvestDraft {
  return renderDraft({ ...draft.input, ...patch });
}

// ---------------------------------------------------------------------------
// Promotion: explicit apply, loader-validated, optional plan-only proof
// ---------------------------------------------------------------------------

export interface PromoteDeps {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

export interface PromoteOpts {
  /** Repository writes require this explicit approval — the sole default
   *  (`false`) never writes into the eval corpus. */
  apply: boolean;
  /** When true (and `apply` is true), also expand a plan-only experiment
   *  over the promoted fixture proving it is executable — no live model
   *  call, no production GitHub write (reuses the pure `expandPlan`). */
  planOnly?: boolean;
}

export interface PromoteResult {
  written: boolean;
  fixturePath?: string;
  plan?: RunPlan;
}

async function defaultMkdir(dir: string): Promise<void> {
  const fs = await import("node:fs");
  await fs.promises.mkdir(dir, { recursive: true });
}
async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  const fs = await import("node:fs");
  await fs.promises.writeFile(filePath, content, "utf8");
}

/** Promote a rendered draft into the repo's eval corpus. Draft-only is the
 *  sole default: `opts.apply` must be explicitly `true` or nothing is
 *  written. Re-validates the draft with the existing fixture loader —
 *  rejecting an invalid draft by naming the offending field — before any
 *  write, and can additionally prove the draft expands into an executable
 *  cell plan (plan-only: no live model call, no production GitHub write —
 *  this module makes no GitHub call of any kind). */
export async function promoteDraft(
  draft: HarvestDraft,
  fixturesDir: string,
  opts: PromoteOpts,
  deps: PromoteDeps = {},
): Promise<PromoteResult> {
  if (!opts.apply) {
    return { written: false };
  }
  // Re-validate against the existing loader: naming the offending field on
  // failure and never writing an invalid draft into the corpus.
  const fixture = validateFixture(draft.raw, draft.fixture.fixture_id);

  const mkdirFn = deps.mkdir ?? defaultMkdir;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const fixturePath = path.join(fixturesDir, `${fixture.fixture_id}.json`);
  await mkdirFn(fixturesDir);
  await writeFileFn(fixturePath, `${JSON.stringify(sanitizeDeep(draft.raw), null, 2)}\n`);

  let plan: RunPlan | undefined;
  if (opts.planOnly) {
    const manifest: ExperimentManifest = {
      schema_version: 1,
      experiment_id: `harvest-plan-only-${fixture.fixture_id}`,
      fixture_ids: [fixture.fixture_id],
      mode: "end-to-end",
      treatments: { harness: ["claude"] },
      replicates: 1,
      seed: 1,
      concurrency: 1,
      timeout: 60,
      output_dir: "",
    };
    plan = expandPlan(manifest, new Map([[fixture.fixture_id, fixture]]));
  }

  return { written: true, fixturePath, plan };
}

export { FixtureValidationError };
