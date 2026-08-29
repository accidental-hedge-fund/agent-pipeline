// Factory Reliability Gate (FRG) — mandatory multi-item reliability precondition
// for every release (#723, capability `factory-reliability-gate`).
//
// Layer A (hermetic composition tests) lives under core/test/*factory-reliability*.
// Layer B (this module): scripted driver that scores a durable loop run against
// fixed numeric thresholds and writes an immutable evidence artifact under
// `.agent-pipeline/frg/<version>/…`. Release preparation looks up a pass artifact
// for the resolved version and fails closed when missing, unparsable, or failed.
//
// FRG observes and scores only — it never merges PRs, enables auto-merge, or
// creates release tags (golden rule #4). After a release-eligible pass it MAY
// close synthetic pack PRs/issues without merging as post-pass hygiene (#754).

import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  isDurableBlockerClass,
  type DurableBlockerClass,
  type LoopContract,
  type LoopLedger,
  type LoopItemState,
} from "./loop/types.ts";
import {
  requirePresentedFrgAttestationKey,
  type PresentFrgAttestorCredentialDeps,
} from "./ship-end-candidate.ts";
import {
  FRG_HYBRID_LIVE_COMPOSITION_IDS,
  FRG_HYBRID_LIVE_SCENARIO_IDS,
  FRG_HYBRID_PILOT_POLICY_ID,
  FRG_HYBRID_PILOT_VERSION,
  FRG_HYBRID_REPLACEMENT_ISSUE,
  FRG_HYBRID_V2_POLICY_ID,
  expectedHybridLayerAProbeIds,
  expectedHybridManifestSha256,
  hybridProvenanceRequired,
  isFrgHybridV1PolicyId,
  isFrgHybridV2PolicyId,
  isFrgRequiredLiveCompositionId,
  isFrgRequiredLiveScenarioId,
  isPostHybridPilotVersion,
  type CollectedFrgObservations,
  type FrgGitHubItemObservation,
  type FrgPackProofSource,
  type FrgPackProvenance,
} from "./frg-pack-observations.ts";
import {
  defaultCollectHybridV2FromRun,
  overlayLedgerStateFromGitHub,
  type HybridV2FromRunArgs,
} from "./frg-hybrid-v2-from-run.ts";

// ---------------------------------------------------------------------------
// Schema + thresholds
// ---------------------------------------------------------------------------

/** FRG evidence schema version — bump when field semantics change incompatibly. */
export const FRG_SCHEMA_VERSION = 1;

/** Stable scenario ids (scoreboard + Layer A mapping). */
export const FRG_SCENARIO_IDS = [
  "capacity-blocked-retain",
  "resume-mid-flight",
  "openspec-multi-change",
  "implement-lockfile-dirt",
  "local-docs-parity",
  "clean-item-throughput",
  "blocker-taxonomy",
  "pr-supersession",
  "release-plan-row",
  "empty-depends-on-stack-honesty",
] as const;

export type FrgScenarioId = (typeof FRG_SCENARIO_IDS)[number];

/**
 * Numeric pass criteria (runbook v1). May tighten via runbook updates; values
 * remain checked here so the driver never uses qualitative-only guidance.
 */
export interface FrgThresholds {
  /** K — min items reaching ready without engine-class block. */
  min_clean_ready_to_deploy: number;
  /** N — capacity stress: blocked retain count the pack must tolerate. */
  capacity_stress_n: number;
  /** Max allowed engine-class rate in [0, 1]; strictly greater fails. */
  max_engine_class_rate: number;
}

export const DEFAULT_FRG_THRESHOLDS: FrgThresholds = {
  min_clean_ready_to_deploy: 2,
  capacity_stress_n: 2,
  max_engine_class_rate: 0.25,
};

/**
 * Versioned fixed-pack manifest for Layer B live FRG runs.
 * `--from-run` evidence is only accepted when the durable loop contract's
 * selector matches this pack (label/milestone), so an unrelated successful
 * loop cannot be recorded as FRG evidence for a release version.
 */
export const FRG_PACK_MANIFEST = {
  pack_id: "factory-gate-v1",
  pack_schema_version: 1,
  /** Exact label selector values that identify the fixed FRG work-list. */
  allowed_label_selectors: ["factory-gate"] as const,
  /**
   * Exact milestone selector values for a dedicated reliability pack
   * (not product milestones — no substring matching).
   */
  allowed_milestone_selectors: [
    "factory-gate",
    "frg-pack",
    "reliability-pack",
  ] as const,
  required_scenario_ids: FRG_SCENARIO_IDS,
  /** Multi-item composition: pack must have at least this many items. */
  min_item_count: 2,
} as const;

/** Scenarios always derived from ledger scoreboard (no operator override required). */
export const FRG_AUTO_SCORED_SCENARIO_IDS: readonly FrgScenarioId[] = [
  "clean-item-throughput",
  "blocker-taxonomy",
];

/** Blocker taxonomy buckets for gate honesty. */
export type FrgBlockerTaxonomy = "engine-class" | "product-class" | "human-authority";

/**
 * Map durable-loop blocker themes to FRG taxonomy.
 * - workflow-engine-defect → engine-class (factory defect)
 * - missing-authority / specification-decision → human-authority
 * - everything else that is a typed durable class → product-class by default
 *   (pack-injected product failures); unknown themes default to engine-class
 *   so silent new defect shapes cannot green the gate.
 */
export function classifyFrgBlocker(theme: string | null | undefined): FrgBlockerTaxonomy {
  if (!theme) return "engine-class";
  if (theme === "workflow-engine-defect") return "engine-class";
  if (theme === "missing-authority" || theme === "specification-decision") {
    return "human-authority";
  }
  if (isDurableBlockerClass(theme)) return "product-class";
  // Capacity cascade / docs-after-PR / lock-dirt-at-zero-attempts strings that
  // may appear as free-form evidence themes.
  if (
    /capacity|worktree.?cap|lockfile|docs.?fresh|pr.?supersed|archive.?false|pr_opened.?strand|resume.?strand/i.test(
      theme,
    )
  ) {
    return "engine-class";
  }
  return "engine-class";
}

export type FrgScenarioStatus = "pass" | "fail" | "warn" | "skip" | "not_observed";

/**
 * Scenario statuses that always fail overall FRG pass when present.
 * `skip` is also non-passing for every required pack scenario (Layer B mandatory).
 * `not_observed` fails required-live only; Layer A-allowed may prove from TAP.
 * `warn` is pass-permitting only for documented honesty scenarios (see
 * {@link frgScenariosPermitPass}).
 */
const FRG_ALWAYS_FAILING_SCENARIO_STATUSES: ReadonlySet<FrgScenarioStatus> = new Set([
  "fail",
  "skip",
]);

/** Scenarios where `warn` may still permit overall pass (documented process honesty). */
const FRG_WARN_PERMITTED_SCENARIO_IDS: ReadonlySet<FrgScenarioId> = new Set([
  "empty-depends-on-stack-honesty",
]);

const FRG_VALID_SCENARIO_STATUSES: ReadonlySet<FrgScenarioStatus> = new Set([
  "pass",
  "fail",
  "warn",
  "skip",
  "not_observed",
]);

export interface FrgScenarioOutcome {
  id: FrgScenarioId;
  status: FrgScenarioStatus;
  detail: string;
  /** Optional observed metric (e.g. clean ready count, engine rate). */
  observed?: number | null;
  /** Optional threshold used for this scenario. */
  threshold?: number | null;
  /** Exact proof class. Required on hybrid v1 (1.33.0) and durable hybrid v2. */
  source?: FrgPackProofSource;
  /** Identities resolved against pack_provenance.proofs. */
  proof_ids?: string[];
}

export interface FrgScoreboard {
  item_count: number;
  ready_clean_count: number;
  engine_class_count: number;
  product_class_count: number;
  human_authority_count: number;
  /**
   * `engine_class_count / item_count` when `item_count ≥ 1` (never null in that case).
   * `null` only when `item_count === 0` (empty pack is never release-eligible).
   */
  engine_class_rate: number | null;
  per_item: FrgItemOutcome[];
}

/**
 * Representative pack composition dimensions (Decision 5 / #757).
 * Freeze ids — release-eligible pass requires every id present with status=pass.
 */
export const FRG_COMPOSITION_DIMENSION_IDS = [
  "openspec-bearing-item",
  "fix-rereview-cycle",
  "concurrency-contention",
  "managed-worktree-dirt",
  "process-restart-hydration",
  "forge-http-5xx-backoff",
  "ci-pending-red-recovery",
  "same-head-noop-reentry",
  "capacity-live-run-coexistence",
  "recovery-controller-one-item",
  "recovery-controller-multi-item",
] as const;

export type FrgCompositionDimensionId = (typeof FRG_COMPOSITION_DIMENSION_IDS)[number];

export type FrgCompositionStatus = "pass" | "fail" | "not_observed";

export type FrgCompositionSource = "live" | "ledger" | "observation" | "layer_a" | "derived";

export interface FrgCompositionDimension {
  id: FrgCompositionDimensionId;
  status: FrgCompositionStatus;
  source: FrgCompositionSource;
  detail: string;
  /** Optional numeric proof (e.g. capacity N, controller entry counts). */
  observed?: number | null;
  /** Identities resolved against pack_provenance.proofs. */
  proof_ids?: string[];
}

export interface FrgComposition {
  dimensions: FrgCompositionDimension[];
  /** Injected recoverable classes wrongly projected human_authority. */
  false_human_authority_count: number;
  /** Dimension ids failing or not_observed (empty when all pass). */
  missing: string[];
}

/** Env var for the HMAC key used to attest release-eligible FRG evidence (#757). */
export const FRG_ATTESTATION_KEY_ENV = "PIPELINE_FRG_ATTESTATION_KEY";

/** Attestation algorithm id written into evidence.integrity.attestation. */
export const FRG_ATTESTATION_ALG = "hmac-sha256-v1" as const;

/**
 * Unit-test-only attestation key. Never a production secret; production mint
 * and tag validation require {@link FRG_ATTESTATION_KEY_ENV}.
 */
export const FRG_UNIT_TEST_ATTESTATION_KEY =
  "unit-test-frg-attestation-key-not-for-production";

export interface FrgAttestation {
  alg: typeof FRG_ATTESTATION_ALG;
  /** Hex-encoded HMAC-SHA256 over the canonical attestation payload. */
  mac: string;
}

export interface FrgIntegrity {
  producer: "pipeline-factory-gate";
  scoreboard_fingerprint: string;
  composition_fingerprint: string;
  /** Present when structured pack provenance is part of the evidence. */
  pack_provenance_fingerprint?: string;
  /**
   * Runner-issued HMAC-SHA256 binding of computed `pass` to the evidence run
   * under {@link FRG_ATTESTATION_KEY_ENV}. Honest-pass requires this receipt
   * to verify; flipping `pass` or reminting a public hash cannot create proof.
   * Full HMAC attestation (`integrity.attestation`) remains optional for that
   * check.
   */
  score_receipt?: string;
  /**
   * HMAC attestation binding evidence to a producer that holds
   * {@link FRG_ATTESTATION_KEY_ENV}. Required for release-eligible `pass: true`
   * and verified (not merely present) on the auto-tag path.
   */
  attestation?: FrgAttestation;
}

export interface FrgRecoveryReasonAggregate {
  success: number;
  exhaustion: number;
  resumes: number;
  elapsed_ms: number;
}

export interface FrgRecoveryAggregates {
  by_reason: Record<string, FrgRecoveryReasonAggregate>;
}

/** Trend ledger path (repo-relative). */
export const FRG_TREND_LEDGER_REL = path.join(".agent-pipeline", "frg", "trend-ledger.jsonl");

export interface FrgTrendLedgerEntry {
  version: string;
  run_id: string;
  loop_run_id: string | null;
  pass: boolean;
  pack_id: string | null;
  created_at: string;
  item_count: number;
  ready_clean_count: number;
  engine_class_count: number;
  engine_class_rate: number | null;
  thresholds: FrgThresholds;
  recovery_aggregates?: FrgRecoveryAggregates;
  composition_missing?: string[];
  false_human_authority_count?: number;
}

export interface FrgItemOutcome {
  item_id: string;
  state: string;
  ready_clean: boolean;
  blocker_theme: string | null;
  blocker_class: FrgBlockerTaxonomy | null;
}

/**
 * How a latest.json (or equivalent) was scored. Honest post-1.33 pass
 * requires `from-run` on the evidence object — notes and caller opts
 * cannot establish this.
 */
export type HonestPost133ScoreSource = "from-run" | "observations" | "unknown";

/**
 * Work-list identity for the skip-frg restore precondition. Honest
 * post-1.33 pass requires `factory-gate-pack` on the evidence object.
 */
export type HonestPost133WorkList = "factory-gate-pack" | "product-milestone" | "other";

export interface FrgEvidence {
  schema_version: number;
  version: string;
  run_id: string;
  pass: boolean;
  scenarios: FrgScenarioOutcome[];
  scoreboard: FrgScoreboard;
  thresholds: FrgThresholds;
  /**
   * Durable loop run id when evidence is projected from a real loop.
   * Required non-empty for release-eligible `pass: true` evidence.
   */
  loop_run_id: string | null;
  /**
   * Fixed FRG pack identity (`FRG_PACK_MANIFEST.pack_id`) when the durable loop
   * was validated as the versioned factory-gate pack. Required to match the
   * current manifest pack_id for release-eligible `pass: true` evidence.
   * Offline/scoreInput reports without pack validation leave this null.
   */
  pack_id: string | null;
  created_at: string;
  /** Optional notes (warnings, pack selection). */
  notes: string[];
  /**
   * Representative pack composition (#757). Required for release-eligible
   * `pass: true` (every required dimension must pass; false_human_authority_count=0).
   */
  composition: FrgComposition;
  /** Optional recovery aggregates by canonical reason code (#757 / #787). */
  recovery_aggregates?: FrgRecoveryAggregates;
  /**
   * Anti-bypass integrity block written by computeFrgEvidence.
   * Required for release-eligible `pass: true` (fingerprints must recompute).
   */
  integrity: FrgIntegrity;
  /** Structured fresh-pack and candidate-probe provenance. */
  pack_provenance: FrgPackProvenance | null;
  /**
   * Optional ship-identity binding. When present it is an HMAC-attested
   * field: unsigned overlays after mint fail `verifyFrgAttestation`.
   */
  factory_release_binding?: unknown;
  /**
   * Runner-stamped score path. Required `from-run` for honest post-1.33
   * pass. Absent / `unknown` / `observations` reject.
   */
  score_source?: HonestPost133ScoreSource;
  /**
   * Runner-stamped work-list identity. Required `factory-gate-pack` for
   * honest post-1.33 pass. Absent / `other` / `product-milestone` reject.
   */
  work_list?: HonestPost133WorkList;
}

export type FrgLookupResult =
  | { kind: "pass"; evidence: FrgEvidence }
  | { kind: "fail"; evidence: FrgEvidence }
  | { kind: "missing"; version: string; path: string }
  | { kind: "unparsable"; version: string; path: string; detail: string };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo-relative root for FRG evidence (stable; documented in the runbook). */
export const FRG_EVIDENCE_ROOT_REL = path.join(".agent-pipeline", "frg");

export function normalizeFrgVersion(version: string): string {
  const v = version.trim().replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(
      `Invalid FRG version "${version}": expected X.Y.Z (optional leading v)`,
    );
  }
  return v;
}

export function frgVersionDir(repoDir: string, version: string): string {
  return path.join(repoDir, FRG_EVIDENCE_ROOT_REL, normalizeFrgVersion(version));
}

export function frgLatestPath(repoDir: string, version: string): string {
  return path.join(frgVersionDir(repoDir, version), "latest.json");
}

export function frgRunEvidencePath(repoDir: string, version: string, runId: string): string {
  return path.join(frgVersionDir(repoDir, version), runId, "evidence.json");
}

export function frgTrendLedgerPath(repoDir: string): string {
  return path.join(repoDir, FRG_TREND_LEDGER_REL);
}

export function newFrgRunId(now: () => Date = () => new Date()): string {
  const iso = now().toISOString().replace(/[:.]/g, "-");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `frg-${iso}-${suffix}`;
}

/**
 * Engine-class rate with item_count denominator (#757).
 * Returns null only when item_count === 0 (empty pack never release-eligible).
 */
export function computeEngineClassRate(
  engineClassCount: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  return engineClassCount / itemCount;
}

/** Stable SHA-256 fingerprint of a JSON-serializable value (canonical key order). */
export function frgStableFingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canonical);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonical(o[k]);
    return out;
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function computeScoreboardFingerprint(scoreboard: FrgScoreboard): string {
  return frgStableFingerprint({
    item_count: scoreboard.item_count,
    ready_clean_count: scoreboard.ready_clean_count,
    engine_class_count: scoreboard.engine_class_count,
    product_class_count: scoreboard.product_class_count,
    human_authority_count: scoreboard.human_authority_count,
    engine_class_rate: scoreboard.engine_class_rate,
    per_item: scoreboard.per_item,
  });
}

export function computeCompositionFingerprint(composition: FrgComposition): string {
  return frgStableFingerprint({
    dimensions: composition.dimensions,
    false_human_authority_count: composition.false_human_authority_count,
    missing: composition.missing,
  });
}

export function computePackProvenanceFingerprint(
  provenance: FrgPackProvenance,
): string {
  return frgStableFingerprint(provenance);
}

/** Runner-issued score receipt payload kind (HMAC; not a public hash). */
export const FRG_SCORE_RECEIPT_KIND = "frg-score-receipt-hmac-v1";

export interface FrgScoreReceiptInput {
  pass: boolean;
  version?: string;
  run_id?: string;
  loop_run_id?: string | null;
  pack_id?: string | null;
  score_source?: HonestPost133ScoreSource;
  work_list?: HonestPost133WorkList;
  scoreboard_fingerprint?: string;
  composition_fingerprint?: string;
  pack_provenance_fingerprint?: string;
}

function frgScoreReceiptPayload(input: FrgScoreReceiptInput): Record<string, unknown> {
  return {
    kind: FRG_SCORE_RECEIPT_KIND,
    pass: input.pass,
    version: input.version ?? null,
    run_id: input.run_id ?? null,
    loop_run_id: input.loop_run_id ?? null,
    pack_id: input.pack_id ?? null,
    score_source: input.score_source ?? null,
    work_list: input.work_list ?? null,
    scoreboard_fingerprint: input.scoreboard_fingerprint ?? null,
    composition_fingerprint: input.composition_fingerprint ?? null,
    pack_provenance_fingerprint: input.pack_provenance_fingerprint ?? null,
  };
}

/**
 * Bind the runner-computed `pass` to the evidence run with HMAC-SHA256 under
 * the producer key. A public hash of the same fields is not a valid receipt.
 */
export function computeFrgScoreReceipt(
  input: FrgScoreReceiptInput & { attestationKey: string },
): string {
  const key = input.attestationKey.trim();
  if (key === "") {
    throw new Error("computeFrgScoreReceipt requires a non-empty attestation key");
  }
  return computeFrgAttestationMac(frgScoreReceiptPayload(input), key);
}

export function buildFrgIntegrity(
  scoreboard: FrgScoreboard,
  composition: FrgComposition,
  packProvenance?: FrgPackProvenance | null,
): FrgIntegrity {
  const integrity: FrgIntegrity = {
    producer: "pipeline-factory-gate",
    scoreboard_fingerprint: computeScoreboardFingerprint(scoreboard),
    composition_fingerprint: computeCompositionFingerprint(composition),
  };
  if (packProvenance) {
    integrity.pack_provenance_fingerprint = computePackProvenanceFingerprint(packProvenance);
  }
  return integrity;
}

/** Resolve the FRG attestation key from an env map (injectable for tests). */
export function resolveFrgAttestationKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[FRG_ATTESTATION_KEY_ENV];
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  return key === "" ? null : key;
}

/**
 * Canonical fields covered by the HMAC. Must bind every field that can affect
 * release eligibility so a MAC from a failed attempt cannot be replayed with
 * mutated `pass` / scenarios / thresholds while fingerprints stay intact.
 * Self-consistent public fingerprints alone are forgeable; the MAC requires the
 * producer secret over the full eligibility payload.
 */
export function buildFrgAttestationPayload(input: {
  schema_version: number;
  version: string;
  run_id: string;
  loop_run_id: string;
  pack_id: string;
  pass: boolean;
  thresholds: FrgThresholds;
  scenarios: readonly FrgScenarioOutcome[];
  scoreboard: FrgScoreboard;
  composition: FrgComposition;
  recovery_aggregates?: FrgRecoveryAggregates | null;
  scoreboard_fingerprint: string;
  composition_fingerprint: string;
  pack_provenance: FrgPackProvenance | null;
  pack_provenance_fingerprint?: string;
  factory_release_binding?: unknown;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    producer: "pipeline-factory-gate",
    alg: FRG_ATTESTATION_ALG,
    schema_version: input.schema_version,
    version: input.version,
    run_id: input.run_id,
    loop_run_id: input.loop_run_id,
    pack_id: input.pack_id,
    pass: input.pass,
    thresholds: input.thresholds,
    scenarios: input.scenarios,
    scoreboard: input.scoreboard,
    composition: input.composition,
    recovery_aggregates: input.recovery_aggregates ?? null,
    scoreboard_fingerprint: input.scoreboard_fingerprint,
    composition_fingerprint: input.composition_fingerprint,
  };
  // Preserve hmac-sha256-v1 byte compatibility for pre-pilot evidence. The
  // new fields exist only on the v1.33.0 hybrid path, where both are required.
  if (input.pack_provenance) {
    payload.pack_provenance = input.pack_provenance;
    payload.pack_provenance_fingerprint = input.pack_provenance_fingerprint ?? null;
  }
  // Include only when present so artifacts minted without this field keep
  // their MAC. A post-sign overlay is then a MAC mismatch, not a retarget.
  if (input.factory_release_binding !== undefined) {
    payload.factory_release_binding = input.factory_release_binding;
  }
  return payload;
}

