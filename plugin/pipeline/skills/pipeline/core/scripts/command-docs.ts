// Documentation metadata for COMMAND_REGISTRY keywords (#597).
//
// Co-located with the registry as a sibling map keyed by the same command ids.
// Dispatch fields live only in command-registry.ts; this module is ignored at
// runtime by the CLI path and is consumed solely by the docs generator.
//
// Adding a user-facing command: update COMMAND_REGISTRY + COMMAND_DOCS, then
// run `node scripts/generate-docs.mjs` from the repo root.

import { COMMAND_REGISTRY } from "./command-registry.ts";

/** Documentation metadata for one registry keyword. */
export interface CommandDoc {
  /** One-line description for tables and the CLI reference. */
  summary: string;
  /**
   * Host-token-agnostic usage synopsis body (without the leading host token).
   * The generator prefixes `/pipeline` or `$pipeline` (and `:` forms) as needed.
   * Multi-line usage is allowed; use `\n` between alternate forms.
   */
  usage: string;
  /**
   * When false, generators omit this keyword from docs/cli.md and host SKILL
   * command tables. Dispatch still works via COMMAND_REGISTRY.
   * Defaults to true when the key is present.
   */
  documented?: boolean;
  /** Optional ordering group for docs (advance, ops, factory, …). */
  section?: string;
}

/**
 * Doc metadata keyed by COMMAND_REGISTRY keywords.
 * Every key here SHOULD also exist in COMMAND_REGISTRY; the generator only
 * emits commands that appear in both and are documented.
 */
