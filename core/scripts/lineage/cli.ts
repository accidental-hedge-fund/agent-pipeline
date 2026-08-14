// Operator entrypoint for intent lineage (#599).
//
//   pipeline lineage export  [--json] [--run-id <id>] [--retention-days N]
//   pipeline lineage impact  [--json] --node-id <id> [--new-revision <r>]
//   pipeline lineage propose [--json] [--evidence-node-id <id>]
//
// Host-local store under .agent-pipeline/lineage/. No hosted UI. Free text redacted.
// Does not mutate GitHub, stages, or merge state.

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import {
  DEFAULT_LINEAGE_RETENTION_DAYS,
  listAnalysisRecords,
  listLineage,
  loadGraphSnapshot,
  realLineageStoreDeps,
  upsertAnalysisRecord,
  upsertGraph,
  type LineageAnalysisRecord,
  type LineageStoreDeps,
} from "./store.ts";
import {
  computeBackwardProposals,
  computeForwardImpact,
  formatImpactReportHuman,
  formatProposalsHuman,
  type CompletenessGateConfig,
  evaluateLineageCompletenessGate,
  type ForwardImpactReport,
  type LineageUpdateProposal,
} from "./impact.ts";
import { buildLineageExportSection, formatLineageExportHuman } from "./export.ts";
import { ingestLineageArtifacts, type LineageIngestInput } from "./ingest.ts";
import { validateGraphIntegrity } from "./graph.ts";
import { LINEAGE_SCHEMA_VERSION } from "./schema.ts";

export const LINEAGE_HELP = `Usage: pipeline lineage <export|impact|propose|ingest> [options]

Intent-lineage evidence graph (host-local store; #599).

  pipeline lineage export  [--json] [--run-id <id>] [--retention-days <n>] [--include-records]
  pipeline lineage impact  [--json] --node-id <id> [--new-revision <r>] [--new-hash <h>]
  pipeline lineage propose [--json] [--evidence-node-id <id>]
  pipeline lineage ingest  [--json] [--fixture <path>] [--dry-run]

Notes:
  - Default store: .agent-pipeline/lineage/ (host-local; customer-hosted safe).
  - Free-text fields are secret-redacted; no raw prompts/source/secrets.
  - Domain-scoped node ids prevent cross-repo issue/path collisions.
  - Retention default: ${DEFAULT_LINEAGE_RETENTION_DAYS} days (config key: lineage.retention_days).
  - Completeness gate default off (config key: lineage.completeness_gate).
  - Backward proposals never silently edit authoritative upstream artifacts.
  - No hosted UI required — JSON and human-readable summaries only.
`;

export type LineageVerb = "export" | "impact" | "propose" | "ingest";

export interface LineageCliOpts {
  repoDir: string;
  verb: LineageVerb;
  json?: boolean;
  dryRun?: boolean;
  retentionDays?: number;
  runId?: string;
  nodeId?: string;
  newRevision?: string;
  newHash?: string;
  evidenceNodeId?: string;
  includeRecords?: boolean;
  fixturePath?: string;
  now?: Date;
}

export interface LineageCliDeps {
  store: LineageStoreDeps;
  readFile: (p: string) => Promise<string>;
  log: (msg: string) => void;
  /** Injectable integrity validator (tests inject fakes; default is pure offline check). */
  validateIntegrity?: typeof validateGraphIntegrity;
}

export function realLineageCliDeps(): LineageCliDeps {
  return {
    store: realLineageStoreDeps(),
    readFile: (p) => fsp.readFile(p, "utf8"),
    log: (msg) => {
      process.stdout.write(`${msg}\n`);
    },
    validateIntegrity: validateGraphIntegrity,
  };
}

function analysisIdFor(kind: string, parts: string[]): string {
  const h = createHash("sha1").update([kind, ...parts].join("|")).digest("hex").slice(0, 16);
  return `${kind}:${h}`;
}