/** Deterministic JSON bytes for HMAC (sorted object keys, same as fingerprints). */
function frgCanonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(canonical);
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonical(o[k]);
    return out;
  };
  return JSON.stringify(canonical(value));
}

export function computeFrgAttestationMac(
  payload: Record<string, unknown>,
  key: string,
): string {
  return crypto
    .createHmac("sha256", key)
    .update(frgCanonicalJson(payload), "utf8")
    .digest("hex");
}

/** Fields required to mint or verify the eligibility-binding attestation MAC. */
export interface FrgAttestationSignInput {
  integrity: FrgIntegrity;
  schema_version: number;
  version: string;
  run_id: string;
  loop_run_id: string;
  pack_id: string;
  pass: boolean;
  thresholds: FrgThresholds;
  scenarios: readonly FrgScenarioOutcome[];
  scoreboard: FrgScoreboard;
  composition: FrgComposition;
  recovery_aggregates?: FrgRecoveryAggregates | null;
  pack_provenance?: FrgPackProvenance | null;
  factory_release_binding?: unknown;
  attestationKey: string;
}

export function signFrgIntegrity(input: FrgAttestationSignInput): FrgIntegrity {
  const payload = buildFrgAttestationPayload({
    schema_version: input.schema_version,
    version: input.version,
    run_id: input.run_id,
    loop_run_id: input.loop_run_id,
    pack_id: input.pack_id,
    pass: input.pass,
    thresholds: input.thresholds,
    scenarios: input.scenarios,
    scoreboard: input.scoreboard,
    composition: input.composition,
    recovery_aggregates: input.recovery_aggregates,
    scoreboard_fingerprint: input.integrity.scoreboard_fingerprint,
    composition_fingerprint: input.integrity.composition_fingerprint,
    pack_provenance: input.pack_provenance ?? null,
    pack_provenance_fingerprint: input.integrity.pack_provenance_fingerprint,
    factory_release_binding: input.factory_release_binding,
  });
  return {
    ...input.integrity,
    attestation: {
      alg: FRG_ATTESTATION_ALG,
      mac: computeFrgAttestationMac(payload, input.attestationKey),
    },
  };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Verify integrity.attestation against the attestation key over the full
 * eligibility-binding payload (pass, scenarios, thresholds, scoreboard,
 * composition, recovery aggregates — not fingerprints alone).
 * Returns true only when alg/mac are present and the MAC matches.
 */
export function verifyFrgAttestation(
  evidence: {
    schema_version: number;
    version: string;
    run_id: string;
    pass: boolean;
    loop_run_id: string | null;
    pack_id: string | null;
    thresholds: FrgThresholds;
    scenarios: readonly FrgScenarioOutcome[];
    scoreboard: FrgScoreboard;
    composition: FrgComposition;
    recovery_aggregates?: FrgRecoveryAggregates | null;
    pack_provenance?: FrgPackProvenance | null;
    factory_release_binding?: unknown;
    integrity: FrgIntegrity;
  },
  attestationKey: string,
): boolean {
  const att = evidence.integrity.attestation;
  if (!att || att.alg !== FRG_ATTESTATION_ALG) return false;
  if (typeof att.mac !== "string" || !/^[0-9a-f]{64}$/.test(att.mac)) return false;
  if (
    typeof evidence.loop_run_id !== "string" ||
    evidence.loop_run_id.trim() === "" ||
    typeof evidence.pack_id !== "string" ||
    evidence.pack_id.trim() === "" ||
    evidence.run_id.trim() === ""
  ) {
    return false;
  }
  const payload = buildFrgAttestationPayload({
    schema_version: evidence.schema_version,
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pack_id: evidence.pack_id,
    pass: evidence.pass,
    thresholds: evidence.thresholds,
    scenarios: evidence.scenarios,
    scoreboard: evidence.scoreboard,
    composition: evidence.composition,
    recovery_aggregates: evidence.recovery_aggregates,
    scoreboard_fingerprint: evidence.integrity.scoreboard_fingerprint,
    composition_fingerprint: evidence.integrity.composition_fingerprint,
    pack_provenance: evidence.pack_provenance ?? null,
    pack_provenance_fingerprint: evidence.integrity.pack_provenance_fingerprint,
    factory_release_binding: evidence.factory_release_binding,
  });
  const expected = computeFrgAttestationMac(payload, attestationKey);
  return timingSafeEqualHex(expected, att.mac);
}

export function frgAttestationPresent(integrity: FrgIntegrity | undefined): boolean {
  if (!integrity?.attestation) return false;
  const att = integrity.attestation;
  return (
    att.alg === FRG_ATTESTATION_ALG &&
    typeof att.mac === "string" &&
    /^[0-9a-f]{64}$/.test(att.mac)
  );
}

/**
 * Cross-check scoreboard counts against per_item and the engine-class rate formula.
 * Returns null when valid; otherwise a human-readable error detail.
 */
export function scoreboardIntegrityError(scoreboard: FrgScoreboard): string | null {
  if (scoreboard.item_count !== scoreboard.per_item.length) {
    return (
      `scoreboard.item_count (${scoreboard.item_count}) !== per_item.length ` +
      `(${scoreboard.per_item.length})`
    );
  }
  let engine = 0;
  let product = 0;
  let human = 0;
  let ready = 0;
  for (const it of scoreboard.per_item) {
    if (it.blocker_class === "engine-class") engine++;
    else if (it.blocker_class === "product-class") product++;
    else if (it.blocker_class === "human-authority") human++;
    if (it.ready_clean) ready++;
  }
  if (scoreboard.engine_class_count !== engine) {
    return `engine_class_count (${scoreboard.engine_class_count}) !== per_item tally (${engine})`;
  }
  if (scoreboard.product_class_count !== product) {
    return `product_class_count (${scoreboard.product_class_count}) !== per_item tally (${product})`;
  }
  if (scoreboard.human_authority_count !== human) {
    return `human_authority_count (${scoreboard.human_authority_count}) !== per_item tally (${human})`;
  }
  if (scoreboard.ready_clean_count !== ready) {
    return `ready_clean_count (${scoreboard.ready_clean_count}) !== per_item tally (${ready})`;
  }
  const expectedRate = computeEngineClassRate(engine, scoreboard.item_count);
  if (scoreboard.item_count === 0) {
    if (scoreboard.engine_class_rate !== null) {
      return "engine_class_rate must be null when item_count === 0";
    }
  } else {
    if (
      scoreboard.engine_class_rate === null ||
      !Number.isFinite(scoreboard.engine_class_rate) ||
      scoreboard.engine_class_rate < 0 ||
      scoreboard.engine_class_rate > 1
    ) {
      return "engine_class_rate must be a finite number in [0, 1] when item_count ≥ 1";
    }
    // Allow tiny float drift from JSON serialization.
    if (Math.abs(scoreboard.engine_class_rate - (expectedRate as number)) > 1e-9) {
      return (
        `engine_class_rate (${scoreboard.engine_class_rate}) !== ` +
        `engine_class_count/item_count (${expectedRate})`
      );
    }
  }
  return null;
}

/** Build composition.missing from dimension statuses. */
export function compositionMissingIds(
  dimensions: readonly FrgCompositionDimension[],
): string[] {
  return dimensions
    .filter((d) => d.status !== "pass")
    .map((d) => d.id);
}

export function frgCompositionAllPass(composition: FrgComposition): boolean {
  if (composition.false_human_authority_count !== 0) return false;
  if (composition.dimensions.length !== FRG_COMPOSITION_DIMENSION_IDS.length) return false;
  const seen = new Set(composition.dimensions.map((d) => d.id));
  for (const id of FRG_COMPOSITION_DIMENSION_IDS) {
    if (!seen.has(id)) return false;
  }
  for (const d of composition.dimensions) {
    if (d.status !== "pass") return false;
  }
  // missing[] must agree with non-pass dimensions
  const expectedMissing = compositionMissingIds(composition.dimensions);
  if (composition.missing.length !== expectedMissing.length) return false;
  const missingSet = new Set(composition.missing);
  for (const id of expectedMissing) {
    if (!missingSet.has(id)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evidence parse / write / lookup
// ---------------------------------------------------------------------------

export interface FrgFsDeps {
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  mkdir(p: string, opts: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /**
   * Host-local serialization for a path-scoped critical section (trend ledger).
   * Production default uses a short-retry PID lock; tests inject an in-memory mutex.
   */
  withPathLock?: <T>(lockKey: string, fn: () => Promise<T>) => Promise<T>;
}

/** Host-local path lock with brief retry (default production seam for ledger append). */
async function defaultFrgPathLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  // Lazy import keeps unit tests that never touch the default dep free of /tmp locks.
  const { withLock } = await import("./lock.ts");
  const domain =
    "frg-tl-" + crypto.createHash("sha256").update(lockKey).digest("hex").slice(0, 16);
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      return await withLock(domain, fn);
    } catch (err) {
      lastErr = err as Error;
      if (!/Pipeline lock held/i.test(lastErr.message)) throw err;
      await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 35)));
    }
  }
  throw new Error(
    `FRG path lock timeout for ${lockKey}` +
      (lastErr ? ` (${lastErr.message})` : ""),
  );
}

