// Repository-control desired-state vs live compare (#695).
//
// Versioned desired-state snapshot, injectable gh live readers (read-only),
// closed compare outcomes with freshness, fail-open/fail-closed disposition,
// and a read-only check surface. No forge mutation. No ForgeAdapter type.

import {
  isGithubAuthOrPermissionError,
  type GhRunOptions,
} from "./gh.ts";
import {
  assertPolicyLifecycleState,
  type PolicyLifecycleState,
  type PolicyLineageEvent,
  type StagedPolicy,
  type StagedPolicyEvidenceRow,
  toPolicyEvidenceRow,
  assertEnforcingLineage,
} from "./stage-policy-lifecycle.ts";
import {
  sha256Hex,
  stableStringify,
  type EvidenceSubjectV1,
} from "./evidence-subject.ts";

// ---------------------------------------------------------------------------
// Risk class + outcomes (closed sets)
// ---------------------------------------------------------------------------

export const CONTROL_RISK_CLASSES = ["observation", "fail_open", "fail_closed"] as const;
export type ControlRiskClass = (typeof CONTROL_RISK_CLASSES)[number];

export function isControlRiskClass(value: unknown): value is ControlRiskClass {
  return typeof value === "string" && (CONTROL_RISK_CLASSES as readonly string[]).includes(value);
}

export function assertControlRiskClass(value: unknown): ControlRiskClass {
  if (!isControlRiskClass(value)) {
    throw new Error(
      `invalid risk_class: ${JSON.stringify(value)}; expected one of ${CONTROL_RISK_CLASSES.join("|")}`,
    );
  }
  return value;
}

export const DRIFT_OUTCOMES = [
  "in_sync",
  "drifted",
  "unknown",
  "unsupported",
  "unavailable",
] as const;
export type DriftOutcome = (typeof DRIFT_OUTCOMES)[number];

/** Typed reason codes for escalation / diagnostics (design decision 10). */
export const DRIFT_REASON_CODES = [
  "drift_required_checks",
  "drift_branch_protection",
  "drift_ruleset",
  "drift_pipeline_gates",
  "drift_collector",
  "drift_live_unavailable",
  "drift_unsupported",
  "drift_unknown",
  "drift_stale",
] as const;
export type DriftReasonCode = (typeof DRIFT_REASON_CODES)[number];

export const DEFAULT_LIVE_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Desired-state schema_version 1
// ---------------------------------------------------------------------------

export const REPOSITORY_CONTROL_DESIRED_STATE_SCHEMA_VERSION = 1 as const;

export interface BranchProtectionDesired {
  /** Required approving review count when readable. */
  required_approving_review_count?: number;
  dismiss_stale_reviews?: boolean;
  require_code_owner_reviews?: boolean;
  require_conversation_resolution?: boolean;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
  /** Required status check contexts nested under branch protection (subset). */
  required_status_check_contexts?: string[];
}

export interface RulesetDesired {
  /** Ruleset name or node id. */
  id_or_name: string;
  /** Expected enforcement when readable: active | evaluate | disabled. */
  enforcement?: "active" | "evaluate" | "disabled";
}

export interface CollectorRequirement {
  collector_id: string;
  min_version?: string;
}

export interface RepositoryControlDesiredStateV1 {
  schema_version: typeof REPOSITORY_CONTROL_DESIRED_STATE_SCHEMA_VERSION;
  repository: string;
  default_branch: string;
  required_checks: string[];
  branch_protections: BranchProtectionDesired;
  rulesets: RulesetDesired[];
  required_pipeline_gates: string[];
  collector_requirements: CollectorRequirement[];
  /** Optional binding to a staged policy lifecycle object. */
  policy_id?: string | null;
  /** Section-level default risk class when per-family not set. */
  risk_class?: ControlRiskClass;
  /** Optional per-family risk overrides. */
  risk_class_by_family?: Partial<Record<ControlFamily, ControlRiskClass>>;
}

export type ControlFamily =
  | "required_checks"
  | "branch_protections"
  | "rulesets"
  | "required_pipeline_gates"
  | "collector_requirements";

export const CONTROL_FAMILIES: readonly ControlFamily[] = [
  "required_checks",
  "branch_protections",
  "rulesets",
  "required_pipeline_gates",
  "collector_requirements",
] as const;

// ---------------------------------------------------------------------------
// Live snapshot
// ---------------------------------------------------------------------------

export interface LiveBranchProtection {
  required_approving_review_count?: number;
  dismiss_stale_reviews?: boolean;
  require_code_owner_reviews?: boolean;
  require_conversation_resolution?: boolean;
  allow_force_pushes?: boolean;
  allow_deletions?: boolean;
  required_status_check_contexts?: string[];
}

export interface LiveRuleset {
  id_or_name: string;
  enforcement?: string;
}

export interface LiveRepositoryControlState {
  repository: string;
  default_branch: string;
  required_checks: string[] | null;
  branch_protections: LiveBranchProtection | null;
  rulesets: LiveRuleset[] | null;
  /** Families the reader cannot represent on this path. */
  unsupported_families: ControlFamily[];
  /** ISO 8601 fetch time. */
  fetched_at: string;
  /** Read error classification when a whole-snapshot read failed. */
  read_error?: "permission" | "network" | "unknown" | null;
  read_error_message?: string | null;
}

// ---------------------------------------------------------------------------
// Compare result
// ---------------------------------------------------------------------------

