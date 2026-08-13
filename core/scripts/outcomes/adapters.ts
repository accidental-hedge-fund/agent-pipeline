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

/**
 * When linkage uniquely resolves one observed, non-disputed run that carries a
 * candidate_sha, return that SHA. Used so squash/rebase merge commits do not
 * split delivery identity from a later deployment of the pipeline candidate.
 * Multiple or disputed runs → null (do not invent a winner).
 */
export function uniqueObservedRunCandidateSha(
  attribution: ReadonlyArray<{
    target_type: string;
    target_id: string;
    authority: string;
    disputed?: boolean;
  }>,
  runs: readonly RunIdentity[],
): string | null {
  const observedRuns = attribution.filter(
    (a) => a.target_type === "run" && a.authority === "observed" && !a.disputed,
  );
  if (observedRuns.length !== 1) return null;
  const hit = runs.find((r) => r.run_id === observedRuns[0]!.target_id);
  return normalizeFullSha(hit?.candidate_sha ?? null);
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
      const signals: RawOutcomeSignal[] = [];
      for (const pr of list) {
        const mergeSha =
          pr.mergeCommit && typeof pr.mergeCommit === "object"
            ? asString((pr.mergeCommit as { oid?: unknown }).oid)
            : null;
        // Durable Pipeline-Run / Issue trailers live on the merge commit message
        // (esp. squash/rebase). PR body is only supplemental — fetch commit text.
        let commitMessage: string | null = null;
        if (mergeSha && ctx.gh) {
          try {
            const commitRaw = await ctx.gh([
              "api",
              `repos/{owner}/{repo}/commits/${mergeSha}`,
            ]);
            const commitJson = JSON.parse(commitRaw) as {
              commit?: { message?: unknown };
            };
            commitMessage = asString(commitJson.commit?.message);
          } catch {
            // Non-fatal: keep body-only evidence when commit fetch fails.
            commitMessage = null;
          }
        }
        signals.push({
          signal_id: `merge:pr:${pr.number}`,
          kind: "merge" as const,
          payload: {
            pr_number: pr.number,
            merged_at: pr.mergedAt,
            merge_commit_sha: mergeSha,
            title: pr.title,
            body: pr.body,
            // Preferred linkage source for trailers (see normalize merge path).
            commit_message: commitMessage,
            url: pr.url,
          },
        });
      }
      return signals;
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
      // Prefer merge-commit message (durable trailers); PR body is supplemental.
      const commitMessage =
        asString(signal.payload.commit_message) ?? asString(signal.payload.body) ?? "";
      const title = asString(signal.payload.title) ?? `PR ${pr ?? "?"}`;
      const deployStatusRaw = asString(signal.payload.deploy_status);
      const env = asString(signal.payload.environment);
      const deployedSha = normalizeFullSha(asString(signal.payload.deployed_candidate_sha));

      // Link first so a uniquely resolved run candidate can key delivery identity
      // (squash/rebase: merge commit SHA ≠ pipeline candidate SHA).
      const link = buildAttributionFromSignal({
        commit_message: commitMessage,
        merge_sha: mergeSha ?? deployedSha,
        pr_number: pr ?? undefined,
        issue_number: asNumber(signal.payload.issue_number) ?? undefined,
        runs,
        signal_at: mergedAt,
      });
      const linkedCandidateSha = uniqueObservedRunCandidateSha(link.attribution, runs);

      // Prefer explicit deploy SHA, else unique run candidate, else merge SHA / PR.
      // Keep merge_sha on the delivery chain; do not use it as sole identity when
      // linkage already resolved a distinct candidate.
      const outcomeId = deriveDeliveryOutcomeId({
        candidateSha: deployedSha ?? linkedCandidateSha ?? mergeSha,
        prNumber: pr,
        fallbackSignalId: signal.signal_id,
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
      const resolvedDeployStatus = hasDeploy ? deploy_status : "not_observed";
      const mergeRollbackOutcomeRaw = asString(signal.payload.rollback_outcome);
      const mergeRollbackOutcome =
        mergeRollbackOutcomeRaw === "succeeded" ||
        mergeRollbackOutcomeRaw === "failed" ||
        mergeRollbackOutcomeRaw === "unknown" ||
        mergeRollbackOutcomeRaw === "not_observed"
          ? mergeRollbackOutcomeRaw
          : null;
      let mergeRollbackOccurred: boolean | null =
        typeof signal.payload.rollback_occurred === "boolean"
          ? signal.payload.rollback_occurred
          : null;
      let mergeRollbackOutcomeResolved = mergeRollbackOutcome;
      // Explicit rolled_back deploy status is an observed rollback; inactive is not.
      if (resolvedDeployStatus === "rolled_back") {
        if (mergeRollbackOccurred == null) mergeRollbackOccurred = true;
        if (mergeRollbackOutcomeResolved == null) mergeRollbackOutcomeResolved = "unknown";
      }
      const delivery = emptyDeliveryChain({
        environment: env,
        deploy_status: resolvedDeployStatus,
        deployed_candidate_sha: deployedSha,
        merge_status: "merged",
        merged_sha: mergeSha,
        verification: {
          status: asString(signal.payload.verification_status) === "passed" ? "passed" : "not_observed",
          evidence_ref: asString(signal.payload.verification_evidence_ref),
          fresh_at: asString(signal.payload.verification_fresh_at),
        },
        rollback: {
          occurred: mergeRollbackOccurred,
          outcome: mergeRollbackOutcomeResolved,
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
      // Prefer merge-commit message (durable trailers); PR body is supplemental.
      const commitMessage =
        asString(signal.payload.commit_message) ?? asString(signal.payload.body) ?? "";
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
        commit_message: commitMessage,
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

      // Link first so a uniquely resolved run candidate can share identity with
      // merge normalization when deploy SHA is a squash merge commit.
      const link = buildAttributionFromSignal({
        merge_sha: sha,
        pr_number: pr ?? undefined,
        runs,
        signal_at: at,
        commit_message: asString(signal.payload.commit_message),
      });
      const linkedCandidateSha = uniqueObservedRunCandidateSha(link.attribution, runs);

      // Prefer unique linked run candidate (aligns with merge on squash/rebase),
      // else payload deploy SHA, else PR fallback.
      const outcomeId = deriveDeliveryOutcomeId({
        candidateSha: linkedCandidateSha ?? sha,
        prNumber: pr,
        fallbackSignalId: signal.signal_id,
      });

      // Map known deploy statuses only. GitHub `inactive` (superseded/deactivated)
      // falls through to unknown — it is not rolled_back and is not a rollback.
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

      // Provider explicit fields override; state=rolled_back still populates the
      // rollback chain (spec: observed rollback must set occurred + outcome).
      // inactive stays unknown deploy_status above and does not enter this branch.
      const rollbackOutcomeRaw = asString(signal.payload.rollback_outcome);
      const rollbackOutcome =
        rollbackOutcomeRaw === "succeeded" ||
        rollbackOutcomeRaw === "failed" ||
        rollbackOutcomeRaw === "unknown" ||
        rollbackOutcomeRaw === "not_observed"
          ? rollbackOutcomeRaw
          : null;
      let rollbackOccurred: boolean | null =
        typeof signal.payload.rollback_occurred === "boolean"
          ? signal.payload.rollback_occurred
          : null;
      let rollbackOutcomeResolved = rollbackOutcome;
      if (deploy_status === "rolled_back") {
        if (rollbackOccurred == null) rollbackOccurred = true;
        if (rollbackOutcomeResolved == null) rollbackOutcomeResolved = "unknown";
      }

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
        rollback: {
          occurred: rollbackOccurred,
          outcome: rollbackOutcomeResolved,
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
