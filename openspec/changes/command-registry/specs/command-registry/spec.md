## ADDED Requirements

### Requirement: The pipeline CLI SHALL maintain a declarative command registry

The pipeline CLI SHALL maintain a `COMMAND_REGISTRY` constant in `core/scripts/command-registry.ts` mapping each recognized command keyword to a `CommandEntry` record. Each `CommandEntry` SHALL declare at minimum: `needsIssueNumber` (boolean), `allowedFlags` (a `Set<string>` of Commander option attribute names, or the sentinel `"all"` for the advance command), `mutatesGitHub` (boolean), `needsConfig` (boolean), `needsGhAuth` (boolean), and `supportsJson` (boolean). The registry SHALL be the single authoritative source for command dispatch routing and flag validation.

#### Scenario: Every recognized command keyword has a registry entry

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** it SHALL contain entries for every keyword the pipeline CLI recognizes: advance (the default/numeric case), init, doctor, release, intake, triage, merge, sweep, refine-spec, logs, summary, path, config, run, improve, scoreboard, cleanup, remove-worktree
- **AND** `lookupCommand("unknown-cmd")` SHALL return `null`
- **AND** `lookupCommand(undefined)` SHALL return the advance entry

#### Scenario: Registry lookup is the single source for dispatch routing

- **WHEN** a new sub-command is added to the pipeline CLI
- **THEN** adding it to `COMMAND_REGISTRY` SHALL be sufficient to register it for dispatch routing and flag validation, without editing any per-command conflict list elsewhere in `pipeline.ts`

---

### Requirement: The CLI SHALL enforce allowlist-based flag validation via the registry for every registered command

For every registered command whose `allowedFlags` is NOT the `"all"` sentinel, the CLI SHALL verify — before ANY config resolution, GitHub API call, or mutating operation — that every option explicitly provided on the command line (i.e., `cmd.getOptionValueSource(key) === "cli"`) appears in that command's `allowedFlags` set. Any offending option attribute name SHALL cause the CLI to exit with code 2 and an error message naming the unsupported flag(s) and the command. The check SHALL be allowlist-based (reject everything not declared), not denylist-based, so that adding a new global option to `buildCmd()` does NOT automatically pass through to commands that do not declare it.

#### Scenario: Unsupported flag is rejected before any mutating operation

- **WHEN** the user invokes any registered command with an explicitly-provided option that is not in that command's `allowedFlags`
- **THEN** the CLI SHALL exit with code 2 and an error naming the offending option(s) BEFORE any config resolution, GitHub API call, or file write

#### Scenario: New global option does not leak into non-declaring commands

- **WHEN** a new global option is added to `buildCmd()` and that option's attribute name is NOT added to a command's `allowedFlags` set
- **THEN** providing that option to that command on the command line SHALL be rejected with exit code 2 without any code change to the per-command validation logic

#### Scenario: Advance command accepts all flags

- **WHEN** the user invokes the advance command (a numeric issue number) with any combination of options defined in `buildCmd()`
- **THEN** the flag allowlist check SHALL NOT reject any option (the advance entry uses `allowedFlags: "all"`)

#### Scenario: Allowed options pass without error

- **WHEN** the user invokes any registered command with an option that IS in that command's `allowedFlags`
- **THEN** the allowlist check SHALL pass silently and the command SHALL proceed to its normal dispatch logic

#### Scenario: The merge command's existing allowlist behavior is preserved

- **WHEN** the user invokes `pipeline merge 42` with any option other than `--repo-path`, `--base`, or `--profile`
- **THEN** the CLI SHALL exit with code 2 and an error naming the offending option BEFORE the squash merge is attempted
- **AND** the error message SHALL state that `pipeline merge` does not support the flag

---

### Requirement: The registry's `allowedFlags` sets SHALL be cross-validated against `buildCmd()` by the test suite

The test suite SHALL include a cross-check test that compares every attribute name in every `CommandEntry.allowedFlags` set against the set of attribute names returned by `buildCmd().options.map(o => o.attributeName())`. An `allowedFlags` entry that names an attribute no longer defined in `buildCmd()` SHALL cause the test to fail, surfacing flag-rename drift before it reaches production.

#### Scenario: Cross-check catches a stale allowlist entry after a flag rename

- **WHEN** a flag is renamed in `buildCmd()` (e.g., `--repo-path` is renamed to `--repo-dir`, changing the attribute name from `repoPath` to `repoDir`) and a command's `allowedFlags` still lists the old attribute name `repoPath`
- **THEN** the cross-check test SHALL fail with a message identifying the stale attribute name
- **AND** no production code change is required to trigger the failure

---

### Requirement: The command-registry module SHALL be importable without importing the CLI

The `command-registry.ts` module SHALL export `CommandEntry`, `COMMAND_REGISTRY`, `lookupCommand`, and `validateFlags` without importing Commander (`import { Command } from "commander"`) at module load time. Callers that need Commander integration SHALL import both modules separately.

#### Scenario: Registry helpers import cleanly in a test context

- **WHEN** a test imports `{ lookupCommand, validateFlags, COMMAND_REGISTRY }` from `./command-registry.ts`
- **THEN** the import SHALL succeed without pulling in `commander`, `process.argv` parsing, or any CLI initialization side-effect