export interface FieldDiff {
  path: string;
  desired: unknown;
  live: unknown;
}

export interface RepositoryControlDriftResult {
  outcome: DriftOutcome;
  repository: string;
  policy_id: string | null;
  live_snapshot_digest: string;
  compared_at: string;
  fetched_at: string;
  stale: boolean;
  differences: FieldDiff[];
  reason_codes: DriftReasonCode[];
  /** Family-level outcomes when partial. */
  family_outcomes?: Partial<Record<ControlFamily, DriftOutcome>>;
  evidence_subject?: EvidenceSubjectV1 | null;
  /** Standalone check (no candidate run) must not claim readiness pass. */
  standalone_check?: boolean;
  readiness_claim?: "none" | "not_applicable";
}

// ---------------------------------------------------------------------------
// Parse / validate desired state
// ---------------------------------------------------------------------------

export function parseRepositoryControlDesiredState(
  raw: unknown,
): RepositoryControlDesiredStateV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("repository_control_desired_state must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== 1) {
    throw new Error(
      `unsupported repository_control_desired_state.schema_version: ${JSON.stringify(o.schema_version)}; only 1 is accepted`,
    );
  }
  if (typeof o.repository !== "string" || !o.repository.trim()) {
    throw new Error("repository_control_desired_state.repository is required");
  }
  if (typeof o.default_branch !== "string" || !o.default_branch.trim()) {
    throw new Error("repository_control_desired_state.default_branch is required");
  }
  if (!Array.isArray(o.required_checks) || !o.required_checks.every((c) => typeof c === "string")) {
    throw new Error("repository_control_desired_state.required_checks must be a string array");
  }
  if (!o.branch_protections || typeof o.branch_protections !== "object" || Array.isArray(o.branch_protections)) {
    throw new Error("repository_control_desired_state.branch_protections must be an object");
  }
  if (!Array.isArray(o.rulesets)) {
    throw new Error("repository_control_desired_state.rulesets must be an array");
  }
  if (!Array.isArray(o.required_pipeline_gates) || !o.required_pipeline_gates.every((c) => typeof c === "string")) {
    throw new Error("repository_control_desired_state.required_pipeline_gates must be a string array");
  }
  if (!Array.isArray(o.collector_requirements)) {
    throw new Error("repository_control_desired_state.collector_requirements must be an array");
  }

  let risk_class: ControlRiskClass | undefined;
  if (o.risk_class !== undefined) {
    risk_class = assertControlRiskClass(o.risk_class);
  }

  let risk_class_by_family: Partial<Record<ControlFamily, ControlRiskClass>> | undefined;
  if (o.risk_class_by_family !== undefined) {
    if (!o.risk_class_by_family || typeof o.risk_class_by_family !== "object") {
      throw new Error("risk_class_by_family must be an object");
    }
    risk_class_by_family = {};
    for (const [k, v] of Object.entries(o.risk_class_by_family as Record<string, unknown>)) {
      if (!(CONTROL_FAMILIES as readonly string[]).includes(k)) {
        throw new Error(`unknown control family in risk_class_by_family: ${k}`);
      }
      risk_class_by_family[k as ControlFamily] = assertControlRiskClass(v);
    }
  }

  const rulesets: RulesetDesired[] = o.rulesets.map((r, i) => {
    if (!r || typeof r !== "object") throw new Error(`rulesets[${i}] must be an object`);
    const rr = r as Record<string, unknown>;
    if (typeof rr.id_or_name !== "string" || !rr.id_or_name.trim()) {
      throw new Error(`rulesets[${i}].id_or_name is required`);
    }
    const enforcement = rr.enforcement;
    if (
      enforcement !== undefined &&
      enforcement !== "active" &&
      enforcement !== "evaluate" &&
      enforcement !== "disabled"
    ) {
      throw new Error(`rulesets[${i}].enforcement invalid: ${JSON.stringify(enforcement)}`);
    }
    return {
      id_or_name: rr.id_or_name,
      ...(enforcement !== undefined
        ? { enforcement: enforcement as RulesetDesired["enforcement"] }
        : {}),
    };
  });

  const collector_requirements: CollectorRequirement[] = o.collector_requirements.map((c, i) => {
    if (!c || typeof c !== "object") throw new Error(`collector_requirements[${i}] must be an object`);
    const cc = c as Record<string, unknown>;
    if (typeof cc.collector_id !== "string" || !cc.collector_id.trim()) {
      throw new Error(`collector_requirements[${i}].collector_id is required`);
    }
    return {
      collector_id: cc.collector_id,
      ...(typeof cc.min_version === "string" ? { min_version: cc.min_version } : {}),
    };
  });

  const bp = o.branch_protections as Record<string, unknown>;
  const branch_protections: BranchProtectionDesired = {};
  if (typeof bp.required_approving_review_count === "number") {
    branch_protections.required_approving_review_count = bp.required_approving_review_count;
  }
  if (typeof bp.dismiss_stale_reviews === "boolean") {
    branch_protections.dismiss_stale_reviews = bp.dismiss_stale_reviews;
  }
  if (typeof bp.require_code_owner_reviews === "boolean") {
    branch_protections.require_code_owner_reviews = bp.require_code_owner_reviews;
  }
  if (typeof bp.require_conversation_resolution === "boolean") {
    branch_protections.require_conversation_resolution = bp.require_conversation_resolution;
  }
  if (typeof bp.allow_force_pushes === "boolean") {
    branch_protections.allow_force_pushes = bp.allow_force_pushes;
  }
  if (typeof bp.allow_deletions === "boolean") {
    branch_protections.allow_deletions = bp.allow_deletions;
  }
  if (Array.isArray(bp.required_status_check_contexts)) {
    branch_protections.required_status_check_contexts = bp.required_status_check_contexts.filter(
      (x): x is string => typeof x === "string",
    );
  }

  return {
    schema_version: 1,
    repository: o.repository.trim(),
    default_branch: o.default_branch.trim(),
    required_checks: [...o.required_checks],
    branch_protections,
    rulesets,
    required_pipeline_gates: [...o.required_pipeline_gates],
    collector_requirements,
    policy_id: typeof o.policy_id === "string" ? o.policy_id : o.policy_id === null ? null : undefined,
    risk_class,
    risk_class_by_family,
  };
}