const defaultFsDeps: FrgFsDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  writeFile: (p, data) => fsp.writeFile(p, data, "utf8"),
  mkdir: async (p, opts) => {
    await fsp.mkdir(p, opts);
  },
  rename: (from, to) => fsp.rename(from, to),
  withPathLock: defaultFrgPathLock,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function parseFrgScenarioOutcome(raw: unknown, index: number): FrgScenarioOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`FRG evidence.scenarios[${index}] must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !(FRG_SCENARIO_IDS as readonly string[]).includes(s.id)) {
    throw new Error(
      `FRG evidence.scenarios[${index}].id must be a known scenario id (got ${String(s.id)})`,
    );
  }
  if (typeof s.status !== "string" || !FRG_VALID_SCENARIO_STATUSES.has(s.status as FrgScenarioStatus)) {
    throw new Error(
      `FRG evidence.scenarios[${index}].status must be pass|fail|warn|skip|not_observed (got ${String(s.status)})`,
    );
  }
  if (typeof s.detail !== "string") {
    throw new Error(`FRG evidence.scenarios[${index}].detail must be a string`);
  }
  const observed =
    s.observed === undefined || s.observed === null
      ? null
      : isFiniteNumber(s.observed)
        ? s.observed
        : (() => {
            throw new Error(`FRG evidence.scenarios[${index}].observed must be a number or null`);
          })();
  const threshold =
    s.threshold === undefined || s.threshold === null
      ? null
      : isFiniteNumber(s.threshold)
        ? s.threshold
        : (() => {
            throw new Error(`FRG evidence.scenarios[${index}].threshold must be a number or null`);
          })();
  let source: FrgPackProofSource | undefined;
  if (s.source !== undefined) {
    if (
      typeof s.source !== "string" ||
      !new Set(["live", "ledger", "derived", "layer_a"]).has(s.source)
    ) {
      throw new Error(`FRG evidence.scenarios[${index}].source is invalid`);
    }
    source = s.source as FrgPackProofSource;
  }
  let proofIds: string[] | undefined;
  if (s.proof_ids !== undefined) {
    if (
      !Array.isArray(s.proof_ids) ||
      s.proof_ids.length === 0 ||
      !s.proof_ids.every((id) => typeof id === "string" && id.trim() !== "") ||
      new Set(s.proof_ids).size !== s.proof_ids.length
    ) {
      throw new Error(`FRG evidence.scenarios[${index}].proof_ids must be unique non-empty strings`);
    }
    proofIds = [...s.proof_ids] as string[];
  }
  return {
    id: s.id as FrgScenarioId,
    status: s.status as FrgScenarioStatus,
    detail: s.detail,
    observed,
    threshold,
    ...(source ? { source } : {}),
    ...(proofIds ? { proof_ids: proofIds } : {}),
  };
}

function parseFrgThresholds(raw: unknown): FrgThresholds {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence.thresholds must be an object");
  }
  const t = raw as Record<string, unknown>;
  if (!isFiniteNumber(t.min_clean_ready_to_deploy) || t.min_clean_ready_to_deploy < 0) {
    throw new Error("FRG evidence.thresholds.min_clean_ready_to_deploy must be a non-negative number");
  }
  if (!isFiniteNumber(t.capacity_stress_n) || t.capacity_stress_n < 0) {
    throw new Error("FRG evidence.thresholds.capacity_stress_n must be a non-negative number");
  }
  if (
    !isFiniteNumber(t.max_engine_class_rate) ||
    t.max_engine_class_rate < 0 ||
    t.max_engine_class_rate > 1
  ) {
    throw new Error("FRG evidence.thresholds.max_engine_class_rate must be a number in [0, 1]");
  }
  return {
    min_clean_ready_to_deploy: t.min_clean_ready_to_deploy,
    capacity_stress_n: t.capacity_stress_n,
    max_engine_class_rate: t.max_engine_class_rate,
  };
}

function parseFrgItemOutcome(raw: unknown, index: number): FrgItemOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`FRG evidence.scoreboard.per_item[${index}] must be an object`);
  }
  const it = raw as Record<string, unknown>;
  if (typeof it.item_id !== "string" || it.item_id.trim() === "") {
    throw new Error(`FRG evidence.scoreboard.per_item[${index}].item_id must be a non-empty string`);
  }
  if (typeof it.state !== "string") {
    throw new Error(`FRG evidence.scoreboard.per_item[${index}].state must be a string`);
  }
  if (typeof it.ready_clean !== "boolean") {
    throw new Error(`FRG evidence.scoreboard.per_item[${index}].ready_clean must be a boolean`);
  }
  const theme =
    it.blocker_theme === undefined || it.blocker_theme === null
      ? null
      : typeof it.blocker_theme === "string"
        ? it.blocker_theme
        : (() => {
            throw new Error(
              `FRG evidence.scoreboard.per_item[${index}].blocker_theme must be a string or null`,
            );
          })();
  const blockerClass =
    it.blocker_class === undefined || it.blocker_class === null
      ? null
      : it.blocker_class === "engine-class" ||
          it.blocker_class === "product-class" ||
          it.blocker_class === "human-authority"
        ? it.blocker_class
        : (() => {
            throw new Error(
              `FRG evidence.scoreboard.per_item[${index}].blocker_class must be engine-class|product-class|human-authority|null`,
            );
          })();
  return {
    item_id: it.item_id,
    state: it.state,
    ready_clean: it.ready_clean,
    blocker_theme: theme,
    blocker_class: blockerClass,
  };
}

function parseFrgScoreboard(raw: unknown): FrgScoreboard {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence.scoreboard must be an object");
  }
  const sb = raw as Record<string, unknown>;
  for (const key of [
    "item_count",
    "ready_clean_count",
    "engine_class_count",
    "product_class_count",
    "human_authority_count",
  ] as const) {
    if (!isFiniteNumber(sb[key]) || sb[key] < 0) {
      throw new Error(`FRG evidence.scoreboard.${key} must be a non-negative number`);
    }
  }
  if (!Array.isArray(sb.per_item)) {
    throw new Error("FRG evidence.scoreboard.per_item must be an array");
  }
  const per_item = sb.per_item.map((it, i) => parseFrgItemOutcome(it, i));
  const itemCount = sb.item_count as number;
  let engineRate: number | null;
  if (sb.engine_class_rate === null) {
    if (itemCount >= 1) {
      throw new Error(
        "FRG evidence.scoreboard.engine_class_rate must be a finite number in [0, 1] when item_count ≥ 1 (never null/n/a)",
      );
    }
    engineRate = null;
  } else if (
    isFiniteNumber(sb.engine_class_rate) &&
    sb.engine_class_rate >= 0 &&
    sb.engine_class_rate <= 1
  ) {
    engineRate = sb.engine_class_rate;
  } else {
    throw new Error(
      "FRG evidence.scoreboard.engine_class_rate must be a finite number in [0, 1] or null (null only when item_count === 0)",
    );
  }
  const scoreboard: FrgScoreboard = {
    item_count: itemCount,
    ready_clean_count: sb.ready_clean_count as number,
    engine_class_count: sb.engine_class_count as number,
    product_class_count: sb.product_class_count as number,
    human_authority_count: sb.human_authority_count as number,
    engine_class_rate: engineRate,
    per_item,
  };
  const integrityErr = scoreboardIntegrityError(scoreboard);
  if (integrityErr) {
    throw new Error(`FRG evidence.scoreboard integrity: ${integrityErr}`);
  }
  return scoreboard;
}

const FRG_VALID_COMPOSITION_STATUSES: ReadonlySet<FrgCompositionStatus> = new Set([
  "pass",
  "fail",
  "not_observed",
]);

const FRG_VALID_COMPOSITION_SOURCES: ReadonlySet<FrgCompositionSource> = new Set([
  "live",
  "ledger",
  "observation",
  "layer_a",
  "derived",
]);

function parseFrgCompositionDimension(raw: unknown, index: number): FrgCompositionDimension {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`FRG evidence.composition.dimensions[${index}] must be an object`);
  }
  const d = raw as Record<string, unknown>;
  if (
    typeof d.id !== "string" ||
    !(FRG_COMPOSITION_DIMENSION_IDS as readonly string[]).includes(d.id)
  ) {
    throw new Error(
      `FRG evidence.composition.dimensions[${index}].id must be a known composition dimension id (got ${String(d.id)})`,
    );
  }
  if (
    typeof d.status !== "string" ||
    !FRG_VALID_COMPOSITION_STATUSES.has(d.status as FrgCompositionStatus)
  ) {
    throw new Error(
      `FRG evidence.composition.dimensions[${index}].status must be pass|fail|not_observed`,
    );
  }
  if (
    typeof d.source !== "string" ||
    !FRG_VALID_COMPOSITION_SOURCES.has(d.source as FrgCompositionSource)
  ) {
    throw new Error(
      `FRG evidence.composition.dimensions[${index}].source must be live|ledger|observation|layer_a|derived`,
    );
  }
  if (typeof d.detail !== "string") {
    throw new Error(`FRG evidence.composition.dimensions[${index}].detail must be a string`);
  }
  const observed =
    d.observed === undefined || d.observed === null
      ? null
      : isFiniteNumber(d.observed)
        ? d.observed
        : (() => {
            throw new Error(
              `FRG evidence.composition.dimensions[${index}].observed must be a number or null`,
            );
          })();
  let proofIds: string[] | undefined;
  if (d.proof_ids !== undefined) {
    if (
      !Array.isArray(d.proof_ids) ||
      d.proof_ids.length === 0 ||
      !d.proof_ids.every((id) => typeof id === "string" && id.trim() !== "") ||
      new Set(d.proof_ids).size !== d.proof_ids.length
    ) {
      throw new Error(
        `FRG evidence.composition.dimensions[${index}].proof_ids must be unique non-empty strings`,
      );
    }
    proofIds = [...d.proof_ids] as string[];
  }
  return {
    id: d.id as FrgCompositionDimensionId,
    status: d.status as FrgCompositionStatus,
    source: d.source as FrgCompositionSource,
    detail: d.detail,
    observed,
    ...(proofIds ? { proof_ids: proofIds } : {}),
  };
}

function parseFrgComposition(raw: unknown): FrgComposition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence.composition must be an object");
  }
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.dimensions)) {
    throw new Error("FRG evidence.composition.dimensions must be an array");
  }
  if (c.dimensions.length !== FRG_COMPOSITION_DIMENSION_IDS.length) {
    throw new Error(
      `FRG evidence.composition.dimensions must include exactly ${FRG_COMPOSITION_DIMENSION_IDS.length} entries ` +
        `(got ${c.dimensions.length})`,
    );
  }
  const dimensions = c.dimensions.map((d, i) => parseFrgCompositionDimension(d, i));
  const seen = new Set(dimensions.map((d) => d.id));
  if (seen.size !== FRG_COMPOSITION_DIMENSION_IDS.length) {
    throw new Error("FRG evidence.composition.dimensions must not duplicate ids");
  }
  for (const id of FRG_COMPOSITION_DIMENSION_IDS) {
    if (!seen.has(id)) {
      throw new Error(`FRG evidence.composition.dimensions missing required id ${id}`);
    }
  }
  if (!isFiniteNumber(c.false_human_authority_count) || c.false_human_authority_count < 0) {
    throw new Error(
      "FRG evidence.composition.false_human_authority_count must be a non-negative number",
    );
  }
  if (
    !Array.isArray(c.missing) ||
    !c.missing.every((m) => typeof m === "string")
  ) {
    throw new Error("FRG evidence.composition.missing must be an array of strings");
  }
  const expectedMissing = compositionMissingIds(dimensions);
  const missing = c.missing as string[];
  if (missing.length !== expectedMissing.length ||
      !expectedMissing.every((id) => missing.includes(id))) {
    throw new Error(
      `FRG evidence.composition.missing must list non-pass dimension ids ` +
        `(expected [${expectedMissing.join(", ")}], got [${missing.join(", ")}])`,
    );
  }
  return {
    dimensions,
    false_human_authority_count: c.false_human_authority_count as number,
    missing,
  };
}

function parseFrgIntegrity(raw: unknown): FrgIntegrity {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence.integrity must be an object");
  }
  const i = raw as Record<string, unknown>;
  if (i.producer !== "pipeline-factory-gate") {
    throw new Error(
      `FRG evidence.integrity.producer must be "pipeline-factory-gate" (got ${String(i.producer)})`,
    );
  }
  if (typeof i.scoreboard_fingerprint !== "string" || i.scoreboard_fingerprint.trim() === "") {
    throw new Error("FRG evidence.integrity.scoreboard_fingerprint must be a non-empty string");
  }
  if (typeof i.composition_fingerprint !== "string" || i.composition_fingerprint.trim() === "") {
    throw new Error("FRG evidence.integrity.composition_fingerprint must be a non-empty string");
  }
  if (
    i.pack_provenance_fingerprint !== undefined &&
    (typeof i.pack_provenance_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(i.pack_provenance_fingerprint))
  ) {
    throw new Error(
      "FRG evidence.integrity.pack_provenance_fingerprint must be a lowercase SHA-256 digest when present",
    );
  }
  let attestation: FrgAttestation | undefined;
  if (i.attestation !== undefined && i.attestation !== null) {
    if (typeof i.attestation !== "object" || Array.isArray(i.attestation)) {
      throw new Error("FRG evidence.integrity.attestation must be an object when present");
    }
    const a = i.attestation as Record<string, unknown>;
    if (a.alg !== FRG_ATTESTATION_ALG) {
      throw new Error(
        `FRG evidence.integrity.attestation.alg must be "${FRG_ATTESTATION_ALG}" (got ${String(a.alg)})`,
      );
    }
    if (typeof a.mac !== "string" || !/^[0-9a-f]{64}$/.test(a.mac.trim())) {
      throw new Error(
        "FRG evidence.integrity.attestation.mac must be a 64-char lowercase hex HMAC-SHA256",
      );
    }
    attestation = { alg: FRG_ATTESTATION_ALG, mac: a.mac.trim() };
  }
  const integrity: FrgIntegrity = {
    producer: "pipeline-factory-gate",
    scoreboard_fingerprint: i.scoreboard_fingerprint.trim(),
    composition_fingerprint: i.composition_fingerprint.trim(),
  };
  if (typeof i.pack_provenance_fingerprint === "string") {
    integrity.pack_provenance_fingerprint = i.pack_provenance_fingerprint;
  }
  if (i.score_receipt !== undefined && i.score_receipt !== null) {
    if (typeof i.score_receipt !== "string" || !/^[0-9a-f]{64}$/.test(i.score_receipt)) {
      throw new Error(
        "FRG evidence.integrity.score_receipt must be a 64-char lowercase hex HMAC-SHA256 when present",
      );
    }
    integrity.score_receipt = i.score_receipt;
  }
  if (attestation) integrity.attestation = attestation;
  return integrity;
}

function parseFrgRecoveryAggregates(raw: unknown): FrgRecoveryAggregates | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence.recovery_aggregates must be an object when present");
  }
  const r = raw as Record<string, unknown>;
  if (r.by_reason === null || typeof r.by_reason !== "object" || Array.isArray(r.by_reason)) {
    throw new Error("FRG evidence.recovery_aggregates.by_reason must be an object");
  }
  const by_reason: Record<string, FrgRecoveryReasonAggregate> = {};
  for (const [key, val] of Object.entries(r.by_reason as Record<string, unknown>)) {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
      throw new Error(`FRG evidence.recovery_aggregates.by_reason.${key} must be an object`);
    }
    const a = val as Record<string, unknown>;
    for (const field of ["success", "exhaustion", "resumes", "elapsed_ms"] as const) {
      if (!isFiniteNumber(a[field]) || a[field] < 0) {
        throw new Error(
          `FRG evidence.recovery_aggregates.by_reason.${key}.${field} must be a non-negative finite number`,
        );
      }
    }
    by_reason[key] = {
      success: a.success as number,
      exhaustion: a.exhaustion as number,
      resumes: a.resumes as number,
      elapsed_ms: a.elapsed_ms as number,
    };
  }
  return { by_reason };
}

/**
 * Layer A-allowed scenario ids proven by same-candidate TAP hashes on
 * `pack_provenance`. Required-live ids are never included.
 */
export function layerAIdsProvenByTap(
  provenance: FrgPackProvenance | null | undefined,
  scenarios: readonly FrgScenarioOutcome[] = [],
): Set<string> {
  const proven = new Set<string>();
  if (!provenance) return proven;
  const proofs = new Map(provenance.proofs.map((proof) => [proof.id, proof] as const));
  if (
    provenance.probes.length === 0 ||
    provenance.probes.some((probe) => probe.candidate_git_sha !== provenance.candidate_git_sha)
  ) {
    return proven;
  }
  for (const scenario of scenarios) {
    if (isFrgRequiredLiveScenarioId(scenario.id)) continue;
    if (!scenario.proof_ids?.length) continue;
    if (scenario.proof_ids.some((id) => !id.startsWith("probe:"))) continue;
    const allTap = scenario.proof_ids.every((id) => {
      const proof = proofs.get(id);
      return Boolean(proof && proof.source === "layer_a");
    });
    if (allTap) proven.add(scenario.id);
  }
  return proven;
}

/**
 * True when scenario statuses alone permit overall pass:
 * - no fail / skip
 * - warn only on documented honesty scenarios (stack-honesty)
 * - `not_observed` fails required-live only
 * - Layer A-allowed `not_observed` is pass-permitting only when a same-candidate
 *   TAP hash proves that closed probe
 */
export function frgScenariosPermitPass(
  scenarios: readonly FrgScenarioOutcome[],
  opts?: { layerAProvenByTap?: ReadonlySet<string> },
): boolean {
  const tapProven = opts?.layerAProvenByTap ?? new Set<string>();
  for (const s of scenarios) {
    if (FRG_ALWAYS_FAILING_SCENARIO_STATUSES.has(s.status)) return false;
    if (s.status === "warn" && !FRG_WARN_PERMITTED_SCENARIO_IDS.has(s.id)) return false;
    if (s.status === "not_observed") {
      if (isFrgRequiredLiveScenarioId(s.id)) return false;
      if (!tapProven.has(s.id)) return false;
    }
  }
  return true;
}

/**
 * Validate hybrid proof (historical v1 for 1.33.0, durable v2 for any version).
 * This check does not turn digests into truth. It proves that the signed
 * evidence contains the exact required-live / Layer A split the closed runner
 * is allowed to emit.
 */
export function hybridPilotProofValid(evidence: {
  version?: string;
  loop_run_id: string | null;
  pack_id: string | null;
  scenarios: readonly FrgScenarioOutcome[];
  scoreboard?: FrgScoreboard;
  composition?: FrgComposition;
  pack_provenance?: FrgPackProvenance | null;
}): boolean {
  const provenance = evidence.pack_provenance ?? null;
  if (!provenance) {
    // 1.33.0 and every later release require hybrid provenance.
    // Pre-1.33.0 evidence may omit it (legacy full-live scoring).
    return !hybridProvenanceRequired(evidence.version);
  }
  if (isFrgHybridV1PolicyId(provenance.policy_id)) {
    if (evidence.version !== FRG_HYBRID_PILOT_VERSION) return false;
    return hybridSplitProofValid(evidence, { historicalV1: true });
  }
  if (isFrgHybridV2PolicyId(provenance.policy_id)) {
    return hybridSplitProofValid(evidence, { historicalV1: false });
  }
  return false;
}

function hybridSplitProofValid(
  evidence: {
    version?: string;
    loop_run_id: string | null;
    pack_id: string | null;
    scenarios: readonly FrgScenarioOutcome[];
    scoreboard?: FrgScoreboard;
    composition?: FrgComposition;
    pack_provenance?: FrgPackProvenance | null;
  },
  opts: { historicalV1: boolean },
): boolean {
  const provenance = evidence.pack_provenance;
  const expectedManifestSha = expectedHybridManifestSha256(provenance?.policy_id ?? "");
  if (
    !provenance ||
    !expectedManifestSha ||
    provenance.manifest_sha256 !== expectedManifestSha ||
    (opts.historicalV1 && provenance.replacement_issue !== FRG_HYBRID_REPLACEMENT_ISSUE) ||
    provenance.release_version !== evidence.version ||
    provenance.pack_id !== FRG_PACK_MANIFEST.pack_id ||
    provenance.pack_id !== evidence.pack_id ||
    provenance.loop_run_id !== evidence.loop_run_id ||
    provenance.issues.length !== 2 ||
    !evidence.scoreboard ||
    !evidence.composition
  ) {
    return false;
  }
  const issueIds = [...provenance.issues.map((issue) => String(issue.issue_number))].sort();
  const scoreboardIds = [...evidence.scoreboard.per_item.map((item) => item.item_id)].sort();
  if (
    issueIds.length !== scoreboardIds.length ||
    issueIds.some((value, index) => value !== scoreboardIds[index])
  ) {
    return false;
  }
  const templates = new Set(provenance.issues.map((issue) => issue.template_id));
  if (!templates.has("clean-docs") || !templates.has("clean-openspec") || templates.size !== 2) {
    return false;
  }
  const expectedProbeList = expectedHybridLayerAProbeIds(provenance.policy_id);
  if (!expectedProbeList) return false;
  const expectedProbeIds = new Set<string>(expectedProbeList);
  const probeIds = new Set(provenance.probes.map((probe) => probe.id));
  if (
    probeIds.size !== expectedProbeIds.size ||
    probeIds.size !== provenance.probes.length ||
    [...expectedProbeIds].some((id) => !probeIds.has(id)) ||
    provenance.probes.some((probe) => probe.candidate_git_sha !== provenance.candidate_git_sha)
  ) {
    return false;
  }
  const proofs = new Map(provenance.proofs.map((proof) => [proof.id, proof] as const));
  if (
    !proofs.has("live:contract") ||
    !proofs.has("ledger:final") ||
    !proofs.has("live:events") ||
    !proofs.has("live:action-evidence") ||
    provenance.probes.some((probe) => !proofs.has(`probe:${probe.id}`))
  ) {
    return false;
  }
  const liveScenarioIds = new Set<string>(FRG_HYBRID_LIVE_SCENARIO_IDS);
  for (const scenario of evidence.scenarios) {
    const expectedSource: FrgPackProofSource =
      scenario.id === "clean-item-throughput" || scenario.id === "blocker-taxonomy"
        ? "ledger"
        : scenario.id === "empty-depends-on-stack-honesty"
          ? "derived"
          : "layer_a";
    if (scenario.source === "layer_a" && liveScenarioIds.has(scenario.id)) return false;
    if (scenario.status === "not_observed" && liveScenarioIds.has(scenario.id)) {
      // Required-live not_observed is scored as overall fail; hybrid identity
      // can still be structurally valid so the not_observed rule is the fail.
      continue;
    }
    if (scenario.source !== expectedSource || !scenario.proof_ids?.length) return false;
    if (liveScenarioIds.has(scenario.id)) {
      const exactProof = scenario.id === "empty-depends-on-stack-honesty"
        ? "live:contract"
        : "ledger:final";
      if (scenario.proof_ids.length !== 1 || scenario.proof_ids[0] !== exactProof) return false;
    } else if (scenario.proof_ids.some((id) => !id.startsWith("probe:"))) {
      return false;
    }
    for (const id of scenario.proof_ids) {
      const proof = proofs.get(id);
      if (!proof) return false;
      if (expectedSource === "layer_a" && proof.source !== "layer_a") return false;
    }
  }
  const liveComposition = new Set<string>(FRG_HYBRID_LIVE_COMPOSITION_IDS);
  for (const dimension of evidence.composition.dimensions) {
    const expectedSource: FrgCompositionSource = liveComposition.has(dimension.id)
      ? "live"
      : "layer_a";
    if (dimension.source === "layer_a" && liveComposition.has(dimension.id)) return false;
    if (dimension.status === "not_observed" && liveComposition.has(dimension.id)) {
      continue;
    }
    if (dimension.source !== expectedSource || !dimension.proof_ids?.length) return false;
    if (expectedSource === "live") {
      if (
        dimension.proof_ids.length !== 1 ||
        !dimension.proof_ids[0]!.startsWith("live:openspec-pr:")
      ) {
        return false;
      }
    } else if (dimension.proof_ids.some((id) => !id.startsWith("probe:"))) {
      return false;
    }
    for (const id of dimension.proof_ids) {
      const proof = proofs.get(id);
      if (!proof || proof.source !== expectedSource) return false;
    }
  }
  return true;
}

/**
 * Release-eligible pass requires scenario criteria + live durable loop provenance
 * (non-empty loop_run_id) + validated fixed-pack identity + scoreboard integrity +
 * representative composition + integrity fingerprints + attestation presence (#757).
 *
 * Cryptographic verification of the attestation MAC is performed by
 * {@link validateReleaseEligibleFrgEvidence} (auto-tag / release gate) with
 * {@link FRG_ATTESTATION_KEY_ENV} — presence alone is not sufficient there.
 *
 * Accepts partial objects (pre-composition callers) but release-eligible true
 * requires full composition/scoreboard/integrity when those fields are present;
 * when scoreboard/composition/integrity are omitted, eligibility is false
 * for the strengthened gate (except when evaluating intermediate pass flags
 * inside computeFrgEvidence which always supplies them).
 */
export function isReleaseEligibleFrgPass(
  evidence: {
    version?: string;
    pass: boolean;
    scenarios: readonly FrgScenarioOutcome[];
    loop_run_id: string | null;
    pack_id: string | null;
    thresholds: FrgThresholds;
    scoreboard?: FrgScoreboard;
    composition?: FrgComposition;
    integrity?: FrgIntegrity;
    pack_provenance?: FrgPackProvenance | null;
    run_id?: string;
  },
  opts?: {
    /**
     * When false, skip the attestation-presence check so the mint path can
     * compute structural eligibility before attaching the HMAC. Also ignore
     * attested `pass: false` when HMAC is absent so omitted HMAC is not
     * treated as structural fail (#1147). Default true.
     */
    requireAttestation?: boolean;
  },
): boolean {
  const hmacOptional = opts?.requireAttestation === false;
  const hmacAbsent = !frgAttestationPresent(evidence.integrity);
  // HMAC-optional structural eligibility ignores attested pass:false when
  // HMAC is absent. Attested pass:true still requires HMAC (#757). Unsigned
  // latest.json stays pass:false until the attestor child signs.
  if (!evidence.pass && !(hmacOptional && hmacAbsent)) return false;
  const layerAProvenByTap = layerAIdsProvenByTap(
    evidence.pack_provenance,
    evidence.scenarios,
  );
  if (!frgScenariosPermitPass(evidence.scenarios, { layerAProvenByTap })) return false;
  if (typeof evidence.loop_run_id !== "string" || evidence.loop_run_id.trim() === "") {
    return false;
  }
  if (evidence.pack_id !== FRG_PACK_MANIFEST.pack_id) return false;
  if (!hybridPilotProofValid(evidence)) return false;
  if (!capacityScenarioMeetsNumericCriterion(evidence.scenarios, evidence.thresholds)) {
    return false;
  }
  // Scoreboard integrity + non-empty pack (#757)
  if (!evidence.scoreboard) return false;
  if (evidence.scoreboard.item_count < 1) return false;
  if (scoreboardIntegrityError(evidence.scoreboard) !== null) return false;
  // Representative composition
  if (!evidence.composition) return false;
  if (!frgCompositionAllPass(evidence.composition)) return false;
  // Integrity fingerprints
  if (!evidence.integrity) return false;
  if (evidence.integrity.producer !== "pipeline-factory-gate") return false;
  const expectedSb = computeScoreboardFingerprint(evidence.scoreboard);
  const expectedComp = computeCompositionFingerprint(evidence.composition);
  if (evidence.integrity.scoreboard_fingerprint !== expectedSb) return false;
  if (evidence.integrity.composition_fingerprint !== expectedComp) return false;
  if (evidence.pack_provenance) {
    if (
      evidence.integrity.pack_provenance_fingerprint !==
        computePackProvenanceFingerprint(evidence.pack_provenance)
    ) {
      return false;
    }
  } else if (hybridProvenanceRequired(evidence.version)) {
    return false;
  }
  if (typeof evidence.run_id === "string" && evidence.run_id.trim() === "") return false;
  // Attestation must be present for release-eligible pass (MAC verified on tag path).
  if (opts?.requireAttestation !== false && !frgAttestationPresent(evidence.integrity)) {
    return false;
  }
  return true;
}

export interface HonestPost133FrgPassOpts {
  /**
   * Caller-observed score path. May only *reject* (`observations`).
   * `from-run` here does not establish honest-pass authority.
   */
  scoreSource?: HonestPost133ScoreSource;
  /** Caller-authored `--observations` file used as score authority. */
  usedObservationsFile?: boolean;
  /**
   * Caller-observed work-list. May only *reject* (`product-milestone` /
   * `other`). `factory-gate-pack` here does not establish authority.
   */
  workList?: HonestPost133WorkList;
  /**
   * Producer key used to verify `integrity.score_receipt`. Explicit `null`
   * or empty fails closed. When omitted, {@link resolveFrgAttestationKey}
   * reads {@link FRG_ATTESTATION_KEY_ENV}.
   */
  attestationKey?: string | null;
}

/** Note prefix written by `runFactoryGate` on the `--from-run` path. */
export const FRG_FROM_RUN_NOTE_PREFIX = "Projected from durable loop run ";

/** Note written by `runFactoryGate` when the contract is the fixed pack. */
export const FRG_NOT_PRODUCT_MILESTONE_NOTE =
  "Scenario pack selection: reliability label/fixture pack (not full product milestone)";

const GIT_SHA_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type HonestPost133FrgPassEvidence = {
  version?: string;
  pass: boolean;
  scenarios: readonly FrgScenarioOutcome[];
  loop_run_id: string | null;
  pack_id: string | null;
  thresholds: FrgThresholds;
  scoreboard?: FrgScoreboard;
  composition?: FrgComposition;
  integrity?: FrgIntegrity;
  pack_provenance?: FrgPackProvenance | null;
  run_id?: string;
  notes?: readonly string[];
  score_source?: HonestPost133ScoreSource;
  work_list?: HonestPost133WorkList;
};

function notesText(evidence: { notes?: readonly string[] }): string {
  return (evidence.notes ?? []).join("\n");
}

function honestPassIsFromRun(
  evidence: { score_source?: HonestPost133ScoreSource },
  opts?: HonestPost133FrgPassOpts,
): boolean {
  if (opts?.scoreSource === "observations") return false;
  return evidence.score_source === "from-run";
}

function honestPassUsedObservationsFile(
  evidence: { notes?: readonly string[]; score_source?: HonestPost133ScoreSource },
  opts?: HonestPost133FrgPassOpts,
): boolean {
  if (opts?.usedObservationsFile === true) return true;
  if (opts?.scoreSource === "observations") return true;
  if (evidence.score_source === "observations") return true;
  const notes = notesText(evidence);
  return /(?:^|\s)--observations\b/.test(notes) || /scored from observations file/i.test(notes);
}

function honestPassIsFactoryGatePack(
  evidence: { notes?: readonly string[]; work_list?: HonestPost133WorkList },
  opts?: HonestPost133FrgPassOpts,
): boolean {
  if (opts?.workList === "product-milestone" || opts?.workList === "other") return false;
  if (evidence.work_list !== "factory-gate-pack") return false;
  const notes = notesText(evidence);
  if (/product v?1\.39 milestone/i.test(notes)) return false;
  if (/\bproduct-milestone\b/i.test(notes) && !/not full product milestone/i.test(notes)) {
    return false;
  }
  return true;
}

function resolveHonestPassAttestationKey(
  opts?: HonestPost133FrgPassOpts,
): string | null {
  if (opts && Object.prototype.hasOwnProperty.call(opts, "attestationKey")) {
    const raw = opts.attestationKey;
    if (typeof raw !== "string") return null;
    const key = raw.trim();
    return key === "" ? null : key;
  }
  return resolveFrgAttestationKey();
}

function honestPassScoreReceiptMatches(
  evidence: HonestPost133FrgPassEvidence,
  opts?: HonestPost133FrgPassOpts,
): boolean {
  const key = resolveHonestPassAttestationKey(opts);
  if (!key) return false;
  const receipt = evidence.integrity?.score_receipt;
  if (typeof receipt !== "string" || !SHA256_RE.test(receipt)) return false;
  const expected = computeFrgScoreReceipt({
    pass: evidence.pass,
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pack_id: evidence.pack_id,
    score_source: evidence.score_source,
    work_list: evidence.work_list,
    scoreboard_fingerprint: evidence.integrity.scoreboard_fingerprint,
    composition_fingerprint: evidence.integrity.composition_fingerprint,
    pack_provenance_fingerprint: evidence.integrity.pack_provenance_fingerprint,
    attestationKey: key,
  });
  return timingSafeEqualHex(receipt, expected);
}

function requiredLiveObserved(evidence: HonestPost133FrgPassEvidence): boolean {
  for (const id of FRG_HYBRID_LIVE_SCENARIO_IDS) {
    const scenario = evidence.scenarios.find((item) => item.id === id);
    if (!scenario || scenario.status === "not_observed") return false;
    if (scenario.source === "layer_a") return false;
  }
  const dimensions = evidence.composition?.dimensions ?? [];
  for (const id of FRG_HYBRID_LIVE_COMPOSITION_IDS) {
    const dimension = dimensions.find((item) => item.id === id);
    if (!dimension || dimension.status === "not_observed") return false;
    if (dimension.source === "layer_a") return false;
  }
  return true;
}

function layerAClaimsHaveCandidateTap(evidence: HonestPost133FrgPassEvidence): boolean {
  const provenance = evidence.pack_provenance ?? null;
  const candidateSha = provenance?.candidate_git_sha;
  if (!provenance || typeof candidateSha !== "string" || !GIT_SHA_RE.test(candidateSha)) {
    return false;
  }
  const probes = new Map(provenance.probes.map((probe) => [probe.id, probe] as const));
  const proofs = new Map(provenance.proofs.map((proof) => [proof.id, proof] as const));

  const checkLayerA = (id: string, source: string | undefined, proofIds: readonly string[] | undefined) => {
    if (source !== "layer_a") return true;
    if (isFrgRequiredLiveScenarioId(id) || isFrgRequiredLiveCompositionId(id)) return false;
    if (!proofIds?.length) return false;
    for (const proofId of proofIds) {
      if (!proofId.startsWith("probe:")) return false;
      const probeId = proofId.slice("probe:".length);
      const probe = probes.get(probeId);
      const proof = proofs.get(proofId);
      if (!probe || !proof || proof.source !== "layer_a") return false;
      if (probe.candidate_git_sha !== candidateSha) return false;
      if (!SHA256_RE.test(probe.stdout_sha256) || !SHA256_RE.test(probe.command_argv_sha256)) {
        return false;
      }
    }
    return true;
  };

  for (const scenario of evidence.scenarios) {
    if (!checkLayerA(scenario.id, scenario.source, scenario.proof_ids)) return false;
  }
  for (const dimension of evidence.composition?.dimensions ?? []) {
    if (!checkLayerA(dimension.id, dimension.source, dimension.proof_ids)) return false;
  }
  return true;
}

/**
 * Skip-frg restore precondition (#1038). True only for one post-1.33
 * `latest.json` (or equivalent) scored via `--from-run` of a request-bound
 * `factory-gate-v1` candidate pack, with required-live observed and Layer A
 * TAP hashes bound to the same candidate SHA.
 *
 * Full HMAC attestation (`integrity.attestation`) is **not** required here
 * (`requireAttestation: false`). A runner-issued HMAC `integrity.score_receipt`
 * **is** required so a hand-edited `pass: true` or a reminted public hash
 * cannot satisfy the skip-frg precondition. Auto-tag / pin children may
 * still require the full attestation MAC later.
 *
 * Later skip-frg restore work SHALL call this helper. It SHALL NOT invent a
 * second pass definition.
 */
export function isHonestPost133FrgPass(
  evidence: HonestPost133FrgPassEvidence,
  opts?: HonestPost133FrgPassOpts,
): boolean {
  if (!isPostHybridPilotVersion(evidence.version)) return false;
  if (!evidence.pass) return false;
  if (typeof evidence.run_id !== "string" || evidence.run_id.trim() === "") return false;
  if (typeof evidence.loop_run_id !== "string" || evidence.loop_run_id.trim() === "") {
    return false;
  }
  if (evidence.pack_id !== FRG_PACK_MANIFEST.pack_id) return false;
  const candidateSha = evidence.pack_provenance?.candidate_git_sha;
  if (typeof candidateSha !== "string" || !GIT_SHA_RE.test(candidateSha)) return false;
  if (honestPassUsedObservationsFile(evidence, opts)) return false;
  if (!honestPassIsFromRun(evidence, opts)) return false;
  if (!honestPassIsFactoryGatePack(evidence, opts)) return false;
  if (!requiredLiveObserved(evidence)) return false;
  if (!layerAClaimsHaveCandidateTap(evidence)) return false;
  if (!honestPassScoreReceiptMatches(evidence, opts)) return false;
  return isReleaseEligibleFrgPass(evidence, { requireAttestation: false });
}

/**
 * Persist gate for `.agent-pipeline/frg/<ver>/latest.json`.
 *
 * Requires `score_source` and `work_list` already present on `scored`.
 * Caller options cannot stamp those fields. Never rewrites `pass: false`
 * to `pass: true`. Persist `pass: true` only when the scored result is
 * true and the honest-pass checker accepts the object as-is.
 */
export function latestJsonForHonestPost133Persist(
  scored: HonestPost133FrgPassEvidence,
  opts?: HonestPost133FrgPassOpts,
): HonestPost133FrgPassEvidence {
  if (!scored.pass) {
    return { ...scored, pass: false };
  }
  const checkOpts: HonestPost133FrgPassOpts = {
    usedObservationsFile: opts?.usedObservationsFile,
  };
  if (opts?.scoreSource === "observations") checkOpts.scoreSource = "observations";
  if (opts?.workList === "product-milestone" || opts?.workList === "other") {
    checkOpts.workList = opts.workList;
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, "attestationKey")) {
    checkOpts.attestationKey = opts.attestationKey;
  }
  if (isHonestPost133FrgPass(scored, checkOpts)) {
    return { ...scored, pass: true };
  }
  return { ...scored, pass: false };
}

export interface HonestPost133LookupDeps {
  readFile(p: string): Promise<string>;
  readdir(p: string): Promise<string[]>;
}

const defaultHonestPost133LookupDeps: HonestPost133LookupDeps = {
  readFile: (p) => fsp.readFile(p, "utf8"),
  readdir: (p) => fsp.readdir(p),
};

function compareFrgSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Scan `.agent-pipeline/frg/<version>/latest.json` and return the first
 * post-1.33 artifact the honest-pass check accepts. Injectable I/O — tests
 * never touch the real tree.
 */
export async function lookupHonestPost133FrgPass(
  repoDir: string,
  deps: HonestPost133LookupDeps = defaultHonestPost133LookupDeps,
  opts?: HonestPost133FrgPassOpts,
): Promise<{ version: string; path: string; evidence: FrgEvidence } | null> {
  const root = path.join(repoDir, FRG_EVIDENCE_ROOT_REL);
  let names: string[];
  try {
    names = await deps.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const versions = names
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    .sort(compareFrgSemver);
  for (const version of versions) {
    const latestPath = frgLatestPath(repoDir, version);
    let text: string;
    try {
      text = await deps.readFile(latestPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    let evidence: FrgEvidence;
    try {
      evidence = parseFrgEvidenceJson(text);
    } catch {
      continue;
    }
    if (isHonestPost133FrgPass(evidence, opts)) {
      return { version, path: latestPath, evidence };
    }
  }
  return null;
}

export interface FrgValidateOpts {
  /**
   * HMAC key for attestation verification. When omitted, HMAC-verify presents
   * `PIPELINE_FRG_ATTESTATION_KEY_FILE` as KEY then authenticates with KEY.
   * Explicit `null` or empty fails closed (hand-authored JSON). Tests inject.
   */
  attestationKey?: string | null;
  /** Parent env for KEY_FILE presentation. Defaults to `process.env`. Tests inject. */
  env?: NodeJS.ProcessEnv;
  presentAttestorCredential?: PresentFrgAttestorCredentialDeps;
}

/**
 * Single strict release-eligibility validator for CLI, parse, lookup, and auto-tag.
 * Throws with a structured message when the raw payload is not release-eligible
 * for `expectedVersion`. Always verifies the HMAC attestation against the
 * producer key so self-consistent hand-authored JSON without the secret fails.
 */
export function validateReleaseEligibleFrgEvidence(
  raw: unknown,
  expectedVersion: string,
  opts: FrgValidateOpts = {},
): FrgEvidence {
  const expected = normalizeFrgVersion(expectedVersion);
  let evidence: FrgEvidence;
  try {
    evidence = typeof raw === "string" ? parseFrgEvidenceJson(raw) : parseFrgEvidence(raw);
  } catch (err) {
    throw new Error(
      `FRG release-eligibility validation failed for ${expected}: ${(err as Error).message}`,
    );
  }
  if (evidence.version !== expected) {
    throw new Error(
      `FRG release-eligibility validation failed for ${expected}: ` +
        `evidence.version is ${evidence.version}`,
    );
  }
  if (!evidence.pass || !isReleaseEligibleFrgPass(evidence)) {
    const missing =
      evidence.composition?.missing?.length
        ? ` missing composition=[${evidence.composition.missing.join(", ")}]`
        : "";
    throw new Error(
      `FRG release-eligibility validation failed for ${expected}: ` +
        `pass=${evidence.pass} releaseEligible=false` +
        missing,
    );
  }
  const key =
    opts.attestationKey !== undefined
      ? opts.attestationKey && opts.attestationKey.trim() !== ""
        ? opts.attestationKey.trim()
        : null
      : resolveFrgAttestationKey();
  if (!key) {
    throw new Error(
      `FRG release-eligibility validation failed for ${expected}: ` +
        `${FRG_ATTESTATION_KEY_ENV} is required to verify integrity.attestation ` +
        `(hand-authored self-consistent JSON is not release-eligible)`,
    );
  }
  if (!verifyFrgAttestation(evidence, key)) {
    throw new Error(
      `FRG release-eligibility validation failed for ${expected}: ` +
        `integrity.attestation MAC is missing or does not match ${FRG_ATTESTATION_KEY_ENV} ` +
        `(forged or re-signed evidence rejected)`,
    );
  }
  return evidence;
}

/** Repo-relative latest.json path named in every tag-path fail-closed message. */
export function frgLatestRelPath(version: string): string {
  return path.join(FRG_EVIDENCE_ROOT_REL, normalizeFrgVersion(version), "latest.json");
}

/**
 * Shared remediating suffix for tag-path FRG fail-closed. Auto-tag and
 * `--validate-tag` reuse this; do not tell the operator FRG is optional.
 */
export const FRG_TAG_PATH_REMEDIATION =
  "Remediation: run factory-release prepare or the Tugboat FRG pack phase " +
  "so that path contains a release-eligible pass artifact.";

/** Fail-closed tag-path message: names latest.json and the pack remediation. */
export function formatFrgTagPathFailure(version: string, reason: string): string {
  const v = normalizeFrgVersion(version);
  const lookup = frgLatestRelPath(v);
  return (
    `FRG evidence is not release-eligible for version ${v} at ${lookup} — ${reason}. ` +
    `Cannot create or push tag v${v} without a release-eligible FRG pass. ` +
    FRG_TAG_PATH_REMEDIATION
  );
}

/** Tag-validator ineligibility reasons that observe maps to not-observed. */
export type FrgTagPathIneligibilityKind = "missing" | "unreadable" | "not_release_eligible";

/**
 * Typed tag-path fail-closed error. Message stays {@link formatFrgTagPathFailure}
 * for tag/ensure-tag callers. Observe-path consumers classify with
 * {@link isFrgTagPathIneligibleError} and MUST NOT match formatter copy.
 */
export class FrgTagPathIneligibleError extends Error {
  readonly kind: FrgTagPathIneligibilityKind;
  readonly version: string;

  constructor(version: string, reason: string, kind: FrgTagPathIneligibilityKind) {
    super(formatFrgTagPathFailure(version, reason));
    this.name = "FrgTagPathIneligibleError";
    this.kind = kind;
    this.version = normalizeFrgVersion(version);
  }
}

export function isFrgTagPathIneligibleError(err: unknown): err is FrgTagPathIneligibleError {
  return err instanceof FrgTagPathIneligibleError;
}

/**
 * Observe-path mapping over the shared tag validator. Missing, unreadable, or
 * not-release-eligible `latest.json` is not observed (`null`). Classification
 * uses {@link FrgTagPathIneligibleError}, not formatter substrings. Missing
 * attestor and other non-ineligibility failures still throw.
 */
export async function observeReleaseEligibleFrgEvidence(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
  opts: FrgValidateOpts = {},
): Promise<FrgEvidence | null> {
  try {
    return await validateFrgEvidenceFileForTag(repoDir, version, deps, opts);
  } catch (err) {
    if (isFrgTagPathIneligibleError(err)) return null;
    throw err;
  }
}

/**
 * Validate the on-disk latest.json for a version (auto-tag / release path).
 * Fail closed on missing, unparsable, or not release-eligible evidence.
 * Every fail-closed path names `.agent-pipeline/frg/<X.Y.Z>/latest.json` and
 * the factory-release prepare / Tugboat FRG pack remediation.
 *
 * Returns the HMAC-validated evidence and the parsed snapshot from the **same**
 * file read so tag binding can compare `--packed-candidate` without reopening
 * `latest.json`.
 */
export async function validateFrgEvidenceSnapshotForTag(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
  opts: FrgValidateOpts = {},
): Promise<{ evidence: FrgEvidence; snapshot: unknown }> {
  const v = normalizeFrgVersion(version);
  const verifyOpts: FrgValidateOpts = { ...opts };
  if (!Object.prototype.hasOwnProperty.call(opts, "attestationKey")) {
    verifyOpts.attestationKey = requirePresentedFrgAttestationKey(
      opts.env ?? process.env,
      opts.presentAttestorCredential,
    );
  }
  const latestPath = frgLatestPath(repoDir, v);
  let text: string;
  try {
    text = await deps.readFile(latestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FrgTagPathIneligibleError(v, `missing at ${latestPath}`, "missing");
    }
    throw new FrgTagPathIneligibleError(
      v,
      `unreadable at ${latestPath}: ${(err as Error).message}`,
      "unreadable",
    );
  }
  try {
    const evidence = validateReleaseEligibleFrgEvidence(text, v, verifyOpts);
    return { evidence, snapshot: JSON.parse(text) as unknown };
  } catch (err) {
    throw new FrgTagPathIneligibleError(v, (err as Error).message, "not_release_eligible");
  }
}

/**
 * Validate the on-disk latest.json for a version (auto-tag / release path).
 * Fail closed on missing, unparsable, or not release-eligible evidence.
 * Every fail-closed path names `.agent-pipeline/frg/<X.Y.Z>/latest.json` and
 * the factory-release prepare / Tugboat FRG pack remediation.
 */
export async function validateFrgEvidenceFileForTag(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
  opts: FrgValidateOpts = {},
): Promise<FrgEvidence> {
  return (await validateFrgEvidenceSnapshotForTag(repoDir, version, deps, opts)).evidence;
}

/** capacity-blocked-retain pass requires observed blocked-retain count ≥ N. */
export function capacityScenarioMeetsNumericCriterion(
  scenarios: readonly FrgScenarioOutcome[],
  thresholds: FrgThresholds,
): boolean {
  const cap = scenarios.find((s) => s.id === "capacity-blocked-retain");
  if (!cap) return false;
  if (cap.status !== "pass") {
    // fail / not_observed / skip already handled by frgScenariosPermitPass;
    // warn is not permitted for capacity.
    return cap.status === "warn" ? false : true;
  }
  const n = thresholds.capacity_stress_n;
  return typeof cap.observed === "number" && Number.isFinite(cap.observed) && cap.observed >= n;
}

/**
 * Enforce machine-checked criteria on scenario outcomes (overrides are not
 * authoritative for numeric / skip rules). Mutates statuses to fail when
 * claims are not proven.
 */
export function enforceRequiredScenarioCriteria(
  scenarios: readonly FrgScenarioOutcome[],
  thresholds: FrgThresholds,
): FrgScenarioOutcome[] {
  return scenarios.map((s) => {
    // Required Layer-B pack scenarios cannot be skipped.
    if (s.status === "skip") {
      return {
        ...s,
        status: "fail" as const,
        detail: `required FRG scenario ${s.id} cannot be skipped; live observation required`,
      };
    }

    if (s.id === "capacity-blocked-retain") {
      const n = thresholds.capacity_stress_n;
      if (s.status === "pass" || s.status === "warn") {
        const obs = s.observed;
        if (typeof obs !== "number" || !Number.isFinite(obs) || obs < n) {
          return {
            ...s,
            status: "fail" as const,
            detail:
              `capacity-blocked-retain requires observed blocked-retain count ≥ N=${n} ` +
              `(got ${obs === null || obs === undefined ? "null" : String(obs)})`,
            observed: typeof obs === "number" ? obs : null,
            threshold: n,
          };
        }
        // Capacity may only pass (not warn) when N is proven.
        if (s.status === "warn") {
          return {
            ...s,
            status: "pass" as const,
            detail:
              s.detail ||
              `capacity stress observed=${obs} ≥ N=${n}; no false needs-human cascade`,
            observed: obs,
            threshold: n,
          };
        }
        return { ...s, observed: obs, threshold: n };
      }
      return { ...s, threshold: s.threshold ?? n };
    }

    // Unauthorized warn on required scenarios is not pass-permitting proof.
    if (s.status === "warn" && !FRG_WARN_PERMITTED_SCENARIO_IDS.has(s.id)) {
      return {
        ...s,
        status: "fail" as const,
        detail:
          `required scenario ${s.id} status=warn is not a documented pass-permitting outcome ` +
          `(only ${[...FRG_WARN_PERMITTED_SCENARIO_IDS].join(", ")} may warn)`,
      };
    }

    return s;
  });
}

/** Parse and validate a machine-readable FRG evidence object (full expected schema). */
const HONEST_POST133_SCORE_SOURCES = ["from-run", "observations", "unknown"] as const;
const HONEST_POST133_WORK_LISTS = ["factory-gate-pack", "product-milestone", "other"] as const;

function parseOptionalHonestEnum<T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new Error(`FRG evidence.${field} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

