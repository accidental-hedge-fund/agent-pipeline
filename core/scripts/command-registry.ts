// Declarative command registry for the pipeline CLI.
//
// Each `CommandEntry` declares per-command metadata including the allowlist of
// Commander option attribute names the command accepts. Flag validation uses
// Commander's `getOptionValueSource` to check only explicitly-provided CLI
// options — defaults and env-sourced values are ignored.
//
// This module intentionally has NO import of "commander" so it can be imported
// in test and tooling contexts without triggering CLI initialization.

export interface CommandEntry {
  needsIssueNumber: boolean;
  /** Attribute names (Commander camelCase) of options this command accepts,
   *  or "all" for the advance command which passes through every flag. */
  allowedFlags: Set<string> | "all";
  needsConfig: boolean;
  needsGhAuth: boolean;
  mutatesGitHub: boolean;
  supportsJson: boolean;
}

/** Minimal duck-type for Commander's Command — no "commander" import needed. */
interface CmdLike {
  options: ReadonlyArray<{ attributeName(): string; long?: string }>;
  getOptionValueSource(key: string): string | undefined;
}

/**
 * Flags injected by the host layer (e.g. the wrapper's unconditional
 * `--profile` injection) rather than chosen per-command. These are tolerated
 * on every registered command regardless of `allowedFlags`, so a profile-free
 * command invoked through the host wrapper is not rejected. This is the single
 * authoritative source for that exemption — do not add `profile` to individual
 * `allowedFlags` sets instead.
 */
export const UNIVERSAL_FLAGS: Set<string> = new Set(["profile"]);

export const COMMAND_REGISTRY: Record<string, CommandEntry> = {
  // Default/numeric path — accepts every flag so new global flags work automatically.
  advance: {
    needsIssueNumber: true,
    allowedFlags: "all",
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  init: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "init"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  doctor: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "json", "isOk", "failFast", "doctor"]),
    needsConfig: true,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  release: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "dryRun", "edit", "release"]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  intake: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "dryRun", "description", "release"]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  triage: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "stage"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  // merge uses an allowlist (not "all") so new global flags are rejected by default —
  // the exact property that prevents accidental flag leakage to an irreversible squash merge.
  merge: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  sweep: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "apply", "repo", "dryRun"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: false,
  },

  "refine-spec": {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "title", "body", "json"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  logs: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "follow", "events"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // loop (#451) is a delegating entry, not a CLI forward: it runs the
  // deterministic loop preflight (argument normalization, loop:contract-coherence,
  // native-/goal capability) and then hands off to the installed goal-loop skill.
  // It never touches gh or the repo config, and performs no external mutation
  // of its own on any path.
  loop: {
    needsIssueNumber: false,
    allowedFlags: new Set(["profile", "milestone", "label", "range", "roadmapSlice", "resume", "audit"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  summary: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  path: {
    needsIssueNumber: false,
    allowedFlags: new Set(["json", "repoPath"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  config: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "profile", "json", "apply", "rel"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  // run is an alias for advance in non-detach mode; allow all flags so that
  // `pipeline run <N> [advance-flags...]` behaves identically to `pipeline <N>`.
  run: {
    needsIssueNumber: true,
    allowedFlags: "all",
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  improve: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath", "apply", "top", "since", "minOccurrences", "json", "interventions",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  scoreboard: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "since", "until", "days", "json", "estimateCost", "bucket", "by", "correctionsBy", "html"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  roadmap: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "apply", "next", "dryRun"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: false,
  },

  queue: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath", "base", "profile",
      "maxIssues", "budgetDollars", "concurrency", "maxFailureRate",
      "label", "milestone", "risk",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // status, unblock, and override were previously flag-only modes; they are now
  // also dispatched as positional keyword sub-commands so they can be exposed as
  // discoverable pipeline:<command> host entries.
  status: {
    needsIssueNumber: true,
    allowedFlags: new Set(["repoPath", "base", "profile", "domain", "json"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: true,
  },

  unblock: {
    needsIssueNumber: true,
    allowedFlags: new Set(["repoPath", "base", "profile", "domain"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  // override re-enters the advance loop after recording the disposition, so it
  // accepts all flags that the advance command accepts.
  override: {
    needsIssueNumber: true,
    allowedFlags: "all",
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  // cleanup is registered both for the legacy --cleanup flag mode and as an
  // actually-dispatched positional keyword (`pipeline cleanup`).
  cleanup: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "cleanup"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: false,
  },

  "remove-worktree": {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "removeWorktree", "force", "json"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: true,
  },

  backfill: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "apply", "capability"]),
    needsConfig: true,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // evals never touches GitHub (mutatesGitHub: false is the property the
  // no-production-writes guarantee is documented by) and never needs gh auth —
  // it replays frozen fixtures offline. `pipeline evals plan|run <manifest>`;
  // `pipeline evals grade|report <experiment-dir>` (#433) grade/report only
  // read/write files under the experiment dir — never a pipeline gate.
  // `pipeline evals harvest <request.json>` (#535) is draft-only by default;
  // `--apply`/`--plan-only`/`--out` gate/steer the harvest workflow's own
  // repo-local fixture write — never a GitHub write.
  evals: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "fixtures", "baseline", "judge", "apply", "planOnly", "out"]),
    needsConfig: true,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // papercut is agent-facing, not human-facing (#419): registered and directly
  // invocable by name, but hidden from `--help` and the generated host
  // pipeline:<command> surface — see dispatch in pipeline.ts and the exclusion
  // in scripts/build.mjs.
  papercut: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "profile", "run", "message", "since", "until", "json"]),
    needsConfig: true,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  // correction (#499, #501): `pipeline correction record` and `pipeline
  // correction attribute` — narrow, non-mutating commands whose only side
  // effect is one appended, sanitized record (a correction_event or a
  // control_attribution). mutatesGitHub:false and needsGhAuth:false are the
  // properties that back both subcommands' authority boundary: neither is
  // ever wired to the advance, unblock, override, merge, or deploy handlers,
  // and no issue-close or PR-merge path writes a control_attribution.
  correction: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath", "profile", "issue", "runId", "sourceKind", "failureClass",
      "stage", "evidenceRef", "correctionText", "reusable", "proposedControl",
      "reviewedSha", "headSha",
      // correction attribute (#501)
      "correctionKey", "controlType", "disposition", "pr", "effectiveCommit",
      "effectiveRelease", "effectiveAt", "supersedes", "note",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },
};

/**
 * Return the registry entry for `keyword`, or `null` for unrecognized keywords.
 * A numeric string (e.g. "123") or `undefined` maps to the advance entry — both
 * represent the default "advance issue N" mode.
 */
export function lookupCommand(keyword: string | undefined): CommandEntry | null {
  if (keyword === undefined || /^\d+$/.test(keyword)) {
    return COMMAND_REGISTRY.advance;
  }
  return COMMAND_REGISTRY[keyword] ?? null;
}

/**
 * Return the attribute names of options that were explicitly provided on the CLI
 * (via `cmd.getOptionValueSource(key) === "cli"`) but are not in
 * `entry.allowedFlags`. Returns an empty array when `allowedFlags === "all"`.
 */
export function validateFlags(entry: CommandEntry, cmd: CmdLike): string[] {
  if (entry.allowedFlags === "all") return [];
  const allowed = entry.allowedFlags;
  return cmd.options
    .map((o) => o.attributeName())
    .filter(
      (key) =>
        !allowed.has(key) &&
        !UNIVERSAL_FLAGS.has(key) &&
        cmd.getOptionValueSource(key) === "cli",
    );
}
