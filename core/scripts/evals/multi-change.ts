// Multi-change maintainability fixtures (#577): pure inheritance, defect
// accounting, prompt materialization, and evidence-contract helpers.
//
// Unit-testable without git/network/harness. The executor imports these for
// lineage execution; the grading layer reuses them for grades.jsonl.

import { createHash } from "node:crypto";
import type {
  Fixture,
  MultiChangeCheckpoint,
  MultiChangeHeldOutVerifier,
  Treatment,
} from "./types.ts";
import { isBareMultiChangeProfile, isMultiChangeFixture } from "./types.ts";

/** Artifacts the runner may preserve between multi-change checkpoints.
 *  Free-form chat and held-out verifier bodies are never in-contract. */
export const MULTI_CHANGE_EVIDENCE_CONTRACT = [
  "repository_state",
  "pipeline_evidence_bundle",
] as const;

export type MultiChangeEvidenceContractKey = (typeof MULTI_CHANGE_EVIDENCE_CONTRACT)[number];

/** Per-checkpoint resource use recorded on the evidence trail. */
export interface MultiChangeResourceUse {
  duration_sec: number;
  tokens?: number | null;
  cost_usd?: number | null;
  cost_source?: "actual" | "estimated" | "unknown";
  retries?: number;
  interventions?: number;
}

/** One step on the multi-change evidence trail (executor → grades). */
export interface MultiChangeCheckpointEvidence {
  checkpoint_id: string;
  checkpoint_index: number;
  /** Hash of the disclosed prompt for this step only. */
  prompt_hash: string;
  treatment_id: string;
  treatment_profile: string;
  model: string | null;
  harness: string | null;
  /** Fresh model/session identity for this checkpoint (no prior chat). */
  session_id: string;
  /** Tree fingerprint or revision after the step. */
  repo_fingerprint: string;
  /** verifier_id → pass for new + inherited verifiers at this step. */
  verifier_results: Record<string, boolean>;
  /** verifier_ids introduced at this checkpoint. */
  new_verifier_ids: string[];
  /** verifier_ids inherited from prior checkpoints. */
  inherited_verifier_ids: string[];
  resource: MultiChangeResourceUse;
  /** True when this step used a portability model override. */
  portability_probe: boolean;
  /** Evidence keys preserved into the next step (never chat / held-out bodies). */
  preserved_evidence_keys: MultiChangeEvidenceContractKey[];
  /** Structural telemetry (non-ground-truth). Optional; absent is not zero. */
  structural_telemetry?: MultiChangeStructuralTelemetry;
  /** Code growth / amplification signals (non-ground-truth). */
  growth?: MultiChangeGrowthSignals;
}

/** Deterministic structural telemetry — telemetry only, never pass/fail truth. */
export interface MultiChangeStructuralTelemetry {
  file_count?: number | null;
  production_loc?: number | null;
  test_loc?: number | null;
  touch_points?: string[];
  /** Free-form named metrics (complexity, duplication, …) without synthesis. */
  metrics?: Record<string, number | null>;
}

export interface MultiChangeGrowthSignals {
  files_added?: number | null;
  files_modified?: number | null;
  production_loc_delta?: number | null;
  test_loc_delta?: number | null;
  change_amplification?: number | null;
}

/** Defect-state fields for one graded checkpoint (#577). */
export interface MultiChangeDefectState {
  strict_pass: boolean;
  current_step_defects: string[];
  inherited_defects: string[];
  accumulated_unresolved: string[];
  recovered_defects: string[];
}

/** Full grade payload for a multi-change lineage. */
export interface MultiChangeGrade {
  checkpoints: Array<
    MultiChangeDefectState & {
      checkpoint_id: string;
      checkpoint_index: number;
      new_verifier_results: Record<string, boolean>;
      inherited_verifier_results: Record<string, boolean>;
      model: string | null;
      portability_probe: boolean;
      resource: MultiChangeResourceUse;
      structural_telemetry?: MultiChangeStructuralTelemetry;
      growth?: MultiChangeGrowthSignals;
    }
  >;
  /** True only when every verifier in the full closure passes at the final step. */
  terminal_all_green: boolean;
}

