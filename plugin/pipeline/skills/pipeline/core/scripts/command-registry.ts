import type { CliOpts } from "./cli-types.ts";

/** Per-command metadata used by the CLI entry point for generic flag validation. */
export interface CommandMeta {
  /** Allowlist of CliOpts keys that are intentionally accepted for this command.
   *  The CLI entry point rejects any key that was explicitly provided via CLI
   *  but is absent from this set. */
  allowedFlags: Set<keyof CliOpts>;
  /** Whether this command mutates GitHub state (labels, comments, PRs). */
  mutatesGitHub: boolean;
  /** Whether this command requires a resolved PipelineConfig. */
  needsConfig: boolean;
  /** Whether this command requires a GitHub issue number. */
  needsIssue: boolean;
  /** Whether this command supports --json output. */
  supportsJson: boolean;
  /** Ordered list of required positional argument names (empty if none). */
  requiresArgs: string[];
}

// ---------------------------------------------------------------------------
// Helper: compute the complement of a denied-flag set over all CliOpts keys.
// Used to derive behavior-identical allowlists from the existing hand-written
// denylist guards that are being removed from main().
// ---------------------------------------------------------------------------

const ALL_CLIOPTS_KEYS: ReadonlyArray<keyof CliOpts> = [
  "status", "summary", "unblock", "override", "once", "dryRun", "domain",
  "repoPath", "base", "model", "profile", "cleanup", "init", "doctor",
  "failFast", "jsonEvents", "follow", "detach", "timeout", "flockTimeout",
  "runId", "json", "isOk", "edit", "description", "release", "apply",
  "next", "repo", "stage",
];

function allExcept(denied: ReadonlyArray<keyof CliOpts>): Set<keyof CliOpts> {
  const ex = new Set<keyof CliOpts>(denied);
  return new Set(ALL_CLIOPTS_KEYS.filter((k) => !ex.has(k)));
}

// ---------------------------------------------------------------------------
// COMMAND_REGISTRY: single source of truth for per-command flag compatibility.
//
// For commands with existing hand-written guards (merge, triage, intake,
// release, doctor): allowedFlags is the exact complement of what those guards
// denied, ensuring behavior-identical refactoring.
//
// For commands without existing guards: allowedFlags is a minimal semantic
// allowlist of flags that the command actually uses.
//
// The "advance" entry (default issue-number path) includes all CliOpts keys so
// the registry-coverage test passes — the advance path accepts every flag
// through its own per-mode validation.
// ---------------------------------------------------------------------------

export const COMMAND_REGISTRY: Record<string, CommandMeta> = {
  init: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "base", "profile", "domain", "init"]),
    mutatesGitHub: true,
    needsConfig: true,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: [],
  },

  doctor: {
    // Existing guard (line 399-406 in pipeline.ts) denied: cleanup, init.
    // Everything else is accepted — behavior-identical complement.
    allowedFlags: allExcept(["cleanup", "init"]),
    mutatesGitHub: false,
    needsConfig: true,
    needsIssue: false,
    supportsJson: true,
    requiresArgs: [],
  },

  logs: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "follow"]),
    mutatesGitHub: false,
    needsConfig: false,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: [],
  },

  path: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "json"]),
    mutatesGitHub: false,
    needsConfig: false,
    needsIssue: false,
    supportsJson: true,
    requiresArgs: [],
  },

  config: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "profile", "json"]),
    mutatesGitHub: false,
    needsConfig: false,
    needsIssue: false,
    supportsJson: true,
    requiresArgs: ["subcommand"],
  },

  run: {
    allowedFlags: new Set<keyof CliOpts>([
      "repoPath", "base", "profile", "domain", "model", "dryRun", "once",
      "doctor", "failFast", "jsonEvents", "detach", "timeout", "flockTimeout", "runId",
    ]),
    mutatesGitHub: true,
    needsConfig: true,
    needsIssue: true,
    supportsJson: false,
    requiresArgs: ["number"],
  },

  release: {
    // Existing guard (lines 407-419) denied: cleanup, init, status.
    // (The isDoctorCommand check in that guard is dead code when numArg==="release".)
    allowedFlags: allExcept(["cleanup", "init", "status"]),
    mutatesGitHub: true,
    needsConfig: false,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: ["version"],
  },

  intake: {
    // Existing guard (lines 420-441) denied: status, cleanup, init, doctor, unblock, override.
    // (The isDoctorCommand positional check is dead code when numArg==="intake".)
    allowedFlags: allExcept(["status", "cleanup", "init", "doctor", "unblock", "override"]),
    mutatesGitHub: true,
    needsConfig: false,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: [],
  },

  roadmap: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "base", "profile", "apply", "next", "dryRun"]),
    mutatesGitHub: false,
    needsConfig: true,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: [],
  },

  sweep: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "base", "profile", "apply", "repo", "dryRun"]),
    mutatesGitHub: false,
    needsConfig: true,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: [],
  },

  triage: {
    // Existing guard (lines 641-661) denied: dryRun, status, summary, cleanup,
    // init (flag), doctor (flag), unblock, override, detach.
    // (isDoctorCommand positional check is dead code when numArg==="triage".)
    allowedFlags: allExcept([
      "dryRun", "status", "summary", "cleanup", "init",
      "doctor", "unblock", "override", "detach",
    ]),
    mutatesGitHub: true,
    needsConfig: true,
    needsIssue: true,
    supportsJson: false,
    requiresArgs: ["issue"],
  },

  merge: {
    // Existing guard (lines 363-378) allowed only: repoPath, base, profile.
    // All other flags are rejected — behavior-identical.
    allowedFlags: new Set<keyof CliOpts>(["repoPath", "base", "profile"]),
    mutatesGitHub: true,
    needsConfig: true,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: ["pr"],
  },

  summary: {
    allowedFlags: new Set<keyof CliOpts>(["repoPath"]),
    mutatesGitHub: false,
    needsConfig: false,
    needsIssue: false,
    supportsJson: false,
    requiresArgs: ["run-id"],
  },

  // Default advance path (positional issue/PR number). Accepts the full CliOpts
  // surface; per-mode validation happens inside runAdvance and the mode-dispatch
  // guards that remain in main() after this registry is introduced.
  advance: {
    allowedFlags: new Set<keyof CliOpts>(ALL_CLIOPTS_KEYS),
    mutatesGitHub: true,
    needsConfig: true,
    needsIssue: true,
    supportsJson: true,
    requiresArgs: ["number"],
  },
};