// ---------------------------------------------------------------------------
// Staged policy config parse helpers
// ---------------------------------------------------------------------------

export interface StagedPolicyConfigDecl {
  policy_id: string;
  state: PolicyLifecycleState;
  acceptance?: Record<string, unknown>;
  lineage?: PolicyLineageEvent[];
}

function parseLineageEvents(raw: unknown, policyId: string): PolicyLineageEvent[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`staged_policies[].lineage for ${policyId} must be an array`);
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`staged_policies[].lineage[${i}] must be an object`);
    }
    const e = item as Record<string, unknown>;
    const from_state = assertPolicyLifecycleState(e.from_state);
    const to_state = assertPolicyLifecycleState(e.to_state);
    if (typeof e.policy_id !== "string" || !e.policy_id.trim()) {
      throw new Error(`staged_policies[].lineage[${i}].policy_id is required`);
    }
    if (typeof e.policy_hash_before !== "string" || !e.policy_hash_before.trim()) {
      throw new Error(`staged_policies[].lineage[${i}].policy_hash_before is required`);
    }
    if (typeof e.policy_hash_after !== "string" || !e.policy_hash_after.trim()) {
      throw new Error(`staged_policies[].lineage[${i}].policy_hash_after is required`);
    }
    if (typeof e.at !== "string" || !e.at.trim()) {
      throw new Error(`staged_policies[].lineage[${i}].at is required`);
    }
    let authority: PolicyLineageEvent["authority"] = null;
    if (e.authority != null) {
      if (typeof e.authority !== "object" || Array.isArray(e.authority)) {
        throw new Error(`staged_policies[].lineage[${i}].authority must be an object or null`);
      }
      const a = e.authority as Record<string, unknown>;
      if (typeof a.actor !== "string" || !a.actor.trim() || typeof a.role !== "string" || !a.role.trim()) {
        throw new Error(`staged_policies[].lineage[${i}].authority requires non-empty actor and role`);
      }
      authority = { actor: a.actor.trim(), role: a.role.trim() };
    }
    const evidence_refs = Array.isArray(e.evidence_refs)
      ? e.evidence_refs.filter((r): r is string => typeof r === "string")
      : [];
    return {
      policy_id: e.policy_id.trim(),
      from_state,
      to_state,
      policy_hash_before: e.policy_hash_before,
      policy_hash_after: e.policy_hash_after,
      at: e.at,
      authority,
      evidence_refs,
    };
  });
}

export function parseStagedPolicyDecl(raw: unknown): StagedPolicyConfigDecl {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("staged_policies[] entry must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.policy_id !== "string" || !o.policy_id.trim()) {
    throw new Error("staged_policies[].policy_id is required");
  }
  const policy_id = o.policy_id.trim();
  const state = assertPolicyLifecycleState(o.state);
  const acceptance =
    o.acceptance && typeof o.acceptance === "object" && !Array.isArray(o.acceptance)
      ? (o.acceptance as Record<string, unknown>)
      : {};
  const lineage = parseLineageEvents(o.lineage, policy_id);
  // Fail closed: enforcing/retired without fully validated lineage is rejected
  // (complete chain, recomputed hashes, authority — not self-attested head).
  assertEnforcingLineage(policy_id, state, lineage, acceptance);
  return {
    policy_id,
    state,
    acceptance,
    ...(lineage.length > 0 ? { lineage } : {}),
  };
}

// ---------------------------------------------------------------------------
// Live readers (injectable)
// ---------------------------------------------------------------------------

