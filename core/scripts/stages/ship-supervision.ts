// Candidate Lineage, operation invariants, owned lifecycle, and
// operation-bound authority for post-ready ship phases (#1331).
//
// RecoverySupervisor is the sole lifecycle owner. This module emits the
// typed observations, claims, and projections that owner consumes. It is
// not a second controller, ledger family, grant schema, or scheduler.

import { canonicalJson, hmacEqual, hmacSha256Hex } from "../grill-hash.ts";
import { projectStageDiagnostic, type StageDiagnostic } from "../stage-diagnostic.ts";

export const SHIP_COOLING_MS = 15_000;
export const ROLLBACK_OPERATION = "factory_pin_rollback" as const;
export const ROLLBACK_ENVELOPE_KIND = "rollback_envelope" as const;
export const ROLLBACK_ENVELOPE_TTL_MS = 24 * 60 * 60 * 1000;
export const ROLLBACK_ENVELOPE_MAC_PREFIX = "hmac-sha256:";
export const ROLLBACK_ENVELOPE_KEY_ENV = "PIPELINE_ROLLBACK_ENVELOPE_KEY";
const ROLLBACK_OID_RE = /^[0-9a-f]{40}$/;

export type ShipReleaseModel = "semver" | "continuous";

export type ShipLifecycleState = "active" | "cooling" | "waiting" | "complete";

export type SideEffectCertainty = "known_complete" | "known_absent" | "uncertain";

export type ShipLineageNodeKind =
  | "integrated_candidate"
  | "frg_candidate"
  | "release_pr_head"
  | "release_merge_result"
  | "tag"
  | "published_artifact"
  | "promoted_pin"
  | "deployed_artifact";

export type SupervisedShipPhase =
  | "release_prepare"
  | "release_finish"
  | "tag"
  | "publication"
  | "promotion"
  | "deployment"
  | "rollback";

export interface CandidateLineageNode {
  kind: ShipLineageNodeKind;
  /** Exact node identity. Never a version string alone. */
  identity: string;
  observer: string;
}

export interface CandidateLineage {
  integrated_candidate: CandidateLineageNode | null;
  frg_candidate: CandidateLineageNode | null;
  release_pr_head: CandidateLineageNode | null;
  release_merge_result: CandidateLineageNode | null;
  tag: CandidateLineageNode | null;
  published_artifact: CandidateLineageNode | null;
  promoted_pin: CandidateLineageNode | null;
  deployed: CandidateLineageNode | null;
}

export interface ShipPhaseInvariant {
  phase: SupervisedShipPhase;
  precondition: string;
  postcondition: string;
  observer: string;
  candidate_binding: string;
  replay_rule: string;
}

export const SHIP_PHASE_INVARIANTS: readonly ShipPhaseInvariant[] = [
  {
    phase: "release_prepare",
    precondition: "current FRG-eligible integrated candidate",
    postcondition: "one release PR whose head is bound to that candidate",
    observer: "GitHub pull-request identity (repository, number, head SHA, base)",
    candidate_binding: "release.candidate_head_oid === frg.candidate_head_oid",
    replay_rule: "observe existing release PR before create; do not open a second PR",
  },
  {
    phase: "release_finish",
    precondition: "prepared release PR whose head still matches the bound candidate",
    postcondition: "merged PR whose merge-commit OID is recorded",
    observer: "GitHub merged pull-request merge-commit OID",
    candidate_binding: "finish.head_oid === prepare.head_oid",
    replay_rule: "observe merged identity before merge; do not remarge a merged PR",
  },
  {
    phase: "tag",
    precondition: "merged release whose merge commit matches the supplied OID",
    postcondition: "origin annotated tag on that merge commit",
    observer: "origin annotated tag peeled commit",
    candidate_binding: "tag peel === merge_commit_oid",
    replay_rule: "observe origin tag before create/push; a local-only tag does not complete",
  },
  {
    phase: "publication",
    precondition: "origin annotated tag bound to the merge commit",
    postcondition: "non-draft GitHub Release bound to that tag and digest",
    observer: "GitHub Release (non-draft) + tagged commit digest",
    candidate_binding: "publication.artifact_digest === merge_commit_oid",
    replay_rule: "observe the Release before wait/create; do not republish a proven Release",
  },
  {
    phase: "promotion",
    precondition: "published artifact and authorized promotion target",
    postcondition: "production pin names the authorized version and digest",
    observer: "production pin version + git_sha digest",
    candidate_binding: "pin.git_sha === published artifact digest",
    replay_rule: "observe pin before write; do not rewrite an already matching pin",
  },
  {
    phase: "deployment",
    precondition: "published artifact and authorized promotion target",
    postcondition: "authorized artifact digest live in the target environment",
    observer: "live installed engine digest for the selected host set",
    candidate_binding: "live_digest === authorized_digest",
    replay_rule: "observe live digest before install; a version string alone does not complete",
  },
  {
    phase: "rollback",
    precondition: "authenticated envelope naming rollback and the retained target",
    postcondition: "production pin repointed to the retained FRG-passed target",
    observer: "production pin previous/retained identity",
    candidate_binding: "pin.version === envelope.retained_target.version",
    replay_rule: "observe retained target before mutation; generic deploy failure grants no authority",
  },
];

