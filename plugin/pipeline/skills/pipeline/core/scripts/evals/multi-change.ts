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
 * Reject treatment-visible leakage of held-out verifier bodies into a
 * checkpoint's task_input (or public_checks). Returns a human-readable
 * reason or null when clean.
 */
export function detectHeldOutLeakage(
  checkpoint: MultiChangeCheckpoint,
  allVerifiers: MultiChangeHeldOutVerifier[],
): string | null {
  const visible = [
    checkpoint.task_input,
    ...(checkpoint.public_checks ?? []),
    checkpoint.stage_entry_artifacts !== undefined
      ? JSON.stringify(checkpoint.stage_entry_artifacts)
      : "",
  ].join("\n");

  for (const v of allVerifiers) {
    const check = v.check.trim();
    if (check.length > 0 && visible.includes(check)) {
      return `held-out verifier check body for ${JSON.stringify(v.verifier_id)} appears in treatment-visible input`;
    }
  }
  return null;
}

/** Collect every held-out verifier across the fixture (ordered). */
export function allHeldOutVerifiers(fixture: Fixture): MultiChangeHeldOutVerifier[] {
  if (!fixture.checkpoints) return [];
  return fixture.checkpoints.flatMap((c) => c.held_out_verifiers);
}

/** Lightweight growth signals from path lists (before/after step). */
export function computeGrowthFromPaths(
  beforePaths: string[],
  afterPaths: string[],
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
    beforePaths.length === 0 ? (afterPaths.length > 0 ? afterPaths.length : null) : afterPaths.length / Math.max(1, beforePaths.length);
  return {
    files_added: added,
    files_modified: modified,
    change_amplification,
  };
}
