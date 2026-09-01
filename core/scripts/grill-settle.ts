// Engine-owned auto-settle + typed-request classification (#1369).
// Pure: models propose; this predicate decides.

import {
  AUTO_ACCEPT_ELIGIBILITY_REASON,
  classifyAuthority,
  isGrillTaxonomyClass,
} from "./grill-taxonomy.ts";
import type { TypedRequestKind } from "./grill-decisions.ts";
import type { HandoffClass } from "./human-question-handoff.ts";

export interface SettlementSignals {
  reversible: boolean;
  in_scope: boolean;
  policy_consistent: boolean;
  covered_by_existing_authority: boolean;
  contradictory: boolean;
  missing_external: boolean;
  discoverable_from_facts: boolean;
  protected_action: boolean;
  confidence: "low" | "medium" | "high";
}

export type SettlementResult =
  | { kind: "auto-accept"; eligibility_reason: string }
  | { kind: "typed-request"; request: TypedRequestKind; handoff_class: HandoffClass; reason: string }
  | { kind: "unresolved"; reason: string };

const PROTECTED_CLASSES = new Set([
  "security",
  "irreversible-operations",
  "merge-release",
  "human-attestation",
]);

/** Action tokens that are protected on their own. Token absence is not proof of safety. */
const PROTECTED_ACTION_TOKENS: ReadonlySet<string> = new Set([
  "merge",
  "merging",
  "merged",
  "merger",
  "deploy",
  "deploying",
  "deployment",
  "ship",
  "shipping",
  "irreversible",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "password",
  "passwords",
  "rbac",
  "auth",
  "authentication",
  "authorization",
  "authenticate",
  "automerge",
  "squash",
  "bypass",
  "bypassing",
  "bypassed",
  "weaken",
  "weakening",
  "weakened",
  "destroy",
  "destroying",
  "destroyed",
  "wipe",
  "wiping",
  "wiped",
]);

/** Release-as-action tokens. Documentation of release notes is not this class. */
const RELEASE_ACTION_TOKENS: ReadonlySet<string> = new Set([
  "release",
  "releasing",
  "released",
]);

const RELEASE_NOTES_TOKENS: ReadonlySet<string> = new Set([
  "notes",
  "changelog",
  "readme",
]);

/** Adjacent-token phrases the single-token set does not cover on its own. */
const PROTECTED_PAIRS: readonly [string, string][] = [
  ["force", "push"],
  ["auto", "merge"],
  ["delete", "branch"],
  ["remove", "branch"],
  ["delete", "worktree"],
  ["remove", "worktree"],
  ["drop", "database"],
  ["drop", "table"],
  ["drop", "data"],
  ["grant", "merge"],
  ["grant", "release"],
  ["grant", "deploy"],
  ["disable", "auth"],
  ["disable", "authentication"],
  ["disable", "authorization"],
  ["skip", "auth"],
  ["skip", "authentication"],
  ["expose", "secret"],
  ["leak", "secret"],
  ["commit", "secret"],
  ["expose", "credential"],
  ["disable", "rbac"],
];

const ACCESS_ACTORS: ReadonlySet<string> = new Set([
  "anyone",
  "anybody",
  "anonymous",
  "unauthenticated",
  "everyone",
  "world",
]);

const ACCESS_VERBS: ReadonlySet<string> = new Set([
  "allow",
  "allows",
  "allowed",
  "permit",
  "permits",
  "permitted",
  "grant",
  "grants",
  "granted",
  "authorize",
  "authorizes",
  "authorized",
  "open",
  "opens",
  "expose",
  "exposes",
  "enable",
  "enables",
]);

const GRANT_REVOKE: ReadonlySet<string> = new Set([
  "grant",
  "grants",
  "granted",
  "revoke",
  "revokes",
  "revoked",
  "deny",
  "denies",
  "denied",
]);

const PERMISSION_OBJECTS: ReadonlySet<string> = new Set([
  "permission",
  "permissions",
  "role",
  "roles",
  "privilege",
  "privileges",
  "rbac",
  "acl",
  "entitlement",
  "entitlements",
]);

const ADMIN_OBJECTS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "admins",
  "root",
  "superuser",
]);

const ACCESS_OBJECTS: ReadonlySet<string> = new Set(["api", "access", "endpoint"]);

const PUBLIC_ACTORS: ReadonlySet<string> = new Set(["public", "anonymous"]);

const FACT_STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "is",
  "be",
  "are",
  "was",
  "were",
  "that",
  "this",
  "it",
  "its",
  "use",
  "using",
  "used",
  "via",
  "into",
  "than",
]);

function tokenizeRecommendation(recommendation: string): string[] {
  return recommendation
    .toLowerCase()
    .replace(/--/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function hasPairWithin(
  tokens: readonly string[],
  a: string,
  b: string,
  window = 3,
): boolean {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== a) continue;
    for (let j = i + 1; j < tokens.length && j <= i + window; j++) {
      if (tokens[j] === b) return true;
    }
  }
  return false;
}

