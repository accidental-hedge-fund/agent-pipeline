// Closed authority taxonomy `grill-taxonomy.v1` (#1072).
// Pure: no network, git, or subprocess.

export const GRILL_TAXONOMY_VERSION = "grill-taxonomy.v1" as const;

export const OPERATOR_REQUIRED_CLASSES = [
  "scope",
  "security",
  "irreversible-operations",
  "merge-release",
  "human-attestation",
] as const;

export const NON_AUTHORITY_CLASSES = [
  "interface-contract",
  "test-evidence",
  "docs-surface",
  "operational-default",
] as const;

export type OperatorRequiredClass = (typeof OPERATOR_REQUIRED_CLASSES)[number];
export type NonAuthorityClass = (typeof NON_AUTHORITY_CLASSES)[number];
export type GrillTaxonomyClass = OperatorRequiredClass | NonAuthorityClass;

const OPERATOR_REQUIRED_SET: ReadonlySet<string> = new Set(OPERATOR_REQUIRED_CLASSES);
const NON_AUTHORITY_SET: ReadonlySet<string> = new Set(NON_AUTHORITY_CLASSES);
const TAXONOMY_SET: ReadonlySet<string> = new Set([...OPERATOR_REQUIRED_CLASSES, ...NON_AUTHORITY_CLASSES]);

export const NON_AUTHORITY_ELIGIBILITY_REASON =
  "taxonomy-validated non-authority class in grill-taxonomy.v1";

export function isGrillTaxonomyClass(value: unknown): value is GrillTaxonomyClass {
  return typeof value === "string" && TAXONOMY_SET.has(value);
}

export function isOperatorRequiredClass(value: unknown): value is OperatorRequiredClass {
  return typeof value === "string" && OPERATOR_REQUIRED_SET.has(value);
}

export function isNonAuthorityClass(value: unknown): value is NonAuthorityClass {
  return typeof value === "string" && NON_AUTHORITY_SET.has(value);
}

/**
 * Unknown or disputed classes stay unresolved authority and cannot record
 * `settled-by: reviewer-accept`.
 */
export function classifyAuthority(rawClass: unknown): {
  class: string;
  known: boolean;
  operatorRequired: boolean;
  mayAutoDefault: boolean;
} {
  const cls = typeof rawClass === "string" ? rawClass : "";
  const known = isGrillTaxonomyClass(cls);
  const operatorRequired = isOperatorRequiredClass(cls);
  return {
    class: cls,
    known,
    operatorRequired: operatorRequired || !known,
    mayAutoDefault: known && !operatorRequired,
  };
}
