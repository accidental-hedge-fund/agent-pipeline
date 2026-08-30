// Documentation metadata co-located with COMMAND_REGISTRY (#597).
//
// Dispatch fields live only in command-registry.ts. This module supplies the
// remaining human-facing summary/usage text consumed by the CLI reference
// generator. In-scope host verbs come from operation-surface.ts (#1048).
// Adding or editing either catalog MUST NOT alter validateFlags / lookupCommand.

import { COMMAND_REGISTRY } from "./command-registry.ts";
import {
  OPERATION_SURFACE,
  type OperationSurfaceEntry,
  type OperationSection,
} from "./operation-surface.ts";

/** Per-command documentation metadata for the generated CLI reference. */
export interface CommandDoc {
  /** One-line description for tables and docs/cli.md. */
  summary: string;
  /**
   * Host-token-agnostic usage body (no leading `/pipeline` or `$pipeline`).
   * Examples: `status <n>`, `N`, `evals plan <manifest.json>`.
   * Generators prefix with the host invocation token.
   */
  usage: string;
  /**
   * When false, the command remains dispatchable but is omitted from generated
   * docs and SKILL command tables (hidden / agent-only / legacy-only surface).
   * Defaults to true when omitted from a complete CommandDoc object.
   */
  documented?: boolean;
  /** Optional grouping for docs/cli.md section order. */
  section?: OperationSection;
}

/**
 * Documentation map keyed by COMMAND_REGISTRY keywords.
 * Every registry key SHOULD appear here; missing keys are treated as undocumented.
 */
