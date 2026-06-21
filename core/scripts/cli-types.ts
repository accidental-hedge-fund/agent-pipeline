/** CLI option bag resolved by Commander and threaded through the pipeline dispatch. */
export interface CliOpts {
  status?: boolean;
  summary?: boolean;
  unblock?: string;
  override?: string;
  once?: boolean;
  dryRun?: boolean;
  domain?: string;
  repoPath?: string;
  base?: string;
  model?: string;
  profile?: string;
  cleanup?: boolean;
  init?: boolean;
  doctor?: boolean;
  failFast?: boolean;
  /** Stream lifecycle events to stdout as JSON lines (--json-events). */
  jsonEvents?: boolean;
  /** Follow mode for `pipeline logs <run-id> --follow` (-f). */
  follow?: boolean;
  // `pipeline run <N> --detach` options
  detach?: boolean;
  timeout?: number;
  flockTimeout?: number;
  /** Internal: pre-allocated #155 run-store run id, set by the detached launcher so
   *  the inner run uses the same `.agent-pipeline/runs/<run-id>` the caller was told. */
  runId?: string;
  /** Emit machine-readable JSON (for --status, the doctor command, `pipeline path`, and `pipeline config validate`). */
  json?: boolean;
  /** Doctor: silent exit-0/1 polling gate; no output. Mutually exclusive with --json. */
  isOk?: boolean;
  /** Release: skip opening $EDITOR for ROADMAP review (commit scaffolded ROADMAP as-is).
   *  Commander's `--no-edit` sets `edit: false` here. */
  edit?: boolean;
  /** Intake: short free-text description to spec into a GitHub issue. */
  description?: string;
  /** Intake/release: pin the target release slot (e.g. "v1.6.0" or "1.6.0"). */
  release?: string;
  /** Roadmap/sweep: gate GitHub write-backs (comments, PRs); default is dry-run. */
  apply?: boolean;
  /** Roadmap: emit top-N dependency-safe issues from an existing plan.json. */
  next?: number;
  /** Sweep: override the target GitHub repository (owner/repo). */
  repo?: string;
  /** Triage: target pre-pipeline stage label (ready or backlog). */
  stage?: string;
}
