// Outcome linkage helpers (#576).
//
// Pure (or deps-injected) helpers that resolve candidate linkages from run
// store identity, Issue / Pipeline-Run trailers, and adapter signal fields.
// Observed vs inferred authority is classified explicitly; missing targets
// produce diagnostics rather than invented ids.

import {
  isPlaceholderIdentity,
  normalizeFullSha,
  type AttributionAuthority,
  type AttributionMethod,
  type OutcomeAttribution,
  type ProductionOutcome,
} from "./schema.ts";
import { ISSUE_TRAILER_KEY, RUN_TRAILER_KEY } from "../traceability.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunIdentity {
  run_id: string;
  issue: number | null;
  pr: number | null;
  /** Candidate / head SHA when known. */
  candidate_sha?: string | null;
  started_at?: string | null;
}

export interface ParsedTrailers {
  issue: number | null;
  pipeline_run: string | null;
}

export interface LinkageBuildResult {
  attribution: OutcomeAttribution[];
  linkage_diagnostics: string[];
}

export const LINKAGE_DIAGNOSTIC_CODES = {
  unresolved_run_id: "unresolved_run_id",
  missing_commit_sha: "missing_commit_sha",
  missing_pr: "missing_pr",
  invented_identity_rejected: "invented_identity_rejected",
  trailer_run_absent: "trailer_run_absent",
  temporal_join_only: "temporal_join_only",
  disputed_targets: "disputed_targets",
  deployment_signal_absent: "deployment_signal_absent",
} as const;

// ---------------------------------------------------------------------------
// Trailer parsing
// ---------------------------------------------------------------------------

/** Parse Issue / Pipeline-Run trailers from a commit message body. */
export function parseCommitTrailers(message: string): ParsedTrailers {
  let issue: number | null = null;
  let pipeline_run: string | null = null;
  if (typeof message !== "string" || !message) {
    return { issue, pipeline_run };
  }
  // Match trailer lines (key: value) near end or anywhere.
  const issueRe = new RegExp(`(?:^|\\n)${ISSUE_TRAILER_KEY}:\\s*#?(\\d+)\\s*(?:\\n|$)`, "i");
  const runRe = new RegExp(
    `(?:^|\\n)${RUN_TRAILER_KEY}:\\s*([^\\n]+?)\\s*(?:\\n|$)`,
    "i",
  );
  const im = message.match(issueRe);
  if (im) {
    const n = Number(im[1]);
    if (Number.isFinite(n) && n > 0) issue = n;
  }
  const rm = message.match(runRe);
  if (rm) {
    const v = rm[1].trim();
    if (v && !isPlaceholderIdentity(v)) pipeline_run = v;
  }
  return { issue, pipeline_run };
}

/**
 * Convert a Pipeline-Run trailer value (`issue/ISO`) into a filesystem-safe
 * run id prefix candidate (`issue-ISO-with-hyphens`). Exact ms may differ;
 * callers match loosely against a run index.
 */