export function shipPhaseInvariant(phase: SupervisedShipPhase): ShipPhaseInvariant {
  const found = SHIP_PHASE_INVARIANTS.find((entry) => entry.phase === phase);
  if (!found) throw new Error(`ship supervision: unknown phase ${phase}`);
  return found;
}

export const EMPTY_CANDIDATE_LINEAGE: CandidateLineage = {
  integrated_candidate: null,
  frg_candidate: null,
  release_pr_head: null,
  release_merge_result: null,
  tag: null,
  published_artifact: null,
  promoted_pin: null,
  deployed: null,
};

export interface ShipLineageEvidence {
  train?: { integrated_head_oid: string } | null;
  frg?: { candidate_head_oid: string; frg_run_id: string } | null;
  release?: { pr: number; head_oid: string; candidate_head_oid: string } | null;
  release_finish?: { merge_commit_oid: string; pr: number; head_oid: string } | null;
  publication?: { tag: string; artifact_digest?: string | null; published?: boolean } | null;
  promotion?: { tag: string; pin_digest?: string | null } | null;
  deployment?: {
    live_digest?: string | null;
    authorized_digest?: string | null;
    environment?: string | null;
  } | null;
}

const OID_RE = /^[0-9a-f]{40}$/i;

function oidIdentity(value: string, field: string): string {
  const oid = value.trim().toLowerCase();
  if (!OID_RE.test(oid)) {
    throw new Error(`ship lineage: ${field} must be a 40-character git OID, not a version string`);
  }
  return oid;
}

/**
 * Project distinct Candidate Lineage nodes from ship evidence.
 * A version string cannot substitute for any node identity.
 */
export function projectCandidateLineage(evidence: ShipLineageEvidence): CandidateLineage {
  const lineage: CandidateLineage = { ...EMPTY_CANDIDATE_LINEAGE };
  if (evidence.train) {
    lineage.integrated_candidate = {
      kind: "integrated_candidate",
      identity: oidIdentity(evidence.train.integrated_head_oid, "integrated_candidate"),
      observer: "GitHub base containment / merge proof",
    };
  }
  if (evidence.frg) {
    lineage.frg_candidate = {
      kind: "frg_candidate",
      identity: `${oidIdentity(evidence.frg.candidate_head_oid, "frg_candidate")}#${evidence.frg.frg_run_id}`,
      observer: "HMAC latest.json packed SHA",
    };
  }
  if (evidence.release) {
    lineage.release_pr_head = {
      kind: "release_pr_head",
      identity: `pr#${evidence.release.pr}@${oidIdentity(evidence.release.head_oid, "release_pr_head")}`,
      observer: "GitHub PR number + head SHA + base",
    };
  }
  if (evidence.release_finish) {
    lineage.release_merge_result = {
      kind: "release_merge_result",
      identity: oidIdentity(evidence.release_finish.merge_commit_oid, "release_merge_result"),
      observer: "merged PR merge-commit OID",
    };
  }
  if (evidence.publication?.published && evidence.publication.artifact_digest) {
    const digest = oidIdentity(evidence.publication.artifact_digest, "published_artifact");
    lineage.tag = {
      kind: "tag",
      identity: `${evidence.publication.tag}@${digest}`,
      observer: "origin annotated tag peeled commit",
    };
    lineage.published_artifact = {
      kind: "published_artifact",
      identity: digest,
      observer: "non-draft GitHub Release bound to that tag",
    };
  }
  if (evidence.promotion?.pin_digest) {
    lineage.promoted_pin = {
      kind: "promoted_pin",
      identity: oidIdentity(evidence.promotion.pin_digest, "promoted_pin"),
      observer: "production pin version + git_sha digest",
    };
  }
  if (evidence.deployment?.live_digest && evidence.deployment.authorized_digest) {
    const live = oidIdentity(evidence.deployment.live_digest, "deployed live_digest");
    const authorized = oidIdentity(evidence.deployment.authorized_digest, "deployed authorized_digest");
    lineage.deployed = {
      kind: "deployed_artifact",
      identity: `${live}@${evidence.deployment.environment ?? "all"}`,
      observer: "live installed engine digest for the selected host set",
    };
    if (live !== authorized) {
      throw new Error("ship lineage: deployed live digest does not match the authorized digest");
    }
  }
  return lineage;
}

