// Outcome source-adapter contract + GitHub-native E2E adapter (#576).
//
// Ingest is read-only toward GitHub and append/upsert only toward the outcome
// store. A single bad signal is non-fatal. outcome_id is a pure function of
// adapter id + stable signal identity for idempotent re-ingest.

import { createHash } from "node:crypto";
import {
  emptyDeliveryChain,
  makeOutcomeShell,
  normalizeFullSha,
  validateProductionOutcome,
  type ProductionOutcome,
} from "./schema.ts";
import {
  buildAttributionFromSignal,
  LINKAGE_DIAGNOSTIC_CODES,
  type RunIdentity,
} from "./linkage.ts";
import {
  listOutcomes,
  upsertOutcome,
  type OutcomeStoreDeps,
  realOutcomeStoreDeps,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface RawOutcomeSignal {
  /** Stable within adapter; used to derive outcome_id. */
  signal_id: string;
  kind: "merge" | "revert" | "deployment" | "other";
  payload: Record<string, unknown>;
}

export interface OutcomeAdapterContext {
  repoDir: string;
  /** Optional injectable run identity index for linkage. */
  runs?: readonly RunIdentity[];
  /** Optional raw signals (fixtures) — when set, discover uses these instead of I/O. */
  signals?: RawOutcomeSignal[];
  /** Optional read-only gh-like function; never used for mutations. */
  gh?: (args: string[]) => Promise<string>;
  now?: Date;
}

export interface OutcomeSourceAdapter {
  readonly id: string;
  discover(ctx: OutcomeAdapterContext): Promise<RawOutcomeSignal[]>;
  normalize(signal: RawOutcomeSignal, ctx: OutcomeAdapterContext): ProductionOutcome | null;
}

export interface IngestDiagnostic {
  code: string;
  message: string;
  signal_id?: string;
}

export interface IngestSummary {
  adapter_id: string;
  written: number;
  replaced: number;
  skipped: number;
  diagnostics: IngestDiagnostic[];
  outcome_ids: string[];
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// outcome_id derivation
// ---------------------------------------------------------------------------

/** Pure stable outcome_id from adapter id + signal identity parts. */
export function deriveOutcomeId(adapterId: string, ...parts: Array<string | number | null | undefined>): string {
  const basis = [adapterId, ...parts.map((p) => (p == null ? "" : String(p)))].join("\x1f");
  const hash = createHash("sha1").update(basis).digest("hex").slice(0, 16);
  const head = `${adapterId}:${parts.filter((p) => p != null && String(p) !== "").slice(0, 3).join(":")}`;
  const safe = head.replace(/[/\\]/g, "_").slice(0, 80);
  return `${safe}:${hash}`;
}

/**
 * Shared delivery identity for merge and deployment observations of the same
 * candidate. Prefer full candidate/merge SHA; fall back to PR; then signal id.
 * Environment is a field on the delivery chain, not part of outcome_id, so a
 * later deploy updates the same delivery record rather than splitting the chain.
 */
export function deriveDeliveryOutcomeId(args: {
  adapterId?: string;
  candidateSha?: string | null;
  prNumber?: number | null;
  fallbackSignalId?: string | null;
}): string {
  const adapterId = args.adapterId ?? GITHUB_OUTCOME_ADAPTER_ID;
  const sha = normalizeFullSha(args.candidateSha ?? null);
  if (sha) {
    return deriveOutcomeId(adapterId, "delivery", sha);
  }
  if (args.prNumber != null && args.prNumber > 0) {
    return deriveOutcomeId(adapterId, "delivery", `pr:${args.prNumber}`);
  }
  return deriveOutcomeId(adapterId, "delivery", args.fallbackSignalId ?? "unknown");
}

// ---------------------------------------------------------------------------
// GitHub-native adapter
// ---------------------------------------------------------------------------

export const GITHUB_OUTCOME_ADAPTER_ID = "github";

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Built-in GitHub adapter: merge, revert, optional deployment signals.
 * Unit tests inject fixtures via ctx.signals (no network).
 */
export const githubOutcomeAdapter: OutcomeSourceAdapter = {
  id: GITHUB_OUTCOME_ADAPTER_ID,

  async discover(ctx: OutcomeAdapterContext): Promise<RawOutcomeSignal[]> {
    if (ctx.signals) return ctx.signals.slice();
    // Live discover is optional: when gh is provided, fetch merged PRs lightly.
    // Never mutates GitHub. Failure → empty list + caller diagnostics.
    if (!ctx.gh) return [];
    try {
      // Confirm shape offline in tests; live: recent closed merged PRs.
      const raw = await ctx.gh([
        "pr",
        "list",
        "--state",
        "merged",
        "--limit",
        "20",
        "--json",
        "number,mergedAt,mergeCommit,title,body,url",
      ]);
      const list = JSON.parse(raw) as Array<Record<string, unknown>>;
      return list.map((pr) => ({
        signal_id: `merge:pr:${pr.number}`,
        kind: "merge" as const,
        payload: {
          pr_number: pr.number,
          merged_at: pr.mergedAt,
          merge_commit_sha:
            pr.mergeCommit && typeof pr.mergeCommit === "object"
              ? (pr.mergeCommit as { oid?: string }).oid
              : null,
          title: pr.title,
          body: pr.body,
          url: pr.url,
        },
      }));
    } catch {
      return [];
    }
  },

  normalize(signal: RawOutcomeSignal, ctx: OutcomeAdapterContext): ProductionOutcome | null {
    const nowIso = (ctx.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
    const runs = ctx.runs ?? [];

    if (signal.kind === "merge") {
      const pr = asNumber(signal.payload.pr_number);
      const mergeSha = normalizeFullSha(asString(signal.payload.merge_commit_sha));
      const mergedAt = asString(signal.payload.merged_at);
      const body = asString(signal.payload.body) ?? asString(signal.payload.commit_message) ?? "";
      const title = asString(signal.payload.title) ?? `PR ${pr ?? "?"}`;
      const deployStatusRaw = asString(signal.payload.deploy_status);
      const env = asString(signal.payload.environment);
      const deployedSha = normalizeFullSha(asString(signal.payload.deployed_candidate_sha));

      // Prefer deployed SHA when present so a co-bundled deploy still keys the
      // same delivery identity as a later pure deployment signal for that SHA.
      const outcomeId = deriveDeliveryOutcomeId({
        candidateSha: deployedSha ?? mergeSha,
        prNumber: pr,
        fallbackSignalId: signal.signal_id,
      });

      const link = buildAttributionFromSignal({
        commit_message: body,
        merge_sha: mergeSha ?? deployedSha,
        pr_number: pr ?? undefined,
        issue_number: asNumber(signal.payload.issue_number) ?? undefined,
        runs,
        signal_at: mergedAt,
      });

      const hasDeploy =
        deployStatusRaw === "succeeded" ||
        deployStatusRaw === "failed" ||
        deployStatusRaw === "rolled_back" ||
        deployStatusRaw === "in_progress" ||
        Boolean(deployedSha) ||
        Boolean(env);

      const diagnostics = [...link.linkage_diagnostics];
      if (!hasDeploy) diagnostics.push(LINKAGE_DIAGNOSTIC_CODES.deployment_signal_absent);

      const deploy_status =
        deployStatusRaw === "succeeded" ||
        deployStatusRaw === "failed" ||
        deployStatusRaw === "rolled_back" ||
        deployStatusRaw === "in_progress" ||
        deployStatusRaw === "unknown" ||
        deployStatusRaw === "not_observed"
          ? deployStatusRaw
          : "not_observed";

      // Never invent deploy success from merge alone.
      const delivery = emptyDeliveryChain({
        environment: env,
        deploy_status: hasDeploy ? deploy_status : "not_observed",
        deployed_candidate_sha: deployedSha,
        merge_status: "merged",
        merged_sha: mergeSha,
        verification: {
          status: asString(signal.payload.verification_status) === "passed" ? "passed" : "not_observed",
          evidence_ref: asString(signal.payload.verification_evidence_ref),
          fresh_at: asString(signal.payload.verification_fresh_at),
        },
        rollback: {
          occurred:
            typeof signal.payload.rollback_occurred === "boolean"
              ? signal.payload.rollback_occurred
              : null,
          outcome:
            asString(signal.payload.rollback_outcome) === "succeeded" ||
            asString(signal.payload.rollback_outcome) === "failed" ||
            asString(signal.payload.rollback_outcome) === "unknown" ||
            asString(signal.payload.rollback_outcome) === "not_observed"
              ? (asString(signal.payload.rollback_outcome) as
                  | "succeeded"
                  | "failed"
                  | "unknown"
                  | "not_observed")
              : null,
        },
      });

      return makeOutcomeShell({
        outcome_id: outcomeId,
        outcome_kind: "delivery",
        observation_state: "observed",
        adapter_id: GITHUB_OUTCOME_ADAPTER_ID,
        signal_ref: asString(signal.payload.url) ?? signal.signal_id,
        provider_event_id: signal.signal_id,
        summary: `Merged: ${title}`,
        observed_at: nowIso,
        signal_at: mergedAt,
        delivery,
        attribution: link.attribution,
        linkage_diagnostics: [...new Set(diagnostics)],
        evidence_refs: [asString(signal.payload.url) ?? signal.signal_id].filter(Boolean) as string[],
      });
    }

    if (signal.kind === "revert") {
      const pr = asNumber(signal.payload.pr_number);
      const originalPr = asNumber(signal.payload.original_pr);
      const body = asString(signal.payload.body) ?? asString(signal.payload.commit_message) ?? "";
      const title = asString(signal.payload.title) ?? `Revert ${originalPr ?? pr ?? "?"}`;
      const mergeSha = normalizeFullSha(asString(signal.payload.merge_commit_sha));
      const at = asString(signal.payload.merged_at) ?? asString(signal.payload.at);

      const outcomeId = deriveOutcomeId(
        GITHUB_OUTCOME_ADAPTER_ID,
        "reversion",
        originalPr ?? pr,
        mergeSha ?? signal.signal_id,
      );

      const link = buildAttributionFromSignal({
        commit_message: body,
        merge_sha: mergeSha,
        pr_number: originalPr ?? pr ?? undefined,
        issue_number: asNumber(signal.payload.issue_number) ?? undefined,
        runs,
        signal_at: at,
        allow_temporal_infer: true,
      });

      // Prefer original PR attribution when present
      if (originalPr != null && !link.attribution.some((a) => a.target_type === "pr" && a.target_id === String(originalPr))) {
        link.attribution.push({
          target_type: "pr",
          target_id: String(originalPr),
          method: "adapter",
          authority: "observed",
          confidence: 1,
          note: "original PR referenced by revert",
        });
      }

      return makeOutcomeShell({
        outcome_id: outcomeId,
        outcome_kind: "reversion",
        observation_state: "observed",
        adapter_id: GITHUB_OUTCOME_ADAPTER_ID,
        signal_ref: asString(signal.payload.url) ?? signal.signal_id,
        provider_event_id: signal.signal_id,
        summary: `Reversion: ${title}`,
        observed_at: nowIso,
        signal_at: at,
        delivery: null,
        attribution: link.attribution,
        linkage_diagnostics: link.linkage_diagnostics,
        evidence_refs: [asString(signal.payload.url) ?? signal.signal_id].filter(Boolean) as string[],
      });
    }

    if (signal.kind === "deployment") {
      const sha = normalizeFullSha(asString(signal.payload.sha) ?? asString(signal.payload.deployed_candidate_sha));
      const env = asString(signal.payload.environment);
      const status = asString(signal.payload.state) ?? asString(signal.payload.deploy_status) ?? "unknown";
      const at = asString(signal.payload.at) ?? asString(signal.payload.updated_at);
      const pr = asNumber(signal.payload.pr_number);

      // Same identity family as merge: candidate SHA (or PR) — not env/deploy
      // markers — so deploy updates the existing delivery chain record.
      const outcomeId = deriveDeliveryOutcomeId({
        candidateSha: sha,
        prNumber: pr,
        fallbackSignalId: signal.signal_id,
      });

      const link = buildAttributionFromSignal({
        merge_sha: sha,
        pr_number: pr ?? undefined,
        runs,
        signal_at: at,
        commit_message: asString(signal.payload.commit_message),
      });

      const deploy_status =
        status === "success" || status === "succeeded"
          ? "succeeded"
          : status === "failure" || status === "failed"
            ? "failed"
            : status === "in_progress" || status === "pending"
              ? "in_progress"
              : status === "rolled_back"
                ? "rolled_back"
                : "unknown";

      const delivery = emptyDeliveryChain({
        environment: env,
        deploy_status,
        deployed_candidate_sha: sha,
        merge_status: "unknown",
        merged_sha: null,
        verification: {
          status: "not_observed",
          evidence_ref: asString(signal.payload.url),
          fresh_at: at,
        },
      });

      return makeOutcomeShell({
        outcome_id: outcomeId,
        outcome_kind: "delivery",
        observation_state: deploy_status === "in_progress" ? "delayed" : "observed",
        adapter_id: GITHUB_OUTCOME_ADAPTER_ID,
        signal_ref: asString(signal.payload.url) ?? signal.signal_id,
        provider_event_id: signal.signal_id,
        summary: `Deployment ${deploy_status}${env ? ` to ${env}` : ""}`,
        observed_at: nowIso,
        signal_at: at,
        delivery,
        attribution: link.attribution,
        linkage_diagnostics: link.linkage_diagnostics,
        evidence_refs: [asString(signal.payload.url) ?? signal.signal_id].filter(Boolean) as string[],
      });
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Registry + ingest
// ---------------------------------------------------------------------------

const BUILTIN_ADAPTERS: OutcomeSourceAdapter[] = [githubOutcomeAdapter];

export function listOutcomeAdapters(): OutcomeSourceAdapter[] {
  return BUILTIN_ADAPTERS.slice();
}

export function getOutcomeAdapter(id: string): OutcomeSourceAdapter | null {
  return BUILTIN_ADAPTERS.find((a) => a.id === id) ?? null;
}

export interface IngestOpts {
  repoDir: string;
  adapterId?: string;
  /** Fixture signals for offline ingest. */
  signals?: RawOutcomeSignal[];
  runs?: readonly RunIdentity[];
  gh?: OutcomeAdapterContext["gh"];
  dryRun?: boolean;
  now?: Date;
  deps?: OutcomeStoreDeps;
}

/**
 * Run one or all adapters, normalize signals, upsert outcomes.
 * Bad signals are skipped with diagnostics; batch continues.
 * Never mutates GitHub labels, stages, worktrees, or merge state.
 */
export async function ingestOutcomes(opts: IngestOpts): Promise<IngestSummary> {
  const adapterId = opts.adapterId ?? GITHUB_OUTCOME_ADAPTER_ID;
  const adapter = getOutcomeAdapter(adapterId);
  const diagnostics: IngestDiagnostic[] = [];
  if (!adapter) {
    return {
      adapter_id: adapterId,
      written: 0,
      replaced: 0,
      skipped: 0,
      diagnostics: [{ code: "unknown_adapter", message: `Unknown adapter: ${adapterId}` }],
      outcome_ids: [],
      dry_run: !!opts.dryRun,
    };
  }

  const ctx: OutcomeAdapterContext = {
    repoDir: opts.repoDir,
    runs: opts.runs,
    signals: opts.signals,
    gh: opts.gh,
    now: opts.now,
  };

  let signals: RawOutcomeSignal[];
  try {
    signals = await adapter.discover(ctx);
  } catch (err) {
    return {
      adapter_id: adapter.id,
      written: 0,
      replaced: 0,
      skipped: 0,
      diagnostics: [{ code: "discover_failed", message: (err as Error).message }],
      outcome_ids: [],
      dry_run: !!opts.dryRun,
    };
  }

  let written = 0;
  let replaced = 0;
  let skipped = 0;
  const outcome_ids: string[] = [];
  const deps = opts.deps ?? realOutcomeStoreDeps();

  for (const signal of signals) {
    let record: ProductionOutcome | null = null;
    try {
      record = adapter.normalize(signal, ctx);
    } catch (err) {
      skipped++;
      diagnostics.push({
        code: "normalize_threw",
        message: (err as Error).message,
        signal_id: signal.signal_id,
      });
      continue;
    }
    if (!record) {
      skipped++;
      diagnostics.push({
        code: "normalize_null",
        message: "signal produced no outcome",
        signal_id: signal.signal_id,
      });
      continue;
    }
    const v = validateProductionOutcome(record);
    if (!v.ok || !v.value) {
      skipped++;
      diagnostics.push({
        code: "validation_failed",
        message: v.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
        signal_id: signal.signal_id,
      });
      continue;
    }
    if (opts.dryRun) {
      written++;
      outcome_ids.push(v.value.outcome_id);
      continue;
    }
    const up = await upsertOutcome(opts.repoDir, v.value, deps);
    if (up.action === "written") {
      written++;
      outcome_ids.push(up.outcome_id);
    } else if (up.action === "replaced") {
      replaced++;
      outcome_ids.push(up.outcome_id);
    } else {
      skipped++;
      diagnostics.push({
        code: "upsert_failed",
        message: up.error ?? "upsert skipped",
        signal_id: signal.signal_id,
      });
    }
  }

  return {
    adapter_id: adapter.id,
    written,
    replaced,
    skipped,
    diagnostics,
    outcome_ids,
    dry_run: !!opts.dryRun,
  };
}

/** Re-export store list for CLI consumers. */
export { listOutcomes };
