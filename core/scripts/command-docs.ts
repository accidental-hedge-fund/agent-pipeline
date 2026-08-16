// Documentation metadata co-located with COMMAND_REGISTRY (#597).
//
// Dispatch fields live only in command-registry.ts. This module supplies the
// human-facing summary/usage text consumed by the CLI reference generator.
// Adding or editing entries here MUST NOT alter validateFlags / lookupCommand.

import { COMMAND_REGISTRY } from "./command-registry.ts";

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
  documented: boolean;
  /** Optional grouping for docs/cli.md section order. */
  section?: "advance" | "lifecycle" | "factory" | "observability" | "config" | "other";
}

/**
 * Documentation map keyed by COMMAND_REGISTRY keywords.
 * Every registry key SHOULD appear here; missing keys are treated as undocumented.
 */
export const COMMAND_DOCS: Record<string, CommandDoc> = {
  advance: {
    summary: "Durable autonomous one-item drive (default when invoked with an issue number)",
    usage: "N",
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
    documented: true,
    section: "advance",
  },
  status: {
    summary: "Read-only — print stage, blocker, PR, last review",
    usage: "status <n>",
    documented: true,
    section: "lifecycle",
  },
  unblock: {
    summary: "Post an answer and clear the blocked label",
    usage: 'unblock <n> "<answer>"',
    documented: true,
    section: "lifecycle",
  },
  override: {
    summary: "Disposition a review finding and auto-resume the advance loop",
    usage: 'override <n> "<key>: <reason>"',
    documented: true,
    section: "lifecycle",
  },
  "recover-parked": {
    summary:
      "One supervisor pass for a parked issue: deterministic recover first, then reflow only stale/DNR/below-high residuals (never auto-override HIGH/CRITICAL/security); re-enter single if clear",
    usage: "recover-parked <n> [--json] [--dry-run]",
    documented: true,
    section: "lifecycle",
  },
  summary: {
    summary: "Print the run evidence bundle for an issue number or exact run-id",
    usage: "summary <run-id>",
    documented: true,
    section: "observability",
  },
  doctor: {
    summary:
      "Deterministic preflight check; print summary, exit 0/1. Opt-in --harness-smoke adds one cheap model call per unique configured harness treatment",
    usage: "doctor [--json|--is-ok] [--fail-fast] [--harness-smoke]",
    documented: true,
    section: "lifecycle",
  },
  init: {
    summary: "Ensure pipeline labels and scaffold .github/pipeline.yml",
    usage: "init",
    documented: true,
    section: "lifecycle",
  },
  cleanup: {
    summary: "Sweep merged-PR worktrees and delete their local branches",
    usage: "cleanup",
    documented: true,
    section: "lifecycle",
  },
  "remove-worktree": {
    summary: "Remove a managed pipeline worktree for an issue (optional --force)",
    usage: "remove-worktree <n> [--force]",
    documented: true,
    section: "lifecycle",
  },
  intake: {
    summary: "Spec a rough description into a GitHub issue and ROADMAP PR",
    usage: 'intake --description "<text>" [--release vX.Y.Z] [--dry-run]',
    documented: true,
    section: "factory",
  },
  decompose: {
    summary:
      "Break an epic issue into dependency-linked child issues and a ROADMAP PR (dry-run default; --apply writes; not intake / not roadmap-order-only / not loop-execute)",
    usage:
      'decompose --epic <N> [--description "…"] [--apply] [--release vX.Y.Z] [--max-children N] [--max-effort S|M|L|XL] [--allow-xl]',
    documented: true,
    section: "factory",
  },
  triage: {
    summary: "Set a pre-pipeline stage label (ready or backlog) on an issue",
    usage: "triage <n> --stage ready|backlog",
    documented: true,
    section: "factory",
  },
  sweep: {
    summary: "Batch re-spec thin issues and reconcile ROADMAP.md",
    usage: "sweep [--apply] [--repo owner/name]",
    documented: true,
    section: "factory",
  },
  backfill: {
    summary: "Preview or apply OpenSpec coverage for legacy behavior (spec-only PR)",
    usage: "backfill [--apply] [--capability <name>]",
    documented: true,
    section: "factory",
  },
  roadmap: {
    summary:
      "Analyze open backlog into a dependency-aware scored roadmap; under SemVer, dry-run lists full milestone reconciliation actions and --apply converges open issues to the reviewed manifest (fingerprint-gated)",
    usage: "roadmap [--apply] [--next <n>]",
    documented: true,
    section: "factory",
  },
  merge: {
    summary: "Operator-authorized squash merge of a ready-to-deploy PR (never called by the advance loop)",
    usage: "merge <pr>",
    documented: true,
    section: "lifecycle",
  },
  "merge-queue": {
    summary: "Operator-authorized sequential merge of ready-to-deploy PRs; dry-run by default; optional prepare-only release-when-complete",
    usage: "merge-queue --milestone <m> [--apply] [--release-when-complete --release-version <ver>]",
    documented: true,
    section: "lifecycle",
  },
  train: {
    summary:
      "Operator-authorized integrate train: base-eligible frontiers advance via one loop wave each (recovery inside the wave); optionally serial-merge with base containment; independent R2D siblings may merge while a peer is parked (never called by the advance loop)",
    usage: "train --milestone <m>|--issues <n,n> [--merge] [--json]",
    documented: true,
    section: "lifecycle",
  },
  release: {
    summary:
      "Prepare a release PR from the matching GitHub milestone plan (or finish-merge one); never tags or publishes (workflows do; auto-tag also refreshes tag-derived CHANGELOG); --dry-run reports milestone presence/open issues",
    usage:
      'release <version> [--theme "..."] [--dry-run|--json] [--no-edit] [--skip-frg] | release finish <pr> [--json]',
    documented: true,
    section: "lifecycle",
  },
  ship: {
    summary:
      "Run or inspect one exact, Buzz-authorized release shipment through train, FRG, release, and engine promotion",
    usage:
      "ship --milestone <m> --for <X.Y.Z> --authorization <absolute-json> --json | ship status --milestone <m> --for <X.Y.Z> --json",
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
      "factory-release prepare --request <absolute-request.json> --json",
    documented: true,
    section: "factory",
  },
  "factory-pin": {
    summary:
      "Show / init / promote / rollback the factory production engine pin (last FRG-passed release; never merges or tags)",
    usage:
      "factory-pin show|init --from-frg <X.Y.Z>|promote --for <X.Y.Z>|rollback [--to <X.Y.Z>] [--git-sha <sha>] [--force]",
    documented: true,
    section: "factory",
  },
  "engine-promote": {
    summary:
      "Self-host: verify published release, promote production pin, install exact tag to all hosts by default, verify version (rollback pin on install failure)",
    usage:
      "engine-promote --for <X.Y.Z> [--host all|codex|claude|grok|opencode] [--dry-run] [--json] [--skip-install]",
    documented: true,
    section: "factory",
  },
  logs: {
    summary: "List or stream pipeline run logs (events --follow exits 0 on terminal run_complete)",
    usage: "logs [<run-id>] [--events] [-f] [--no-until-terminal]",
    documented: true,
    section: "observability",
  },
  loop: {
    summary: "Durable multi-item run — driven in-repo by the pipeline's own loop supervisor",
    usage: "loop --milestone <m>|--label <l>|--range a-b [--resume <run-id>] [--audit] [--follow]",
    documented: true,
    section: "advance",
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
    summary: "Refine an existing issue's spec; non-mutating JSON output",
    usage: 'refine-spec --title "<t>" --body "<b>"',
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
): DocumentedCommand[] {
  const out: DocumentedCommand[] = [];
  for (const keyword of Object.keys(registry)) {
    const doc = docs[keyword];
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
  // Usage that already starts with the bare command form for advance ("N") stays space-joined.
  return `${token} ${body}`;
}