/** True when every required prior edge is present for `phase`. */
export function lineageHasPriorEdges(
  lineage: CandidateLineage,
  phase: SupervisedShipPhase,
): boolean {
  switch (phase) {
    case "release_prepare":
      return Boolean(lineage.integrated_candidate && lineage.frg_candidate);
    case "release_finish":
      return Boolean(lineage.release_pr_head);
    case "tag":
    case "publication":
      return Boolean(lineage.release_merge_result);
    case "promotion":
      return Boolean(lineage.published_artifact && lineage.tag);
    case "deployment":
      return Boolean(lineage.promoted_pin && lineage.published_artifact);
    case "rollback":
      return true;
    default:
      return false;
  }
}

export interface ShipMutationClaim {
  operation: string;
  repository: string;
  lineage_node: string;
  scope: string;
  actor: string;
  expiry: string;
  outcome: "started" | "complete" | "uncertain";
  evidence_fingerprint: string;
  started_at: string;
}

export interface OperationBoundAuthority {
  operation: string;
  repository: string;
  candidate: string;
  scope: string;
  actor: string;
  expires_at: string;
}

export function assertOperationBoundAuthority(
  presented: OperationBoundAuthority,
  current: OperationBoundAuthority,
  nowMs: number,
): void {
  const fields: (keyof OperationBoundAuthority)[] = [
    "operation",
    "repository",
    "candidate",
    "scope",
    "actor",
    "expires_at",
  ];
  for (const field of fields) {
    if (presented[field] !== current[field]) {
      throw new Error(
        `ship authority: ${field} does not match the current claim (${presented[field]} vs ${current[field]})`,
      );
    }
  }
  if (nowMs >= Date.parse(current.expires_at)) {
    throw new Error("ship authority: grant has expired");
  }
}

export interface RollbackRetainedTarget {
  version: string;
  tag?: string;
  git_sha?: string | null;
}

export interface RollbackAuthorityEnvelope {
  kind: typeof ROLLBACK_ENVELOPE_KIND;
  operation: typeof ROLLBACK_OPERATION;
  retained_target: RollbackRetainedTarget;
  actor: string;
  repository: string;
  issued_at: string;
  expires_at: string;
  mac?: string;
}

export interface AssertRollbackEnvelopeOpts {
  repository: string;
  nowMs: number;
  hmacKey?: string | null;
  /** Automatic rollback requires a verified HMAC. Operator argv does not. */
  requireMac?: boolean;
}

export function resolveRollbackEnvelopeKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[ROLLBACK_ENVELOPE_KEY_ENV];
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  return key === "" ? null : key;
}

export function signRollbackEnvelope(
  unsigned: Omit<RollbackAuthorityEnvelope, "mac">,
  key: string,
): RollbackAuthorityEnvelope {
  const mac = `${ROLLBACK_ENVELOPE_MAC_PREFIX}${hmacSha256Hex(key, canonicalJson(unsigned))}`;
  return { ...unsigned, mac };
}