const BASE_COMMAND_DOCS: Record<string, CommandDoc> = {
  advance: {
    summary: "Durable autonomous one-item drive (default when invoked with an issue number)",
    usage: "N [--sha <sha>]",
    documented: true,
    section: "advance",
  },
  single: {
    summary: "Canonical durable one-item autonomous drive (owns a durable loop; delegates stages to advance)",
    usage: "single <n>",
    documented: true,
    section: "advance",
  },
  run: {
    summary: "Advance alias; use with --detach for a legacy raw detached run (desktop launchers)",
    usage: "run <n> [--detach]",
    documented: false,
    section: "advance",
  },
  "remove-worktree": {
    summary:
      "Remove a managed pipeline worktree for an issue (optional --force). After a proven merge, /pipeline and train --merge share bound-proof park-release; cleanup is not the required fix",
    usage: "remove-worktree <n> [--force]",
    documented: true,
    section: "lifecycle",
  },
  backfill: {
    summary: "Preview or apply OpenSpec coverage for legacy behavior (spec-only PR)",
    usage: "backfill [--apply] [--capability <name>]",
    documented: true,
    section: "factory",
  },
  train: {
    summary:
      "Operator-authorized integrate train: base-eligible frontiers advance via one loop wave each (recovery inside the wave); optionally serial-merge with base containment; independent R2D siblings may merge while a peer is parked (never called by the advance loop)",
    usage:
      "train --milestone <m> [--merge] [--json] [--dry-run] | train --issues <n,n> [--merge] [--json] [--dry-run]",
    documented: true,
    section: "lifecycle",
  },
  ship: {
    summary:
      "Run or inspect one durable milestone shipment (train --merge, release, finish, promote). Operator product is pipeline ship --milestone vX.Y.Z; no grant file required.",
    usage:
      "ship --milestone vX.Y.Z [--json] | ship status --milestone vX.Y.Z [--json]",
    documented: true,
    section: "lifecycle",
  },
  "factory-gate": {
    summary: "Score a durable loop / fixture pack and write immutable FRG evidence (never merges or tags)",
    usage:
      "factory-gate --for <version> [--from-run <run-id>] [--observations <file>] [--scenario id=status:detail] [--promote-pin-on-pass]",
    documented: true,
    section: "factory",
  },
  "factory-release": {
    summary:
      "Durable post-pilot FRG generation + prepare-only release handoff (in_progress → awaiting_frg_attestation → complete; never merges/tags)",
    usage:
      "factory-release prepare --request <absolute-off-repo-request.json> --json",
    documented: true,
    section: "factory",
  },
  "factory-pin": {
    summary:
      "Show / init / promote / rollback the factory production engine pin (last FRG-passed release; promote writes a real frg_run_id + evidence path; never merges or tags)",
    usage:
      "factory-pin show|init --from-frg <X.Y.Z>|promote --for <X.Y.Z>|rollback [--to <X.Y.Z>] [--git-sha <sha>] [--force]",
    documented: true,
    section: "factory",
  },
  "engine-promote": {
    summary:
      "Self-host: verify published release, promote a production-quality pin from FRG, install exact tag to all hosts by default, verify version (rollback pin on install failure; --skip-frg writes a no-frg-* non-production marker only)",
    usage:
      "engine-promote --for <X.Y.Z> [--host all|codex|claude|grok|opencode|omp] [--dry-run] [--json] [--skip-install] [--skip-frg]",
    documented: true,
    section: "factory",
  },
  scoreboard: {
    summary:
      "Print read-only factory throughput/cost/reliability metrics from run artifacts " +
      "(incl. human-touch, escape-recurrence, discovery-channel, stratified stabilization; #763; " +
      "production outcomes #576; planning-leverage / material-rework #702)",
    usage: "scoreboard [--days <n>|--since <iso>] [--until <iso>] [--bucket day|week] [--by <dim>] [--json] [--html <path>]",
    documented: true,
    section: "observability",
  },
  outcomes: {
    summary:
      "Ingest or list production/rework outcomes linked to pipeline runs (host-local store; #576). " +
      "R2D alone is never production delivery; free text is redacted; no GitHub mutations",
    usage:
      "outcomes ingest|list [--adapter github] [--fixture <path>] [--days <n>] [--retention-days <n>] [--dry-run] [--json]",
    documented: true,
    section: "observability",
  },
  lineage: {
    summary:
      "Export, impact-analyze, or propose updates on the intent-lineage evidence graph (host-local store; #599). " +
      "Backward proposals never silently edit authority; free text is redacted; no GitHub mutations",
    usage:
      "lineage export|impact|propose|ingest [--run-id <id>] [--node-id <id>] [--fixture <path>] [--retention-days <n>] [--dry-run] [--json]",
    documented: true,
    section: "observability",
  },
  improve: {
    summary: "Cluster papercuts / corrections / durable-run blockers into backlog candidates",
    usage: "improve [--apply] [--top <n>] [--json]",
    documented: true,
    section: "factory",
  },
  queue: {
    summary: "Batch factory: dispatch all pipeline:ready issues up to concurrency/budget limits",
    usage: "queue [--max-issues <n>] [--concurrency <n>] [--budget-dollars <d>]",
    documented: true,
    section: "factory",
  },
  config: {
    summary: "Config schema, validate, sync scaffold, and repo-map mutations",
    usage: "config schema|validate|sync|repo-map …",
    documented: true,
    section: "config",
  },
  path: {
    summary: "Discover installed host skill paths (JSON-friendly for desktop integrators)",
    usage: "path [--json]",
    documented: true,
    section: "config",
  },
  controls: {
    summary:
      "Read-only repository-control drift check against configured desired state (#695); never mutates forge settings",
    usage: "controls check [--json] [--strict]",
    documented: true,
    section: "observability",
  },
  "refine-spec": {
    summary:
      "Grill an issue spec: --title/--body preview, --issue preview, or apply a signed proposal",
    usage:
      'refine-spec --title "<t>" --body "<b>" | refine-spec --issue N | refine-spec apply --issue N [--proposal-file PATH]',
    documented: true,
    section: "factory",
  },
  evals: {
    summary: "Offline eval plan/run/grade/report/harvest (never writes to production GitHub)",
    usage: "evals plan|run|grade|report|harvest …",
    documented: true,
    section: "factory",
  },
  handoff: {
    summary:
      "List, inspect, answer, reject, or supersede durable human-question handoffs (#647)",
    usage:
      "handoff list|show|answer|reject|supersede … [--json] [--issue N] [--run-id id] [--status pending]",
  },

  correction: {
    summary: "Record a correction event or attribute a control (append-only local ledger)",
    usage: "correction record|attribute …",
    documented: true,
    section: "observability",
  },
  report: {
    summary: "Privacy-safe product-fault report preview/submit (optional; off by default in config)",
    usage: "report [--yes]",
    documented: true,
    section: "observability",
  },
  // Agent-facing only — registered for dispatch, hidden from --help and docs (#419).
  papercut: {
    summary: "Agent-logged friction event capture (hidden from operator docs)",
    usage: "papercut --message \"…\"",
    documented: false,
    section: "other",
  },
};