export function parseFrgEvidence(raw: unknown): FrgEvidence {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG evidence must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== FRG_SCHEMA_VERSION) {
    throw new Error(
      `FRG evidence schema_version must be ${FRG_SCHEMA_VERSION} (got ${String(o.schema_version)})`,
    );
  }
  if (typeof o.version !== "string" || !/^\d+\.\d+\.\d+$/.test(o.version)) {
    throw new Error("FRG evidence.version must be X.Y.Z");
  }
  if (typeof o.run_id !== "string" || o.run_id.trim() === "") {
    throw new Error("FRG evidence.run_id must be a non-empty string");
  }
  if (typeof o.pass !== "boolean") {
    throw new Error("FRG evidence.pass must be a boolean");
  }
  if (!Array.isArray(o.scenarios)) {
    throw new Error("FRG evidence.scenarios must be an array");
  }
  if (o.scenarios.length !== FRG_SCENARIO_IDS.length) {
    throw new Error(
      `FRG evidence.scenarios must include exactly ${FRG_SCENARIO_IDS.length} named outcomes ` +
        `(got ${o.scenarios.length})`,
    );
  }
  const scenarios = o.scenarios.map((s, i) => parseFrgScenarioOutcome(s, i));
  const seen = new Set(scenarios.map((s) => s.id));
  if (seen.size !== FRG_SCENARIO_IDS.length) {
    throw new Error("FRG evidence.scenarios must not duplicate scenario ids");
  }
  for (const id of FRG_SCENARIO_IDS) {
    if (!seen.has(id)) {
      throw new Error(`FRG evidence.scenarios missing required scenario id ${id}`);
    }
  }
  const scoreboard = parseFrgScoreboard(o.scoreboard);
  const thresholds = parseFrgThresholds(o.thresholds);
  if (o.loop_run_id !== null && typeof o.loop_run_id !== "string") {
    throw new Error("FRG evidence.loop_run_id must be a string or null");
  }
  // pack_id: null | string; omit → null (pre-provenance artifacts)
  if (
    o.pack_id !== undefined &&
    o.pack_id !== null &&
    typeof o.pack_id !== "string"
  ) {
    throw new Error("FRG evidence.pack_id must be a string or null");
  }
  const packId =
    o.pack_id === undefined || o.pack_id === null
      ? null
      : (o.pack_id as string).trim() === ""
        ? null
        : (o.pack_id as string).trim();
  if (typeof o.created_at !== "string" || o.created_at.trim() === "") {
    throw new Error("FRG evidence.created_at must be a non-empty string");
  }
  if (!Array.isArray(o.notes) || !o.notes.every((n) => typeof n === "string")) {
    throw new Error("FRG evidence.notes must be an array of strings");
  }

  // composition + integrity required on the wire (additive schema fields for #757)
  if (o.composition === undefined || o.composition === null) {
    throw new Error("FRG evidence.composition is required");
  }
  const composition = parseFrgComposition(o.composition);
  const packProvenance = o.pack_provenance === undefined || o.pack_provenance === null
    ? null
    : parseFrgPackProvenance(o.pack_provenance);
  if (o.integrity === undefined || o.integrity === null) {
    throw new Error("FRG evidence.integrity is required");
  }
  const integrity = parseFrgIntegrity(o.integrity);
  // Recompute fingerprints — forged/stale integrity fails parse.
  const expectedSbFp = computeScoreboardFingerprint(scoreboard);
  const expectedCompFp = computeCompositionFingerprint(composition);
  if (integrity.scoreboard_fingerprint !== expectedSbFp) {
    throw new Error(
      "FRG evidence.integrity.scoreboard_fingerprint does not match recomputed scoreboard fingerprint",
    );
  }
  if (integrity.composition_fingerprint !== expectedCompFp) {
    throw new Error(
      "FRG evidence.integrity.composition_fingerprint does not match recomputed composition fingerprint",
    );
  }
  if (packProvenance) {
    const expectedPackFp = computePackProvenanceFingerprint(packProvenance);
    if (integrity.pack_provenance_fingerprint !== expectedPackFp) {
      throw new Error(
        "FRG evidence.integrity.pack_provenance_fingerprint does not match recomputed pack provenance fingerprint",
      );
    }
  } else if (integrity.pack_provenance_fingerprint !== undefined) {
    throw new Error(
      "FRG evidence.integrity.pack_provenance_fingerprint is present without pack_provenance",
    );
  }
  const recovery_aggregates = parseFrgRecoveryAggregates(o.recovery_aggregates);
  const scoreSource = parseOptionalHonestEnum(
    o.score_source,
    "score_source",
    HONEST_POST133_SCORE_SOURCES,
  );
  const workList = parseOptionalHonestEnum(
    o.work_list,
    "work_list",
    HONEST_POST133_WORK_LISTS,
  );

  // Re-apply numeric/skip criteria so forged overrides cannot parse as pass.
  const enforced = enforceRequiredScenarioCriteria(scenarios, thresholds);
  const loopRunId =
    o.loop_run_id === null || o.loop_run_id === undefined
      ? null
      : typeof o.loop_run_id === "string" && o.loop_run_id.trim() !== ""
        ? o.loop_run_id.trim()
        : null;
  const releaseEligible = isReleaseEligibleFrgPass({
    pass: true, // evaluate eligibility of the scenario/provenance fields
    version: o.version,
    scenarios: enforced,
    loop_run_id: loopRunId,
    pack_id: packId,
    thresholds,
    scoreboard,
    composition,
    integrity,
    pack_provenance: packProvenance,
    run_id: typeof o.run_id === "string" ? o.run_id : "",
  });

  if (o.pass === true && !releaseEligible) {
    const missing =
      composition.missing.length > 0
        ? ` missing composition=[${composition.missing.join(", ")}]`
        : "";
    throw new Error(
      "FRG evidence.pass is true but is not release-eligible " +
        "(require observed non-fail scenarios including capacity observed≥N, " +
        `non-empty loop_run_id, pack_id=${FRG_PACK_MANIFEST.pack_id}, ` +
        "item_count≥1 with computable engine_class_rate, representative composition, " +
        "false_human_authority_count=0, valid integrity fingerprints, and " +
        "integrity.attestation (HMAC via PIPELINE_FRG_ATTESTATION_KEY);" +
        `${missing} offline scoreInput reports are not release evidence)`,
    );
  }
  if (o.pass === false && releaseEligible) {
    throw new Error(
      "FRG evidence.pass is false but evidence is release-eligible " +
        "(inconsistent evidence)",
    );
  }

  const evidence: FrgEvidence = {
    schema_version: FRG_SCHEMA_VERSION,
    version: o.version,
    run_id: o.run_id.trim(),
    pass: o.pass,
    scenarios: enforced,
    scoreboard,
    thresholds,
    loop_run_id: loopRunId,
    pack_id: packId,
    created_at: o.created_at,
    notes: o.notes as string[],
    composition,
    integrity,
    pack_provenance: packProvenance,
  };
  if (recovery_aggregates) evidence.recovery_aggregates = recovery_aggregates;
  if (scoreSource !== undefined) evidence.score_source = scoreSource;
  if (workList !== undefined) evidence.work_list = workList;
  if (Object.prototype.hasOwnProperty.call(o, "factory_release_binding")) {
    evidence.factory_release_binding = o.factory_release_binding;
  }
  return evidence;
}

