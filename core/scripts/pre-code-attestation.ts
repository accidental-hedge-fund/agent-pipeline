// Pre-code human attestation gate (#575) — pure logic shared by the stage
// handler: deterministic trigger evaluation, design-dossier validation,
// authorized-approver resolution, SoD, attestation currency, objective
// manifests, and contract-to-evidence traces.
// No network/git/subprocess calls anywhere in this file.

import { createHash } from "node:crypto";
import {
  DEFAULT_CONFIG,
  PRE_CODE_ATTESTATION_TRIGGER_CLASSES,
  type BehaviorDiffEntry,
  type BehavioralContract,
  type PipelineConfig,
  type PreCodeApproverRule,
  type PreCodeAttestationConfig,
  type PreCodeAttestationRecord,
  type PreCodeAttestationState,
  type PreCodeAuthzResolution,
  type PreCodeContractTraceRow,
  type PreCodeDesignDossier,
  type PreCodeObjectiveManifestEntry,
  type PreCodeSodRole,
  type PreCodeTriggerMatch,
  type PreCodeTriggerResult,
} from "./types.ts";

/** Resolve pre_code_attestation with defaults when test/partial configs omit the block. */
export function effectivePreCodeAttestation(
  cfg: Partial<Pick<PipelineConfig, "pre_code_attestation">> | Pick<PipelineConfig, "pre_code_attestation">,
): PreCodeAttestationConfig {
  return cfg.pre_code_attestation ?? DEFAULT_CONFIG.pre_code_attestation;
}

export const PRE_CODE_DOSSIER_SCHEMA_VERSION = 1 as const;
export const PRE_CODE_ATTESTATION_COMMENT_HEADING = "## Pre-Code Attestation";
export const PRE_CODE_DOSSIER_COMMENT_HEADING = "## Pre-Code Design Dossier";

// ---------------------------------------------------------------------------
// Glob helpers (aligned with design-gate)
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§§§")
    .replace(/\*\*/g, "¶¶¶")
    .replace(/\*/g, "[^/]*")
    .replace(/§§§/g, "(?:.*/)?")
    .replace(/¶¶¶/g, ".*");
  return new RegExp(`^${regexStr}$`, "i");
}

function matchesAnyGlob(filePath: string, patterns: string[]): string | null {
  for (const p of patterns) {
    try {
      if (globToRegExp(p).test(filePath)) return p;
    } catch {
      // malformed pattern never matches
    }
  }
  return null;
}

/** Built-in path globs per pre-code risk class. */
export const PRE_CODE_TRIGGER_GLOBS: Record<
  (typeof PRE_CODE_ATTESTATION_TRIGGER_CLASSES)[number],
  string[]
> = {
  architecture: [
    "**/architecture*.*",
    "**/architecture/**",
    "**/ARCHITECTURE.md",
    "**/design/**",
    "**/ADR/**",
    "**/adr/**",
  ],
  auth: [
    "**/*auth*.*",
    "**/*session*.*",
    "**/*token*.*",
    "**/*permission*.*",
    "**/*rbac*.*",
    "**/*credential*.*",
    "**/*oauth*.*",
  ],
  storage: [
    "**/*migration*.*",
    "**/*schema*.*",
    "**/models/**",
    "**/*.sql",
    "**/db/**",
    "**/database/**",
    "**/*repository*.*",
  ],
  migration: ["**/migrations/**", "**/*migration*.*", "**/*.sql"],
  "public-api": [
    "**/api/**",
    "**/*controller*.*",
    "**/routes/**",
    "**/*route*.*",
    "**/openapi*.*",
    "**/*.proto",
    "**/graphql/**",
  ],
  "large-diff": [],
};

// ---------------------------------------------------------------------------
// Policy hash
// ---------------------------------------------------------------------------