export interface RepositoryControlLiveReaderDeps {
  /**
   * Run a read-only `gh` invocation. Must never be used for forge writes.
   * Injectable; unit tests pass fakes.
   */
  ghRun: (args: string[], opts?: GhRunOptions) => Promise<string>;
  /** Clock for freshness; injectable. */
  nowIso?: () => string;
  /**
   * Optional override for configured pipeline gates present in the engine
   * (no live forge read). Pure function over local knowledge.
   */
  listLocalPipelineGates?: () => string[];
  /**
   * Optional override for collector inventory (local/config only).
   */
  listCollectors?: () => Array<{ collector_id: string; version?: string }>;
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

/**
 * Fetch live repository-control state via existing gh API read surfaces.
 * Never mutates forge settings.
 */
export async function fetchLiveRepositoryControlState(
  desired: RepositoryControlDesiredStateV1,
  deps: RepositoryControlLiveReaderDeps,
): Promise<LiveRepositoryControlState> {
  const now = (deps.nowIso ?? defaultNowIso)();
  const repo = desired.repository;
  const branch = desired.default_branch;
  const unsupported: ControlFamily[] = [];

  let required_checks: string[] | null = null;
  let branch_protections: LiveBranchProtection | null = null;
  let rulesets: LiveRuleset[] | null = null;
  let read_error: LiveRepositoryControlState["read_error"] = null;
  let read_error_message: string | null = null;

  // Branch protection (includes nested required status checks when present).
  try {
    const raw = await deps.ghRun(
      [
        "api",
        `repos/${repo}/branches/${encodeURIComponent(branch)}/protection`,
        "--jq",
        ".",
      ],
      { wrapperName: "fetchLiveBranchProtection", retries: 1 },
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const reviews = (parsed.required_pull_request_reviews ?? {}) as Record<string, unknown>;
    const statusChecks = (parsed.required_status_checks ?? {}) as Record<string, unknown>;
    const contexts = Array.isArray(statusChecks.contexts)
      ? (statusChecks.contexts as unknown[]).filter((c): c is string => typeof c === "string")
      : Array.isArray(statusChecks.checks)
        ? (statusChecks.checks as Array<{ context?: string }>)
            .map((c) => c.context)
            .filter((c): c is string => typeof c === "string")
        : [];
    branch_protections = {
      required_approving_review_count:
        typeof reviews.required_approving_review_count === "number"
          ? reviews.required_approving_review_count
          : undefined,
      dismiss_stale_reviews:
        typeof reviews.dismiss_stale_reviews === "boolean"
          ? reviews.dismiss_stale_reviews
          : undefined,
      require_code_owner_reviews:
        typeof reviews.require_code_owner_reviews === "boolean"
          ? reviews.require_code_owner_reviews
          : undefined,
      require_conversation_resolution:
        typeof parsed.required_conversation_resolution === "object" &&
        parsed.required_conversation_resolution !== null
          ? Boolean((parsed.required_conversation_resolution as { enabled?: boolean }).enabled)
          : undefined,
      allow_force_pushes:
        typeof parsed.allow_force_pushes === "object" && parsed.allow_force_pushes !== null
          ? Boolean((parsed.allow_force_pushes as { enabled?: boolean }).enabled)
          : undefined,
      allow_deletions:
        typeof parsed.allow_deletions === "object" && parsed.allow_deletions !== null
          ? Boolean((parsed.allow_deletions as { enabled?: boolean }).enabled)
          : undefined,
      required_status_check_contexts: contexts,
    };
    required_checks = contexts;
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (isGithubAuthOrPermissionError(msg) || /http 403|resource not accessible|not accessible by integration/i.test(msg)) {
      read_error = "permission";
      read_error_message = msg;
      branch_protections = null;
      required_checks = null;
    } else if (/http 404|branch not protected|not found/i.test(msg)) {
      // Branch has no protection → empty live protection, empty checks.
      branch_protections = {
        required_approving_review_count: 0,
        required_status_check_contexts: [],
      };
      required_checks = [];
    } else {
      read_error = "unknown";
      read_error_message = msg;
    }
  }

  // Rulesets (repo rulesets list).
  try {
    const raw = await deps.ghRun(
      ["api", `repos/${repo}/rulesets`, "--jq", "."],
      { wrapperName: "fetchLiveRulesets", retries: 1 },
    );
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      rulesets = parsed.map((r) => {
        const rr = r as Record<string, unknown>;
        const name = typeof rr.name === "string" ? rr.name : undefined;
        const id = rr.id != null ? String(rr.id) : undefined;
        return {
          id_or_name: name ?? id ?? "unknown",
          enforcement: typeof rr.enforcement === "string" ? rr.enforcement : undefined,
        };
      });
    } else {
      rulesets = null;
      unsupported.push("rulesets");
    }
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (isGithubAuthOrPermissionError(msg) || /http 403|resource not accessible/i.test(msg)) {
      if (!read_error) {
        read_error = "permission";
        read_error_message = msg;
      }
      rulesets = null;
    } else if (/http 404|not found|unknown/i.test(msg)) {
      // Endpoint absent → unsupported rather than empty success.
      rulesets = null;
      if (!unsupported.includes("rulesets")) unsupported.push("rulesets");
    } else {
      if (!read_error) {
        read_error = "unknown";
        read_error_message = msg;
      }
      rulesets = null;
    }
  }

  // Pipeline gates / collectors are local knowledge (no forge write).
  // When desired lists them, live comes from deps hooks; absent hooks → empty live.
  if (desired.required_pipeline_gates.length > 0 && !deps.listLocalPipelineGates) {
    // Readable via optional local hook only; without hook mark unsupported.
    if (!unsupported.includes("required_pipeline_gates")) {
      unsupported.push("required_pipeline_gates");
    }
  }
  if (desired.collector_requirements.length > 0 && !deps.listCollectors) {
    if (!unsupported.includes("collector_requirements")) {
      unsupported.push("collector_requirements");
    }
  }

  return {
    repository: repo,
    default_branch: branch,
    required_checks,
    branch_protections,
    rulesets,
    unsupported_families: unsupported,
    fetched_at: now,
    read_error,
    read_error_message,
  };
}

// ---------------------------------------------------------------------------
// Pure compare
// ---------------------------------------------------------------------------

export interface CompareOptions {
  nowIso?: string;
  maxAgeMs?: number;
  /** Local live values for pipeline gates (when supported). */
  livePipelineGates?: string[] | null;
  liveCollectors?: Array<{ collector_id: string; version?: string }> | null;
  policy_id?: string | null;
}

function sortedUnique(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

function digestLive(live: LiveRepositoryControlState): string {
  return sha256Hex(
    stableStringify({
      repository: live.repository,
      default_branch: live.default_branch,
      required_checks: live.required_checks,
      branch_protections: live.branch_protections,
      rulesets: live.rulesets,
      unsupported_families: live.unsupported_families,
      fetched_at: live.fetched_at,
      read_error: live.read_error,
    }),
  );
}

function isStale(fetchedAt: string, nowIso: string, maxAgeMs: number): boolean {
  const t = Date.parse(fetchedAt);
  const n = Date.parse(nowIso);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return true;
  return n - t > maxAgeMs;
}

/**
 * Compare desired state to a live snapshot. Pure; no I/O.
 * Stale live snapshots are never reported as in_sync.
 */
export function compareRepositoryControlState(
  desired: RepositoryControlDesiredStateV1,
  live: LiveRepositoryControlState,
  opts: CompareOptions = {},
): RepositoryControlDriftResult {
  const nowIso = opts.nowIso ?? defaultNowIso();
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_LIVE_MAX_AGE_MS;
  const stale = isStale(live.fetched_at, nowIso, maxAgeMs);
  const policy_id =
    opts.policy_id !== undefined
      ? opts.policy_id
      : desired.policy_id !== undefined
        ? desired.policy_id
        : null;
  const live_snapshot_digest = digestLive(live);
  const differences: FieldDiff[] = [];
  const reason_codes: DriftReasonCode[] = [];
  const family_outcomes: Partial<Record<ControlFamily, DriftOutcome>> = {};

  // Whole-snapshot permission/network failure → unavailable (not in_sync).
  if (live.read_error === "permission" || live.read_error === "network") {
    return {
      outcome: "unavailable",
      repository: desired.repository,
      policy_id,
      live_snapshot_digest,
      compared_at: nowIso,
      fetched_at: live.fetched_at,
      stale,
      differences: [],
      reason_codes: ["drift_live_unavailable"],
      family_outcomes,
    };
  }

  // Required checks
  if (live.required_checks === null && live.read_error) {
    family_outcomes.required_checks = "unavailable";
    reason_codes.push("drift_live_unavailable");
  } else if (live.required_checks === null) {
    family_outcomes.required_checks = "unknown";
    reason_codes.push("drift_unknown");
  } else {
    const desiredChecks = sortedUnique(desired.required_checks);
    const liveChecks = sortedUnique(live.required_checks);
    for (const c of desiredChecks) {
      if (!liveChecks.includes(c)) {
        differences.push({ path: `required_checks.${c}`, desired: true, live: false });
      }
    }
    // Only desired ⊆ live is required; extra live checks are not drift.
    family_outcomes.required_checks = differences.some((d) => d.path.startsWith("required_checks."))
      ? "drifted"
      : "in_sync";
    if (family_outcomes.required_checks === "drifted") reason_codes.push("drift_required_checks");
  }

  // Branch protections
  const bpDesired = desired.branch_protections;
  const bpKeys = Object.keys(bpDesired) as (keyof BranchProtectionDesired)[];
  if (bpKeys.length === 0) {
    family_outcomes.branch_protections = "in_sync";
  } else if (live.branch_protections === null) {
    if (live.read_error) {
      family_outcomes.branch_protections = "unavailable";
      if (!reason_codes.includes("drift_live_unavailable")) reason_codes.push("drift_live_unavailable");
    } else {
      family_outcomes.branch_protections = "unknown";
      if (!reason_codes.includes("drift_unknown")) reason_codes.push("drift_unknown");
    }
  } else {
    let bpDrift = false;
    for (const key of bpKeys) {
      const dVal = bpDesired[key];
      if (dVal === undefined) continue;
      if (key === "required_status_check_contexts" && Array.isArray(dVal)) {
        const liveCtx = sortedUnique(live.branch_protections.required_status_check_contexts ?? []);
        for (const c of dVal) {
          if (!liveCtx.includes(c)) {
            differences.push({
              path: `branch_protections.required_status_check_contexts.${c}`,
              desired: true,
              live: false,
            });
            bpDrift = true;
          }
        }
      } else {
        const lVal = live.branch_protections[key as keyof LiveBranchProtection];
        if (lVal === undefined) {
          differences.push({ path: `branch_protections.${key}`, desired: dVal, live: null });
          bpDrift = true;
        } else if (lVal !== dVal) {
          differences.push({ path: `branch_protections.${key}`, desired: dVal, live: lVal });
          bpDrift = true;
        }
      }
    }
    family_outcomes.branch_protections = bpDrift ? "drifted" : "in_sync";
    if (bpDrift) reason_codes.push("drift_branch_protection");
  }

  // Rulesets
  if (desired.rulesets.length === 0) {
    family_outcomes.rulesets = "in_sync";
  } else if (live.unsupported_families.includes("rulesets")) {
    family_outcomes.rulesets = "unsupported";
    reason_codes.push("drift_unsupported");
  } else if (live.rulesets === null) {
    family_outcomes.rulesets = live.read_error ? "unavailable" : "unknown";
    if (family_outcomes.rulesets === "unavailable" && !reason_codes.includes("drift_live_unavailable")) {
      reason_codes.push("drift_live_unavailable");
    }
    if (family_outcomes.rulesets === "unknown" && !reason_codes.includes("drift_unknown")) {
      reason_codes.push("drift_unknown");
    }
  } else {
    let rsDrift = false;
    const liveByName = new Map(live.rulesets.map((r) => [r.id_or_name, r]));
    for (const want of desired.rulesets) {
      const got = liveByName.get(want.id_or_name);
      if (!got) {
        differences.push({
          path: `rulesets.${want.id_or_name}`,
          desired: want,
          live: null,
        });
        rsDrift = true;
      } else if (want.enforcement && got.enforcement !== want.enforcement) {
        differences.push({
          path: `rulesets.${want.id_or_name}.enforcement`,
          desired: want.enforcement,
          live: got.enforcement ?? null,
        });
        rsDrift = true;
      }
    }
    family_outcomes.rulesets = rsDrift ? "drifted" : "in_sync";
    if (rsDrift) reason_codes.push("drift_ruleset");
  }

  // Pipeline gates (local)
  if (desired.required_pipeline_gates.length === 0) {
    family_outcomes.required_pipeline_gates = "in_sync";
  } else if (live.unsupported_families.includes("required_pipeline_gates")) {
    family_outcomes.required_pipeline_gates = "unsupported";
    if (!reason_codes.includes("drift_unsupported")) reason_codes.push("drift_unsupported");
  } else if (opts.livePipelineGates == null) {
    family_outcomes.required_pipeline_gates = "unknown";
    if (!reason_codes.includes("drift_unknown")) reason_codes.push("drift_unknown");
  } else {
    const liveGates = sortedUnique(opts.livePipelineGates);
    let gateDrift = false;
    for (const g of desired.required_pipeline_gates) {
      if (!liveGates.includes(g)) {
        differences.push({ path: `required_pipeline_gates.${g}`, desired: true, live: false });
        gateDrift = true;
      }
    }
    family_outcomes.required_pipeline_gates = gateDrift ? "drifted" : "in_sync";
    if (gateDrift) reason_codes.push("drift_pipeline_gates");
  }

  // Collectors (local)
  if (desired.collector_requirements.length === 0) {
    family_outcomes.collector_requirements = "in_sync";
  } else if (live.unsupported_families.includes("collector_requirements")) {
    family_outcomes.collector_requirements = "unsupported";
    if (!reason_codes.includes("drift_unsupported")) reason_codes.push("drift_unsupported");
  } else if (opts.liveCollectors == null) {
    family_outcomes.collector_requirements = "unknown";
    if (!reason_codes.includes("drift_unknown")) reason_codes.push("drift_unknown");
  } else {
    const byId = new Map(opts.liveCollectors.map((c) => [c.collector_id, c]));
    let colDrift = false;
    for (const want of desired.collector_requirements) {
      const got = byId.get(want.collector_id);
      if (!got) {
        differences.push({
          path: `collector_requirements.${want.collector_id}`,
          desired: want,
          live: null,
        });
        colDrift = true;
      } else if (want.min_version && got.version && got.version < want.min_version) {
        // Lexicographic version compare is a v1 stand-in; callers can refine.
        differences.push({
          path: `collector_requirements.${want.collector_id}.min_version`,
          desired: want.min_version,
          live: got.version,
        });
        colDrift = true;
      }
    }
    family_outcomes.collector_requirements = colDrift ? "drifted" : "in_sync";
    if (colDrift) reason_codes.push("drift_collector");
  }

  // Aggregate outcome
  const outcomes = Object.values(family_outcomes);
  let outcome: DriftOutcome;
  if (outcomes.includes("unavailable")) outcome = "unavailable";
  else if (outcomes.includes("unsupported") && outcomes.every((o) => o === "unsupported" || o === "in_sync")) {
    // Any unsupported with no drifted/unknown → unsupported if any family needs it
    outcome = outcomes.includes("unsupported") ? "unsupported" : "in_sync";
  } else if (outcomes.includes("unknown")) outcome = "unknown";
  else if (outcomes.includes("drifted") || differences.length > 0) outcome = "drifted";
  else if (outcomes.includes("unsupported")) outcome = "unsupported";
  else outcome = "in_sync";

  // Stale never in_sync
  if (stale && outcome === "in_sync") {
    outcome = "unavailable";
    reason_codes.push("drift_stale");
  } else if (stale && !reason_codes.includes("drift_stale")) {
    reason_codes.push("drift_stale");
  }

  return {
    outcome,
    repository: desired.repository,
    policy_id,
    live_snapshot_digest,
    compared_at: nowIso,
    fetched_at: live.fetched_at,
    stale,
    differences,
    reason_codes: [...new Set(reason_codes)],
    family_outcomes,
  };
}

// ---------------------------------------------------------------------------
// Fail-open / fail-closed disposition
// ---------------------------------------------------------------------------

export type ReadinessDisposition = "pass" | "record_only" | "advisory" | "block";

export interface DriftReadinessDecision {
  disposition: ReadinessDisposition;
  blocks_readiness: boolean;
  reason_code: DriftReasonCode | null;
  risk_class: ControlRiskClass;
  lifecycle_state: PolicyLifecycleState | null;
  outcome: DriftOutcome;
}

export function riskClassForFamily(
  desired: RepositoryControlDesiredStateV1,
  family: ControlFamily,
): ControlRiskClass {
  return (
    desired.risk_class_by_family?.[family] ??
    desired.risk_class ??
    "observation"
  );
}

/**
 * Combine lifecycle state + risk class + compare outcome into readiness disposition.
 *
 * - draft / observe → record only (never block)
 * - required → record only unless config enables gating at required (v1: no gate)
 * - enforcing + observation → record only
 * - enforcing + fail_open → advisory
 * - enforcing + fail_closed → block on non-in_sync
 * - unbound (no policy) → use risk_class alone for check severity; never invent enforcing
 */
export function disposeDriftForReadiness(input: {
  outcome: DriftOutcome;
  risk_class: ControlRiskClass;
  lifecycle_state: PolicyLifecycleState | null;
  /** When true, `required` may block (config opt-in). Default false. */
  gate_at_required?: boolean;
  primary_reason?: DriftReasonCode | null;
}): DriftReadinessDecision {
  const { outcome, risk_class, lifecycle_state } = input;
  const reason = input.primary_reason ?? null;
  const nonSync = outcome !== "in_sync";

  if (lifecycle_state === "draft" || lifecycle_state === "observe" || lifecycle_state === "retired") {
    return {
      disposition: "record_only",
      blocks_readiness: false,
      reason_code: nonSync ? reason : null,
      risk_class,
      lifecycle_state,
      outcome,
    };
  }

  if (lifecycle_state === "required") {
    if (input.gate_at_required && risk_class === "fail_closed" && nonSync) {
      return {
        disposition: "block",
        blocks_readiness: true,
        reason_code: reason ?? "drift_unknown",
        risk_class,
        lifecycle_state,
        outcome,
      };
    }
    return {
      disposition: "record_only",
      blocks_readiness: false,
      reason_code: nonSync ? reason : null,
      risk_class,
      lifecycle_state,
      outcome,
    };
  }

  // enforcing, or unbound (null lifecycle — check-command severity only)
  if (lifecycle_state === null) {
    // Unbound: check severity only; do not invent enforcing for advance readiness.
    if (risk_class === "fail_closed" && nonSync) {
      return {
        disposition: "block",
        blocks_readiness: true,
        reason_code: reason ?? "drift_unknown",
        risk_class,
        lifecycle_state,
        outcome,
      };
    }
    if (risk_class === "fail_open" && nonSync) {
      return {
        disposition: "advisory",
        blocks_readiness: false,
        reason_code: reason,
        risk_class,
        lifecycle_state,
        outcome,
      };
    }
    return {
      disposition: nonSync ? "record_only" : "pass",
      blocks_readiness: false,
      reason_code: nonSync ? reason : null,
      risk_class,
      lifecycle_state,
      outcome,
    };
  }

  // enforcing
  if (risk_class === "observation") {
    return {
      disposition: "record_only",
      blocks_readiness: false,
      reason_code: nonSync ? reason : null,
      risk_class,
      lifecycle_state,
      outcome,
    };
  }
  if (risk_class === "fail_open") {
    return {
      disposition: nonSync ? "advisory" : "pass",
      blocks_readiness: false,
      reason_code: nonSync ? reason : null,
      risk_class,
      lifecycle_state,
      outcome,
    };
  }
  // fail_closed
  if (nonSync) {
    return {
      disposition: "block",
      blocks_readiness: true,
      reason_code: reason ?? "drift_unknown",
      risk_class,
      lifecycle_state,
      outcome,
    };
  }
  return {
    disposition: "pass",
    blocks_readiness: false,
    reason_code: null,
    risk_class,
    lifecycle_state,
    outcome,
  };
}

/**
 * Worst disposition across families for a full compare result.
 */
export function disposeCompareResult(input: {
  result: RepositoryControlDriftResult;
  desired: RepositoryControlDesiredStateV1;
  lifecycle_state: PolicyLifecycleState | null;
  gate_at_required?: boolean;
}): DriftReadinessDecision {
  const { result, desired, lifecycle_state } = input;
  // Use section-level risk class for the aggregate decision.
  const risk = desired.risk_class ?? "observation";
  const primary = result.reason_codes[0] ?? null;
  return disposeDriftForReadiness({
    outcome: result.outcome,
    risk_class: risk,
    lifecycle_state,
    gate_at_required: input.gate_at_required,
    primary_reason: primary,
  });
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

export function bindDriftEvidenceSubject(
  result: RepositoryControlDriftResult,
  subject: EvidenceSubjectV1 | null | undefined,
  standalone: boolean,
): RepositoryControlDriftResult {
  if (standalone || !subject) {
    return {
      ...result,
      evidence_subject: null,
      standalone_check: true,
      readiness_claim: "none",
    };
  }
  return {
    ...result,
    evidence_subject: subject,
    standalone_check: false,
    readiness_claim: "not_applicable",
  };
}

export function policiesToEvidenceRows(policies: StagedPolicy[]): StagedPolicyEvidenceRow[] {
  return policies.map(toPolicyEvidenceRow);
}

// ---------------------------------------------------------------------------
// Read-only check surface
// ---------------------------------------------------------------------------

export interface ControlsCheckInput {
  desired: RepositoryControlDesiredStateV1 | null;
  /** Bound staged policy state when policy_id is set; null if unbound. */
  lifecycle_state?: PolicyLifecycleState | null;
  staged_policies?: StagedPolicy[];
  strict?: boolean;
  json?: boolean;
  /** Optional candidate subject for run-scoped checks. */
  evidence_subject?: EvidenceSubjectV1 | null;
  maxAgeMs?: number;
  nowIso?: string;
}

export interface ControlsCheckOutput {
  configured: boolean;
  results: RepositoryControlDriftResult[];
  policies: StagedPolicyEvidenceRow[];
  decisions: DriftReadinessDecision[];
  /** Process exit code recommendation: 0 pass, 1 fail-closed non-sync, 2 usage. */
  exit_code: number;
  message: string;
}

export async function runControlsCheck(
  input: ControlsCheckInput,
  deps: RepositoryControlLiveReaderDeps,
): Promise<ControlsCheckOutput> {
  if (!input.desired) {
    return {
      configured: false,
      results: [],
      policies: input.staged_policies ? policiesToEvidenceRows(input.staged_policies) : [],
      decisions: [],
      exit_code: 0,
      message: "repository-control drift checking is not configured (no desired state)",
    };
  }

  const desired = input.desired;
  const live = await fetchLiveRepositoryControlState(desired, deps);
  const livePipelineGates = deps.listLocalPipelineGates?.() ?? null;
  const liveCollectors = deps.listCollectors?.() ?? null;
  const result = compareRepositoryControlState(desired, live, {
    nowIso: input.nowIso ?? (deps.nowIso ?? defaultNowIso)(),
    maxAgeMs: input.maxAgeMs,
    livePipelineGates,
    liveCollectors,
    policy_id: desired.policy_id ?? null,
  });

  const lifecycle =
    input.lifecycle_state !== undefined
      ? input.lifecycle_state
      : desired.policy_id && input.staged_policies
        ? input.staged_policies.find((p) => p.policy_id === desired.policy_id)?.state ?? null
        : null;

  const bound = bindDriftEvidenceSubject(
    result,
    input.evidence_subject,
    !input.evidence_subject,
  );

  const decision = disposeCompareResult({
    result: bound,
    desired,
    lifecycle_state: lifecycle,
  });

  let exit_code = 0;
  if (decision.blocks_readiness) exit_code = 1;
  else if (input.strict && bound.outcome === "drifted") exit_code = 1;

  return {
    configured: true,
    results: [bound],
    policies: input.staged_policies ? policiesToEvidenceRows(input.staged_policies) : [],
    decisions: [decision],
    exit_code,
    message:
      bound.outcome === "in_sync"
        ? `repository controls in_sync for ${desired.repository}`
        : `repository controls ${bound.outcome} for ${desired.repository}` +
          (decision.blocks_readiness ? " (fail-closed block)" : ""),
  };
}

/**
 * Format human-readable check output. Never claims multi-family readiness pass
 * for standalone checks.
 */
export function formatControlsCheckHuman(out: ControlsCheckOutput): string {
  if (!out.configured) {
    return out.message;
  }
  const lines: string[] = [out.message];
  for (const r of out.results) {
    lines.push(`  outcome: ${r.outcome}`);
    lines.push(`  repository: ${r.repository}`);
    lines.push(`  policy_id: ${r.policy_id ?? "null"}`);
    lines.push(`  stale: ${r.stale}`);
    lines.push(`  fetched_at: ${r.fetched_at}`);
    lines.push(`  live_snapshot_digest: ${r.live_snapshot_digest.slice(0, 16)}…`);
    if (r.standalone_check) {
      lines.push("  standalone_check: true (does not claim readiness pass)");
    }
    if (r.differences.length > 0) {
      lines.push("  differences:");
      for (const d of r.differences) {
        lines.push(`    - ${d.path}: desired=${JSON.stringify(d.desired)} live=${JSON.stringify(d.live)}`);
      }
    }
    if (r.reason_codes.length > 0) {
      lines.push(`  reason_codes: ${r.reason_codes.join(", ")}`);
    }
  }
  for (const d of out.decisions) {
    lines.push(
      `  disposition: ${d.disposition} blocks_readiness=${d.blocks_readiness}` +
        (d.reason_code ? ` reason=${d.reason_code}` : ""),
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fail-closed park helper (production escalation site)
// ---------------------------------------------------------------------------

export interface ParkFailClosedDriftDeps {
  setBlocked: (args: {
    issueNumber: number;
    reason: string;
    kind: "needs-human";
  }) => Promise<void>;
}

/**
 * Park readiness when an enforcing fail-closed control is not in_sync.
 * Escalation site: deliberately-fail-closed; no forge remediation.
 *
 * Callers MUST only invoke this when disposeCompareResult().blocks_readiness
 * is true. Observation-only drift MUST NOT call this.
 */
export async function parkFailClosedRepositoryControlDrift(
  issueNumber: number,
  decision: DriftReadinessDecision,
  result: RepositoryControlDriftResult,
  deps: ParkFailClosedDriftDeps,
): Promise<void> {
  if (!decision.blocks_readiness) {
    throw new Error("parkFailClosedRepositoryControlDrift: decision does not block readiness");
  }
  const code = decision.reason_code ?? "drift_unknown";
  const reason =
    `repository-control drift fail-closed: ${code} ` +
    `(outcome=${result.outcome}, repository=${result.repository}, ` +
    `policy_id=${result.policy_id ?? "null"}). ` +
    `Agent Pipeline does not auto-remediate forge settings; ` +
    `restore required checks/branch protection/rulesets to the desired state, ` +
    `then re-run.`;
  await deps.setBlocked({
    issueNumber,
    reason,
    kind: "needs-human",
  });
}

/** Stable site id fragment for inventory drift-guards (module path without scripts/). */
export const REPOSITORY_CONTROL_DRIFT_ESCALATION_SITE_MODULE =
  "scripts/repository-control-drift.ts";