/** Synchronous-style parse from a JSON string. */
export function parseFrgEvidenceJson(text: string): FrgEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`FRG evidence JSON parse failed: ${(err as Error).message}`);
  }
  return parseFrgEvidence(raw);
}

/** Build a trend-ledger entry from scored evidence. */
export function trendLedgerEntryFromEvidence(evidence: FrgEvidence): FrgTrendLedgerEntry {
  const entry: FrgTrendLedgerEntry = {
    version: evidence.version,
    run_id: evidence.run_id,
    loop_run_id: evidence.loop_run_id,
    pass: evidence.pass,
    pack_id: evidence.pack_id,
    created_at: evidence.created_at,
    item_count: evidence.scoreboard.item_count,
    ready_clean_count: evidence.scoreboard.ready_clean_count,
    engine_class_count: evidence.scoreboard.engine_class_count,
    engine_class_rate: evidence.scoreboard.engine_class_rate,
    thresholds: { ...evidence.thresholds },
    composition_missing: [...evidence.composition.missing],
    false_human_authority_count: evidence.composition.false_human_authority_count,
  };
  if (evidence.recovery_aggregates) {
    entry.recovery_aggregates = evidence.recovery_aggregates;
  }
  return entry;
}

/**
 * Append a trend-ledger line with idempotency key (version, run_id).
 * Duplicate keys are no-ops. Read–merge–write is serialized via
 * {@link FrgFsDeps.withPathLock} (host-local) and uses a unique temp filename
 * so concurrent writers cannot clobber retained history via a shared `.tmp`.
 */
export async function appendFrgTrendLedger(
  repoDir: string,
  entry: FrgTrendLedgerEntry,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<{ appended: boolean; path: string }> {
  const ledgerPath = frgTrendLedgerPath(repoDir);
  await deps.mkdir(path.dirname(ledgerPath), { recursive: true });

  const critical = async (): Promise<{ appended: boolean; path: string }> => {
    let existing = "";
    try {
      existing = await deps.readFile(ledgerPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const lines = existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const prev = JSON.parse(line) as { version?: unknown; run_id?: unknown };
        if (prev.version === entry.version && prev.run_id === entry.run_id) {
          return { appended: false, path: ledgerPath };
        }
      } catch {
        // keep malformed prior lines; do not treat as the same key
      }
    }
    const nextBody = `${lines.length ? lines.join("\n") + "\n" : ""}${JSON.stringify(entry)}\n`;
    // Unique temp avoids two writers racing on the same `${ledgerPath}.tmp`.
    const tmp =
      `${ledgerPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
    await deps.writeFile(tmp, nextBody);
    await deps.rename(tmp, ledgerPath);
    return { appended: true, path: ledgerPath };
  };

  const lock = deps.withPathLock ?? defaultFrgPathLock;
  return lock(ledgerPath, critical);
}

/**
 * Atomic write of immutable evidence + latest pointer for the version.
 * After primary success, appends a trend-ledger entry (fail-soft: reports via
 * optional onLedgerError, never deletes evidence).
 */
export async function writeFrgEvidence(
  repoDir: string,
  evidence: FrgEvidence,
  deps: FrgFsDeps = defaultFsDeps,
  opts?: {
    onLedgerError?: (err: Error) => void;
  },
): Promise<{ evidencePath: string; latestPath: string; ledgerPath: string | null; ledgerAppended: boolean }> {
  const version = normalizeFrgVersion(evidence.version);
  const evidencePath = frgRunEvidencePath(repoDir, version, evidence.run_id);
  const latestPath = frgLatestPath(repoDir, version);
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  await deps.mkdir(path.dirname(evidencePath), { recursive: true });
  const tmp = `${evidencePath}.tmp`;
  await deps.writeFile(tmp, body);
  await deps.rename(tmp, evidencePath);
  await deps.mkdir(path.dirname(latestPath), { recursive: true });
  const latestTmp = `${latestPath}.tmp`;
  await deps.writeFile(latestTmp, body);
  await deps.rename(latestTmp, latestPath);

  let ledgerPath: string | null = null;
  let ledgerAppended = false;
  try {
    const ledger = await appendFrgTrendLedger(
      repoDir,
      trendLedgerEntryFromEvidence(evidence),
      deps,
    );
    ledgerPath = ledger.path;
    ledgerAppended = ledger.appended;
  } catch (err) {
    const e = err as Error;
    if (opts?.onLedgerError) {
      opts.onLedgerError(e);
    }
    // Fail-soft: primary evidence remains; do not rethrow.
  }
  return { evidencePath, latestPath, ledgerPath, ledgerAppended };
}

/**
 * Look up the latest FRG evidence for a version. Distinguishes missing vs
 * failed vs unparsable so release can surface the right refusal.
 */
export async function lookupFrgPass(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<FrgLookupResult> {
  const v = normalizeFrgVersion(version);
  const latestPath = frgLatestPath(repoDir, v);
  let text: string;
  try {
    text = await deps.readFile(latestPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", version: v, path: latestPath };
    }
    return {
      kind: "unparsable",
      version: v,
      path: latestPath,
      detail: (err as Error).message,
    };
  }
  try {
    const evidence = parseFrgEvidenceJson(text);
    if (evidence.version !== v) {
      return {
        kind: "unparsable",
        version: v,
        path: latestPath,
        detail: `evidence.version ${evidence.version} does not match lookup ${v}`,
      };
    }
    if (!evidence.run_id.trim()) {
      return {
        kind: "unparsable",
        version: v,
        path: latestPath,
        detail: "evidence.run_id is empty",
      };
    }
    return evidence.pass
      ? { kind: "pass", evidence }
      : { kind: "fail", evidence };
  } catch (err) {
    return {
      kind: "unparsable",
      version: v,
      path: latestPath,
      detail: (err as Error).message,
    };
  }
}

/** Documented native-`/goal` engine for the factory-gate pack loop (#1252). */
export const FRG_PACK_LOOP_NATIVE_GOAL_PROFILE = "claude";

export function frgPackLoopCommand(): string {
  return `pipeline loop --label factory-gate --profile ${FRG_PACK_LOOP_NATIVE_GOAL_PROFILE}`;
}

export function frgScorerFromRunCommand(version: string): string {
  return `pipeline factory-gate --for ${normalizeFrgVersion(version)} --from-run <loop-run-id>`;
}

/**
 * Shared next-command block for missing / unparsable / ineligible FRG evidence.
 * Pack loop + native-`/goal` profile first; scorer `--from-run` second.
 * Optional extras (e.g. `factory-release prepare`) follow. `--skip-frg` last.
 */
export function formatMissingFrgRecoveryCommands(opts: {
  version: string;
  extraLines?: readonly string[];
  includeSkipEscape?: boolean;
}): string {
  const v = normalizeFrgVersion(opts.version);
  const lines = [
    `    ${frgPackLoopCommand()}`,
    `    ${frgScorerFromRunCommand(v)}`,
    ...(opts.extraLines ?? []).map((line) =>
      line.startsWith("    ") ? line : `    ${line}`,
    ),
  ];
  if (opts.includeSkipEscape) {
    lines.push(
      "    Escape (non-production no-frg-* pin; not a substitute for the pack loop): pipeline release --skip-frg",
    );
  }
  return lines.join("\n");
}

function frgRecoveryFooter(version: string, includeSkipEscape: boolean): string {
  return (
    `Run the factory-gate pack on a native-/goal engine, then score it:\n` +
    formatMissingFrgRecoveryCommands({ version, includeSkipEscape }) +
    `\nSee docs/factory-reliability-gate-runbook.md.`
  );
}

export function missingFrgPassDiagnostic(opts: {
  version: string;
  path: string;
}): string {
  const v = normalizeFrgVersion(opts.version);
  return (
    `[pipeline release] Factory Reliability Gate pass missing for version ${v} ` +
    `(expected ${opts.path}). ` +
    `Unit CI alone is not sufficient. ` +
    frgRecoveryFooter(v, true)
  );
}

export function factoryGateMissingFromRunUsage(): string {
  return (
    "pipeline factory-gate: provide --from-run <loop-run-id> after a durable pack loop finishes.\n" +
      "  1) Start the pack via shipped durable loop on a native-/goal engine (no second ledger):\n" +
      `       ${frgPackLoopCommand()}\n` +
      "     (or --milestone <reliability-pack> — not the full product milestone)\n" +
      "  2) Score + write evidence:\n" +
      "       pipeline factory-gate --for <X.Y.Z> --from-run <loop-run-id> [--json]\n" +
      "  See docs/factory-reliability-gate-runbook.md"
  );
}

export function shipMissingFrgDiagnostic(opts: {
  version: string;
  includePrepare?: boolean;
}): string {
  const v = normalizeFrgVersion(opts.version);
  const extra = opts.includePrepare
    ? [
        "pipeline factory-release prepare --request <absolute-off-repo-request.json> --json",
      ]
    : [];
  return (
    `ship FRG: no release-eligible candidate artifact for v${v}. ` +
    `Unit CI alone is not sufficient. ` +
    `Run the factory-gate pack on a native-/goal engine, then score it:\n` +
    formatMissingFrgRecoveryCommands({ version: v, extraLines: extra }) +
    (opts.includePrepare
      ? `\nPrepare is an additional durable path (it does not replace the loop + profile + --from-run commands). ` +
        `Hybrid pilot remains valid only for exactly v${FRG_HYBRID_PILOT_VERSION}.`
      : "")
  );
}

/**
 * Release-path gate: require a pass artifact for the resolved version.
 * Throws with a message that names the version and the runnable pack path.
 */
export async function requireFrgPassForRelease(
  repoDir: string,
  version: string,
  deps: FrgFsDeps = defaultFsDeps,
): Promise<FrgEvidence> {
  const v = normalizeFrgVersion(version);
  const result = await lookupFrgPass(repoDir, v, deps);
  if (result.kind === "pass") return result.evidence;
  if (result.kind === "fail") {
    throw new Error(
      `[pipeline release] Factory Reliability Gate FAILED for version ${v} ` +
        `(run_id=${result.evidence.run_id}). ` +
        frgRecoveryFooter(v, true),
    );
  }
  if (result.kind === "unparsable") {
    throw new Error(
      `[pipeline release] Factory Reliability Gate evidence for version ${v} is unparsable ` +
        `(${result.path}): ${result.detail}. ` +
        frgRecoveryFooter(v, true),
    );
  }
  throw new Error(missingFrgPassDiagnostic({ version: v, path: result.path }));
}

/** Format engine-class rate for PR/CLI: never print n/a when item_count ≥ 1. */
export function formatEngineClassRateDisplay(scoreboard: FrgScoreboard): string {
  if (scoreboard.item_count >= 1) {
    const rate =
      scoreboard.engine_class_rate === null
        ? 0
        : scoreboard.engine_class_rate;
    return `${(rate * 100).toFixed(1)}%`;
  }
  return "n/a (empty pack)";
}

/** Markdown section for the release PR body. */
export function formatFrgPrSection(evidence: FrgEvidence): string {
  const missing =
    evidence.composition.missing.length > 0
      ? `- **Composition missing:** ${evidence.composition.missing.join(", ")}`
      : null;
  return [
    "### Factory Reliability Gate",
    "",
    `- **Version:** ${evidence.version}`,
    `- **Result:** ${evidence.pass ? "pass" : "fail"}`,
    `- **FRG run_id:** \`${evidence.run_id}\``,
    evidence.loop_run_id ? `- **Loop run_id:** \`${evidence.loop_run_id}\`` : null,
    `- **Clean ready-to-deploy:** ${evidence.scoreboard.ready_clean_count} (threshold K=${evidence.thresholds.min_clean_ready_to_deploy})`,
    `- **Engine-class rate:** ${formatEngineClassRateDisplay(evidence.scoreboard)} (max ${(evidence.thresholds.max_engine_class_rate * 100).toFixed(0)}%; denom=item_count)`,
    `- **Composition:** ${evidence.composition.missing.length === 0 ? "all dimensions pass" : `missing ${evidence.composition.missing.length}`}`,
    missing,
    "",
    `_Evidence: \`${FRG_EVIDENCE_ROOT_REL}/${evidence.version}/${evidence.run_id}/evidence.json\`_`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Scoring from durable loop ledger / item outcomes
// ---------------------------------------------------------------------------

export interface FrgItemInput {
  item_id: string;
  state: string;
  blocker_theme?: string | null;
  /** When true, item reached ready/ready-to-deploy without engine-class block. */
  ready_clean?: boolean;
}

export interface FrgScenarioOverride {
  id: FrgScenarioId;
  status: FrgScenarioStatus;
  detail: string;
  observed?: number | null;
  threshold?: number | null;
  source?: FrgPackProofSource;
  proof_ids?: string[];
}

/**
 * Fixture helper: mark every non-auto-scored pack scenario as observed.
 * Use with items that already satisfy K / engine-rate so overall pass can be true.
 * Capacity always carries `observed ≥ capacity_stress_n` when status is pass.
 * Live Layer B must still supply real observations (or pack automation); this is for
 * hermetic scoring tests only. Offline scoreInput still needs `loop_run_id` +
 * `pack_id` for release-eligible `pass: true`.
 *
 * **Test-only** — operators must use `--observations <file>` (see runbook).
 */
export function frgRequiredObservationOverrides(
  status: Exclude<FrgScenarioStatus, "not_observed"> = "pass",
  thresholds: FrgThresholds = DEFAULT_FRG_THRESHOLDS,
): FrgScenarioOverride[] {
  const auto = new Set<string>(FRG_AUTO_SCORED_SCENARIO_IDS);
  return FRG_SCENARIO_IDS.filter((id) => !auto.has(id)).map((id) => {
    if (id === "capacity-blocked-retain") {
      const n = thresholds.capacity_stress_n;
      if (status === "pass") {
        return {
          id,
          status,
          detail: `capacity stress observed=${n} ≥ N=${n}; no false needs-human cascade`,
          observed: n,
          threshold: n,
        };
      }
      if (status === "skip" || status === "fail") {
        return {
          id,
          status,
          detail: `observed ${status}: ${id}`,
          observed: status === "fail" ? 0 : null,
          threshold: n,
        };
      }
      // warn is not pass-permitting for capacity — still attach N for clarity
      return {
        id,
        status,
        detail: `observed warn: ${id}`,
        observed: n,
        threshold: n,
      };
    }
    return {
      id,
      status,
      detail:
        status === "pass"
          ? `observed pass: ${id}`
          : status === "warn"
            ? `observed warn: ${id}`
            : `observed ${status}: ${id}`,
      observed: null,
      threshold: null,
    };
  });
}

export interface FrgCompositionOverride {
  id: FrgCompositionDimensionId;
  status: FrgCompositionStatus;
  detail: string;
  source?: FrgCompositionSource;
  observed?: number | null;
  proof_ids?: string[];
}

/**
 * Fixture helper: mark every required composition dimension with a status.
 * **Test-only** companion to {@link frgRequiredObservationOverrides}.
 * Operators supply composition via `--observations` file.
 */
export function frgRequiredCompositionOverrides(
  status: FrgCompositionStatus = "pass",
  thresholds: FrgThresholds = DEFAULT_FRG_THRESHOLDS,
): FrgCompositionOverride[] {
  return FRG_COMPOSITION_DIMENSION_IDS.map((id) => {
    const observed =
      id === "concurrency-contention" && status === "pass"
        ? thresholds.capacity_stress_n
        : null;
    return {
      id,
      status,
      source: "observation" as const,
      detail:
        status === "pass"
          ? `observed pass: ${id}`
          : status === "fail"
            ? `observed fail: ${id}`
            : `not observed: ${id}`,
      observed,
    };
  });
}

/**
 * Build a full composition block from overrides + defaults (not_observed).
 */
export function buildFrgComposition(input: {
  overrides?: FrgCompositionOverride[];
  false_human_authority_count?: number;
  /** Optional ledger-derived projections applied before overrides. */
  ledgerProjections?: FrgCompositionOverride[];
}): FrgComposition {
  const byId = new Map<FrgCompositionDimensionId, FrgCompositionDimension>();
  for (const id of FRG_COMPOSITION_DIMENSION_IDS) {
    byId.set(id, {
      id,
      status: "not_observed",
      source: "derived",
      detail: "not observed in this scoring pass",
      observed: null,
    });
  }
  for (const o of input.ledgerProjections ?? []) {
    byId.set(o.id, {
      id: o.id,
      status: o.status,
      source: o.source ?? "ledger",
      detail: o.detail,
      observed: o.observed ?? null,
      ...(o.proof_ids ? { proof_ids: [...o.proof_ids] } : {}),
    });
  }
  for (const o of input.overrides ?? []) {
    byId.set(o.id, {
      id: o.id,
      status: o.status,
      source: o.source ?? "observation",
      detail: o.detail,
      observed: o.observed ?? null,
      ...(o.proof_ids ? { proof_ids: [...o.proof_ids] } : {}),
    });
  }
  const dimensions = FRG_COMPOSITION_DIMENSION_IDS.map((id) => byId.get(id)!);
  return {
    dimensions,
    false_human_authority_count: input.false_human_authority_count ?? 0,
    missing: compositionMissingIds(dimensions),
  };
}

/**
 * Project composition dimensions from capacity scenario + item signals when possible.
 * Remaining dimensions stay not_observed until observation file fills them.
 */
export function projectCompositionFromScoreboard(
  scenarios: readonly FrgScenarioOutcome[],
  scoreboard: FrgScoreboard,
  thresholds: FrgThresholds,
): FrgCompositionOverride[] {
  const out: FrgCompositionOverride[] = [];
  const cap = scenarios.find((s) => s.id === "capacity-blocked-retain");
  if (
    cap &&
    cap.status === "pass" &&
    typeof cap.observed === "number" &&
    cap.observed >= thresholds.capacity_stress_n
  ) {
    out.push({
      id: "concurrency-contention",
      status: "pass",
      source: "ledger",
      detail: `capacity-blocked-retain observed=${cap.observed} ≥ N=${thresholds.capacity_stress_n}`,
      observed: cap.observed,
    });
    out.push({
      id: "capacity-live-run-coexistence",
      status: "pass",
      source: "derived",
      detail: `capacity stress N=${cap.observed} with multi-item pack (item_count=${scoreboard.item_count})`,
      observed: cap.observed,
    });
  }
  // OpenSpec multi-change scenario pass is a weak ledger signal for openspec-bearing.
  const os = scenarios.find((s) => s.id === "openspec-multi-change");
  if (os && os.status === "pass") {
    out.push({
      id: "openspec-bearing-item",
      status: "pass",
      source: "derived",
      detail: "openspec-multi-change scenario passed (archive/coherence path exercised)",
      observed: null,
    });
  }
  // Lockfile dirt scenario → managed-worktree-dirt
  const dirt = scenarios.find((s) => s.id === "implement-lockfile-dirt");
  if (dirt && dirt.status === "pass") {
    out.push({
      id: "managed-worktree-dirt",
      status: "pass",
      source: "derived",
      detail: "implement-lockfile-dirt scenario passed",
      observed: null,
    });
  }
  // Resume → process-restart-hydration
  const resume = scenarios.find((s) => s.id === "resume-mid-flight");
  if (resume && resume.status === "pass") {
    out.push({
      id: "process-restart-hydration",
      status: "pass",
      source: "derived",
      detail: "resume-mid-flight scenario passed",
      observed: null,
    });
  }
  return out;
}

/** Observation file schema version. */
export const FRG_OBSERVATIONS_SCHEMA_VERSION = 1;

export interface FrgObservationsFile {
  schema_version: number;
  scenarios?: FrgScenarioOverride[];
  composition?: FrgCompositionOverride[];
  false_human_authority_count?: number;
  recovery_aggregates?: FrgRecoveryAggregates;
  pack_provenance?: FrgPackProvenance;
}

function requiredObservationString(
  value: unknown,
  field: string,
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.trim() === "" || (pattern && !pattern.test(value))) {
    throw new Error(`FRG observations.${field} is invalid`);
  }
  return value;
}

function requiredObservationStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.trim() !== "") ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`FRG observations.${field} must be unique non-empty strings`);
  }
  return [...value] as string[];
}

