## MODIFIED Requirements

### Requirement: The pipeline CLI SHALL maintain a declarative command registry

The pipeline CLI SHALL maintain a `COMMAND_REGISTRY` constant in `core/scripts/command-registry.ts` mapping each recognized command keyword to a `CommandEntry` record. Each `CommandEntry` SHALL declare at minimum: `needsIssueNumber` (boolean), `allowedFlags` (a `Set<string>` of Commander option attribute names, or the sentinel `"all"` for the advance command), `mutatesGitHub` (boolean), `needsConfig` (boolean), `needsGhAuth` (boolean), and `supportsJson` (boolean). The registry SHALL be the single authoritative source for command dispatch routing and flag validation. The registry SHALL include entries for the operations promoted from mode-selecting flags to positional sub-command keywords by this change — `status`, `unblock`, `override`, and `cleanup` — and `cleanup` SHALL be dispatched as an actual positional keyword (`pipeline cleanup`), not only as the legacy `--cleanup` flag mode. The registry SHALL also include the human-invoked `merge-queue` keyword for selector-based ready-to-deploy queue planning.

#### Scenario: Every recognized command keyword has a registry entry

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** it SHALL contain entries for every keyword the pipeline CLI recognizes: advance (the default/numeric case), init, doctor, release, intake, triage, merge, merge-queue, sweep, refine-spec, logs, summary, path, config, run, improve, scoreboard, roadmap, cleanup, remove-worktree, **status, unblock, and override**
- **AND** `lookupCommand("status")`, `lookupCommand("unblock")`, `lookupCommand("override")`, and `lookupCommand("cleanup")` SHALL each return a non-null entry
- **AND** `lookupCommand("merge-queue")` SHALL return a non-null entry
- **AND** `lookupCommand("unknown-cmd")` SHALL return `null`
- **AND** `lookupCommand(undefined)` SHALL return the advance entry

#### Scenario: Registry lookup is the single source for dispatch routing

- **WHEN** a new sub-command is added to the pipeline CLI
- **THEN** adding it to `COMMAND_REGISTRY` SHALL be sufficient to register it for dispatch routing and flag validation, without editing any per-command conflict list elsewhere in `pipeline.ts`

#### Scenario: Promoted keyword entries declare correct issue-number metadata

- **WHEN** the registry entries for `status`, `unblock`, and `override` are inspected
- **THEN** each SHALL declare `needsIssueNumber: true` (these operations act on an issue/PR number, e.g. `pipeline status 42`)
- **AND** the `cleanup` entry SHALL declare `needsIssueNumber: false` (it takes no issue number)
- **AND** each promoted entry's handler SHALL be the same handler the corresponding legacy flag invoked, so the operation's behavior is unchanged

## ADDED Requirements

### Requirement: The `merge-queue` registry entry SHALL declare dry-run-safe metadata and an explicit flag allowlist
The `merge-queue` command entry in `COMMAND_REGISTRY` SHALL declare `needsIssueNumber: false`, `needsConfig: true`, `needsGhAuth: true`, and `mutatesGitHub: false` for the dry-run-only implementation of this change. Its `allowedFlags` SHALL be an allowlist (not `"all"`) that includes at least the Commander attribute names for `--milestone`, `--dry-run`, `--repo-path`, `--base`, and `--profile`, and SHALL reject any other explicitly provided global option with exit code 2 before GitHub mutation or planning side effects that depend on rejected flags. Unsupported flags SHALL be named in the error message.

#### Scenario: merge-queue entry is non-mutating and does not need an issue number
- **WHEN** the registry entry for `merge-queue` is inspected
- **THEN** it SHALL declare `needsIssueNumber: false`
- **AND** it SHALL declare `mutatesGitHub: false` while only dry-run is implemented

#### Scenario: Unsupported flag is rejected on merge-queue
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.0.0"` with an explicitly provided option outside the merge-queue allowlist
- **THEN** the CLI SHALL exit with code 2 naming the offending flag
- **AND** SHALL NOT merge any PR

#### Scenario: Allowlisted milestone and dry-run flags are accepted
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.0.0" --dry-run`
- **THEN** the allowlist guard SHALL NOT reject the invocation
- **AND** the command SHALL proceed to selector validation and planning