function hasSetPairWithin(
  tokens: readonly string[],
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  window = 8,
): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    const aLeft = left.has(a);
    const aRight = right.has(a);
    if (!aLeft && !aRight) continue;
    for (let j = i + 1; j < tokens.length && j <= i + window; j++) {
      const b = tokens[j]!;
      if (aLeft && right.has(b)) return true;
      if (aRight && left.has(b)) return true;
    }
  }
  return false;
}

function recommendationMatchesAccessControl(tokens: readonly string[]): boolean {
  if (hasSetPairWithin(tokens, ACCESS_VERBS, ACCESS_ACTORS)) return true;
  if (hasSetPairWithin(tokens, ACCESS_ACTORS, ADMIN_OBJECTS)) return true;
  if (hasSetPairWithin(tokens, ACCESS_ACTORS, ACCESS_OBJECTS)) return true;
  if (hasSetPairWithin(tokens, GRANT_REVOKE, PERMISSION_OBJECTS)) return true;
  if (hasSetPairWithin(tokens, PUBLIC_ACTORS, ADMIN_OBJECTS)) return true;
  if (hasPairWithin(tokens, "policy", "exception", 4) || hasPairWithin(tokens, "exception", "policy", 4)) {
    return true;
  }
  if (hasPairWithin(tokens, "policy", "exceptions", 4) || hasPairWithin(tokens, "exceptions", "policy", 4)) {
    return true;
  }
  return false;
}

function isReleaseNotesDocumentation(tokens: readonly string[]): boolean {
  return (
    tokens.some((t) => RELEASE_ACTION_TOKENS.has(t)) &&
    tokens.some((t) => RELEASE_NOTES_TOKENS.has(t))
  );
}

/**
 * Engine-owned fail-closed scan. Class labels and keyword absence are not
 * sufficient. Access-control changes are protected even without listed verbs
 * such as auth/merge/deploy.
 */
export function recommendationMatchesProtectedAction(recommendation: string): boolean {
  const rec = recommendation.trim();
  if (!rec) return false;
  const tokens = tokenizeRecommendation(rec);
  if (recommendationMatchesAccessControl(tokens)) return true;
  if (PROTECTED_PAIRS.some(([a, b]) => hasPairWithin(tokens, a, b))) return true;
  if (tokens.some((t) => PROTECTED_ACTION_TOKENS.has(t))) return true;
  if (!isReleaseNotesDocumentation(tokens) && tokens.some((t) => RELEASE_ACTION_TOKENS.has(t))) {
    return true;
  }
  return false;
}

function contentTokens(text: string): string[] {
  return tokenizeRecommendation(text).filter((t) => !FACT_STOPWORDS.has(t) && t.length > 1);
}

/**
 * Trusted-fact coverage. Exact substring or every content token of the
 * recommendation already present in gathered facts. Empty input fails closed.
 */
export function factsCoverRecommendation(recommendation: string, factText: string): boolean {
  const rec = recommendation.trim();
  const facts = factText.trim();
  if (!rec || !facts) return false;
  if (facts.toLowerCase().includes(rec.toLowerCase())) return true;
  const recTokens = contentTokens(rec);
  if (recTokens.length === 0) return false;
  const factSet = new Set(tokenizeRecommendation(facts));
  return recTokens.every((t) => factSet.has(t));
}

export function engineProtectedAction(nodeClass: string, recommendation: string): boolean {
  return PROTECTED_CLASSES.has(nodeClass) || recommendationMatchesProtectedAction(recommendation);
}

export function typedRequestHandoffClass(
  request: TypedRequestKind,
  nodeClass: string,
): HandoffClass {
  if (request === "CapabilityRequest") return "missing_context";
  if (request === "DecisionRequest") return "product_judgment";
  if (nodeClass === "security" || nodeClass === "irreversible-operations") return "risk_authority";
  return "product_judgment";
}

/**
 * Derive auto-settle predicates from the concrete recommendation plus trusted
 * taxonomy / repository / GitHub / configuration facts. Class membership
 * alone is not eligibility. Unproven recommendations fail closed.
 */
export function deriveSettlementSignals(
  node: { class: string; recommendation: string },
  factText: string,
): SettlementSignals {
  const rec = (node.recommendation ?? "").trim();
  const unproven = rec.length === 0;
  const recProtected = recommendationMatchesProtectedAction(rec);
  const protectedAction = unproven || engineProtectedAction(node.class, rec);
  // Configuration law: auto-settle never grants merge/release/deploy/destroy/security.
  const policyConsistent = !unproven && !protectedAction && !recProtected;
  return {
    reversible: !unproven && !protectedAction,
    in_scope: !unproven && !protectedAction,
    policy_consistent: policyConsistent,
    covered_by_existing_authority: engineCoveredByExistingAuthority(
      node.class,
      rec,
      factText,
    ),
    contradictory: false,
    missing_external: false,
    discoverable_from_facts: engineDiscoverableFromFacts(rec, factText),
    protected_action: protectedAction,
    confidence: "medium",
  };
}

export function defaultSettlementSignals(
  nodeClass: string,
  recommendation = "",
  factText = "",
): SettlementSignals {
  return deriveSettlementSignals({ class: nodeClass, recommendation }, factText);
}

