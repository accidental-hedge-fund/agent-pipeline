// Selector parse + freeze for `pipeline grill` (#1369).
// Pure: no network, git, or subprocess.

export type GrillSelectorForm = "issue" | "issues" | "milestone" | "label";

export type GrillSelector =
  | { form: "issue"; issue: number }
  | { form: "issues"; issues: number[] }
  | { form: "milestone"; milestone: string }
  | { form: "label"; labels: string[] };

export interface GrillSelectorFlags {
  issue?: number;
  issues?: string;
  milestone?: string;
  label?: string[];
}

export type GrillSelectorParse =
  | { ok: true; selector: GrillSelector }
  | { ok: false; reason: string };

const POSITIVE_INT = /^[1-9][0-9]*$/;

export function parseIssueList(raw: string): number[] | { error: string } {
  const parts = raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { error: "--issues requires at least one issue number" };
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    if (!POSITIVE_INT.test(part)) {
      return { error: `--issues contains a non-positive id "${part}"` };
    }
    const n = Number(part);
    if (seen.has(n)) continue;
    seen.add(n);
    ids.push(n);
  }
  ids.sort((a, b) => a - b);
  return ids;
}

function hasIssue(flags: GrillSelectorFlags): boolean {
  return typeof flags.issue === "number" && Number.isFinite(flags.issue) && flags.issue > 0;
}

function hasIssues(flags: GrillSelectorFlags): boolean {
  return typeof flags.issues === "string" && flags.issues.trim().length > 0;
}

function hasMilestone(flags: GrillSelectorFlags): boolean {
  return typeof flags.milestone === "string" && flags.milestone.trim().length > 0;
}

function hasLabel(flags: GrillSelectorFlags): boolean {
  return Array.isArray(flags.label) && flags.label.some((l) => l.trim().length > 0);
}

/** Exactly one selector form. Mixing two forms is a usage error. */
export function parseGrillSelector(flags: GrillSelectorFlags): GrillSelectorParse {
  const forms: GrillSelectorForm[] = [];
  if (hasIssue(flags)) forms.push("issue");
  if (hasIssues(flags)) forms.push("issues");
  if (hasMilestone(flags)) forms.push("milestone");
  if (hasLabel(flags)) forms.push("label");
  if (forms.length === 0) {
    return {
      ok: false,
      reason:
        "exactly one selector is required: --issue N, --issues N,N,..., --milestone M, or --label L",
    };
  }
  if (forms.length > 1) {
    return {
      ok: false,
      reason: `mixed selectors are not allowed (${forms.map((f) => `--${f}`).join(" and ")})`,
    };
  }
  const form = forms[0]!;
  if (form === "issue") {
    const n = flags.issue!;
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, reason: "--issue requires a positive integer" };
    }
    return { ok: true, selector: { form: "issue", issue: n } };
  }
  if (form === "issues") {
    const parsed = parseIssueList(flags.issues!);
    if ("error" in parsed) return { ok: false, reason: parsed.error };
    return { ok: true, selector: { form: "issues", issues: parsed } };
  }
  if (form === "milestone") {
    return { ok: true, selector: { form: "milestone", milestone: flags.milestone!.trim() } };
  }
  const labels = (flags.label ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  if (labels.length === 0) {
    return { ok: false, reason: "--label requires a non-empty label" };
  }
  return { ok: true, selector: { form: "label", labels } };
}

export const GRILL_MANIFEST_SCHEMA = "grill-manifest.v1" as const;

export interface GrillIneligible {
  issue: number;
  reason: string;
}

export interface GrillManifest {
  schema_version: typeof GRILL_MANIFEST_SCHEMA;
  run_id: string;
  selector: GrillSelector;
  issue_ids: number[];
  ineligible: GrillIneligible[];
  repo: string;
  created_at: string;
  integration_base_sha: string;
}

export function freezeManifest(input: {
  runId: string;
  selector: GrillSelector;
  openIds: number[];
  ineligible: GrillIneligible[];
  repo: string;
  createdAt: string;
  integrationBaseSha: string;
}): GrillManifest {
  const unique = [...new Set(input.openIds.filter((n) => Number.isInteger(n) && n > 0))];
  unique.sort((a, b) => a - b);
  return {
    schema_version: GRILL_MANIFEST_SCHEMA,
    run_id: input.runId,
    selector: input.selector,
    issue_ids: unique,
    ineligible: [...input.ineligible].sort((a, b) => a.issue - b.issue),
    repo: input.repo,
    created_at: input.createdAt,
    integration_base_sha: input.integrationBaseSha,
  };
}

export function parseGrillManifest(raw: unknown): GrillManifest | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== GRILL_MANIFEST_SCHEMA) return null;
  if (typeof o.run_id !== "string" || typeof o.repo !== "string") return null;
  if (typeof o.created_at !== "string" || typeof o.integration_base_sha !== "string") return null;
  if (!Array.isArray(o.issue_ids) || o.issue_ids.some((n) => typeof n !== "number")) return null;
  if (!Array.isArray(o.ineligible)) return null;
  const selector = o.selector;
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) return null;
  return o as unknown as GrillManifest;
}
