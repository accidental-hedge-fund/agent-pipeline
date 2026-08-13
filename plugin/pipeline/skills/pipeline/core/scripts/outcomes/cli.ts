// Operator entrypoint for production outcomes (#576).
//
//   pipeline outcomes ingest [--adapter github] [--json] [--dry-run]
//   pipeline outcomes list   [--json] [--days N] [--retention-days N]
//
// Privacy: host-local store under .agent-pipeline/outcomes/; free text is
// redacted; R2D is never treated as production delivery. Ingest performs no
// GitHub-mutating operations and no stage/label transitions.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { runsDir } from "../run-store.ts";
import {
  GITHUB_OUTCOME_ADAPTER_ID,
  ingestOutcomes,
  listOutcomeAdapters,
  type IngestSummary,
  type RawOutcomeSignal,
} from "./adapters.ts";
import {
  DEFAULT_OUTCOME_RETENTION_DAYS,
  listOutcomes,
  realOutcomeStoreDeps,
  type OutcomeStoreDeps,
} from "./store.ts";
import type { RunIdentity } from "./linkage.ts";
import type { ProductionOutcome } from "./schema.ts";

export const OUTCOMES_HELP = `Usage: pipeline outcomes <ingest|list> [options]

Link pipeline runs to production and rework outcomes (host-local store).

  pipeline outcomes ingest [--adapter github] [--json] [--dry-run] [--fixture <path>]
  pipeline outcomes list   [--json] [--days <n>] [--retention-days <n>]

Notes:
  - Default store: .agent-pipeline/outcomes/ (host-local; customer-hosted safe).
  - Free-text fields are secret-redacted; no raw prompts/source/secrets.
  - Ready-to-deploy alone is never counted as production delivery.
  - Ingest is read-only toward GitHub (no labels, comments, or merges).
  - Observed outcome facts are separate from inferred attribution claims.
  - Retention default: ${DEFAULT_OUTCOME_RETENTION_DAYS} days (configurable via --retention-days).
`;

export interface OutcomesCliOpts {
  repoDir: string;
  verb: "ingest" | "list";
  adapter?: string;
  json?: boolean;
  dryRun?: boolean;
  days?: number;
  retentionDays?: number;
  /** Absolute path to a JSON file of RawOutcomeSignal[] for offline ingest. */
  fixturePath?: string;
  now?: Date;
}

export interface OutcomesCliDeps {
  store: OutcomeStoreDeps;
  readFile: (p: string) => Promise<string>;
  readdir: (p: string) => Promise<Array<{ name: string; isDirectory(): boolean }>>;
  log: (msg: string) => void;
  /** Injectable gh for discover; tests omit or fake. Never mutates. */
  gh?: (args: string[]) => Promise<string>;
}

export function realOutcomesCliDeps(): OutcomesCliDeps {
  return {
    store: realOutcomeStoreDeps(),
    readFile: (p) => fsp.readFile(p, "utf8"),
    readdir: async (p) => {
      const entries = await fsp.readdir(p, { withFileTypes: true });
      return entries.map((e) => ({ name: e.name, isDirectory: () => e.isDirectory() }));
    },
    log: (msg) => process.stdout.write(`${msg}\n`),
  };
}

/** Load a lightweight run identity index from the local run store (best-effort). */
export async function loadRunIdentityIndex(
  repoDir: string,
  deps: Pick<OutcomesCliDeps, "readFile" | "readdir">,
): Promise<RunIdentity[]> {
  const root = runsDir(repoDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await deps.readdir(root);
  } catch {
    return [];
  }
  const runs: RunIdentity[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const raw = await deps.readFile(path.join(root, e.name, "run.json"));
      const meta = JSON.parse(raw) as Record<string, unknown>;
      runs.push({
        run_id: typeof meta.run_id === "string" ? meta.run_id : e.name,
        issue: typeof meta.issue === "number" ? meta.issue : null,
        pr: typeof meta.pr === "number" ? meta.pr : null,
        started_at: typeof meta.started_at === "string" ? meta.started_at : null,
        candidate_sha: typeof meta.candidate_sha === "string" ? meta.candidate_sha : null,
      });
    } catch {
      runs.push({ run_id: e.name, issue: null, pr: null });
    }
  }
  return runs;
}

export interface OutcomesListSummary {
  count: number;
  records: ProductionOutcome[];
  diagnostics: Array<{ code: string; message: string; path?: string }>;
  retention_days: number;
}