/** Held-out verifiers declared by checkpoints `0..k-1` (inherited set at k). */
export function inheritedVerifiers(
  checkpoints: MultiChangeCheckpoint[],
  checkpointIndex: number,
): MultiChangeHeldOutVerifier[] {
  const out: MultiChangeHeldOutVerifier[] = [];
  for (let i = 0; i < checkpointIndex && i < checkpoints.length; i++) {
    out.push(...checkpoints[i].held_out_verifiers);
  }
  return out;
}

/** Union of held-out verifiers for checkpoints `0..k` inclusive. */
export function verifiersThrough(
  checkpoints: MultiChangeCheckpoint[],
  checkpointIndexInclusive: number,
): MultiChangeHeldOutVerifier[] {
  const out: MultiChangeHeldOutVerifier[] = [];
  for (let i = 0; i <= checkpointIndexInclusive && i < checkpoints.length; i++) {
    out.push(...checkpoints[i].held_out_verifiers);
  }
  return out;
}

/** Map of verifier_id → check command for the full fixture closure. */
export function verifierCheckMap(fixture: Fixture): Map<string, string> {
  const map = new Map<string, string>();
  if (!isMultiChangeFixture(fixture) || !fixture.checkpoints) return map;
  for (const cp of fixture.checkpoints) {
    for (const v of cp.held_out_verifiers) {
      map.set(v.verifier_id, v.check);
    }
  }
  return map;
}

/**
 * Compute defect-state fields for checkpoint k given verifier pass/fail
 * results for new + inherited verifiers, and the prior step's accumulated
 * unresolved set (empty at k=0).
 */
export function computeDefectState(args: {
  newVerifierIds: string[];
  inheritedVerifierIds: string[];
  verifierResults: Record<string, boolean>;
  priorAccumulatedUnresolved: string[];
}): MultiChangeDefectState {
  const current_step_defects = args.newVerifierIds.filter((id) => args.verifierResults[id] !== true);
  const inherited_defects = args.inheritedVerifierIds.filter((id) => args.verifierResults[id] !== true);
  const failingNow = new Set([...current_step_defects, ...inherited_defects]);
  const recovered_defects = args.priorAccumulatedUnresolved.filter((id) => args.verifierResults[id] === true);
  // Accumulated unresolved = still-failing from prior union plus new failures.
  const accumulated = new Set<string>([...args.priorAccumulatedUnresolved.filter((id) => failingNow.has(id))]);
  for (const id of failingNow) accumulated.add(id);
  const accumulated_unresolved = [...accumulated].sort();
  return {
    strict_pass: current_step_defects.length === 0 && inherited_defects.length === 0,
    current_step_defects: [...current_step_defects].sort(),
    inherited_defects: [...inherited_defects].sort(),
    accumulated_unresolved,
    recovered_defects: [...recovered_defects].sort(),
  };
}

/** Grade an entire multi-change lineage from per-checkpoint evidence. */
export function gradeMultiChangeLineage(
  fixture: Fixture,
  evidence: MultiChangeCheckpointEvidence[],
): MultiChangeGrade {
  if (!isMultiChangeFixture(fixture) || !fixture.checkpoints) {
    throw new Error("gradeMultiChangeLineage: fixture is not multi_change");
  }
  const checkpoints = fixture.checkpoints;
  const graded: MultiChangeGrade["checkpoints"] = [];
  let priorAccumulated: string[] = [];

  for (let k = 0; k < evidence.length; k++) {
    const step = evidence[k];
    const newIds = step.new_verifier_ids;
    const inheritedIds = step.inherited_verifier_ids;
    const state = computeDefectState({
      newVerifierIds: newIds,
      inheritedVerifierIds: inheritedIds,
      verifierResults: step.verifier_results,
      priorAccumulatedUnresolved: priorAccumulated,
    });
    const new_verifier_results: Record<string, boolean> = {};
    for (const id of newIds) new_verifier_results[id] = step.verifier_results[id] === true;
    const inherited_verifier_results: Record<string, boolean> = {};
    for (const id of inheritedIds) inherited_verifier_results[id] = step.verifier_results[id] === true;

    graded.push({
      checkpoint_id: step.checkpoint_id,
      checkpoint_index: step.checkpoint_index,
      ...state,
      new_verifier_results,
      inherited_verifier_results,
      model: step.model,
      portability_probe: step.portability_probe,
      resource: step.resource,
      ...(step.structural_telemetry ? { structural_telemetry: step.structural_telemetry } : {}),
      ...(step.growth ? { growth: step.growth } : {}),
    });
    priorAccumulated = state.accumulated_unresolved;
  }

  // Terminal all-green: final step has every verifier in the full closure green.
  let terminal_all_green = false;
  if (evidence.length === checkpoints.length && evidence.length > 0) {
    const last = evidence[evidence.length - 1];
    const full = verifiersThrough(checkpoints, checkpoints.length - 1);
    terminal_all_green = full.every((v) => last.verifier_results[v.verifier_id] === true);
  }

  return { checkpoints: graded, terminal_all_green };
}