export function trailerToRunIdCandidates(trailer: string): string[] {
  const t = trailer.trim();
  if (!t || isPlaceholderIdentity(t)) return [];
  const out = [t];
  // issue/2026-08-13T15:47:45Z → issue-2026-08-13T15-47-45
  const m = t.match(/^(\d+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/);
  if (m) {
    const issue = m[1];
    const isoCore = m[2].replace(/:/g, "-");
    out.push(`${issue}-${isoCore}`);
    out.push(`${issue}-${isoCore}-000Z`);
    out.push(`${issue}-${isoCore}Z`);
  }
  // Already filesystem form
  if (t.includes("-") && !t.includes("/")) {
    out.push(t);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Attribution builders
// ---------------------------------------------------------------------------

export function makeAttribution(args: {
  target_type: OutcomeAttribution["target_type"];
  target_id: string;
  method: AttributionMethod;
  authority: AttributionAuthority;
  confidence?: number | null;
  note?: string | null;
  disputed?: boolean;
}): OutcomeAttribution | null {
  if (!args.target_id || isPlaceholderIdentity(args.target_id)) return null;
  if (args.target_type === "commit") {
    const sha = normalizeFullSha(args.target_id);
    if (!sha) return null;
    return {
      target_type: "commit",
      target_id: sha,
      method: args.method,
      authority: args.authority,
      confidence: args.confidence ?? null,
      note: args.note ?? null,
      disputed: args.disputed,
    };
  }
  return {
    target_type: args.target_type,
    target_id: String(args.target_id).trim(),
    method: args.method,
    authority: args.authority,
    confidence: args.confidence ?? null,
    note: args.note ?? null,
    disputed: args.disputed,
  };
}

/**
 * Resolve a run attribution from a Pipeline-Run trailer against a run index.
 * Observed when a matching run exists; unresolved diagnostic otherwise.
 */
export function resolveRunFromTrailer(
  trailerValue: string | null | undefined,
  runs: readonly RunIdentity[],
): { attribution: OutcomeAttribution | null; diagnostic: string | null } {
  if (!trailerValue || isPlaceholderIdentity(trailerValue)) {
    return { attribution: null, diagnostic: LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id };
  }
  const candidates = trailerToRunIdCandidates(trailerValue);
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  for (const c of candidates) {
    const hit = byId.get(c);
    if (hit) {
      const a = makeAttribution({
        target_type: "run",
        target_id: hit.run_id,
        method: "trailer",
        authority: "observed",
        confidence: 1,
      });
      return { attribution: a, diagnostic: null };
    }
  }
  // Prefix / issue+timestamp second-precision match
  const m = trailerValue.match(/^(\d+)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  if (m) {
    const issue = Number(m[1]);
    const stamp = m[2];
    for (const r of runs) {
      if (r.issue !== issue) continue;
      if (r.run_id.includes(stamp.replace(/:/g, "-"))) {
        const a = makeAttribution({
          target_type: "run",
          target_id: r.run_id,
          method: "trailer",
          authority: "observed",
          confidence: 0.95,
        });
        return { attribution: a, diagnostic: null };
      }
      if (r.started_at && r.started_at.startsWith(stamp)) {
        const a = makeAttribution({
          target_type: "run",
          target_id: r.run_id,
          method: "trailer",
          authority: "observed",
          confidence: 0.9,
        });
        return { attribution: a, diagnostic: null };
      }
    }
  }
  return {
    attribution: null,
    diagnostic: LINKAGE_DIAGNOSTIC_CODES.trailer_run_absent,
  };
}

/**
 * Temporal co-occurrence only: same issue/day with no SHA/trailer/PR join.
 * Always authority: inferred.
 */
export function inferRunFromTemporalProximity(args: {
  signal_at: string | null;
  issue: number | null;
  runs: readonly RunIdentity[];
}): { attribution: OutcomeAttribution | null; diagnostic: string | null } {
  if (!args.signal_at || args.issue == null) {
    return { attribution: null, diagnostic: LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id };
  }
  const day = args.signal_at.slice(0, 10);
  const matches = args.runs.filter((r) => {
    if (r.issue !== args.issue) return false;
    const t = r.started_at ?? "";
    return t.startsWith(day);
  });
  if (matches.length !== 1) {
    return { attribution: null, diagnostic: LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id };
  }
  const a = makeAttribution({
    target_type: "run",
    target_id: matches[0].run_id,
    method: "heuristic",
    authority: "inferred",
    confidence: 0.3,
    note: "temporal co-occurrence only",
  });
  return {
    attribution: a,
    diagnostic: LINKAGE_DIAGNOSTIC_CODES.temporal_join_only,
  };
}

/**
 * Build attribution entries from adapter signal fields + optional run index.
 * Many-to-many: all resolvable targets are included; no primary forced.
 */
export function buildAttributionFromSignal(args: {
  commit_message?: string | null;
  merge_sha?: string | null;
  pr_number?: number | null;
  issue_number?: number | null;
  component_ids?: string[];
  run_id_direct?: string | null;
  runs?: readonly RunIdentity[];
  /** When true, attempt temporal inferred join if no observed run. */
  allow_temporal_infer?: boolean;
  signal_at?: string | null;
}): LinkageBuildResult {
  const attribution: OutcomeAttribution[] = [];
  const diagnostics: string[] = [];
  const runs = args.runs ?? [];

  if (args.run_id_direct && !isPlaceholderIdentity(args.run_id_direct)) {
    const hit = runs.find((r) => r.run_id === args.run_id_direct);
    if (hit || runs.length === 0) {
      // When runs empty (adapter unit test without store), still accept direct id as observed if non-placeholder
      const a = makeAttribution({
        target_type: "run",
        target_id: args.run_id_direct,
        method: "direct",
        authority: hit || runs.length === 0 ? "observed" : "inferred",
        confidence: hit || runs.length === 0 ? 1 : 0.5,
      });
      if (a) attribution.push(a);
      else diagnostics.push(LINKAGE_DIAGNOSTIC_CODES.invented_identity_rejected);
    } else {
      diagnostics.push(LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id);
    }
  }

  const trailers = parseCommitTrailers(args.commit_message ?? "");
  if (trailers.pipeline_run) {
    const { attribution: runAttr, diagnostic } = resolveRunFromTrailer(trailers.pipeline_run, runs);
    if (runAttr) {
      // Dedupe by target
      if (!attribution.some((a) => a.target_type === "run" && a.target_id === runAttr.target_id)) {
        attribution.push(runAttr);
      }
    } else if (diagnostic) {
      diagnostics.push(diagnostic);
    }
  }

  const issueNum = args.issue_number ?? trailers.issue;
  if (issueNum != null && issueNum > 0) {
    const a = makeAttribution({
      target_type: "issue",
      target_id: String(issueNum),
      method: trailers.issue != null ? "trailer" : "adapter",
      authority: "observed",
      confidence: 1,
    });
    if (a) attribution.push(a);
  }

  if (args.pr_number != null && args.pr_number > 0) {
    const a = makeAttribution({
      target_type: "pr",
      target_id: String(args.pr_number),
      method: "adapter",
      authority: "observed",
      confidence: 1,
    });
    if (a) attribution.push(a);
  } else if (args.pr_number === undefined) {
    // omit
  }

  const sha = normalizeFullSha(args.merge_sha ?? null);
  if (args.merge_sha != null && args.merge_sha !== "" && !sha) {
    diagnostics.push(LINKAGE_DIAGNOSTIC_CODES.missing_commit_sha);
  } else if (sha) {
    const a = makeAttribution({
      target_type: "commit",
      target_id: sha,
      method: "adapter",
      authority: "observed",
      confidence: 1,
    });
    if (a) attribution.push(a);
  }

  for (const comp of args.component_ids ?? []) {
    if (!comp || isPlaceholderIdentity(comp)) continue;
    const a = makeAttribution({
      target_type: "component",
      target_id: comp,
      method: "adapter",
      authority: "observed",
      confidence: 0.8,
    });
    if (a) attribution.push(a);
  }

  const hasRun = attribution.some((a) => a.target_type === "run" && a.authority === "observed");
  if (!hasRun && args.allow_temporal_infer) {
    const { attribution: inferred, diagnostic } = inferRunFromTemporalProximity({
      signal_at: args.signal_at ?? null,
      issue: issueNum,
      runs,
    });
    if (inferred) attribution.push(inferred);
    if (diagnostic) diagnostics.push(diagnostic);
  } else if (!hasRun && !attribution.some((a) => a.target_type === "run")) {
    if (!diagnostics.includes(LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id) &&
        !diagnostics.includes(LINKAGE_DIAGNOSTIC_CODES.trailer_run_absent)) {
      // Only add unresolved if we expected a run somehow (trailer or direct absent)
      if (trailers.pipeline_run || args.run_id_direct) {
        diagnostics.push(LINKAGE_DIAGNOSTIC_CODES.unresolved_run_id);
      }
    }
  }

  return { attribution, linkage_diagnostics: [...new Set(diagnostics)] };
}

/**
 * When two sources attribute different runs to the same outcome, mark disputed.
 * Keeps all entries; does not drop last-writer.
 */
export function applyDisputedRunAttributions(
  existing: OutcomeAttribution[],
  incoming: OutcomeAttribution[],
): { attribution: OutcomeAttribution[]; observation_state: "disputed" | null } {
  const merged = [...existing];
  for (const a of incoming) {
    const dup = merged.find(
      (m) => m.target_type === a.target_type && m.target_id === a.target_id,
    );
    if (!dup) merged.push(a);
  }
  const runIds = merged.filter((a) => a.target_type === "run").map((a) => a.target_id);
  const uniqueRuns = new Set(runIds);
  if (uniqueRuns.size > 1) {
    for (const a of merged) {
      if (a.target_type === "run") a.disputed = true;
    }
    return { attribution: merged, observation_state: "disputed" };
  }
  return { attribution: merged, observation_state: null };
}

/** True when at least one attribution has authority observed. */
export function hasObservedAttribution(record: Pick<ProductionOutcome, "attribution">): boolean {
  return record.attribution.some((a) => a.authority === "observed");
}

/** True when all run attributions (if any) are inferred-only. */
export function hasOnlyInferredRunAttribution(
  record: Pick<ProductionOutcome, "attribution">,
): boolean {
  const runs = record.attribution.filter((a) => a.target_type === "run");
  if (runs.length === 0) return false;
  return runs.every((a) => a.authority === "inferred");
}