/**
 * Overlay catalog-owned documentation onto the broader registry metadata.
 * Removing an in-scope operation hides that catalog entry; adding or editing
 * one changes generated CLI and SKILL output without a second prose edit.
 */
export function commandDocsForOperationSurface(
  surface: readonly OperationSurfaceEntry[],
  baseDocs: Record<string, CommandDoc> = BASE_COMMAND_DOCS,
): Record<string, CommandDoc> {
  const docs = { ...baseDocs };
  const supplied = new Set<string>();

  for (const op of surface) {
    if (!op.name.trim()) throw new Error("OPERATION_SURFACE contains an empty name");
    if (supplied.has(op.name)) {
      throw new Error(`OPERATION_SURFACE contains duplicate operation: ${op.name}`);
    }
    supplied.add(op.name);
    docs[op.name] = {
      summary: op.desc,
      usage: op.usage,
      documented: true,
      section: op.section,
    };
  }

  // A caller-provided surface is authoritative for the catalog-owned names.
  // Registry-only commands outside this in-scope catalog keep their existing
  // documentation metadata.
  for (const op of OPERATION_SURFACE) {
    if (supplied.has(op.name) || !docs[op.name]) continue;
    docs[op.name] = { ...docs[op.name], documented: false };
  }

  return docs;
}

/** Documentation metadata with OPERATION_SURFACE as the authoritative overlay. */
export const COMMAND_DOCS: Record<string, CommandDoc> = commandDocsForOperationSurface(
  OPERATION_SURFACE,
);

const SECTION_ORDER: NonNullable<CommandDoc["section"]>[] = [
  "advance",
  "lifecycle",
  "factory",
  "observability",
  "config",
  "other",
];

export interface DocumentedCommand {
  keyword: string;
  summary: string;
  usage: string;
  section: NonNullable<CommandDoc["section"]>;
}

/**
 * Return documented commands present in COMMAND_REGISTRY, in stable section then
 * keyword order. Keywords marked undocumented or missing from COMMAND_DOCS are omitted.
 * Never invents commands absent from the registry.
 */
export function listDocumentedCommands(
  registry: Record<string, unknown> = COMMAND_REGISTRY,
  docs: Record<string, CommandDoc> = COMMAND_DOCS,
  operationSurface?: readonly OperationSurfaceEntry[],
): DocumentedCommand[] {
  const effectiveSurface = operationSurface ?? (docs === COMMAND_DOCS ? OPERATION_SURFACE : undefined);
  const effectiveDocs = effectiveSurface
    ? commandDocsForOperationSurface(effectiveSurface, docs)
    : docs;
  const out: DocumentedCommand[] = [];
  for (const keyword of Object.keys(registry)) {
    const doc = effectiveDocs[keyword];
    if (!doc || doc.documented === false) continue;
    if (!doc.summary?.trim() || !doc.usage?.trim()) continue;
    out.push({
      keyword,
      summary: doc.summary.trim(),
      usage: doc.usage.trim(),
      section: doc.section ?? "other",
    });
  }
  out.sort((a, b) => {
    const si = SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    if (si !== 0) return si;
    return a.keyword.localeCompare(b.keyword);
  });
  return out;
}

/**
 * Prefix a host-token-agnostic usage body with the host invocation token.
 * Examples: token="/pipeline", usage="status <n>" → "/pipeline status <n>"
 *            token="$pipeline", usage="N" → "$pipeline N"
 */
export function formatHostUsage(hostToken: string, usage: string): string {
  const token = hostToken.trim();
  const body = usage.trim();
  if (!body) return token;
  // Prefix every spaced-pipe alternative so each form is a complete invocation.
  // Split only on spaced pipes so flag unions such as `[--json|--is-ok]` stay intact.
  return body
    .split(/\s+\|\s+/)
    .map((alt) => `${token} ${alt}`)
    .join(" | ");
}