/**
 * Classify one frontier recommendation. Low confidence is ignored.
 * Discoverable facts never become CapabilityRequest.
 * Auto-accept never grants merge, release, destructive, or security authority.
 * Authority predicates are re-derived from the concrete recommendation and
 * trusted facts; caller/model signals cannot satisfy them.
 */
export function settleRecommendation(
  node: { class: string; recommendation: string },
  signals: SettlementSignals,
  factText = "",
): SettlementResult {
  const rec = (node.recommendation ?? "").trim();
  if (signals.contradictory) {
    return {
      kind: "typed-request",
      request: "DecisionRequest",
      handoff_class: typedRequestHandoffClass("DecisionRequest", node.class),
      reason: "contradictory product requirements",
    };
  }
  const recDiscoverable = engineDiscoverableFromFacts(rec, factText);
  if (signals.missing_external && !signals.discoverable_from_facts && !recDiscoverable) {
    return {
      kind: "typed-request",
      request: "CapabilityRequest",
      handoff_class: typedRequestHandoffClass("CapabilityRequest", node.class),
      reason: "missing external ability or information",
    };
  }
  if (!isGrillTaxonomyClass(node.class)) {
    return { kind: "unresolved", reason: `unknown class ${node.class}` };
  }
  const classified = classifyAuthority(node.class);
  if (!rec) {
    if (classified.operatorRequired) {
      return {
        kind: "typed-request",
        request: "AuthorityRequest",
        handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
        reason: "operator-required node has no recommendation",
      };
    }
    return { kind: "unresolved", reason: "empty recommendation" };
  }
  const derived = deriveSettlementSignals({ class: node.class, recommendation: rec }, factText);
  const protectedGrant = derived.protected_action;
  const covered = derived.covered_by_existing_authority;
  if (protectedGrant && !covered) {
    return {
      kind: "typed-request",
      request: "AuthorityRequest",
      handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
      reason: "protected action lacks existing authority",
    };
  }
  const autoSettleOk =
    derived.reversible &&
    derived.in_scope &&
    derived.policy_consistent &&
    covered &&
    !protectedGrant;
  if (autoSettleOk) {
    return { kind: "auto-accept", eligibility_reason: AUTO_ACCEPT_ELIGIBILITY_REASON };
  }
  if (classified.operatorRequired) {
    return {
      kind: "typed-request",
      request: "AuthorityRequest",
      handoff_class: typedRequestHandoffClass("AuthorityRequest", node.class),
      reason: "operator-required recommendation is not covered by existing authority",
    };
  }
  return { kind: "unresolved", reason: "recommendation does not meet auto-settle predicate" };
}

/**
 * Existing-authority coverage is engine-owned. A protected recommendation
 * is never covered, including when the model puts it in a non-authority
 * class. Empty or unproven recommendations are not covered. Non-authority
 * class membership is not coverage. Coverage requires affirmative trusted
 * facts for the concrete recommendation. Protected classes never auto-grant
 * from model prose.
 */
export function engineCoveredByExistingAuthority(
  nodeClass: string,
  recommendation: string,
  factText: string,
): boolean {
  const rec = recommendation.trim();
  if (!rec) return false;
  if (engineProtectedAction(nodeClass, rec)) return false;
  return factsCoverRecommendation(rec, factText);
}

/**
 * A recommendation is discoverable when trusted facts already cover it,
 * including paraphrases that share the same content tokens. Empty
 * recommendations are not discoverable.
 */
export function engineDiscoverableFromFacts(recommendation: string, factText: string): boolean {
  return factsCoverRecommendation(recommendation, factText);
}

/**
 * Model output may supply pause evidence (contradictory, missing_external)
 * and confidence. Authority-predicate fields are derived from taxonomy,
 * the concrete recommendation, and trusted facts, never copied from the model.
 * `missing_external` is a candidate only: discoverable facts never pause.
 */
export function parseSignalsFromModel(
  raw: Record<string, unknown>,
  nodeClass: string,
  recommendation = "",
  factText = "",
): SettlementSignals {
  const base = deriveSettlementSignals({ class: nodeClass, recommendation }, factText);
  const bool = (key: string, fallback: boolean): boolean => {
    const v = raw[key];
    if (typeof v === "boolean") return v;
    return fallback;
  };
  const confidenceRaw = raw.confidence;
  const confidence =
    confidenceRaw === "low" || confidenceRaw === "medium" || confidenceRaw === "high"
      ? confidenceRaw
      : base.confidence;
  const candidateMissing = bool("missing_external", base.missing_external);
  return {
    reversible: base.reversible,
    in_scope: base.in_scope,
    policy_consistent: base.policy_consistent,
    covered_by_existing_authority: base.covered_by_existing_authority,
    contradictory: bool("contradictory", base.contradictory),
    missing_external: candidateMissing && !base.discoverable_from_facts,
    discoverable_from_facts: base.discoverable_from_facts,
    protected_action: base.protected_action,
    confidence,
  };
}