/** Strict parser for the candidate/run/manifest proof block emitted by the runner. */
export function parseFrgPackProvenance(raw: unknown): FrgPackProvenance {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG observations.pack_provenance must be an object");
  }
  const p = raw as Record<string, unknown>;
  if (
    p.schema_version !== 1 ||
    p.pack_id !== FRG_PACK_MANIFEST.pack_id ||
    p.manifest_version !== 1
  ) {
    throw new Error("FRG observations.pack_provenance identity or schema is invalid");
  }
  if (typeof p.policy_id !== "string" || p.policy_id.trim() === "") {
    throw new Error("FRG observations.pack_provenance.policy_id is invalid");
  }
  const policyId = p.policy_id;
  if (!isFrgHybridV1PolicyId(policyId) && !isFrgHybridV2PolicyId(policyId)) {
    throw new Error(
      `FRG observations.pack_provenance.policy_id is not a known hybrid policy (got ${policyId})`,
    );
  }
  if (typeof p.release_version !== "string" || !/^\d+\.\d+\.\d+$/.test(p.release_version)) {
    throw new Error("FRG observations.pack_provenance.release_version must be X.Y.Z");
  }
  const releaseVersion = p.release_version;
  if (isFrgHybridV1PolicyId(policyId)) {
    if (releaseVersion !== FRG_HYBRID_PILOT_VERSION) {
      throw new Error(
        `historical ${FRG_HYBRID_PILOT_POLICY_ID} pack_provenance is valid only for ${FRG_HYBRID_PILOT_VERSION}`,
      );
    }
    if (p.replacement_issue !== FRG_HYBRID_REPLACEMENT_ISSUE) {
      throw new Error(
        `historical ${FRG_HYBRID_PILOT_POLICY_ID} pack_provenance requires replacement_issue ${FRG_HYBRID_REPLACEMENT_ISSUE}`,
      );
    }
  }
  const digest = /^[0-9a-f]{64}$/;
  const gitSha = /^[0-9a-f]{40,64}$/;
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
  const manifestSha = requiredObservationString(p.manifest_sha256, "pack_provenance.manifest_sha256", digest);
  const candidateSha = requiredObservationString(p.candidate_git_sha, "pack_provenance.candidate_git_sha", gitSha);
  const packRunId = requiredObservationString(p.pack_run_id, "pack_provenance.pack_run_id", safeId);
  const loopRunId = requiredObservationString(p.loop_run_id, "pack_provenance.loop_run_id", safeId);
  const repository = requiredObservationString(p.repository, "pack_provenance.repository", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  const baseBranch = requiredObservationString(p.base_branch, "pack_provenance.base_branch");
  const startedAt = requiredObservationString(p.started_at, "pack_provenance.started_at");
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("FRG observations.pack_provenance.started_at is invalid");
  const contractSha = requiredObservationString(p.contract_sha256, "pack_provenance.contract_sha256", digest);
  const ledgerSha = requiredObservationString(p.ledger_sha256, "pack_provenance.ledger_sha256", digest);
  const eventsSha = requiredObservationString(p.events_sha256, "pack_provenance.events_sha256", digest);
  const actionSha = requiredObservationString(p.action_evidence_sha256, "pack_provenance.action_evidence_sha256", digest);
  if (!Array.isArray(p.issues) || p.issues.length < FRG_PACK_MANIFEST.min_item_count) {
    throw new Error("FRG observations.pack_provenance.issues must contain the fresh pack items");
  }
  const issues = p.issues.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`FRG observations.pack_provenance.issues[${index}] must be an object`);
    }
    const issue = entry as Record<string, unknown>;
    const issueNumber = issue.issue_number;
    const prNumber = issue.pr_number;
    if (!Number.isSafeInteger(issueNumber) || (issueNumber as number) <= 0 || !Number.isSafeInteger(prNumber) || (prNumber as number) <= 0) {
      throw new Error(`FRG observations.pack_provenance.issues[${index}] has invalid issue or PR identity`);
    }
    const createdAt = requiredObservationString(issue.created_at, `pack_provenance.issues[${index}].created_at`);
    if (!Number.isFinite(Date.parse(createdAt)) || Date.parse(createdAt) < Date.parse(startedAt)) {
      throw new Error(`FRG observations.pack_provenance.issues[${index}] is not fresh`);
    }
    return {
      issue_number: issueNumber as number,
      issue_node_id: requiredObservationString(issue.issue_node_id, `pack_provenance.issues[${index}].issue_node_id`, safeId),
      template_id: requiredObservationString(issue.template_id, `pack_provenance.issues[${index}].template_id`, safeId),
      template_sha256: requiredObservationString(issue.template_sha256, `pack_provenance.issues[${index}].template_sha256`, digest),
      created_at: new Date(Date.parse(createdAt)).toISOString(),
      advance_run_id: requiredObservationString(issue.advance_run_id, `pack_provenance.issues[${index}].advance_run_id`, safeId),
      pr_number: prNumber as number,
      pr_node_id: requiredObservationString(issue.pr_node_id, `pack_provenance.issues[${index}].pr_node_id`, safeId),
      pr_head_sha: requiredObservationString(issue.pr_head_sha, `pack_provenance.issues[${index}].pr_head_sha`, gitSha),
      pr_files_sha256: requiredObservationString(issue.pr_files_sha256, `pack_provenance.issues[${index}].pr_files_sha256`, digest),
      check_run_ids: requiredObservationStringArray(issue.check_run_ids, `pack_provenance.issues[${index}].check_run_ids`),
    };
  });
  if (new Set(issues.map((issue) => issue.issue_number)).size !== issues.length || new Set(issues.map((issue) => issue.template_id)).size !== issues.length) {
    throw new Error("FRG observations.pack_provenance.issues has duplicate issue or template identities");
  }
  if (!Array.isArray(p.probes) || p.probes.length === 0) {
    throw new Error("FRG observations.pack_provenance.probes must be non-empty");
  }
  const probes = p.probes.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`FRG observations.pack_provenance.probes[${index}] must be an object`);
    }
    const probe = entry as Record<string, unknown>;
    const probeCandidate = requiredObservationString(probe.candidate_git_sha, `pack_provenance.probes[${index}].candidate_git_sha`, gitSha);
    if (probeCandidate !== candidateSha) throw new Error(`FRG observations.pack_provenance.probes[${index}] is bound to another candidate`);
    return {
      id: requiredObservationString(probe.id, `pack_provenance.probes[${index}].id`, safeId),
      test_file: requiredObservationString(probe.test_file, `pack_provenance.probes[${index}].test_file`, /^core\/test\/[A-Za-z0-9._-]+\.test\.ts$/),
      test_name: requiredObservationString(probe.test_name, `pack_provenance.probes[${index}].test_name`),
      candidate_git_sha: probeCandidate,
      command_argv_sha256: requiredObservationString(probe.command_argv_sha256, `pack_provenance.probes[${index}].command_argv_sha256`, digest),
      stdout_sha256: requiredObservationString(probe.stdout_sha256, `pack_provenance.probes[${index}].stdout_sha256`, digest),
      stderr_sha256: requiredObservationString(probe.stderr_sha256, `pack_provenance.probes[${index}].stderr_sha256`, digest),
    };
  });
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) {
    throw new Error("FRG observations.pack_provenance.probes has duplicate ids");
  }
  if (!Array.isArray(p.proofs) || p.proofs.length === 0) {
    throw new Error("FRG observations.pack_provenance.proofs must be non-empty");
  }
  const validSources = new Set<FrgPackProofSource>(["live", "ledger", "derived", "layer_a"]);
  const proofs = p.proofs.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`FRG observations.pack_provenance.proofs[${index}] must be an object`);
    }
    const proof = entry as Record<string, unknown>;
    if (typeof proof.source !== "string" || !validSources.has(proof.source as FrgPackProofSource)) {
      throw new Error(`FRG observations.pack_provenance.proofs[${index}].source is invalid`);
    }
    return {
      id: requiredObservationString(proof.id, `pack_provenance.proofs[${index}].id`),
      source: proof.source as FrgPackProofSource,
      artifact_sha256: requiredObservationString(proof.artifact_sha256, `pack_provenance.proofs[${index}].artifact_sha256`, digest),
    };
  });
  if (new Set(proofs.map((proof) => proof.id)).size !== proofs.length) {
    throw new Error("FRG observations.pack_provenance.proofs has duplicate ids");
  }
  let replacementIssue: number | undefined;
  if (p.replacement_issue !== undefined) {
    if (
      typeof p.replacement_issue !== "number" ||
      !Number.isSafeInteger(p.replacement_issue) ||
      p.replacement_issue <= 0
    ) {
      throw new Error("FRG observations.pack_provenance.replacement_issue is invalid");
    }
    replacementIssue = p.replacement_issue;
  }
  return {
    schema_version: 1,
    policy_id: policyId,
    ...(replacementIssue !== undefined ? { replacement_issue: replacementIssue } : {}),
    pack_id: FRG_PACK_MANIFEST.pack_id,
    manifest_version: 1,
    manifest_sha256: manifestSha,
    release_version: releaseVersion,
    candidate_git_sha: candidateSha,
    pack_run_id: packRunId,
    loop_run_id: loopRunId,
    repository,
    base_branch: baseBranch,
    started_at: new Date(Date.parse(startedAt)).toISOString(),
    contract_sha256: contractSha,
    ledger_sha256: ledgerSha,
    events_sha256: eventsSha,
    action_evidence_sha256: actionSha,
    issues,
    probes,
    proofs,
  };
}

/**
 * Parse and schema-validate an operator observations file.
 * Unknown scenario/composition ids → hard reject.
 */
export function parseFrgObservationsFile(raw: unknown): FrgObservationsFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("FRG observations file must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== FRG_OBSERVATIONS_SCHEMA_VERSION) {
    throw new Error(
      `FRG observations schema_version must be ${FRG_OBSERVATIONS_SCHEMA_VERSION} (got ${String(o.schema_version)})`,
    );
  }
  const scenarios: FrgScenarioOverride[] = [];
  if (o.scenarios !== undefined) {
    if (!Array.isArray(o.scenarios)) {
      throw new Error("FRG observations.scenarios must be an array when present");
    }
    for (let i = 0; i < o.scenarios.length; i++) {
      const s = o.scenarios[i];
      if (s === null || typeof s !== "object" || Array.isArray(s)) {
        throw new Error(`FRG observations.scenarios[${i}] must be an object`);
      }
      const rec = s as Record<string, unknown>;
      if (
        typeof rec.id !== "string" ||
        !(FRG_SCENARIO_IDS as readonly string[]).includes(rec.id)
      ) {
        throw new Error(
          `FRG observations.scenarios[${i}].id is unknown or missing (got ${String(rec.id)})`,
        );
      }
      if (
        typeof rec.status !== "string" ||
        !FRG_VALID_SCENARIO_STATUSES.has(rec.status as FrgScenarioStatus)
      ) {
        throw new Error(
          `FRG observations.scenarios[${i}].status must be pass|fail|warn|skip|not_observed`,
        );
      }
      if (typeof rec.detail !== "string") {
        throw new Error(`FRG observations.scenarios[${i}].detail must be a string`);
      }
      const observed =
        rec.observed === undefined || rec.observed === null
          ? null
          : isFiniteNumber(rec.observed)
            ? rec.observed
            : (() => {
                throw new Error(
                  `FRG observations.scenarios[${i}].observed must be a number or null`,
                );
              })();
      const threshold =
        rec.threshold === undefined || rec.threshold === null
          ? null
          : isFiniteNumber(rec.threshold)
            ? rec.threshold
            : (() => {
                throw new Error(
                  `FRG observations.scenarios[${i}].threshold must be a number or null`,
                );
              })();
      let source: FrgPackProofSource | undefined;
      if (rec.source !== undefined) {
        if (
          typeof rec.source !== "string" ||
          !new Set(["live", "ledger", "derived", "layer_a"]).has(rec.source)
        ) {
          throw new Error(`FRG observations.scenarios[${i}].source is invalid`);
        }
        if (rec.source === "layer_a" && isFrgRequiredLiveScenarioId(rec.id as string)) {
          throw new Error(
            `FRG observations.scenarios[${i}] source layer_a is refused for required-live id ${rec.id}`,
          );
        }
        source = rec.source as FrgPackProofSource;
      }
      let proofIds: string[] | undefined;
      if (rec.proof_ids !== undefined) {
        if (
          !Array.isArray(rec.proof_ids) ||
          rec.proof_ids.length === 0 ||
          !rec.proof_ids.every((id) => typeof id === "string" && id.trim() !== "") ||
          new Set(rec.proof_ids).size !== rec.proof_ids.length
        ) {
          throw new Error(`FRG observations.scenarios[${i}].proof_ids must be unique non-empty strings`);
        }
        proofIds = [...rec.proof_ids] as string[];
      }
      scenarios.push({
        id: rec.id as FrgScenarioId,
        status: rec.status as FrgScenarioStatus,
        detail: rec.detail,
        observed,
        threshold,
        ...(source ? { source } : {}),
        ...(proofIds ? { proof_ids: proofIds } : {}),
      });
    }
  }
  const composition: FrgCompositionOverride[] = [];
  if (o.composition !== undefined) {
    if (!Array.isArray(o.composition)) {
      throw new Error("FRG observations.composition must be an array when present");
    }
    for (let i = 0; i < o.composition.length; i++) {
      const c = o.composition[i];
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        throw new Error(`FRG observations.composition[${i}] must be an object`);
      }
      const rec = c as Record<string, unknown>;
      if (
        typeof rec.id !== "string" ||
        !(FRG_COMPOSITION_DIMENSION_IDS as readonly string[]).includes(rec.id)
      ) {
        throw new Error(
          `FRG observations.composition[${i}].id is unknown or missing (got ${String(rec.id)})`,
        );
      }
      if (
        typeof rec.status !== "string" ||
        !FRG_VALID_COMPOSITION_STATUSES.has(rec.status as FrgCompositionStatus)
      ) {
        throw new Error(
          `FRG observations.composition[${i}].status must be pass|fail|not_observed`,
        );
      }
      if (typeof rec.detail !== "string") {
        throw new Error(`FRG observations.composition[${i}].detail must be a string`);
      }
      const observed =
        rec.observed === undefined || rec.observed === null
          ? null
          : isFiniteNumber(rec.observed)
            ? rec.observed
            : (() => {
                throw new Error(
                  `FRG observations.composition[${i}].observed must be a number or null`,
                );
              })();
      const source = rec.source === undefined ? "observation" : rec.source;
      if (
        typeof source !== "string" ||
        !FRG_VALID_COMPOSITION_SOURCES.has(source as FrgCompositionSource)
      ) {
        throw new Error(`FRG observations.composition[${i}].source is invalid`);
      }
      if (source === "layer_a" && isFrgRequiredLiveCompositionId(rec.id as string)) {
        throw new Error(
          `FRG observations.composition[${i}] source layer_a is refused for required-live id ${rec.id}`,
        );
      }
      let proofIds: string[] | undefined;
      if (rec.proof_ids !== undefined) {
        if (
          !Array.isArray(rec.proof_ids) ||
          rec.proof_ids.length === 0 ||
          !rec.proof_ids.every((id) => typeof id === "string" && id.trim() !== "") ||
          new Set(rec.proof_ids).size !== rec.proof_ids.length
        ) {
          throw new Error(`FRG observations.composition[${i}].proof_ids must be unique non-empty strings`);
        }
        proofIds = [...rec.proof_ids] as string[];
      }
      composition.push({
        id: rec.id as FrgCompositionDimensionId,
        status: rec.status as FrgCompositionStatus,
        detail: rec.detail,
        source: source as FrgCompositionSource,
        observed,
        ...(proofIds ? { proof_ids: proofIds } : {}),
      });
    }
  }
  let false_human_authority_count: number | undefined;
  if (o.false_human_authority_count !== undefined) {
    if (!isFiniteNumber(o.false_human_authority_count) || o.false_human_authority_count < 0) {
      throw new Error(
        "FRG observations.false_human_authority_count must be a non-negative number",
      );
    }
    false_human_authority_count = o.false_human_authority_count;
  }
  const recovery_aggregates = parseFrgRecoveryAggregates(o.recovery_aggregates);
  const pack_provenance = o.pack_provenance === undefined
    ? undefined
    : parseFrgPackProvenance(o.pack_provenance);
  return {
    schema_version: FRG_OBSERVATIONS_SCHEMA_VERSION,
    scenarios,
    composition,
    false_human_authority_count,
    recovery_aggregates,
    pack_provenance,
  };
}

export function parseFrgObservationsJson(text: string): FrgObservationsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`FRG observations JSON parse failed: ${(err as Error).message}`);
  }
  return parseFrgObservationsFile(raw);
}

/**
 * Parse a compact CLI `--scenario id=status:detail[:observed=N]` token.
 */
export function parseFrgScenarioCliToken(token: string): FrgScenarioOverride {
  // id=status:detail or id=status:detail:observed=N
  const eq = token.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `Invalid --scenario token "${token}": expected id=status:detail[:observed=N]`,
    );
  }
  const id = token.slice(0, eq);
  const rest = token.slice(eq + 1);
  if (!(FRG_SCENARIO_IDS as readonly string[]).includes(id)) {
    throw new Error(`Unknown FRG scenario id in --scenario: ${id}`);
  }
  const colon = rest.indexOf(":");
  const status = colon === -1 ? rest : rest.slice(0, colon);
  let detail = colon === -1 ? "" : rest.slice(colon + 1);
  let observed: number | null = null;
  const obsMatch = detail.match(/:observed=(-?\d+(?:\.\d+)?)\s*$/);
  if (obsMatch) {
    observed = Number(obsMatch[1]);
    detail = detail.slice(0, detail.length - obsMatch[0].length);
  }
  if (!FRG_VALID_SCENARIO_STATUSES.has(status as FrgScenarioStatus)) {
    throw new Error(
      `Invalid --scenario status "${status}" (want pass|fail|warn|skip|not_observed)`,
    );
  }
  return {
    id: id as FrgScenarioId,
    status: status as FrgScenarioStatus,
    detail: detail || `cli observation: ${id}`,
    observed,
    threshold: null,
  };
}

export interface ComputeFrgInput {
  version: string;
  run_id?: string;
  loop_run_id?: string | null;
  /**
   * Fixed pack id after validateFrgPackContract. Required equal to
   * FRG_PACK_MANIFEST.pack_id for release-eligible pass.
   */
  pack_id?: string | null;
  items: FrgItemInput[];
  thresholds?: FrgThresholds;
  /** Pack-specific scenario outcomes (capacity, resume, …). */
  scenario_overrides?: FrgScenarioOverride[];
  /** Composition dimension overrides (observation file / test helpers). */
  composition_overrides?: FrgCompositionOverride[];
  /** Injected recoverable classes wrongly projected human_authority. */
  false_human_authority_count?: number;
  /** Optional recovery aggregates by reason code. */
  recovery_aggregates?: FrgRecoveryAggregates;
  /** Candidate/run/manifest proof block from the closed pack runner. */
  pack_provenance?: FrgPackProvenance | null;
  /** Optional HMAC-attested ship-identity binding (tag-path candidate SHA). */
  factory_release_binding?: unknown;
  notes?: string[];
  now?: () => Date;
  /**
   * HMAC key for integrity.attestation. When omitted, falls back to
   * {@link resolveFrgAttestationKey}. Without a key, release-eligible
   * `pass: true` cannot be minted (attestation required).
   */
  attestation_key?: string | null;
  /** Runner-stamped score path for the honest-pass checker. */
  score_source?: HonestPost133ScoreSource;
  /** Runner-stamped work-list identity for the honest-pass checker. */
  work_list?: HonestPost133WorkList;
}