export async function runOutcomesList(
  opts: OutcomesCliOpts,
  deps: OutcomesCliDeps = realOutcomesCliDeps(),
): Promise<OutcomesListSummary> {
  const retentionDays = opts.retentionDays ?? DEFAULT_OUTCOME_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  let since: string | undefined;
  if (opts.days != null && opts.days > 0) {
    since = new Date(now.getTime() - opts.days * 24 * 60 * 60 * 1000).toISOString();
  }
  const listed = await listOutcomes(
    opts.repoDir,
    { retentionDays, since, now },
    deps.store,
  );
  return {
    count: listed.records.length,
    records: listed.records,
    diagnostics: listed.diagnostics,
    retention_days: retentionDays,
  };
}

export async function runOutcomesIngest(
  opts: OutcomesCliOpts,
  deps: OutcomesCliDeps = realOutcomesCliDeps(),
): Promise<IngestSummary> {
  const runs = await loadRunIdentityIndex(opts.repoDir, deps);
  let signals: RawOutcomeSignal[] | undefined;
  if (opts.fixturePath) {
    const raw = await deps.readFile(opts.fixturePath);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("fixture must be a JSON array of RawOutcomeSignal objects");
    }
    signals = parsed as RawOutcomeSignal[];
  }
  return ingestOutcomes({
    repoDir: opts.repoDir,
    adapterId: opts.adapter ?? GITHUB_OUTCOME_ADAPTER_ID,
    signals,
    runs,
    gh: deps.gh,
    dryRun: opts.dryRun,
    now: opts.now,
    deps: deps.store,
  });
}

export async function runOutcomesCli(
  opts: OutcomesCliOpts,
  deps: OutcomesCliDeps = realOutcomesCliDeps(),
): Promise<void> {
  if (opts.verb === "list") {
    const summary = await runOutcomesList(opts, deps);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            schema_version: 1,
            type: "outcomes_list",
            count: summary.count,
            retention_days: summary.retention_days,
            records: summary.records,
            diagnostics: summary.diagnostics,
            // Explicit: no maintainability_score
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    deps.log(`# pipeline outcomes list`);
    deps.log(`Count: ${summary.count} (retention ${summary.retention_days}d)`);
    deps.log("");
    if (summary.records.length === 0) {
      deps.log("(no outcomes)");
    } else {
      for (const r of summary.records) {
        const observed = r.attribution.filter((a) => a.authority === "observed").length;
        const inferred = r.attribution.filter((a) => a.authority === "inferred").length;
        deps.log(
          `- ${r.outcome_kind} [${r.observation_state}] ${r.outcome_id}` +
            ` attr(observed=${observed},inferred=${inferred})` +
            (r.delivery
              ? ` merge=${r.delivery.merge_status} deploy=${r.delivery.deploy_status}`
              : ""),
        );
        deps.log(`  ${r.summary}`);
      }
    }
    if (summary.diagnostics.length) {
      deps.log("");
      deps.log("Diagnostics:");
      for (const d of summary.diagnostics) {
        deps.log(`  [${d.code}] ${d.message}`);
      }
    }
    return;
  }

  if (opts.verb === "ingest") {
    const summary = await runOutcomesIngest(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ schema_version: 1, type: "outcomes_ingest", ...summary }, null, 2)}\n`);
      return;
    }
    deps.log(`# pipeline outcomes ingest`);
    deps.log(`Adapter: ${summary.adapter_id}${summary.dry_run ? " (dry-run)" : ""}`);
    deps.log(`Written: ${summary.written}; replaced: ${summary.replaced}; skipped: ${summary.skipped}`);
    if (summary.outcome_ids.length) {
      deps.log(`Outcome ids: ${summary.outcome_ids.join(", ")}`);
    }
    if (summary.diagnostics.length) {
      deps.log("Diagnostics:");
      for (const d of summary.diagnostics) {
        deps.log(`  [${d.code}] ${d.signal_id ?? ""} ${d.message}`);
      }
    }
    deps.log("");
    deps.log("Privacy: store is host-local under .agent-pipeline/outcomes/; free text redacted.");
    deps.log("R2D alone is never recorded as production delivery success.");
    return;
  }

  throw new Error(`unknown outcomes verb: ${(opts as OutcomesCliOpts).verb}`);
}

export function formatAdaptersHelp(): string {
  return listOutcomeAdapters()
    .map((a) => a.id)
    .join(", ");
}