/** Materialize the treatment-visible prompt for one multi-change checkpoint.
 *  Never includes later checkpoints' requirements or held-out verifier bodies. */
export function materializeMultiChangeCheckpointPrompt(
  fixture: Fixture,
  checkpoint: MultiChangeCheckpoint,
  profile: string,
): string {
  const profileLabel = isBareMultiChangeProfile(profile)
    ? "bare / just-solve"
    : profile === "pipeline-current"
      ? "Agent Pipeline (current)"
      : profile;

  const parts = [
    "You are applying the next change in a multi-change maintainability evaluation.",
    `Treatment profile: ${profileLabel}.`,
    "",
    "Apply ONLY the requirement disclosed below. Do not invent later requirements.",
    "Do not attempt to discover or run hidden evaluation verifiers.",
    "",
    "## Current requirement",
    checkpoint.task_input,
  ];

  const artifacts = checkpoint.stage_entry_artifacts ?? fixture.stage_entry_artifacts;
  const impl = artifacts?.implementing;
  if (impl !== undefined) {
    parts.push("", "## Stage input", JSON.stringify(impl, null, 2));
  }

  if (profile === "pipeline-current" || profile === "adversarial-review") {
    parts.push(
      "",
      "## Treatment profile notes",
      profile === "adversarial-review"
        ? "Use the pipeline review path with adversarial review enabled where configured."
        : "Use the current Agent Pipeline treatment graph (implement + review discipline).",
    );
  }
  if (profile === "quality-feedback") {
    parts.push(
      "",
      "## Quality feedback",
      "Deterministic code-quality signals may be injected as feedback. They are advisory telemetry, not maintainability ground truth.",
    );
  }
  if (profile === "design-dossier") {
    parts.push(
      "",
      "## Design dossier (#575)",
      "When risk policy fires, produce design-dossier / human-attestation materials. If #575 controls are unconfigured, proceed without them.",
    );
  }

  parts.push(
    "",
    "## Evaluation execution constraints (mandatory)",
    "You are inside an isolated evaluation worktree. Do not push, open PRs, or call production GitHub APIs.",
  );

  return parts.join("\n");
}

/** Resolve the treatment profile for a multi-change cell. */
export function resolveMultiChangeProfile(treatment: Treatment, mode: string): string {
  if (treatment.profile) return treatment.profile;
  if (mode === "implementing-paired" || mode === "pipeline-paired" || mode === "end-to-end") {
    return "pipeline-current";
  }
  return "bare";
}

/** Effective model/harness/effort for a checkpoint (portability override wins). */
export function resolveCheckpointCoordinates(
  treatment: Treatment,
  checkpoint: MultiChangeCheckpoint,
): { model: string | undefined; harness: string | undefined; effort: string | undefined; portability: boolean } {
  if (checkpoint.portability?.model) {
    return {
      model: checkpoint.portability.model,
      harness: checkpoint.portability.harness ?? treatment.harness,
      effort: checkpoint.portability.effort ?? treatment.effort,
      portability: true,
    };
  }
  return {
    model: treatment.model,
    harness: treatment.harness,
    effort: treatment.effort,
    portability: false,
  };
}

/** SHA-256 hex of prompt text (evidence trail). */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/**
 * A treatment-visible text channel to scan for held-out verifier leakage.
 * `label` is used in rejection messages (e.g. "fixture task_input",
 * `checkpoint "C1" public_checks[0]`).
 */
export type TreatmentVisibleSource = { label: string; text: string };

/**
 * Reject treatment-visible leakage of held-out verifier bodies or identifiers
 * into any disclosed fixture/checkpoint field (task_input, public checks,
 * stage-entry artifacts). Returns a human-readable reason or null when clean.
 *
 * Public-check *wrappers* that embed a held-out command body are rejected
 * (substring containment), not only exact command equality.
 */