/** Stable hex digest of the effective attestation policy (for currency). */
export function hashPreCodeAttestationPolicy(
  cfg: Pick<PreCodeAttestationConfig, keyof PreCodeAttestationConfig> | PreCodeAttestationConfig,
): string {
  const material = {
    enabled: cfg.enabled,
    triggers: [...cfg.triggers].sort(),
    extra_triggers: Object.fromEntries(
      Object.keys(cfg.extra_triggers)
        .sort()
        .map((k) => [k, [...(cfg.extra_triggers[k] ?? [])].sort()]),
    ),
    thresholds: cfg.thresholds,
    expiration: {
      max_age_hours: cfg.expiration.max_age_hours,
      reapprove_on: [...cfg.expiration.reapprove_on].sort(),
    },
    approvers: cfg.approvers,
    separation_of_duties: {
      enabled: cfg.separation_of_duties.enabled,
      forbid_self_attest_roles: [...cfg.separation_of_duties.forbid_self_attest_roles].sort(),
    },
    wait: cfg.wait,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export function hashDossier(dossier: PreCodeDesignDossier): string {
  return createHash("sha256").update(stableStringify(dossier)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function hashObjectiveContent(contract: BehavioralContract): string {
  return createHash("sha256")
    .update(
      stableStringify({
        objective_id: contract.objective_id,
        preconditions: contract.preconditions,
        command_or_input: contract.command_or_input,
        expected_outcome: contract.expected_outcome,
        ownership_boundary: contract.ownership_boundary,
        failure_retry_concurrency: contract.failure_retry_concurrency ?? "",
        origin: contract.origin,
        verification: contract.verification,
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

export interface PreCodeTriggerInputs {
  labels: string[];
  /** Declared affected paths from plan/dossier surface. */
  declaredPaths: string[];
  /** Declared risk classes from plan/dossier (optional advisory). */
  declaredRiskClasses?: string[];
  /** Declared components (for ownership later; not required for trigger). */
  declaredComponents?: string[];
  estimatedFiles?: number | null;
  estimatedLoc?: number | null;
}

/**
 * Pure trigger evaluator (#575): no network/git/subprocess; identical output
 * for identical input.
 */
export function evaluatePreCodeAttestationTrigger(
  cfg: Partial<Pick<PipelineConfig, "pre_code_attestation">> | Pick<PipelineConfig, "pre_code_attestation">,
  inputs: PreCodeTriggerInputs,
): PreCodeTriggerResult {
  const pca = effectivePreCodeAttestation(cfg);
  if (!pca.enabled) {
    return { triggered: false, matched: [], reason: "gate-disabled" };
  }
  const armed = new Set(pca.triggers);
  const matched: PreCodeTriggerMatch[] = [];
  const labelSet = new Set(inputs.labels.map((l) => l.toLowerCase()));
  const declaredClasses = new Set(
    (inputs.declaredRiskClasses ?? []).map((c) => c.toLowerCase()),
  );

  for (const trigger of PRE_CODE_ATTESTATION_TRIGGER_CLASSES) {
    if (!armed.has(trigger)) continue;
    if (trigger === "large-diff") {
      const maxFiles = pca.thresholds.max_files;
      const maxLoc = pca.thresholds.max_loc;
      if (
        maxFiles != null &&
        inputs.estimatedFiles != null &&
        inputs.estimatedFiles > maxFiles
      ) {
        matched.push({
          trigger,
          evidence: `estimated_files ${inputs.estimatedFiles} exceeds max_files ${maxFiles}`,
        });
      }
      if (maxLoc != null && inputs.estimatedLoc != null && inputs.estimatedLoc > maxLoc) {
        matched.push({
          trigger,
          evidence: `estimated_loc ${inputs.estimatedLoc} exceeds max_loc ${maxLoc}`,
        });
      }
      // Label-based large-diff
      if (labelSet.has("large-diff") || labelSet.has("risk:large-diff")) {
        matched.push({ trigger, evidence: `issue label "large-diff"` });
      }
      continue;
    }

    const globs = [
      ...(PRE_CODE_TRIGGER_GLOBS[trigger] ?? []),
      ...(pca.extra_triggers[trigger] ?? []),
    ];
    for (const file of inputs.declaredPaths) {
      const g = matchesAnyGlob(file, globs);
      if (g) {
        matched.push({
          trigger,
          evidence: `path "${file}" matched glob "${g}"`,
        });
      }
    }
    if (labelSet.has(trigger) || labelSet.has(`risk:${trigger}`)) {
      matched.push({ trigger, evidence: `issue label "${trigger}"` });
    }
    if (declaredClasses.has(trigger)) {
      matched.push({
        trigger,
        evidence: `declared risk class "${trigger}" on plan/dossier surface`,
      });
    }
  }

  // Repository-specific extra_triggers with free-form class names
  for (const [className, globs] of Object.entries(pca.extra_triggers)) {
    if ((PRE_CODE_ATTESTATION_TRIGGER_CLASSES as readonly string[]).includes(className)) {
      continue; // already handled above when armed
    }
    // Free-form classes only match via extra_triggers (always "armed" when listed)
    for (const file of inputs.declaredPaths) {
      const g = matchesAnyGlob(file, globs);
      if (g) {
        matched.push({
          trigger: className,
          evidence: `path "${file}" matched extra_trigger glob "${g}"`,
        });
      }
    }
    if (labelSet.has(className.toLowerCase()) || labelSet.has(`risk:${className.toLowerCase()}`)) {
      matched.push({ trigger: className, evidence: `issue label "${className}"` });
    }
    for (const g of globs) {
      // label glob: treat exact label match if pattern has no path separators
      if (!g.includes("/") && !g.includes("*") && labelSet.has(g.toLowerCase())) {
        matched.push({
          trigger: className,
          evidence: `issue label "${g}" via extra_triggers`,
        });
      }
    }
  }

  if (matched.length === 0) {
    return { triggered: false, matched: [], reason: "no-trigger-matched" };
  }
  return { triggered: true, matched, reason: "triggered" };
}

// ---------------------------------------------------------------------------
// Dossier validation
// ---------------------------------------------------------------------------

export interface DossierValidation {
  ok: boolean;
  errors: string[];
  dossier?: PreCodeDesignDossier;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseVerification(raw: unknown): BehavioralContract["verification"] | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "ref" && isNonEmptyString(o.ref)) return { kind: "ref", ref: o.ref };
  if (o.kind === "untestable" && isNonEmptyString(o.reason)) {
    const reason = o.reason.startsWith("Untestable:") ? o.reason : `Untestable: ${o.reason}`;
    return { kind: "untestable", reason };
  }
  // Convenience: string verification ref or Untestable: reason
  if (typeof o === "string") {
    // unreachable — object check above
  }
  return null;
}

function parseVerificationLoose(raw: unknown): BehavioralContract["verification"] | null {
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (/^untestable:/i.test(s)) {
      return { kind: "untestable", reason: s.startsWith("Untestable:") ? s : `Untestable: ${s.slice(s.indexOf(":") + 1).trim()}` };
    }
    return { kind: "ref", ref: s };
  }
  return parseVerification(raw);
}

function parseBehaviorDiff(raw: unknown, path: string, errors: string[]): BehaviorDiffEntry | null {
  if (!raw || typeof raw !== "object") {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (op !== "addition" && op !== "change" && op !== "removal") {
    errors.push(`${path}.op: must be addition|change|removal (got ${JSON.stringify(op)})`);
    return null;
  }
  if (!isNonEmptyString(o.target)) {
    errors.push(`${path}.target: required non-empty string`);
    return null;
  }
  return {
    op,
    target: o.target.trim(),
    summary: isNonEmptyString(o.summary) ? o.summary : undefined,
  };
}

function parseBehavioralContract(
  raw: unknown,
  path: string,
  errors: string[],
): BehavioralContract | null {
  if (!raw || typeof raw !== "object") {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.objective_id)) {
    errors.push(`${path}.objective_id: required`);
    return null;
  }
  if (!isNonEmptyString(o.preconditions)) {
    errors.push(`${path}.preconditions: required`);
    return null;
  }
  if (!isNonEmptyString(o.command_or_input) && !isNonEmptyString(o.command) && !isNonEmptyString(o.input)) {
    errors.push(`${path}.command_or_input: required`);
    return null;
  }
  if (
    !isNonEmptyString(o.expected_outcome) &&
    !isNonEmptyString(o.expected_state) &&
    !isNonEmptyString(o.expected_output)
  ) {
    errors.push(`${path}.expected_outcome: required`);
    return null;
  }
  if (!isNonEmptyString(o.ownership_boundary)) {
    errors.push(`${path}.ownership_boundary: required`);
    return null;
  }
  if (o.origin !== "stated" && o.origin !== "derived") {
    errors.push(`${path}.origin: must be stated|derived`);
    return null;
  }
  const verification = parseVerificationLoose(o.verification);
  if (!verification) {
    errors.push(`${path}.verification: required ref or Untestable: reason`);
    return null;
  }
  let derived_disposition: BehavioralContract["derived_disposition"];
  if (o.origin === "derived") {
    if (o.derived_disposition === "accept" || o.derived_disposition === "reject" || o.derived_disposition === "pending") {
      derived_disposition = o.derived_disposition;
    } else if (o.derived_disposition === undefined) {
      derived_disposition = "pending";
    } else {
      errors.push(`${path}.derived_disposition: must be accept|reject|pending`);
      return null;
    }
  }
  return {
    objective_id: String(o.objective_id).trim(),
    preconditions: String(o.preconditions).trim(),
    command_or_input: String(o.command_or_input ?? o.command ?? o.input).trim(),
    expected_outcome: String(o.expected_outcome ?? o.expected_state ?? o.expected_output).trim(),
    ownership_boundary: String(o.ownership_boundary).trim(),
    failure_retry_concurrency: isNonEmptyString(o.failure_retry_concurrency)
      ? o.failure_retry_concurrency
      : isNonEmptyString(o.failure_notes)
        ? o.failure_notes
        : undefined,
    origin: o.origin,
    verification,
    derived_disposition,
  };
}

/**
 * Validate a candidate design dossier. Malformed dossiers are not eligible
 * for attestation.
 */
export function validatePreCodeDesignDossier(candidate: unknown): DossierValidation {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, errors: ["dossier must be an object"] };
  }
  const o = candidate as Record<string, unknown>;
  if (o.schema_version !== 1 && o.schema_version !== "1") {
    errors.push("schema_version must be 1");
  }
  if (!isNonEmptyString(o.intent)) errors.push("intent: required");
  if (!isNonEmptyString(o.system_boundary)) errors.push("system_boundary: required");
  if (!isNonEmptyString(o.interaction_sequence)) errors.push("interaction_sequence: required");

  const uiFacing = o.ui_facing === true;
  if (uiFacing) {
    if (!isNonEmptyString(o.ui_mockup) && !isNonEmptyString(o.ui_mockup_exception)) {
      errors.push("ui_facing work requires ui_mockup or ui_mockup_exception");
    }
  }

  let file_tree: string[] = [];
  let call_stack: string | undefined;
  if (!o.expected_delta || typeof o.expected_delta !== "object") {
    errors.push("expected_delta: required object");
  } else {
    const ed = o.expected_delta as Record<string, unknown>;
    if (Array.isArray(ed.file_tree)) {
      file_tree = ed.file_tree.filter((p): p is string => typeof p === "string");
    } else if (isNonEmptyString(ed.file_tree)) {
      file_tree = ed.file_tree.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    } else {
      errors.push("expected_delta.file_tree: required");
    }
    if (isNonEmptyString(ed.call_stack)) call_stack = ed.call_stack;
  }

  let key_contracts: string[] = [];
  if (Array.isArray(o.key_contracts)) {
    key_contracts = o.key_contracts.filter((c): c is string => typeof c === "string");
  } else if (isNonEmptyString(o.key_contracts)) {
    key_contracts = [o.key_contracts];
  } else {
    errors.push("key_contracts: required non-empty array");
  }
  if (key_contracts.length === 0 && !errors.some((e) => e.startsWith("key_contracts"))) {
    errors.push("key_contracts: must include at least one entry");
  }

  if (!Array.isArray(o.slices) || o.slices.length === 0) {
    errors.push("slices: required non-empty array");
  }

  const slices: PreCodeDesignDossier["slices"] = [];
  if (Array.isArray(o.slices)) {
    o.slices.forEach((sliceRaw, i) => {
      const sp = `slices[${i}]`;
      if (!sliceRaw || typeof sliceRaw !== "object") {
        errors.push(`${sp}: must be an object`);
        return;
      }
      const s = sliceRaw as Record<string, unknown>;
      if (!isNonEmptyString(s.id)) errors.push(`${sp}.id: required`);
      if (!isNonEmptyString(s.title)) errors.push(`${sp}.title: required`);
      if (!Array.isArray(s.behavior_diff) || s.behavior_diff.length === 0) {
        errors.push(`${sp}.behavior_diff: required non-empty array`);
      }
      if (!Array.isArray(s.behaviors) || s.behaviors.length === 0) {
        errors.push(`${sp}.behaviors: required non-empty array`);
      }
      const diffs: BehaviorDiffEntry[] = [];
      if (Array.isArray(s.behavior_diff)) {
        s.behavior_diff.forEach((d, j) => {
          const parsed = parseBehaviorDiff(d, `${sp}.behavior_diff[${j}]`, errors);
          if (parsed) diffs.push(parsed);
        });
      }
      const behaviors: BehavioralContract[] = [];
      if (Array.isArray(s.behaviors)) {
        s.behaviors.forEach((b, j) => {
          const parsed = parseBehavioralContract(b, `${sp}.behaviors[${j}]`, errors);
          if (parsed) behaviors.push(parsed);
        });
      }
      // Happy-path check: at least one behavior without failure-only title cue is fine;
      // require at least one behavior (already enforced). Soft note only.
      if (isNonEmptyString(s.id) && isNonEmptyString(s.title) && diffs.length && behaviors.length) {
        slices.push({
          id: s.id.trim(),
          title: s.title.trim(),
          behavior_diff: diffs,
          behaviors,
        });
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };

  const dossier: PreCodeDesignDossier = {
    schema_version: 1,
    intent: String(o.intent).trim(),
    ui_facing: uiFacing || undefined,
    ui_mockup: isNonEmptyString(o.ui_mockup) ? o.ui_mockup : undefined,
    ui_mockup_exception: isNonEmptyString(o.ui_mockup_exception) ? o.ui_mockup_exception : undefined,
    system_boundary: String(o.system_boundary).trim(),
    interaction_sequence: String(o.interaction_sequence).trim(),
    expected_delta: { call_stack, file_tree },
    key_contracts,
    slices,
    dossier_author: isNonEmptyString(o.dossier_author) ? o.dossier_author : undefined,
    declared_risk_classes: Array.isArray(o.declared_risk_classes)
      ? o.declared_risk_classes.filter((c): c is string => typeof c === "string")
      : undefined,
    declared_components: Array.isArray(o.declared_components)
      ? o.declared_components.filter((c): c is string => typeof c === "string")
      : undefined,
    estimated_files: typeof o.estimated_files === "number" ? o.estimated_files : undefined,
    estimated_loc: typeof o.estimated_loc === "number" ? o.estimated_loc : undefined,
  };
  return { ok: true, errors: [], dossier };
}

/**
 * Whether a validated dossier is eligible for approve (derived pending blocks).
 */
export function dossierApprovalEligibility(
  dossier: PreCodeDesignDossier,
  derivedDispositions?: Record<string, "accept" | "reject">,
): { eligible: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const slice of dossier.slices) {
    for (const b of slice.behaviors) {
      if (b.origin === "derived") {
        const d =
          derivedDispositions?.[b.objective_id] ??
          (b.derived_disposition === "accept" || b.derived_disposition === "reject"
            ? b.derived_disposition
            : "pending");
        if (d === "pending") {
          errors.push(`derived behavior ${b.objective_id} has pending disposition`);
        }
      }
    }
  }
  return { eligible: errors.length === 0, errors };
}

/**
 * Build approved objective manifest: accepted contracts only (rejects excluded).
 */
export function buildObjectiveManifest(
  dossier: PreCodeDesignDossier,
  opts: {
    derivedDispositions?: Record<string, "accept" | "reject">;
    untestableAffirmations?: string[];
  } = {},
): PreCodeObjectiveManifestEntry[] {
  const out: PreCodeObjectiveManifestEntry[] = [];
  const affirmed = new Set(opts.untestableAffirmations ?? []);
  for (const slice of dossier.slices) {
    for (const b of slice.behaviors) {
      if (b.origin === "derived") {
        const d =
          opts.derivedDispositions?.[b.objective_id] ??
          (b.derived_disposition === "accept" || b.derived_disposition === "reject"
            ? b.derived_disposition
            : "pending");
        if (d !== "accept") continue;
      }
      out.push({
        objective_id: b.objective_id,
        content_hash: hashObjectiveContent(b),
        origin: b.origin,
        verification: b.verification,
        untestable_affirmed:
          b.verification.kind === "untestable" ? affirmed.has(b.objective_id) : undefined,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approver resolution + SoD
// ---------------------------------------------------------------------------

export interface IdentityAdapter {
  /** Resolve group_ref → member identity strings. */
  resolveGroupMembers?(groupRef: string): string[] | Promise<string[]>;
  /** Resolve whether actor holds repository role. */
  actorHasRole?(actor: string, role: string): boolean | Promise<boolean>;
  /**
   * Optional path owners (CODEOWNERS-like). When absent, path_owner rules
   * cannot authorize anyone for unmatched paths.
   */
  ownersForPath?(path: string): string[] | Promise<string[]>;
}

export interface ApproverResolutionInput {
  actor: string;
  authenticated: boolean;
  identitySource: string;
  affectedPaths: string[];
  affectedComponents: string[];
  matchedRiskClasses: string[];
  rules: PreCodeApproverRule[];
  adapter?: IdentityAdapter;
}

export interface ApproverResolutionResult {
  authorized: boolean;
  resolutions: PreCodeAuthzResolution[];
  unresolved: boolean;
  matchedRuleIds: string[];
}

function ruleCoversPath(rule: PreCodeApproverRule, path: string): boolean {
  const paths = "paths" in rule && rule.paths && rule.paths.length > 0 ? rule.paths : null;
  if (!paths) return true;
  return matchesAnyGlob(path, paths) != null;
}

function ruleCoversRisk(rule: PreCodeApproverRule, risk: string): boolean {
  const classes =
    "risk_classes" in rule && rule.risk_classes && rule.risk_classes.length > 0
      ? rule.risk_classes
      : null;
  if (!classes) return true;
  return classes.map((c) => c.toLowerCase()).includes(risk.toLowerCase());
}

function ruleId(rule: PreCodeApproverRule, index: number): string {
  switch (rule.kind) {
    case "identity":
      return `identity:${rule.identity}#${index}`;
    case "group_ref":
      return `group_ref:${rule.group_ref}#${index}`;
    case "role":
      return `role:${rule.role}#${index}`;
    case "path_owner":
      return `path_owner#${index}`;
    case "risk_class":
      return `risk_class:${rule.risk_classes.join(",")}#${index}`;
  }
}

/**
 * Deterministic approver resolution over injectable adapters.
 * Requires coverage of every (component/path × risk class) obligation.
 */
export async function resolveAuthorizedApprover(
  input: ApproverResolutionInput,
): Promise<ApproverResolutionResult> {
  const paths =
    input.affectedPaths.length > 0
      ? input.affectedPaths
      : input.affectedComponents.length > 0
        ? input.affectedComponents
        : ["*"];
  const risks =
    input.matchedRiskClasses.length > 0 ? input.matchedRiskClasses : ["*"];

  const resolutions: PreCodeAuthzResolution[] = [];
  const matchedRuleIds: string[] = [];
  let unresolved = false;

  for (const path of paths) {
    for (const risk of risks) {
      let covered = false;
      let anyRuleForScope = false;
      let matched: string | undefined;
      let evidence = "no matching rule";

      for (let i = 0; i < input.rules.length; i++) {
        const rule = input.rules[i]!;
        if (!ruleCoversPath(rule, path) || !ruleCoversRisk(rule, risk)) continue;
        // risk_class alone is a scope filter, not an authorizer
        if (rule.kind === "risk_class") continue;
        anyRuleForScope = true;
        const id = ruleId(rule, i);

        if (rule.kind === "identity") {
          if (
            input.authenticated &&
            input.actor.toLowerCase() === rule.identity.toLowerCase()
          ) {
            covered = true;
            matched = id;
            evidence = `identity match for actor ${input.actor}`;
            if (!matchedRuleIds.includes(id)) matchedRuleIds.push(id);
            break;
          }
        } else if (rule.kind === "group_ref") {
          const members = input.adapter?.resolveGroupMembers
            ? await input.adapter.resolveGroupMembers(rule.group_ref)
            : [];
          if (
            input.authenticated &&
            members.some((m) => m.toLowerCase() === input.actor.toLowerCase())
          ) {
            covered = true;
            matched = id;
            evidence = `group_ref ${rule.group_ref} membership for ${input.actor}`;
            if (!matchedRuleIds.includes(id)) matchedRuleIds.push(id);
            break;
          }
        } else if (rule.kind === "role") {
          const has = input.adapter?.actorHasRole
            ? await input.adapter.actorHasRole(input.actor, rule.role)
            : false;
          if (input.authenticated && has) {
            covered = true;
            matched = id;
            evidence = `role ${rule.role} for ${input.actor}`;
            if (!matchedRuleIds.includes(id)) matchedRuleIds.push(id);
            break;
          }
        } else if (rule.kind === "path_owner") {
          const owners = input.adapter?.ownersForPath
            ? await input.adapter.ownersForPath(path)
            : [];
          if (
            input.authenticated &&
            owners.some((o) => o.toLowerCase() === input.actor.toLowerCase())
          ) {
            covered = true;
            matched = id;
            evidence = `path_owner of ${path} includes ${input.actor}`;
            if (!matchedRuleIds.includes(id)) matchedRuleIds.push(id);
            break;
          }
        }
      }

      if (!anyRuleForScope) {
        unresolved = true;
        resolutions.push({
          component: path,
          risk_class: risk,
          authorized: false,
          evidence: "unresolved ownership: no approver rule covers this obligation",
        });
      } else {
        resolutions.push({
          component: path,
          risk_class: risk,
          authorized: covered,
          matched_rule: matched,
          evidence,
        });
      }
    }
  }

  const authorized =
    input.authenticated &&
    !unresolved &&
    resolutions.length > 0 &&
    resolutions.every((r) => r.authorized);

  return { authorized, resolutions, unresolved, matchedRuleIds };
}

export interface SodCheckInput {
  enabled: boolean;
  forbidRoles: PreCodeSodRole[];
  actor: string;
  implementer?: string | null;
  dossierAuthor?: string | null;
}

export interface SodCheckResult {
  ok: boolean;
  violatedRoles: PreCodeSodRole[];
  reason?: string;
}

export function checkSeparationOfDuties(input: SodCheckInput): SodCheckResult {
  if (!input.enabled) return { ok: true, violatedRoles: [] };
  const violated: PreCodeSodRole[] = [];
  const actor = input.actor.toLowerCase();
  if (
    input.forbidRoles.includes("implementer") &&
    input.implementer &&
    input.implementer.toLowerCase() === actor
  ) {
    violated.push("implementer");
  }
  if (
    input.forbidRoles.includes("dossier_author") &&
    input.dossierAuthor &&
    input.dossierAuthor.toLowerCase() === actor
  ) {
    violated.push("dossier_author");
  }
  if (violated.length > 0) {
    return {
      ok: false,
      violatedRoles: violated,
      reason: `separation of duties forbids self-attest for roles: ${violated.join(", ")}`,
    };
  }
  return { ok: true, violatedRoles: [] };
}

// ---------------------------------------------------------------------------
// Attestation currency + bypass resistance
// ---------------------------------------------------------------------------

export interface AttestationCurrencyInput {
  record: PreCodeAttestationRecord;
  currentDossierHash: string;
  currentPolicyHash: string;
  currentScope?: {
    components: string[];
    risk_classes: string[];
  };
  nowMs: number;
  reapproveOn: PreCodeAttestationConfig["expiration"]["reapprove_on"];
}

export type AttestationCurrencyStatus =
  | { current: true }
  | { current: false; reason: string };

export function evaluateAttestationCurrency(
  input: AttestationCurrencyInput,
): AttestationCurrencyStatus {
  const { record } = input;
  if (record.decision !== "approve") {
    return { current: false, reason: "decision is not approve" };
  }
  if (record.expires_at) {
    const exp = Date.parse(record.expires_at);
    if (Number.isFinite(exp) && input.nowMs > exp) {
      return { current: false, reason: "attestation expired" };
    }
  }
  if (
    input.reapproveOn.includes("dossier_change") &&
    record.dossier_hash !== input.currentDossierHash
  ) {
    return { current: false, reason: "dossier hash mismatch" };
  }
  if (
    input.reapproveOn.includes("policy_change") &&
    record.policy_hash !== input.currentPolicyHash
  ) {
    return { current: false, reason: "policy hash mismatch" };
  }
  if (input.reapproveOn.includes("scope_change") && input.currentScope) {
    const a = [...record.scope.risk_classes].map((s) => s.toLowerCase()).sort().join(",");
    const b = [...input.currentScope.risk_classes].map((s) => s.toLowerCase()).sort().join(",");
    const c = [...record.scope.components].map((s) => s.toLowerCase()).sort().join(",");
    const d = [...input.currentScope.components].map((s) => s.toLowerCase()).sort().join(",");
    if (a !== b || c !== d) {
      return { current: false, reason: "scope/risk classification changed" };
    }
  }
  return { current: true };
}

/**
 * Reject silent approve paths: unauthenticated, agent plan-review only,
 * markers-only, or model prose without a structured attestation record.
 */
export function isSilentBypassAttempt(input: {
  hasStructuredAttestation: boolean;
  authenticated: boolean;
  agentPlanReviewApproved?: boolean;
  modelProseClaimsApproval?: boolean;
  markerOnly?: boolean;
}): { bypass: boolean; reason?: string } {
  if (input.hasStructuredAttestation && input.authenticated) {
    return { bypass: false };
  }
  if (input.agentPlanReviewApproved && !input.hasStructuredAttestation) {
    return { bypass: true, reason: "agent plan-review approve is insufficient" };
  }
  if (input.modelProseClaimsApproval && !input.hasStructuredAttestation) {
    return { bypass: true, reason: "model prose claiming approval is insufficient" };
  }
  if (input.markerOnly && !input.hasStructuredAttestation) {
    return { bypass: true, reason: "pipeline markers alone are insufficient" };
  }
  if (!input.authenticated) {
    return { bypass: true, reason: "unauthenticated actor cannot approve" };
  }
  if (!input.hasStructuredAttestation) {
    return { bypass: true, reason: "no structured attestation record" };
  }
  return { bypass: false };
}

export interface BuildApproveRecordInput {
  actor: string;
  identitySource: string;
  resolution: ApproverResolutionResult;
  dossierHash: string;
  policyHash: string;
  scope: PreCodeAttestationRecord["scope"];
  maxAgeHours: number;
  nowMs: number;
  untestableAffirmations?: string[];
  derivedDispositions?: Record<string, "accept" | "reject">;
}

export function buildApproveAttestationRecord(
  input: BuildApproveRecordInput,
): PreCodeAttestationRecord {
  const timestamp = new Date(input.nowMs).toISOString();
  const expires_at = new Date(
    input.nowMs + input.maxAgeHours * 3600_000,
  ).toISOString();
  return {
    actor: input.actor,
    identity_source: input.identitySource,
    authorized_rules: input.resolution.matchedRuleIds,
    resolution_evidence: input.resolution.resolutions,
    timestamp,
    expires_at,
    scope: input.scope,
    decision: "approve",
    dossier_hash: input.dossierHash,
    policy_hash: input.policyHash,
    untestable_affirmations: input.untestableAffirmations,
    derived_dispositions: input.derivedDispositions,
    evidence_subject: {
      policy_hash: input.policyHash,
      dossier_hash: input.dossierHash,
    },
  };
}

export function buildRejectAttestationRecord(input: {
  actor: string;
  identitySource: string;
  dossierHash: string;
  policyHash: string;
  scope: PreCodeAttestationRecord["scope"];
  nowMs: number;
  resolution?: ApproverResolutionResult;
}): PreCodeAttestationRecord {
  return {
    actor: input.actor,
    identity_source: input.identitySource,
    authorized_rules: input.resolution?.matchedRuleIds ?? [],
    resolution_evidence: input.resolution?.resolutions ?? [],
    timestamp: new Date(input.nowMs).toISOString(),
    scope: input.scope,
    decision: "reject",
    dossier_hash: input.dossierHash,
    policy_hash: input.policyHash,
    evidence_subject: {
      policy_hash: input.policyHash,
      dossier_hash: input.dossierHash,
    },
  };
}

// ---------------------------------------------------------------------------
// Untestable affirmation + contract traces
// ---------------------------------------------------------------------------

export function requireUntestableAffirmations(
  dossier: PreCodeDesignDossier,
  affirmations: string[] | undefined,
): { ok: boolean; missing: string[] } {
  const needed: string[] = [];
  for (const slice of dossier.slices) {
    for (const b of slice.behaviors) {
      if (b.verification.kind === "untestable") needed.push(b.objective_id);
    }
  }
  // Only for behaviors that will be accepted (stated + accepted derived)
  const affirmed = new Set((affirmations ?? []).map((s) => s.trim()));
  const missing = needed.filter((id) => !affirmed.has(id));
  return { ok: missing.length === 0, missing };
}

export function buildContractTraces(
  objectives: PreCodeObjectiveManifestEntry[],
  verificationResults?: Record<string, { verified: boolean; evidence_ref?: string }>,
): PreCodeContractTraceRow[] {
  return objectives.map((o) => {
    if (o.verification.kind === "untestable") {
      return {
        objective_id: o.objective_id,
        content_hash: o.content_hash,
        status: "unverified_exception" as const,
        evidence_ref: o.verification.reason,
      };
    }
    const vr = verificationResults?.[o.objective_id];
    if (vr?.verified) {
      return {
        objective_id: o.objective_id,
        content_hash: o.content_hash,
        status: "verified" as const,
        evidence_ref: vr.evidence_ref ?? o.verification.ref,
      };
    }
    return {
      objective_id: o.objective_id,
      content_hash: o.content_hash,
      status: "missing" as const,
      evidence_ref: o.verification.ref,
    };
  });
}

/** Fail-safe readiness: any missing required verification fails. */
export function contractTracesFailSafe(traces: PreCodeContractTraceRow[]): {
  ok: boolean;
  missing: string[];
} {
  const missing = traces.filter((t) => t.status === "missing").map((t) => t.objective_id);
  return { ok: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// Parse dossier / attestation from plan surface or comments
// ---------------------------------------------------------------------------

function extractJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    blocks.push(m[1]!.trim());
  }
  // Also try raw JSON object containing schema_version
  const idx = text.indexOf('"schema_version"');
  if (idx >= 0) {
    const start = text.lastIndexOf("{", idx);
    if (start >= 0) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            blocks.push(text.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }
  return blocks;
}

export function parseDossierFromText(text: string): DossierValidation {
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as unknown;
      if (parsed && typeof parsed === "object" && "slices" in (parsed as object)) {
        const v = validatePreCodeDesignDossier(parsed);
        if (v.ok) return v;
      }
    } catch {
      // try next
    }
  }
  return { ok: false, errors: ["no valid pre-code design dossier found in text"] };
}

export function parseAttestationFromText(text: string): PreCodeAttestationRecord | null {
  for (const block of extractJsonBlocks(text)) {
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>;
      if (
        parsed &&
        (parsed.decision === "approve" || parsed.decision === "reject") &&
        typeof parsed.actor === "string" &&
        typeof parsed.dossier_hash === "string" &&
        typeof parsed.policy_hash === "string"
      ) {
        return parsed as unknown as PreCodeAttestationRecord;
      }
    } catch {
      // next
    }
  }
  return null;
}

/** Extract declared paths from plan text (naive path-like tokens). */
export function extractDeclaredPathsFromPlan(plan: string): string[] {
  const paths = new Set<string>();
  const re =
    /(?:^|[\s`"'(])((?:[\w.-]+\/)+[\w.-]+\.[\w]+)(?=[\s`"',)]|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plan)) !== null) {
    paths.add(m[1]!);
  }
  // Also `path/to/file` style without extension for directories
  const re2 = /(?:^|[\s`"'(])((?:core|src|lib|app|packages|services)\/[\w./-]+)/gm;
  while ((m = re2.exec(plan)) !== null) {
    paths.add(m[1]!.replace(/[.,;:]+$/, ""));
  }
  return [...paths];
}

export function emptyPreCodeState(
  trigger: PreCodeTriggerResult,
  policyHash: string,
  outcome: PreCodeAttestationState["outcome"],
): PreCodeAttestationState {
  return {
    schema_version: 1,
    enabled: trigger.reason !== "gate-disabled",
    trigger,
    policy_hash: policyHash,
    dossier_hash: null,
    dossier: null,
    objectives: [],
    attestations: [],
    authorization_summary: null,
    outcome,
    traces: [],
  };
}

export function waitExhaustedOutcome(
  mode: PreCodeAttestationConfig["wait"]["mode"],
): "wait-exhausted-resume-safe" | "wait-exhausted-hard-block" {
  return mode === "hard_block" ? "wait-exhausted-hard-block" : "wait-exhausted-resume-safe";
}

export function isWaitBudgetExhausted(input: {
  waitStartedAt: string | undefined;
  maxWaitHours: number | null;
  nowMs: number;
}): boolean {
  if (input.maxWaitHours == null || !input.waitStartedAt) return false;
  const start = Date.parse(input.waitStartedAt);
  if (!Number.isFinite(start)) return false;
  return input.nowMs - start > input.maxWaitHours * 3600_000;
}