function isReadyState(state: string): boolean {
  return state === "ready" || state === "ready_to_deploy" || state === "merged" || state === "released";
}

/** Build scoreboard + overall pass from item outcomes and scenario overrides. */
export function computeFrgEvidence(input: ComputeFrgInput): FrgEvidence {
  const version = normalizeFrgVersion(input.version);
  const thresholds = { ...DEFAULT_FRG_THRESHOLDS, ...input.thresholds };
  const now = input.now ?? (() => new Date());
  const runId = input.run_id?.trim() || newFrgRunId(now);

  const perItem: FrgItemOutcome[] = input.items.map((it) => {
    const theme = it.blocker_theme ?? null;
    const blockerClass = theme ? classifyFrgBlocker(theme) : null;
    const readyClean =
      it.ready_clean ??
      (isReadyState(it.state) && blockerClass !== "engine-class");
    return {
      item_id: it.item_id,
      state: it.state,
      ready_clean: readyClean,
      blocker_theme: theme,
      blocker_class: blockerClass,
    };
  });

  let engine = 0;
  let product = 0;
  let human = 0;
  for (const it of perItem) {
    if (it.blocker_class === "engine-class") engine++;
    else if (it.blocker_class === "product-class") product++;
    else if (it.blocker_class === "human-authority") human++;
  }
  // #757: rate denominator is processed pack item_count (never classified-only; never null when ≥1).
  const itemCount = perItem.length;
  const engineRate = computeEngineClassRate(engine, itemCount);
  const readyCleanCount = perItem.filter((i) => i.ready_clean).length;

  const overrideById = new Map(
    (input.scenario_overrides ?? []).map((s) => [s.id, s] as const),
  );

  const rawScenarios: FrgScenarioOutcome[] = FRG_SCENARIO_IDS.map((id) => {
    if (overrideById.has(id)) {
      const o = overrideById.get(id)!;
      return {
        id,
        status: o.status,
        detail: o.detail,
        observed: o.observed ?? null,
        threshold: o.threshold ?? null,
        ...(o.source ? { source: o.source } : {}),
        ...(o.proof_ids ? { proof_ids: [...o.proof_ids] } : {}),
      };
    }
    if (id === "clean-item-throughput") {
      const ok = readyCleanCount >= thresholds.min_clean_ready_to_deploy;
      return {
        id,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `${readyCleanCount} clean ready items meet K=${thresholds.min_clean_ready_to_deploy}`
          : `${readyCleanCount} clean ready items < K=${thresholds.min_clean_ready_to_deploy}`,
        observed: readyCleanCount,
        threshold: thresholds.min_clean_ready_to_deploy,
        ...(version === FRG_HYBRID_PILOT_VERSION || input.pack_provenance
          ? { source: "ledger" as const, proof_ids: ["ledger:final"] }
          : {}),
      };
    }
    if (id === "blocker-taxonomy") {
      // Empty pack: fail rate criterion (not release-eligible).
      if (itemCount === 0) {
        return {
          id,
          status: "fail",
          detail: "empty pack (item_count=0); engine-class rate undefined — not release-eligible",
          observed: null,
          threshold: thresholds.max_engine_class_rate,
        };
      }
      const rate = engineRate as number;
      const ok = rate <= thresholds.max_engine_class_rate;
      return {
        id,
        status: ok ? "pass" : "fail",
        detail: ok
          ? `engine-class rate ${(rate * 100).toFixed(1)}% (${engine}/${itemCount}) ≤ max ${(thresholds.max_engine_class_rate * 100).toFixed(0)}%`
          : `engine-class rate ${(rate * 100).toFixed(1)}% (${engine}/${itemCount}) > max ${(thresholds.max_engine_class_rate * 100).toFixed(0)}%`,
        observed: rate,
        threshold: thresholds.max_engine_class_rate,
        ...(version === FRG_HYBRID_PILOT_VERSION || input.pack_provenance
          ? { source: "ledger" as const, proof_ids: ["ledger:final"] }
          : {}),
      };
    }
    return {
      id,
      status: "not_observed",
      detail: "not observed in this scoring pass (live pack or Layer A must cover)",
      observed: null,
      threshold: null,
    };
  });

  if (input.pack_provenance) {
    for (const s of rawScenarios) {
      if (s.source) continue;
      if (s.id === "empty-depends-on-stack-honesty") {
        s.source = "derived";
        s.proof_ids = ["live:contract"];
      }
    }
  }

  // Overrides are not authoritative for numeric/skip rules — re-validate.
  const scenarios = enforceRequiredScenarioCriteria(rawScenarios, thresholds);

  const loopRunId =
    typeof input.loop_run_id === "string" && input.loop_run_id.trim() !== ""
      ? input.loop_run_id.trim()
      : null;
  const packId =
    typeof input.pack_id === "string" && input.pack_id.trim() !== ""
      ? input.pack_id.trim()
      : null;

  const scoreboard: FrgScoreboard = {
    item_count: itemCount,
    ready_clean_count: readyCleanCount,
    engine_class_count: engine,
    product_class_count: product,
    human_authority_count: human,
    engine_class_rate: engineRate,
    per_item: perItem,
  };

  const ledgerProjections = projectCompositionFromScoreboard(
    scenarios,
    scoreboard,
    thresholds,
  );
  const composition = buildFrgComposition({
    ledgerProjections,
    overrides: input.composition_overrides,
    false_human_authority_count: input.false_human_authority_count ?? 0,
  });
  const packProvenance = input.pack_provenance ?? null;
  let integrity = buildFrgIntegrity(scoreboard, composition, packProvenance);

  // Sign when a producer key is available (env or explicit). Without a key,
  // attestation is omitted and release-eligible pass cannot be true (#757).
  // MAC binds eligibility-defining fields (pass, scenarios, thresholds, …) so a
  // failed-attempt MAC cannot be replayed with mutated scenario/threshold values.
  const attestationKey =
    input.attestation_key !== undefined
      ? input.attestation_key && input.attestation_key.trim() !== ""
        ? input.attestation_key.trim()
        : null
      : resolveFrgAttestationKey();
  const canSign = Boolean(
    attestationKey && loopRunId && packId && runId.trim() !== "",
  );

  // Structural eligibility first (no attestation yet); final pass requires MAC.
  const structuralPass = isReleaseEligibleFrgPass(
    {
      pass: true,
      version,
      scenarios,
      loop_run_id: loopRunId,
      pack_id: packId,
      thresholds,
      scoreboard,
      composition,
      integrity,
      pack_provenance: packProvenance,
      run_id: runId,
    },
    { requireAttestation: false },
  );
  // Claim pass:true only when structure is eligible and we will attach attestation.
  const pass = structuralPass && canSign;

  if (canSign) {
    integrity = {
      ...integrity,
      score_receipt: computeFrgScoreReceipt({
        pass,
        version,
        run_id: runId,
        loop_run_id: loopRunId,
        pack_id: packId,
        score_source: input.score_source,
        work_list: input.work_list,
        scoreboard_fingerprint: integrity.scoreboard_fingerprint,
        composition_fingerprint: integrity.composition_fingerprint,
        pack_provenance_fingerprint: integrity.pack_provenance_fingerprint,
        attestationKey: attestationKey!,
      }),
    };
    integrity = signFrgIntegrity({
      integrity,
      schema_version: FRG_SCHEMA_VERSION,
      version,
      run_id: runId,
      loop_run_id: loopRunId!,
      pack_id: packId!,
      pass,
      thresholds,
      scenarios,
      scoreboard,
      composition,
      recovery_aggregates: input.recovery_aggregates ?? null,
      pack_provenance: packProvenance,
      factory_release_binding: input.factory_release_binding,
      attestationKey: attestationKey!,
    });
  }

  const evidence: FrgEvidence = {
    schema_version: FRG_SCHEMA_VERSION,
    version,
    run_id: runId,
    pass,
    scenarios,
    scoreboard,
    thresholds,
    loop_run_id: loopRunId,
    pack_id: packId,
    created_at: now().toISOString().replace(/\.\d{3}Z$/, "Z"),
    notes: [
      ...(input.notes ?? []),
      ...(composition.missing.length > 0
        ? [`composition missing: ${composition.missing.join(", ")}`]
        : []),
      ...(!attestationKey
        ? [
            `release-eligible attestation omitted: set ${FRG_ATTESTATION_KEY_ENV} when minting evidence`,
          ]
        : []),
    ],
    composition,
    integrity,
    pack_provenance: packProvenance,
  };
  if (input.factory_release_binding !== undefined) {
    evidence.factory_release_binding = input.factory_release_binding;
  }
  if (input.recovery_aggregates) {
    evidence.recovery_aggregates = input.recovery_aggregates;
  }
  if (input.score_source !== undefined) evidence.score_source = input.score_source;
  if (input.work_list !== undefined) evidence.work_list = input.work_list;
  return evidence;
}

/** Project FRG item inputs from a durable loop ledger. */
export function itemsFromLoopLedger(ledger: LoopLedger): FrgItemInput[] {
  const out: FrgItemInput[] = [];
  for (const [itemId, entry] of Object.entries(ledger.items ?? {})) {
    const state = entry.state as LoopItemState;
    const theme =
      entry.blocked_theme && isDurableBlockerClass(entry.blocked_theme)
        ? (entry.blocked_theme as DurableBlockerClass)
        : entry.blocked_theme ?? null;
    out.push({
      item_id: itemId,
      state,
      blocker_theme: theme,
      ready_clean: frgReadyCleanFromState(state),
    });
  }
  return out;
}

function frgReadyCleanFromState(state: string): boolean {
  return state === "ready" || state === "merged" || state === "released";
}

/**
 * Overlay GitHub ready-to-deploy + bound-PR green checks onto ledger-projected
 * FRG items. Missing/unbound/unreadable observations keep the ledger row
 * (fail closed). Pure; no GitHub I/O (#1297).
 */
export function projectFrgItemsWithGitHubOverlay(
  items: readonly FrgItemInput[],
  observations: Readonly<Record<string, FrgGitHubItemObservation | undefined>>,
): FrgItemInput[] {
  return items.map((item) => {
    const obs = observations[item.item_id];
    if (!obs || obs.pr_number == null) return { ...item };
    const state = overlayLedgerStateFromGitHub(item.state, {
      labels: obs.labels,
      checks: obs.checks,
    });
    return {
      ...item,
      state,
      ready_clean: frgReadyCleanFromState(state),
    };
  });
}

/**
 * Whether a durable-loop contract selector matches the versioned FRG fixed pack.
 * Rejects product milestones and ad-hoc work-lists so arbitrary successful loops
 * cannot be scored as FRG release evidence.
 */
export function isAllowedFrgPackSelector(selector: unknown): boolean {
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
    return false;
  }
  const s = selector as { type?: unknown; value?: unknown };
  if (s.type === "label" && typeof s.value === "string") {
    return (FRG_PACK_MANIFEST.allowed_label_selectors as readonly string[]).includes(s.value);
  }
  if (s.type === "milestone" && typeof s.value === "string") {
    return (FRG_PACK_MANIFEST.allowed_milestone_selectors as readonly string[]).includes(
      s.value,
    );
  }
  return false;
}

export type FrgPackValidation =
  | { ok: true }
  | { ok: false; detail: string };

/**
 * Validate that a durable loop contract is the FRG fixed scenario pack
 * (selector + multi-item inventory). Call before writing release evidence
 * from `--from-run`.
 */