function impactFromAnalyses(
  records: LineageAnalysisRecord[],
): ForwardImpactReport | null {
  const ordered = records
    .filter((r) => r.record_kind === "forward_impact" && r.impact)
    .sort((a, b) => a.computed_at.localeCompare(b.computed_at));
  return ordered[ordered.length - 1]?.impact ?? null;
}

function proposalsFromAnalyses(
  records: LineageAnalysisRecord[],
): LineageUpdateProposal[] {
  const out: LineageUpdateProposal[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.record_kind !== "backward_proposals" || !r.proposals) continue;
    for (const p of r.proposals) {
      if (seen.has(p.proposal_id)) continue;
      seen.add(p.proposal_id);
      out.push(p);
    }
  }
  return out;
}

export async function runLineageExport(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof buildLineageExportSection>> {
  const retentionDays = opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS;
  const listed = await listLineage(
    opts.repoDir,
    { retentionDays, now: opts.now, runId: opts.runId },
    deps.store,
  );
  const analyses = await listAnalysisRecords(
    opts.repoDir,
    { runId: opts.runId },
    deps.store,
  );
  const impact = impactFromAnalyses(analyses.records);
  const proposals = proposalsFromAnalyses(analyses.records);
  return buildLineageExportSection({
    nodes: listed.nodes,
    edges: listed.edges,
    run_id: opts.runId,
    impact,
    proposals: proposals.length > 0 ? proposals : null,
    include_records: opts.includeRecords,
    skip_reason:
      listed.nodes.length === 0 && listed.diagnostics.some((d) => d.code === "missing_lineage_store")
        ? "missing_lineage_store"
        : listed.nodes.length === 0
          ? "no_lineage_projected"
          : null,
  });
}

export async function runLineageImpact(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof computeForwardImpact>> {
  if (!opts.nodeId?.trim()) {
    throw new Error("lineage impact requires --node-id <id>");
  }
  const graph = await loadGraphSnapshot(
    opts.repoDir,
    { retentionDays: opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS, now: opts.now },
    deps.store,
  );
  const report = computeForwardImpact(graph, {
    upstream_node_id: opts.nodeId,
    new_revision: opts.newRevision ?? null,
    new_content_hash: opts.newHash ?? null,
  });

  // Persist immutable impact record for later evidence export.
  if (!opts.dryRun) {
    const computedAt = (opts.now ?? new Date()).toISOString();
    const analysis_id = analysisIdFor("impact", [
      opts.nodeId,
      opts.newRevision ?? "",
      opts.newHash ?? "",
      opts.runId ?? "",
      computedAt,
    ]);
    const record: LineageAnalysisRecord = {
      schema_version: LINEAGE_SCHEMA_VERSION,
      type: "lineage_analysis_record",
      analysis_id,
      record_kind: "forward_impact",
      run_id: opts.runId ?? null,
      computed_at: computedAt,
      impact: report,
      proposals: null,
      drift_reason_codes: [...report.drift_reason_codes],
    };
    await upsertAnalysisRecord(opts.repoDir, record, deps.store);
  }

  return report;
}

export async function runLineagePropose(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<ReturnType<typeof computeBackwardProposals>> {
  const graph = await loadGraphSnapshot(
    opts.repoDir,
    { retentionDays: opts.retentionDays ?? DEFAULT_LINEAGE_RETENTION_DAYS, now: opts.now },
    deps.store,
  );
  const result = computeBackwardProposals(graph, {
    evidence_node_id: opts.evidenceNodeId,
  });

  // Persist immutable proposal records for later evidence export.
  if (!opts.dryRun) {
    const computedAt = (opts.now ?? new Date()).toISOString();
    const analysis_id = analysisIdFor("propose", [
      opts.evidenceNodeId ?? "all",
      opts.runId ?? "",
      ...result.proposals.map((p) => p.proposal_id).sort(),
      computedAt,
    ]);
    const drift = new Set<string>();
    for (const p of result.proposals) {
      for (const c of p.reason_codes) drift.add(c);
    }
    const record: LineageAnalysisRecord = {
      schema_version: LINEAGE_SCHEMA_VERSION,
      type: "lineage_analysis_record",
      analysis_id,
      record_kind: "backward_proposals",
      run_id: opts.runId ?? null,
      computed_at: computedAt,
      impact: null,
      proposals: result.proposals,
      drift_reason_codes: [...drift].sort(),
    };
    await upsertAnalysisRecord(opts.repoDir, record, deps.store);
  }

  return result;
}

export async function runLineageIngest(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<{
  written_nodes: number;
  written_edges: number;
  diagnostics: Array<{ code: string; message: string; ref?: string }>;
  integrity_ok: boolean;
  dry_run: boolean;
  rejected: boolean;
}> {
  if (!opts.fixturePath) {
    throw new Error("lineage ingest requires --fixture <path> (JSON LineageIngestInput)");
  }
  const raw = await deps.readFile(opts.fixturePath);
  const input = JSON.parse(raw) as LineageIngestInput;
  const result = ingestLineageArtifacts(input);
  const checkIntegrity = deps.validateIntegrity ?? validateGraphIntegrity;
  const integrity = checkIntegrity({ nodes: result.nodes, edges: result.edges });
  const diagnostics = [
    ...result.diagnostics,
    ...integrity.diagnostics.map((d) => ({
      code: d.code,
      message: d.message,
      ref: d.edge_id ?? d.node_id,
    })),
  ];

  // Fail closed: never write invalid graphs as authoritative.
  if (!integrity.ok) {
    return {
      written_nodes: 0,
      written_edges: 0,
      diagnostics,
      integrity_ok: false,
      dry_run: !!opts.dryRun,
      rejected: true,
    };
  }

  if (!opts.dryRun) {
    await upsertGraph(
      opts.repoDir,
      { nodes: result.nodes, edges: result.edges },
      deps.store,
    );
  }

  return {
    written_nodes: result.nodes.length,
    written_edges: result.edges.length,
    diagnostics,
    integrity_ok: true,
    dry_run: !!opts.dryRun,
    rejected: false,
  };
}

export async function runLineageCli(
  opts: LineageCliOpts,
  deps: LineageCliDeps = realLineageCliDeps(),
): Promise<void> {
  if (opts.verb === "export") {
    const section = await runLineageExport(opts, deps);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ schema_version: LINEAGE_SCHEMA_VERSION, type: "lineage_export", ...section }, null, 2)}\n`,
      );
      return;
    }
    deps.log(formatLineageExportHuman(section));
    return;
  }

  if (opts.verb === "impact") {
    const report = await runLineageImpact(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    deps.log(formatImpactReportHuman(report));
    return;
  }

  if (opts.verb === "propose") {
    const result = await runLineagePropose(opts, deps);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    deps.log(formatProposalsHuman(result));
    return;
  }

  if (opts.verb === "ingest") {
    const summary = await runLineageIngest(opts, deps);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ schema_version: LINEAGE_SCHEMA_VERSION, type: "lineage_ingest", ...summary }, null, 2)}\n`,
      );
    } else {
      deps.log("# pipeline lineage ingest");
      deps.log(
        `Nodes: ${summary.written_nodes}; edges: ${summary.written_edges}${summary.dry_run ? " (dry-run)" : ""}${summary.rejected ? " (rejected)" : ""}`,
      );
      deps.log(`Integrity: ${summary.integrity_ok ? "ok" : "failed — not written"}`);
      if (summary.diagnostics.length) {
        deps.log("Diagnostics:");
        for (const d of summary.diagnostics) {
          deps.log(`  [${d.code}] ${d.message}`);
        }
      }
      deps.log("");
      deps.log("Privacy: store is host-local under .agent-pipeline/lineage/; free text redacted.");
    }
    if (summary.rejected || !summary.integrity_ok) {
      throw new Error(
        "lineage ingest refused: graph integrity validation failed; invalid records were not written",
      );
    }
    return;
  }

  throw new Error(`unknown lineage verb: ${(opts as LineageCliOpts).verb}`);
}

export type { CompletenessGateConfig };
export { evaluateLineageCompletenessGate };