export function detectHeldOutLeakage(
  sources: TreatmentVisibleSource[],
  allVerifiers: MultiChangeHeldOutVerifier[],
): string | null {
  for (const v of allVerifiers) {
    const check = v.check.trim();
    for (const src of sources) {
      if (!src.text) continue;
      if (check.length > 0 && src.text.includes(check)) {
        return `held-out verifier check body for ${JSON.stringify(v.verifier_id)} appears in treatment-visible ${src.label}`;
      }
      // Identifiers are treatment-visible oracle channels when embedded in prompts/artifacts.
      if (v.verifier_id.length > 0 && src.text.includes(v.verifier_id)) {
        return `held-out verifier id ${JSON.stringify(v.verifier_id)} appears in treatment-visible ${src.label}`;
      }
    }
  }
  return null;
}

/** Collect treatment-visible text sources for one multi-change checkpoint. */
export function checkpointVisibleSources(checkpoint: MultiChangeCheckpoint): TreatmentVisibleSource[] {
  const sources: TreatmentVisibleSource[] = [
    { label: `checkpoint ${JSON.stringify(checkpoint.checkpoint_id)} task_input`, text: checkpoint.task_input },
  ];
  for (let i = 0; i < (checkpoint.public_checks ?? []).length; i++) {
    sources.push({
      label: `checkpoint ${JSON.stringify(checkpoint.checkpoint_id)} public_checks[${i}]`,
      text: checkpoint.public_checks![i],
    });
  }
  if (checkpoint.stage_entry_artifacts !== undefined) {
    sources.push({
      label: `checkpoint ${JSON.stringify(checkpoint.checkpoint_id)} stage_entry_artifacts`,
      text: JSON.stringify(checkpoint.stage_entry_artifacts),
    });
  }
  return sources;
}

/** Collect fixture-level treatment-visible sources (synopsis, public checks, stage entry). */
export function fixtureVisibleSources(fixture: {
  task_input: string;
  public_checks: string[];
  stage_entry_artifacts?: unknown;
}): TreatmentVisibleSource[] {
  const sources: TreatmentVisibleSource[] = [
    { label: "fixture task_input", text: fixture.task_input },
  ];
  for (let i = 0; i < fixture.public_checks.length; i++) {
    sources.push({ label: `fixture public_checks[${i}]`, text: fixture.public_checks[i] });
  }
  if (fixture.stage_entry_artifacts !== undefined) {
    sources.push({
      label: "fixture stage_entry_artifacts",
      text: JSON.stringify(fixture.stage_entry_artifacts),
    });
  }
  return sources;
}

/** Collect every held-out verifier across the fixture (ordered). */
export function allHeldOutVerifiers(fixture: Fixture): MultiChangeHeldOutVerifier[] {
  if (!fixture.checkpoints) return [];
  return fixture.checkpoints.flatMap((c) => c.held_out_verifiers);
}

/**
 * Content-addressed repository fingerprint inputs (pure). Two distinct edits
 * to the same path MUST produce different digests when trackedDiff or untracked
 * content hashes differ — path-only porcelain status is not sufficient.
 */
export function contentAddressedRepoFingerprint(parts: {
  headSha: string;
  /** Full unified diff of tracked changes vs HEAD (staged + unstaged). */
  trackedDiff: string;
  /** Sorted untracked paths with content digests (empty file → empty hash). */
  untrackedFiles: Array<{ path: string; contentSha256: string }>;
}): string {
  const h = createHash("sha256");
  h.update("head:");
  h.update(parts.headSha.trim());
  h.update("\ntracked-diff:");
  h.update(parts.trackedDiff);
  h.update("\nuntracked:\n");
  const sorted = [...parts.untrackedFiles].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    h.update(f.path);
    h.update("\0");
    h.update(f.contentSha256);
    h.update("\n");
  }
  return h.digest("hex");
}

/** Classify a repo-relative path as production, test, or other for growth metrics. */
export function classifyCodePath(relPath: string): "production" | "test" | "other" {
  const p = relPath.replace(/\\/g, "/");
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java)$/i.test(p)) return "other";
  if (
    /(^|\/)(test|tests|__tests__|spec|specs)(\/|$)/i.test(p) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p)
  ) {
    return "test";
  }
  return "production";
}