function normalizeRollbackOid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const sha = value.trim().toLowerCase();
  return ROLLBACK_OID_RE.test(sha) ? sha : null;
}

function normalizeRollbackTag(value: string): string {
  return value.trim().replace(/^[vV]/, "");
}

export function operatorRollbackEnvelope(input: {
  retainedTarget: RollbackRetainedTarget;
  actor?: string;
  repository: string;
  now?: Date;
  ttlMs?: number;
  hmacKey?: string;
}): RollbackAuthorityEnvelope {
  const now = input.now ?? new Date();
  const ttlMs = input.ttlMs ?? ROLLBACK_ENVELOPE_TTL_MS;
  const unsigned: Omit<RollbackAuthorityEnvelope, "mac"> = {
    kind: ROLLBACK_ENVELOPE_KIND,
    operation: ROLLBACK_OPERATION,
    retained_target: { ...input.retainedTarget },
    actor: input.actor ?? "operator-cli",
    repository: input.repository,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
  if (typeof input.hmacKey === "string" && input.hmacKey.trim()) {
    return signRollbackEnvelope(unsigned, input.hmacKey);
  }
  return unsigned;
}

export function assertRollbackEnvelope(
  envelope: unknown,
  retainedTarget: RollbackRetainedTarget,
  opts: AssertRollbackEnvelopeOpts,
): asserts envelope is RollbackAuthorityEnvelope {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error(
      "rollback refused: authenticated envelope naming factory_pin_rollback and the retained target is required",
    );
  }
  const rec = envelope as Partial<RollbackAuthorityEnvelope>;
  if (rec.kind !== ROLLBACK_ENVELOPE_KIND) {
    throw new Error("rollback refused: envelope kind must be rollback_envelope");
  }
  if (rec.operation !== ROLLBACK_OPERATION) {
    throw new Error("rollback refused: envelope must name the factory_pin_rollback operation");
  }
  const target = rec.retained_target;
  if (!target || typeof target !== "object" || typeof target.version !== "string" || !target.version.trim()) {
    throw new Error("rollback refused: envelope must name the retained target version");
  }
  const expected = retainedTarget.version.replace(/^[vV]/, "");
  const presented = target.version.replace(/^[vV]/, "");
  if (presented !== expected) {
    throw new Error(
      `rollback refused: envelope retained target ${target.version} does not match ${retainedTarget.version}`,
    );
  }
  if (typeof retainedTarget.tag === "string" && retainedTarget.tag.trim()) {
    const presentedTag = typeof target.tag === "string" ? target.tag.trim() : "";
    if (!presentedTag) {
      throw new Error("rollback refused: envelope must name the retained target tag");
    }
    if (normalizeRollbackTag(presentedTag) !== normalizeRollbackTag(retainedTarget.tag)) {
      throw new Error(
        `rollback refused: envelope retained tag ${presentedTag} does not match ${retainedTarget.tag}`,
      );
    }
  }
  const expectedSha = normalizeRollbackOid(retainedTarget.git_sha);
  if (expectedSha) {
    const presentedSha = normalizeRollbackOid(target.git_sha);
    if (!presentedSha) {
      throw new Error("rollback refused: envelope must name the retained target digest");
    }
    if (presentedSha !== expectedSha) {
      throw new Error(
        `rollback refused: envelope retained digest ${String(target.git_sha)} does not match ${retainedTarget.git_sha}`,
      );
    }
  }
  if (typeof rec.actor !== "string" || rec.actor.trim() === "") {
    throw new Error("rollback refused: envelope must name the actor");
  }
  if (typeof rec.repository !== "string" || rec.repository.trim() === "") {
    throw new Error("rollback refused: envelope must name the repository");
  }
  if (rec.repository.trim() !== opts.repository.trim()) {
    throw new Error(
      `rollback refused: envelope repository ${rec.repository} does not match ${opts.repository}`,
    );
  }
  if (typeof rec.issued_at !== "string" || !Number.isFinite(Date.parse(rec.issued_at))) {
    throw new Error("rollback refused: envelope must name issued_at");
  }
  if (typeof rec.expires_at !== "string" || !Number.isFinite(Date.parse(rec.expires_at))) {
    throw new Error("rollback refused: envelope must name expires_at");
  }
  if (opts.nowMs >= Date.parse(rec.expires_at)) {
    throw new Error("rollback refused: envelope has expired");
  }
  if (!opts.requireMac) return;
  const key = typeof opts.hmacKey === "string" ? opts.hmacKey.trim() : "";
  if (!key) {
    throw new Error("rollback refused: automatic rollback requires a verified signed envelope");
  }
  const mac = rec.mac;
  if (typeof mac !== "string" || !mac.startsWith(ROLLBACK_ENVELOPE_MAC_PREFIX)) {
    throw new Error("rollback refused: envelope MAC is missing");
  }
  const { mac: _mac, ...unsigned } = rec as RollbackAuthorityEnvelope;
  const expectedMac = hmacSha256Hex(key, canonicalJson(unsigned));
  const actualMac = mac.slice(ROLLBACK_ENVELOPE_MAC_PREFIX.length);
  if (!hmacEqual(expectedMac, actualMac)) {
    throw new Error("rollback refused: envelope MAC verification failed");
  }
}