export const COMMAND_DOCS: Record<string, CommandDoc> = {
  advance: {
    summary: "Advance issue N through the pipeline (default path; up to 12 transitions)",
    usage: "N\nN --once\nN --dry-run\nN --domain <d>\nN --base <branch>\nN --repo-path <path>\nN --detach\nN --doctor",
    section: "advance",
  },
  status: {
    summary: "Read-only status of issue or PR N — stage, blocker, PR, last review",
    usage: "status <N>",
    section: "observe",
  },
  unblock: {
    summary: "Post an answer and clear the blocked label for issue N",
    usage: 'unblock <N> "<answer>"',
    section: "ops",
  },
  override: {
    summary: "Disposition a review finding and auto-resume the advance loop for issue N",
    usage: 'override <N> "<key>: <reason>"',
    section: "ops",
  },
  summary: {
    summary: "Print the evidence bundle for issue N, or for an exact run-id",
    usage: "summary <N>\nsummary <run-id>",
    section: "observe",
  },
  doctor: {
    summary: "Run deterministic preflight checks and print a pass/fail summary",
    usage: "doctor\ndoctor --json\ndoctor --is-ok\ndoctor --fail-fast",
    section: "ops",
  },
  init: {
    summary: "Ensure pipeline labels and scaffold .github/pipeline.yml",
    usage: "init",
    section: "ops",
  },
  cleanup: {
    summary: "Sweep merged-PR worktrees and delete their local branches",
    usage: "cleanup",
    section: "ops",
  },
  intake: {
    summary: "Spec a rough description into a GitHub issue and ROADMAP PR",
    usage: 'intake [--description "<text>"] [--release <vX.Y.Z>] [--dry-run]',
    section: "backlog",
  },
  triage: {
    summary: "Set a pre-pipeline stage label (ready or backlog) on issue N",
    usage: "triage <N> --stage ready\ntriage <N> --stage backlog",
    section: "backlog",
  },
  sweep: {
    summary: "Batch re-spec thin issues and reconcile ROADMAP.md",
    usage: "sweep\nsweep --apply\nsweep --apply --repo <owner/repo>",
    section: "backlog",
  },
  roadmap: {
    summary: "Generate a dependency-aware scored roadmap for the backlog",
    usage: "roadmap\nroadmap --apply\nroadmap --next <N>\nroadmap --dry-run",
    section: "backlog",
  },
  backfill: {
    summary: "Preview or apply OpenSpec coverage for legacy behavior (spec-only PR)",
    usage: "backfill\nbackfill --apply\nbackfill --apply --capability <name>",
    section: "backlog",
  },
  merge: {
    summary: "Human-only squash merge of a ready-to-deploy PR (never called by the advance loop)",
    usage: "merge <pr>",
    section: "release",
  },
  release: {
    summary: "Prepare a release PR for the given version",
    usage: "release <version>\nrelease <version> --dry-run\nrelease <version> --edit",
    section: "release",
  },
  logs: {
    summary: "List or stream pipeline run logs (terminal or structured events)",
    usage: "logs [<run-id>]\nlogs <run-id> --follow\nlogs <run-id> --events --follow",
    section: "observe",
  },
  path: {
    summary: "Print resolved install/engine paths for this host",
    usage: "path\npath --json",
    section: "ops",
  },
  config: {
    summary: "Config schema/validate/sync and repo-map maintenance for .github/pipeline.yml",
    usage: "config schema\nconfig validate\nconfig sync [--apply]\nconfig repo-map <add|remove|list>",
    section: "ops",
  },
  improve: {
    summary: "Cluster recurring run friction and optionally file backlog issues",
    usage: "improve\nimprove --apply\nimprove --top <N> --since <date> --json",
    section: "factory",
  },
  scoreboard: {
    summary: "Print read-only factory throughput/cost/reliability metrics from run artifacts",
    usage: "scoreboard\nscoreboard --days <N> --json\nscoreboard --bucket day|week\nscoreboard --by <dimension>\nscoreboard --html <path>",
    section: "factory",
  },
  queue: {
    summary: "Batch factory: dispatch pipeline:ready issues up to limits",
    usage: "queue\nqueue --max-issues <N> --concurrency <N> --budget-dollars <N>\nqueue --label <label> --milestone <m> --risk <r>",
    section: "factory",
  },
  loop: {
    summary: "Start, resume, or audit a durable multi-item run (in-repo supervisor)",
    usage: "loop --milestone <name>\nloop --resume <run-id>\nloop --audit\nloop --resume <run-id> --audit --follow\nloop logs [<run-id>] [--events] [-f]",
    section: "factory",
  },
  "refine-spec": {
    summary: "Refine an existing issue title/body into a decision-complete spec (non-mutating JSON)",
    usage: 'refine-spec --title "<t>" --body "<b>"\nrefine-spec --title "<t>" --body "<b>" --json',
    section: "backlog",
  },
  "remove-worktree": {
    summary: "Remove issue N's on-disk worktree and local branch",
    usage: "N --remove-worktree\nN --remove-worktree --force\nN --remove-worktree --json",
    section: "ops",
  },
  evals: {
    summary: "Manifest-driven offline experiment runner (plan/run/grade/report/harvest); never writes production GitHub",
    usage: "evals plan <manifest.json>\nevals run <manifest.json>\nevals grade <experiment-dir>\nevals report <experiment-dir> --baseline <treatment_id>\nevals harvest <request.json> [--apply] [--plan-only]",
    section: "evals",
  },
  correction: {
    summary: "Record a structured correction event or attribute a control disposition",
    usage: "correction record …\ncorrection attribute …",
    section: "factory",
  },
  report: {
    summary: "Preview or submit a privacy-safe product-fault report (opt-in; inert when disabled)",
    usage: "report\nreport --yes",
    section: "ops",
  },

  // Hidden / legacy — retained for dispatch only.
  run: {
    summary: "Legacy alias for advance (non-detach); not listed in operator docs",
    usage: "run <N>",
    documented: false,
    section: "hidden",
  },
  papercut: {
    summary: "Agent-facing friction logger (hidden from --help and host command menus)",
    usage: 'papercut --message "<text>"',
    documented: false,
    section: "hidden",
  },
};

/** True when the keyword should appear in generated operator docs. */
export function isDocumentedCommand(keyword: string): boolean {
  const doc = COMMAND_DOCS[keyword];
  if (!doc) return false;
  if (doc.documented === false) return false;
  return keyword in COMMAND_REGISTRY;
}

/** Documented registry keywords in stable docs order (section then name). */
export function listDocumentedCommands(): string[] {
  const SECTION_ORDER = [
    "advance",
    "observe",
    "ops",
    "backlog",
    "release",
    "factory",
    "evals",
    "hidden",
  ];
  const keys = Object.keys(COMMAND_REGISTRY).filter(isDocumentedCommand);
  return keys.sort((a, b) => {
    const da = COMMAND_DOCS[a]!;
    const db = COMMAND_DOCS[b]!;
    const sa = SECTION_ORDER.indexOf(da.section ?? "ops");
    const sb = SECTION_ORDER.indexOf(db.section ?? "ops");
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });
}