export function validateFrgPackContract(
  contract: LoopContract,
  expectedIssueNumbers?: readonly number[],
): FrgPackValidation {
  if (!isAllowedFrgPackSelector(contract.selector)) {
    return {
      ok: false,
      detail:
        `contract.selector is not an FRG fixed-pack selector ` +
        `(got ${JSON.stringify(contract.selector)}). ` +
        `Expected label "${FRG_PACK_MANIFEST.allowed_label_selectors.join('"|"')}" ` +
        `or milestone "${FRG_PACK_MANIFEST.allowed_milestone_selectors.join('"|"')}" ` +
        `(pack_id=${FRG_PACK_MANIFEST.pack_id}). ` +
        `Start the pack with: pipeline loop --label factory-gate`,
    };
  }
  const items = contract.items ?? [];
  if (items.length < FRG_PACK_MANIFEST.min_item_count) {
    return {
      ok: false,
      detail:
        `FRG fixed pack requires ≥${FRG_PACK_MANIFEST.min_item_count} items ` +
        `(got ${items.length}); multi-item composition is mandatory ` +
        `(pack_id=${FRG_PACK_MANIFEST.pack_id})`,
    };
  }
  if (expectedIssueNumbers) {
    const expected = [...expectedIssueNumbers].map(String).sort();
    const actual = items.map((item) => item.id).sort();
    if (
      expected.length !== actual.length ||
      expected.some((value, index) => value !== actual[index])
    ) {
      return {
        ok: false,
        detail:
          `FRG fixed pack contract items [${actual.join(",")}] do not equal ` +
          `the fresh manifest issue set [${expected.join(",")}]`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Post-pass pack auto-close (#754)
// ---------------------------------------------------------------------------

/**
 * Deterministic close comment for synthetic factory-gate pack PRs/issues after
 * a release-eligible FRG pass. Auditable; no free-form LLM text.
 */
export function formatFrgPackCloseComment(version: string, runId: string): string {
  return (
    `FRG ${version} pass (run_id=${runId}): synthetic factory-gate pack item ` +
    `scored ready-to-deploy; closing without merge.`
  );
}

/** Parse a scoreboard `item_id` as a positive GitHub issue number, or null. */
export function parseFrgItemIssueNumber(itemId: string): number | null {
  const trimmed = itemId.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Pack label required on an issue before auto-close. Label selectors use their
 * value; milestone packs fall back to the primary allowed label (`factory-gate`)
 * so product work is never closed by label-less coincidence.
 */
export function packLabelFromSelector(selector: unknown): string {
  if (selector !== null && typeof selector === "object" && !Array.isArray(selector)) {
    const s = selector as { type?: unknown; value?: unknown };
    if (s.type === "label" && typeof s.value === "string" && s.value.trim() !== "") {
      return s.value.trim();
    }
  }
  return FRG_PACK_MANIFEST.allowed_label_selectors[0];
}

/**
 * Scoreboard-only candidate set: `ready_clean` items with parseable issue ids.
 * Does not hit GitHub; callers still filter by pack label and open state.
 */
export function selectReadyCleanPackIssueNumbers(
  scoreboard: FrgScoreboard,
): { item_id: string; issueNumber: number }[] {
  const out: { item_id: string; issueNumber: number }[] = [];
  for (const it of scoreboard.per_item) {
    if (!it.ready_clean) continue;
    const issueNumber = parseFrgItemIssueNumber(it.item_id);
    if (issueNumber === null) continue;
    out.push({ item_id: it.item_id, issueNumber });
  }
  return out;
}

/** Injectable GitHub seams for post-pass pack close (no merge APIs). */
export interface FrgPackCloseDeps {
  getIssueStateAndLabels(
    issueNumber: number,
  ): Promise<{ state: "open" | "closed"; labels: string[] } | null>;
  /**
   * Every open PR associated with the issue (pipeline branch and/or same-repo
   * closing ref). Singleton resolvers leave abandoned drafts open (#754 review-2).
   */
  findOpenPrsForIssue(issueNumber: number): Promise<number[]>;
  /** Close PR without merging; post the deterministic FRG comment. */
  closePr(prNumber: number, comment: string): Promise<void>;
  /** Close issue with the same deterministic FRG comment. */
  closeIssue(issueNumber: number, comment: string): Promise<void>;
}

export interface FrgPackCloseResult {
  closedPrs: number[];
  closedIssues: number[];
  skipped: { issueNumber: number; reason: string }[];
  errors: string[];
}

/**
 * Post-pass hygiene: close open PRs and linked open issues for ready_clean pack
 * items that still carry the pack selector label. Fail-soft (errors reported,
 * remaining candidates still attempted). Never merges.
 *
 * Call only after release-eligible `pass: true` evidence has been written.
 */
export async function closeFrgPackArtifacts(
  evidence: FrgEvidence,
  packLabel: string,
  deps: FrgPackCloseDeps,
  log: (msg: string) => void = () => {},
): Promise<FrgPackCloseResult> {
  const result: FrgPackCloseResult = {
    closedPrs: [],
    closedIssues: [],
    skipped: [],
    errors: [],
  };
  const comment = formatFrgPackCloseComment(evidence.version, evidence.run_id);
  const candidates = selectReadyCleanPackIssueNumbers(evidence.scoreboard);

  for (const { item_id, issueNumber } of candidates) {
    let stateLabels: { state: "open" | "closed"; labels: string[] } | null;
    try {
      stateLabels = await deps.getIssueStateAndLabels(issueNumber);
    } catch (err) {
      const msg =
        `issue #${issueNumber} (item ${item_id}): label/state lookup failed: ` +
        `${(err as Error).message}`;
      result.errors.push(msg);
      log(`[pipeline factory-gate] pack close: ${msg}`);
      continue;
    }
    if (!stateLabels) {
      result.skipped.push({ issueNumber, reason: "issue not found" });
      continue;
    }
    if (!stateLabels.labels.includes(packLabel)) {
      result.skipped.push({
        issueNumber,
        reason: `missing pack label "${packLabel}"`,
      });
      continue;
    }

    let prNumbers: number[] = [];
    try {
      prNumbers = await deps.findOpenPrsForIssue(issueNumber);
    } catch (err) {
      const msg =
        `issue #${issueNumber}: open PR lookup failed: ${(err as Error).message}`;
      result.errors.push(msg);
      log(`[pipeline factory-gate] pack close: ${msg}`);
    }

    // Close each open associated PR independently (fail-soft per PR). A
    // singleton resolver leaves replacement/abandoned drafts open (#754).
    for (const prNumber of prNumbers) {
      try {
        await deps.closePr(prNumber, comment);
        result.closedPrs.push(prNumber);
        log(
          `[pipeline factory-gate] pack close: closed PR #${prNumber} (issue #${issueNumber})`,
        );
      } catch (err) {
        const msg =
          `PR #${prNumber} (issue #${issueNumber}): close failed: ${(err as Error).message}`;
        result.errors.push(msg);
        log(`[pipeline factory-gate] pack close: ${msg}`);
      }
    }

    if (stateLabels.state === "closed") {
      result.skipped.push({ issueNumber, reason: "issue already closed" });
      continue;
    }
    try {
      await deps.closeIssue(issueNumber, comment);
      result.closedIssues.push(issueNumber);
      log(`[pipeline factory-gate] pack close: closed issue #${issueNumber}`);
    } catch (err) {
      const msg = `issue #${issueNumber}: close failed: ${(err as Error).message}`;
      result.errors.push(msg);
      log(`[pipeline factory-gate] pack close: ${msg}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Driver CLI
// ---------------------------------------------------------------------------

export interface FactoryGateOpts {
  /** Target release version X.Y.Z (required). */
  version: string;
  repoDir: string;
  /** Score an existing durable loop run instead of starting a new one. */
  fromRun?: string;
  /** Label selector for starting a new pack loop (default: factory-gate). */
  label?: string[];
  /** Milestone selector alternative to label. */
  milestone?: string;
  /** Emit evidence JSON to stdout. */
  json?: boolean;
  /**
   * When set, skip live loop I/O and score this pre-built input (tests / offline
   * fixture scoring). Offline reports are **not** release-eligible unless the
   * input includes a non-empty `loop_run_id` and validated `pack_id`. By default
   * scoreInput does **not** persist evidence (`writeEvidence` defaults false).
   */
  scoreInput?: ComputeFrgInput;
  /**
   * Persist evidence under the repo. Default: true for live/from-run paths;
   * false for offline `scoreInput` (so offline scoring cannot silently mint
   * release-eligible latest.json without an explicit write).
   */
  writeEvidence?: boolean;
  /**
   * Skip post-pass synthetic pack auto-close (#754). Default: false (close on
   * release-eligible pass when {@link packCloseDeps} is provided).
   */
  noClosePack?: boolean;
  /**
   * Pack selector label required on issues before auto-close (default:
   * `factory-gate` / value from the scored contract).
   */
  packSelectorLabel?: string;
  /**
   * Injectable GitHub close seams. When omitted, post-pass close is a no-op
   * (unit tests without network). Production CLI injects real `gh` wrappers.
   */
  packCloseDeps?: FrgPackCloseDeps;
  /**
   * Start a durable loop for the pack (production path). Injected so unit tests
   * never spawn a real loop. Returns the loop run id when complete.
   */
  startLoop?: (args: {
    repoDir: string;
    label?: string[];
    milestone?: string;
  }) => Promise<{ loop_run_id: string }>;
  /**
   * Load ledger for a loop run id. Defaults unused when scoreInput provided.
   */
  loadLedger?: (loopRunId: string) => Promise<LoopLedger>;
  /** Load contract (optional; used for empty-depends_on stack honesty notes). */
  loadContract?: (loopRunId: string) => Promise<LoopContract | null>;
  /** Scenario overrides after ledger projection (live observations). */
  scenarioOverrides?: FrgScenarioOverride[];
  /** Composition dimension overrides (from --observations file). */
  compositionOverrides?: FrgCompositionOverride[];
  falseHumanAuthorityCount?: number;
  recoveryAggregates?: FrgRecoveryAggregates;
  /** Structured proof block from the closed hybrid pack runner (v1 or v2). */
  packProvenance?: FrgPackProvenance;
  /**
   * Post-1.33 --from-run collect. When omitted, production builds hybrid-v2
   * provenance from the live pack + Layer A TAP (#1118). Tests inject a fake.
   */
  collectHybridV2?: (args: HybridV2FromRunArgs) => Promise<CollectedFrgObservations>;
  /**
   * In-process factory-release request `integrated_candidate.git_sha`.
   * Forwarded to hybrid-v2 collect. CLI `--from-run` omits this.
   */
  requestCandidateGitSha?: string;
  thresholds?: FrgThresholds;
  now?: () => Date;
  /**
   * HMAC key for release-eligible attestation. When omitted on `--from-run`,
   * the engine presents KEY_FILE as KEY then authenticates with KEY.
   * Injected in tests; production CLI uses env.
   */
  attestationKey?: string | null;
  /** Parent env for KEY_FILE presentation on `--from-run`. Tests inject. */
  env?: NodeJS.ProcessEnv;
  presentAttestorCredential?: PresentFrgAttestorCredentialDeps;
  /**
   * True when the operator passed `--observations <file>`. Stamps
   * `score_source: "observations"` so honest-pass cannot accept it.
   */
  usedObservationsFile?: boolean;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

export interface FactoryGateResult {
  evidence: FrgEvidence;
  evidencePath: string | null;
  latestPath: string | null;
  exitCode: number;
  /** Post-pass pack close summary, or null when close did not run. */
  packClose: FrgPackCloseResult | null;
}

/**
 * Run the FRG driver: score (from ledger / fixture / started loop), write
 * evidence, return pass/fail. Does not merge or tag. After a release-eligible
 * pass with evidence written, may close synthetic pack PRs/issues (#754).
 */
export async function runFactoryGate(
  opts: FactoryGateOpts,
  fsDeps: FrgFsDeps = defaultFsDeps,
): Promise<FactoryGateResult> {
  const version = normalizeFrgVersion(opts.version);
  const stdout = opts.stdout ?? ((m) => process.stdout.write(`${m}\n`));
  const stderr = opts.stderr ?? ((m) => process.stderr.write(`${m}\n`));
  // Offline scoreInput must not default-write release evidence (e5da5fc8).
  const writeEvidence =
    opts.writeEvidence !== undefined
      ? opts.writeEvidence
      : opts.scoreInput
        ? false
        : true;

  let computeInput: ComputeFrgInput;
  /** Pack label for post-pass close filter; refined when a contract is loaded. */
  let packSelectorLabel =
    opts.packSelectorLabel ?? FRG_PACK_MANIFEST.allowed_label_selectors[0];

  const resolvedAttestationKey =
    opts.attestationKey !== undefined
      ? opts.attestationKey
      : resolveFrgAttestationKey();

  if (opts.scoreInput) {
    computeInput = {
      ...opts.scoreInput,
      version,
      thresholds: opts.thresholds ?? opts.scoreInput.thresholds,
      now: opts.now ?? opts.scoreInput.now,
      composition_overrides:
        opts.compositionOverrides ?? opts.scoreInput.composition_overrides,
      false_human_authority_count:
        opts.falseHumanAuthorityCount ??
        opts.scoreInput.false_human_authority_count,
      recovery_aggregates:
        opts.recoveryAggregates ?? opts.scoreInput.recovery_aggregates,
      pack_provenance:
        opts.packProvenance ?? opts.scoreInput.pack_provenance,
      attestation_key:
        opts.scoreInput.attestation_key !== undefined
          ? opts.scoreInput.attestation_key
          : resolvedAttestationKey,
    };
  } else if (opts.fromRun) {
    if (!opts.loadLedger) {
      throw new Error(
        "pipeline factory-gate: --from-run requires a ledger loader (internal: loadLedger dep)",
      );
    }
    if (!opts.loadContract) {
      throw new Error(
        "pipeline factory-gate: --from-run requires a contract loader for fixed-pack validation " +
          "(internal: loadContract dep)",
      );
    }
    const contract = await opts.loadContract(opts.fromRun);
    if (!contract) {
      throw new Error(
        `pipeline factory-gate: --from-run ${opts.fromRun} has no loadable loop contract; ` +
          `cannot validate FRG fixed-pack membership (pack_id=${FRG_PACK_MANIFEST.pack_id})`,
      );
    }
    const packCheck = validateFrgPackContract(
      contract,
      opts.packProvenance?.issues.map((issue) => issue.issue_number),
    );
    if (!packCheck.ok) {
      throw new Error(
        `pipeline factory-gate: refused to score non-pack run ${opts.fromRun}: ${packCheck.detail}`,
      );
    }
    const fromRunAttestationKey =
      opts.attestationKey !== undefined
        ? resolvedAttestationKey
        : requirePresentedFrgAttestationKey(
            opts.env ?? process.env,
            opts.presentAttestorCredential,
          );
    if (opts.packSelectorLabel === undefined) {
      packSelectorLabel = packLabelFromSelector(contract.selector);
    }
    const ledger = await opts.loadLedger(opts.fromRun);
    let items = itemsFromLoopLedger(ledger);
    const notes: string[] = [
      `Projected from durable loop run ${opts.fromRun}`,
      `FRG fixed pack validated: pack_id=${FRG_PACK_MANIFEST.pack_id} selector=${JSON.stringify(contract.selector)}`,
      "Scenario pack selection: reliability label/fixture pack (not full product milestone)",
    ];
    let overrides = [...(opts.scenarioOverrides ?? [])];
    let compositionOverrides = opts.compositionOverrides;
    let falseHumanAuthorityCount = opts.falseHumanAuthorityCount;
    let packProvenance = opts.packProvenance;
    if (
      !packProvenance &&
      isPostHybridPilotVersion(version) &&
      !opts.usedObservationsFile
    ) {
      const collected = await (opts.collectHybridV2 ?? defaultCollectHybridV2FromRun)({
        repoDir: opts.repoDir,
        version,
        fromRun: opts.fromRun,
        contract,
        ledger,
        requestCandidateGitSha: opts.requestCandidateGitSha,
      });
      packProvenance = collected.pack_provenance;
      if (overrides.length === 0) {
        overrides = collected.scenarios.map((s) => ({
          id: s.id as FrgScenarioId,
          status: s.status,
          detail: s.detail,
          observed: s.observed,
          threshold: s.threshold,
          source: s.source,
          proof_ids: s.proof_ids,
        }));
      }
      if (!compositionOverrides) {
        compositionOverrides = collected.composition.map((d) => ({
          id: d.id as FrgCompositionDimensionId,
          status: d.status,
          detail: d.detail,
          source: d.source,
          observed: d.observed,
          proof_ids: d.proof_ids,
        }));
      }
      if (falseHumanAuthorityCount === undefined) {
        falseHumanAuthorityCount = collected.false_human_authority_count;
      }
      items = projectFrgItemsWithGitHubOverlay(
        items,
        collected.github_item_observations ?? {},
      );
    }
    const stackHonesty = detectEmptyDependsOnStackHonesty(contract, ledger);
    if (stackHonesty) overrides = mergeScenarioOverride(overrides, stackHonesty);
    // Unobserved required scenarios fail overall pass (not release evidence).
    // Throughput + taxonomy on --from-run overlay GitHub R2D + bound-PR green
    // checks over the ledger (#1297). Other pack scenarios need
    // scenarioOverrides / live observation.
    computeInput = {
      version,
      loop_run_id: opts.fromRun,
      pack_id: FRG_PACK_MANIFEST.pack_id,
      items,
      scenario_overrides: overrides,
      composition_overrides: compositionOverrides,
      false_human_authority_count: falseHumanAuthorityCount,
      recovery_aggregates: opts.recoveryAggregates,
      pack_provenance: packProvenance,
      notes,
      thresholds: opts.thresholds,
      now: opts.now,
      attestation_key: fromRunAttestationKey,
      score_source: opts.usedObservationsFile ? "observations" : "from-run",
      work_list: "factory-gate-pack",
    };
  } else if (opts.startLoop) {
    // Refuse non-pack selectors before starting a durable loop.
    if (opts.milestone) {
      if (
        !(FRG_PACK_MANIFEST.allowed_milestone_selectors as readonly string[]).includes(
          opts.milestone,
        )
      ) {
        throw new Error(
          `pipeline factory-gate: milestone "${opts.milestone}" is not an FRG fixed-pack selector ` +
            `(allowed: ${FRG_PACK_MANIFEST.allowed_milestone_selectors.join(", ")})`,
        );
      }
    } else {
      const labels = opts.label ?? ["factory-gate"];
      for (const lab of labels) {
        if (!(FRG_PACK_MANIFEST.allowed_label_selectors as readonly string[]).includes(lab)) {
          throw new Error(
            `pipeline factory-gate: label "${lab}" is not an FRG fixed-pack selector ` +
              `(allowed: ${FRG_PACK_MANIFEST.allowed_label_selectors.join(", ")})`,
          );
        }
      }
      if (opts.packSelectorLabel === undefined && labels[0]) {
        packSelectorLabel = labels[0];
      }
    }
    stderr(
      `[pipeline factory-gate] starting durable loop for FRG pack (version ${version})…`,
    );
    const { loop_run_id } = await opts.startLoop({
      repoDir: opts.repoDir,
      label: opts.label ?? ["factory-gate"],
      milestone: opts.milestone,
    });
    if (!opts.loadLedger) {
      throw new Error(
        "pipeline factory-gate: startLoop path requires loadLedger to project outcomes",
      );
    }
    const ledger = await opts.loadLedger(loop_run_id);
    let overrides = [...(opts.scenarioOverrides ?? [])];
    const notes = [
      `Live FRG loop ${loop_run_id}`,
      `Selector: label=${(opts.label ?? ["factory-gate"]).join(",")} milestone=${opts.milestone ?? "(none)"}`,
    ];
    if (opts.loadContract) {
      const contract = await opts.loadContract(loop_run_id);
      if (contract) {
        const packCheck = validateFrgPackContract(
          contract,
          opts.packProvenance?.issues.map((issue) => issue.issue_number),
        );
        if (!packCheck.ok) {
          throw new Error(
            `pipeline factory-gate: started loop ${loop_run_id} is not FRG fixed pack: ${packCheck.detail}`,
          );
        }
        if (opts.packSelectorLabel === undefined) {
          packSelectorLabel = packLabelFromSelector(contract.selector);
        }
        notes.push(
          `FRG fixed pack validated: pack_id=${FRG_PACK_MANIFEST.pack_id} selector=${JSON.stringify(contract.selector)}`,
        );
        const stackHonesty = detectEmptyDependsOnStackHonesty(contract, ledger);
        if (stackHonesty) overrides = mergeScenarioOverride(overrides, stackHonesty);
      }
    }
    computeInput = {
      version,
      loop_run_id,
      pack_id: FRG_PACK_MANIFEST.pack_id,
      items: itemsFromLoopLedger(ledger),
      scenario_overrides: overrides,
      composition_overrides: opts.compositionOverrides,
      false_human_authority_count: opts.falseHumanAuthorityCount,
      recovery_aggregates: opts.recoveryAggregates,
      pack_provenance: opts.packProvenance,
      notes,
      thresholds: opts.thresholds,
      now: opts.now,
      attestation_key: resolvedAttestationKey,
    };
  } else {
    throw new Error(factoryGateMissingFromRunUsage());
  }

  if (opts.usedObservationsFile) {
    computeInput = { ...computeInput, score_source: "observations" };
  }

  if (computeInput.pack_provenance) {
    const provenance = computeInput.pack_provenance;
    if (isFrgHybridV1PolicyId(provenance.policy_id)) {
      if (version !== FRG_HYBRID_PILOT_VERSION) {
        throw new Error(
          `pipeline factory-gate: ${FRG_HYBRID_PILOT_POLICY_ID} is historical for ` +
            `v${FRG_HYBRID_PILOT_VERSION} only; v${version} requires ${FRG_HYBRID_V2_POLICY_ID}`,
        );
      }
    } else if (!isFrgHybridV2PolicyId(provenance.policy_id)) {
      throw new Error(
        `pipeline factory-gate: unknown hybrid policy ${provenance.policy_id}`,
      );
    }
    if (
      provenance.release_version !== version ||
      provenance.loop_run_id !== computeInput.loop_run_id ||
      provenance.pack_id !== computeInput.pack_id
    ) {
      throw new Error("pipeline factory-gate: pack provenance does not match the scored version, loop, or pack");
    }
  } else if (version === FRG_HYBRID_PILOT_VERSION) {
    throw new Error(
      `pipeline factory-gate: v${FRG_HYBRID_PILOT_VERSION} requires the closed ` +
        `hybrid runner provenance; CLI scenario claims are not release evidence`,
    );
  } else if (isPostHybridPilotVersion(version)) {
    throw new Error(
      `pipeline factory-gate: v${version} requires ${FRG_HYBRID_V2_POLICY_ID} ` +
        `pack provenance; missing provenance is not release evidence`,
    );
  }

  const evidence = computeFrgEvidence(computeInput);
  let evidencePath: string | null = null;
  let latestPath: string | null = null;
  if (writeEvidence) {
    const written = await writeFrgEvidence(opts.repoDir, evidence, fsDeps, {
      onLedgerError: (err) => {
        stderr(
          `[pipeline factory-gate] trend ledger append failed (evidence retained): ${err.message}`,
        );
      },
    });
    evidencePath = written.evidencePath;
    latestPath = written.latestPath;
  }

  // Post-pass pack disposition (#754): only after durable evidence write on a
  // release-eligible pass. Fail-soft; never flips pass or deletes evidence.
  let packClose: FrgPackCloseResult | null = null;
  const releaseEligible = isReleaseEligibleFrgPass(evidence);
  if (
    writeEvidence &&
    evidence.pass &&
    releaseEligible &&
    !opts.noClosePack &&
    opts.packCloseDeps
  ) {
    packClose = await closeFrgPackArtifacts(
      evidence,
      packSelectorLabel,
      opts.packCloseDeps,
      stderr,
    );
  } else if (
    writeEvidence &&
    evidence.pass &&
    releaseEligible &&
    opts.noClosePack
  ) {
    stderr(
      "[pipeline factory-gate] --no-close-pack: skipping synthetic pack auto-close",
    );
  }

  if (opts.json) {
    stdout(JSON.stringify(evidence, null, 2));
  } else {
    stdout(`[pipeline factory-gate] version=${evidence.version} run_id=${evidence.run_id} pass=${evidence.pass}`);
    stdout(
      `  clean_ready=${evidence.scoreboard.ready_clean_count}/${evidence.thresholds.min_clean_ready_to_deploy} ` +
        `engine_rate=${formatEngineClassRateDisplay(evidence.scoreboard)} ` +
        `(max ${(evidence.thresholds.max_engine_class_rate * 100).toFixed(0)}%; denom=item_count)`,
    );
    if (evidence.composition.missing.length > 0) {
      stdout(`  composition missing: ${evidence.composition.missing.join(", ")}`);
    }
    for (const s of evidence.scenarios) {
      if (s.status === "not_observed") continue;
      stdout(`  scenario ${s.id}: ${s.status} — ${s.detail}`);
    }
    if (evidencePath) stdout(`  evidence: ${evidencePath}`);
    if (packClose) {
      stdout(
        `  pack close: PRs closed=[${packClose.closedPrs.join(",") || "none"}] ` +
          `issues closed=[${packClose.closedIssues.join(",") || "none"}]` +
          (packClose.errors.length
            ? ` errors=${packClose.errors.length} (pass unchanged)`
            : ""),
      );
    }
  }

  if (!evidence.pass) {
    stderr(
      `[pipeline factory-gate] FAIL — see docs/factory-reliability-gate-runbook.md`,
    );
  } else if (packClose && packClose.errors.length > 0) {
    stderr(
      `[pipeline factory-gate] pack auto-close reported ${packClose.errors.length} error(s); ` +
        `FRG pass=${evidence.pass} and evidence paths are unchanged`,
    );
  }

  return {
    evidence,
    evidencePath,
    latestPath,
    exitCode: evidence.pass ? 0 : 1,
    packClose,
  };
}

function mergeScenarioOverride(
  list: FrgScenarioOverride[],
  next: FrgScenarioOverride,
): FrgScenarioOverride[] {
  const filtered = list.filter((s) => s.id !== next.id);
  return [...filtered, next];
}

/**
 * Process honesty: empty depends_on items that still introduce stacked OpenSpec
 * changes across branches should warn/fail rather than silent omission.
 * Detects multi-item contracts where every item has empty depends_on but
 * contract notes / item ids imply independent OpenSpec stacking risk when more
 * than one item is active — we mark warn when ≥2 empty-depends_on items exist
 * (live pack should tighten with real branch observation).
 */
export function detectEmptyDependsOnStackHonesty(
  contract: LoopContract,
  _ledger: LoopLedger,
): FrgScenarioOverride | null {
  const items = contract.items ?? [];
  const emptyDeps = items.filter(
    (it) => !it.depends_on || it.depends_on.length === 0,
  );
  if (emptyDeps.length >= 2 && items.length >= 2) {
    return {
      id: "empty-depends-on-stack-honesty",
      status: "warn",
      detail:
        `${emptyDeps.length} items have empty depends_on while the pack has ${items.length} items — ` +
        `verify OpenSpec changes are not stacked across independent branches (process honesty)`,
      observed: emptyDeps.length,
      threshold: null,
    };
  }
  return {
    id: "empty-depends-on-stack-honesty",
    status: "pass",
    detail: "no empty-depends_on multi-item stacking signal",
    observed: emptyDeps.length,
    threshold: null,
  };
}

/** Layer A / Layer B ownership map (mirrored in the runbook). */
export const FRG_SCENARIO_OWNERSHIP: Record<
  FrgScenarioId,
  { layer_a: "test" | "waiver"; layer_b: boolean; pass_criteria: string }
> = {
  "capacity-blocked-retain": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `With max worktrees low and blocked retain ≥ N=${DEFAULT_FRG_THRESHOLDS.capacity_stress_n}, next eligible item is not false-blocked as needs-human solely for capacity`,
  },
  "resume-mid-flight": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Supervisor interrupt/resume leaves live next_action; no permanent dead pr_opened strand",
  },
  "openspec-multi-change": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Archive result and residual still-active check agree (no skip then still-active block)",
  },
  "implement-lockfile-dirt": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Uncommitted lockfile after HEAD advanced is folded/cleaned; no human-block on known lock dirt at 0 attempts",
  },
  "local-docs-parity": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Docs/generator failures that fail CI fail before PR open / ready-to-deploy",
  },
  "clean-item-throughput": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `≥ K=${DEFAULT_FRG_THRESHOLDS.min_clean_ready_to_deploy} easy items reach ready-to-deploy without engine-class block`,
  },
  "blocker-taxonomy": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: `engine-class rate ≤ ${DEFAULT_FRG_THRESHOLDS.max_engine_class_rate}`,
  },
  "pr-supersession": {
    layer_a: "test",
    layer_b: true,
    pass_criteria:
      "Default supersede_mode closes stale second PRs (hermetic config + composition contract; was #729)",
  },
  "release-plan-row": {
    layer_a: "test",
    layer_b: true,
    pass_criteria:
      "Auto-tag FRG guard validates release-eligible evidence before tag create/push (was #730)",
  },
  "empty-depends-on-stack-honesty": {
    layer_a: "test",
    layer_b: true,
    pass_criteria: "Empty depends_on items that stack OpenSpec across branches produce warn or fail",
  },
};

/**
 * Explicit Layer A waivers (scenario id → open tracking issue).
 * Empty after #757: both former closed-issue waivers (#729/#730) now have hermetic tests.
 * Inventory must stay empty-or-open-only — closed-only citations forbidden.
 */
export const FRG_LAYER_A_WAIVERS: Partial<Record<FrgScenarioId, string>> = {};

// ---------------------------------------------------------------------------
// CLI --validate-tag entry (auto-tag workflow / shared Node validator)
// ---------------------------------------------------------------------------

/**
 * When this module is invoked as:
 *   node --experimental-strip-types core/scripts/factory-reliability-gate.ts --validate-tag <X.Y.Z> [--repo-dir <path>]
 * validate release-eligible FRG evidence for the version and exit 0/1.
 */
export async function mainValidateTag(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = [...argv];
  let version: string | undefined;
  let repoDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--validate-tag") {
      version = args[i + 1];
      i++;
    } else if (args[i] === "--repo-dir") {
      repoDir = args[i + 1] ?? repoDir;
      i++;
    }
  }
  if (!version) {
    process.stderr.write(
      "usage: factory-reliability-gate.ts --validate-tag <X.Y.Z> [--repo-dir <path>]\n",
    );
    return 2;
  }
  try {
    const evidence = await validateFrgEvidenceFileForTag(repoDir, version);
    process.stdout.write(
      `FRG release-eligible pass ok for ${evidence.version} run_id=${evidence.run_id}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("factory-reliability-gate.ts") ||
    process.argv[1].endsWith("factory-reliability-gate.js"));

if (isMain && process.argv.includes("--validate-tag")) {
  mainValidateTag().then((code) => {
    process.exitCode = code;
  });
}