export function diagnosticFromError(err: unknown): StageDiagnostic | null {
  if (!err || typeof err !== "object") return null;
  const diagnostic = (err as { diagnostic?: unknown }).diagnostic;
  if (!diagnostic) return null;
  const projection = projectStageDiagnostic(diagnostic);
  if (projection.disposition === "protocol_failure") return null;
  return diagnostic as StageDiagnostic;
}

export function projectHumanAuthorityBit(input: {
  diagnostic?: StageDiagnostic | null;
  authorityRequest?: OperationBoundAuthority | null;
  nowMs?: number;
}): boolean {
  if (input.diagnostic && projectStageDiagnostic(input.diagnostic).disposition === "human_authority") {
    return true;
  }
  const request = input.authorityRequest;
  if (!request) return false;
  const nowMs = input.nowMs ?? Date.now();
  return Number.isFinite(Date.parse(request.expires_at)) && nowMs < Date.parse(request.expires_at);
}

export function isAuthorizationOrProtocolShipError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.startsWith("ship authorization:") ||
    message.startsWith("ship status") ||
    message.startsWith("ship train plan") ||
    message.includes("events_file does not match") ||
    message.includes("belongs to a different") ||
    message.includes("unsupported schema")
  );
}

export function isRemainingOpenShipWait(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("ship-end-open-issue-gate:");
}

export function coolingUntilIso(now: Date, ms: number = SHIP_COOLING_MS): string {
  return new Date(now.getTime() + ms).toISOString();
}

export function resolveShipReleaseModel(value: unknown): ShipReleaseModel {
  return value === "continuous" ? "continuous" : "semver";
}

export interface ShipStatusView {
  phase: string;
  candidate: string | null;
  next_action: string;
  human_authority: boolean;
  lifecycle: ShipLifecycleState;
  lineage: CandidateLineage;
}

export function projectShipStatusView(status: {
  next_action: string;
  complete?: boolean;
  human_authority?: boolean;
  lifecycle?: ShipLifecycleState;
  lineage?: CandidateLineage | null;
  train?: { integrated_head_oid?: string } | null;
  promotion?: { pin_digest?: string | null } | null;
  deployment?: { live_digest?: string | null } | null;
}): ShipStatusView {
  const lineage = status.lineage ?? EMPTY_CANDIDATE_LINEAGE;
  const candidate =
    status.deployment?.live_digest ??
    status.promotion?.pin_digest ??
    lineage.deployed?.identity ??
    lineage.promoted_pin?.identity ??
    lineage.release_merge_result?.identity ??
    lineage.frg_candidate?.identity ??
    status.train?.integrated_head_oid ??
    lineage.integrated_candidate?.identity ??
    null;
  return {
    phase: status.next_action,
    candidate,
    next_action: status.next_action,
    human_authority: status.human_authority === true,
    lifecycle: status.lifecycle ?? (status.complete ? "complete" : "active"),
    lineage,
  };
}