/** Deterministic structural metrics extracted from a single source file body. */
export function analyzeSourceText(content: string): {
  loc: number;
  function_count: number;
  branch_complexity: number;
  max_nesting: number;
  import_edge_count: number;
} {
  const lines = content.split(/\r?\n/);
  let loc = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
    loc++;
  }
  // Function/method declarations (JS/TS/Python-ish) — telemetry only, not a language parser.
  const function_count = (
    content.match(
      /\b(?:function\s+[A-Za-z_$][\w$]*|export\s+(?:async\s+)?function\b|(?:async\s+)?function\b|[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(|[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?function\b|def\s+[A-Za-z_][\w]*\s*\()/g,
    ) ?? []
  ).length;
  const branch_complexity = (
    content.match(/\b(if|else\s+if|elif|for|while|case|catch|switch)\b|\?\.|\?[^.]|&&|\|\|/g) ?? []
  ).length;
  let max_nesting = 0;
  let depth = 0;
  for (const ch of content) {
    if (ch === "{" || ch === "(") {
      depth++;
      if (depth > max_nesting) max_nesting = depth;
    } else if (ch === "}" || ch === ")") {
      depth = Math.max(0, depth - 1);
    }
  }
  const import_edge_count = (
    content.match(
      /^\s*(?:import\s|export\s+.+from\s|require\s*\(|from\s+\S+\s+import\s)/gm,
    ) ?? []
  ).length;
  return { loc, function_count, branch_complexity, max_nesting, import_edge_count };
}

/**
 * Build structural telemetry from post-step file contents. Metrics that cannot
 * be derived deterministically from path+text alone are recorded as `null`
 * (unavailable coverage) — never silently replaced by changed-path count.
 */
export function buildStructuralTelemetry(args: {
  /** Repo-relative path + full text of files present in the graded tree slice. */
  files: Array<{ path: string; content: string }>;
  changedPaths: string[];
}): {
  structural: MultiChangeStructuralTelemetry;
  production_loc: number;
  test_loc: number;
} {
  let production_loc = 0;
  let test_loc = 0;
  let function_count = 0;
  let branch_complexity = 0;
  let max_nesting = 0;
  let import_edge_count = 0;
  let source_file_count = 0;

  for (const f of args.files) {
    const kind = classifyCodePath(f.path);
    if (kind === "other") continue;
    source_file_count++;
    const m = analyzeSourceText(f.content);
    if (kind === "production") production_loc += m.loc;
    else test_loc += m.loc;
    function_count += m.function_count;
    branch_complexity += m.branch_complexity;
    if (m.max_nesting > max_nesting) max_nesting = m.max_nesting;
    import_edge_count += m.import_edge_count;
  }

  const structural: MultiChangeStructuralTelemetry = {
    file_count: source_file_count,
    production_loc,
    test_loc,
    touch_points: args.changedPaths.slice(0, 50),
    metrics: {
      changed_path_count: args.changedPaths.length,
      production_loc,
      test_loc,
      function_count,
      branch_complexity,
      max_nesting,
      import_edge_count,
      // Unavailable without heavier whole-repo analysis — explicit null coverage.
      duplication: null,
      dependency_cycles: null,
      symbol_churn: null,
      single_use_wrappers: null,
      propagation_cost: null,
    },
  };
  return { structural, production_loc, test_loc };
}

/** Growth signals from path lists plus measured production/test LOC deltas. */
export function computeGrowthFromPaths(
  beforePaths: string[],
  afterPaths: string[],
  loc?: {
    beforeProductionLoc: number;
    afterProductionLoc: number;
    beforeTestLoc: number;
    afterTestLoc: number;
  },
): MultiChangeGrowthSignals {
  const before = new Set(beforePaths);
  const after = new Set(afterPaths);
  let added = 0;
  let modified = 0;
  for (const p of after) {
    if (!before.has(p)) added++;
    else modified++; // present in both — count as touch if listed as changed
  }
  // `afterPaths` is typically the set of paths that differ from base; treat
  // length delta as amplification proxy when before is previous step's set.
  const change_amplification =
    beforePaths.length === 0
      ? afterPaths.length > 0
        ? afterPaths.length
        : null
      : afterPaths.length / Math.max(1, beforePaths.length);
  return {
    files_added: added,
    files_modified: modified,
    change_amplification,
    production_loc_delta: loc
      ? loc.afterProductionLoc - loc.beforeProductionLoc
      : null,
    test_loc_delta: loc ? loc.afterTestLoc - loc.beforeTestLoc : null,
  };
}
