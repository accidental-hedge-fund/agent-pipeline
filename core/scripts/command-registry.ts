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

  // Canonical one-item autonomous drive. Unlike `advance`, this command owns a
  // durable one-item loop and delegates each whole-item attempt back through
  // the normal advance state machine.
  single: {
    needsIssueNumber: true,
    allowedFlags: new Set(["repoPath", "base", "profile", "engineTrack"]),
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
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "json",
      "isOk",
      "failFast",
      "doctor",
      "harnessSmoke",
      "engineTrack",
    ]),
    needsConfig: true,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  release: {
    needsIssueNumber: false,
    // prepare: version + dryRun/edit; finish: pr number + json (positional finish <pr>)
    allowedFlags: new Set(["repoPath", "base", "dryRun", "edit", "release", "json", "skipFrg", "allowOpenSoakDefects", "packedCandidate"]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
  },

  // Operator milestone shipment. Pipeline owns lifecycle convergence;
  // the host process supervisor owns only restart policy. Grant flags are
  // parked and not required.
  ship: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "milestone",
      "for",
      "authorization",
      "json",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
  },

  // Factory Reliability Gate (#723): score a durable loop / fixture pack and
  // write immutable evidence under .agent-pipeline/frg/<version>/. Never merges
  // or tags. --from-run scores an existing loop; no gh required for scoring.
  "factory-gate": {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "json",
      "for",
      "fromRun",
      "label",
      "milestone",
      "closePack",
      "observations",
      "scenario",
      "promotePinOnPass",
      "engineTrack",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  // Durable 1.34+ FRG generation + prepare-only release handoff (#953 / #908).
  // Nested verb: factory-release prepare --request <abs> --json.
  // Two-call protocol; never merges/tags/promotes. mutatesGitHub true only on
  // the post-attestation call that opens/reconciles the release PR via shared
  // runRelease.
  "factory-release": {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "json", "request"]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
  },

  // Two-track production pin (#762): show / init / promote / rollback.
  // Never merges or tags. Writes only the repo pin JSON under .agent-pipeline/.
  "engine-promote": {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "for",
      "host",
      "json",
      "dryRun",
      "gitSha",
      "skipInstall",
      "skipFrg",
    ]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: true,
  },

  "factory-pin": {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "json",
      "for",
      "fromFrg",
      "to",
      "gitSha",
      "force",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  intake: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "dryRun", "description", "release"]),
    needsConfig: false,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  // Epic work-breakdown (#766): dry-run default; GitHub writes only under --apply.
  decompose: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "epic",
      "description",
      "apply",
      "release",
      "maxChildren",
      "maxEffort",
      "allowXl",
      "dryRun",
    ]),
    needsConfig: true,
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

  // Operator-authorized merge-queue (#676/#675): sequential R2D merges +
  // optional prepare-only release-when-complete + optional surgical repair
  // holds. Dry-run remains the default. A caller validates any external
  // operator authority; this command does not load external grant state.
  // Allowlist keeps merge/release/repair flags explicit; never auto_merge.
  // mutatesGitHub true when --apply (merges/repair) or release prepare runs.
  "merge-queue": {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "milestone",
      "apply",
      "dryRun",
      "repair",
      "releaseWhenComplete",
      "releaseVersion",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: false,
  },

  // Integrated train (factory simplification Phase 1): ordered advance, optional
  // merge-between via existing merge surface + squash-aware base containment.
  // Loop-isolated — never called from advance stage dispatch. No auto_merge.
  train: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "milestone",
      "issues",
      "merge",
      "json",
      "dryRun",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
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
    allowedFlags: new Set(["repoPath", "title", "body", "json", "issue", "proposalFile"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  // Native grill-with-docs admission (#1369). No positional issue number.
  // Selectors reuse existing Commander flags; exactly one form per invocation.
  grill: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "issue",
      "issues",
      "milestone",
      "label",
      "dryRun",
      "json",
      "follow",
      "resume",
      "runId",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
  },

  logs: {
    needsIssueNumber: false,
    // untilTerminal: advance `logs … --events --follow` until-terminal (#725)
    allowedFlags: new Set(["repoPath", "follow", "events", "untilTerminal"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // loop (#451, internalized #512): a self-contained durable run, not an
  // external hand-off. It runs the deterministic loop preflight (argument
  // normalization, loop:store-schema-compatibility, native-/goal capability),
  // then drives the run entirely in-repo through this skill's own loop
  // supervisor — never an externally installed goal-loop skill. It never
  // touches gh or the repo config, and performs no external mutation of its
  // own on any path.
  // loop (#451/#512): start/resume/audit a durable multi-item run. Nested
  // `pipeline loop logs` (#666/#699) is an observation-only sub-verb that reuses
  // the root `--events`/`--follow`/`--until-terminal` flags; those are
  // allowlisted here so a nested logs invocation that still hits flag
  // validation is not rejected. The logs path itself is dispatched before
  // preflight/supervisor (see pipeline.ts).
  loop: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "profile",
      "milestone",
      "label",
      "range",
      "roadmapSlice",
      "resume",
      "audit",
      "newRun",
      "follow",
      "events",
      "untilTerminal",
      "engineTrack",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  summary: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "domain"]),
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

  // Production/rework outcome ingest + list (#576). Host-local store only;
  // never mutates GitHub labels, stages, worktrees, or merge state.
  outcomes: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "json",
      "dryRun",
      "days",
      "adapter",
      "retentionDays",
      "fixture",
    ]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: true,
  },

  // Intent-lineage graph export / impact / propose / ingest (#599). Host-local
  // store only; never mutates GitHub, stages, worktrees, or merge state.
  lineage: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "json",
      "dryRun",
      "retentionDays",
      "fixture",
      "runId",
      "nodeId",
      "newRevision",
      "newHash",
      "evidenceNodeId",
      "includeRecords",
    ]),
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

  // recover-parked (#1061): one supervisor senior pass per park fingerprint.
  // May record audited overrides and re-enter advance; never authorizes merge.
  "recover-parked": {
    needsIssueNumber: true,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "domain",
      "json",
      "dryRun",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
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
    allowedFlags: new Set([
      "repoPath", "base", "profile", "fixtures", "baseline", "judge", "apply", "planOnly", "out",
      "trajectoryMaxEvents", "trajectoryMaxBytes", "linkArtifacts",
      "engineTrack",
    ]),
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

  // Human-question handoff (#647): list/show are non-mutating; answer/reject/
  // supersede are audited local mutations (and optional comment) — not merge.
  handoff: {
    needsIssueNumber: false,
    allowedFlags: new Set([
      "repoPath",
      "base",
      "profile",
      "domain",
      "json",
      "issue",
      "runId",
      "filterStatus",
      "batch",
      "text",
      "reason",
      "clientRequestId",
      "question",
      "class",
      "capability",
      "candidateSha",
      "resumeTarget",
    ]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: true,
    supportsJson: true,
  },

  // report (#502): operator-facing `pipeline report` — builds a sanitized
  // product-fault payload, previews it, and (only after explicit operator
  // confirmation) submits it to the configured intake service, or prepares a
  // manual GitHub issue draft when no intake is configured. Reads the
  // `product_fault` config block directly (gh-free) rather than via
  // resolveConfig, so it stays inert and works unauthenticated when reporting
  // is disabled or absent. needsGhAuth/mutatesGitHub are both false: the
  // client itself never calls `gh` and never creates an upstream issue.
  report: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "yes"]),
    needsConfig: false,
    needsGhAuth: false,
    mutatesGitHub: false,
    supportsJson: false,
  },

  // controls check (#695): read-only repository-control drift compare.
  // Never mutates branch protection, rulesets, or required checks.
  controls: {
    needsIssueNumber: false,
    allowedFlags: new Set(["repoPath", "base", "profile", "json", "strict"]),
    needsConfig: true,
    needsGhAuth: true,
    mutatesGitHub: false,
    supportsJson: true,
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
 * Whether the early CLI `--json` guard should allow this invocation.
 *
 * Prefer the registry's `supportsJson` bit so new JSON-capable commands (e.g.
 * `train`, `engine-promote`) do not need a hand-maintained string list in
 * `pipeline.ts`. Flag-only modes still need explicit overrides:
 * - `pipeline doctor --json` / `isDoctor`
 * - `pipeline <N> --status --json` (numeric path → advance entry, supportsJson false)
 */
export function allowsJsonFlag(input: {
  entry: CommandEntry | null;
  isDoctor?: boolean;
  statusMode?: boolean;
}): boolean {
  if (input.isDoctor || input.statusMode) return true;
  return input.entry?.supportsJson === true;
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
