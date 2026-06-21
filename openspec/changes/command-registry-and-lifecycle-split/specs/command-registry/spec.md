## ADDED Requirements

### Requirement: A declarative command registry SHALL enumerate every CLI subcommand with its flag allowlist and capability metadata

`command-registry.ts` SHALL export a `COMMAND_REGISTRY` map keyed by subcommand name. Each entry SHALL carry: `allowedFlags` (a `Set<keyof CliOpts>` allowlist), `mutatesGitHub` (boolean), `needsConfig` (boolean), `needsIssue` (boolean), `supportsJson` (boolean), and `requiresArgs` (ordered list of required positional argument names). The CLI entry point SHALL use this registry as the single source of truth for per-command flag compatibility — no command SHALL rely solely on a bespoke, hand-written guard block for flags that are categorically inapplicable.

#### Scenario: Registry entry exists for every recognized subcommand

- **WHEN** the `COMMAND_REGISTRY` map is inspected
- **THEN** it SHALL contain an entry for every subcommand name that `main()` recognizes: `init`, `doctor`, `logs`, `path`, `config`, `run`, `release`, `intake`, `roadmap`, `sweep`, `triage`, `merge`, `summary`, and the default advance command
- **AND** each entry SHALL have a non-null `allowedFlags` set

#### Scenario: Unrecognized subcommand is rejected before config resolution

- **WHEN** the user invokes `pipeline <word>` where `<word>` is not a digit and not in `COMMAND_REGISTRY`
- **THEN** the CLI SHALL exit with code 2 and print a message naming the unrecognized sub-command and listing the recognized ones
- **AND** no config resolution or GitHub API call SHALL occur

### Requirement: The CLI entry point SHALL use the registry's allowedFlags to reject disallowed flags for every command

For every command whose registry entry defines an `allowedFlags` set, the CLI entry point SHALL iterate the parsed options and reject any flag whose `getOptionValueSource` is `"cli"` and whose key is absent from the entry's `allowedFlags`. The error message SHALL name every offending flag in a single combined diagnostic.

#### Scenario: A flag disallowed for 'merge' is rejected before the merge handler runs

- **WHEN** the user runs `pipeline merge 42 --json`
- **THEN** the CLI SHALL exit with code 2 naming `--json` as disallowed for `pipeline merge`
- **AND** no `mergePr` call SHALL be made

#### Scenario: A flag disallowed for 'triage' is rejected before the triage handler runs

- **WHEN** the user runs `pipeline triage 7 --stage ready --dry-run`
- **THEN** the CLI SHALL exit with code 2 naming `--dry-run` as disallowed for `pipeline triage`
- **AND** no config resolution or label mutation SHALL occur

#### Scenario: A flag listed in a command's allowedFlags is accepted

- **WHEN** the user runs a command with a flag present in that command's `allowedFlags`
- **THEN** the CLI SHALL not reject the flag on account of the registry
- **AND** SHALL proceed to the command's normal validation and dispatch

### Requirement: The registry coverage SHALL be complete over all CliOpts keys

A test SHALL assert that every key of `CliOpts` appears in the `allowedFlags` of at least one registry entry. A new flag added to `buildCmd()` but omitted from every registry entry SHALL cause this test to fail.

#### Scenario: Missing flag in all registry entries causes test failure

- **WHEN** a new option key is added to the `CliOpts` interface and `buildCmd()` but is absent from every `allowedFlags` set in the registry
- **THEN** the registry-coverage unit test SHALL fail with a message identifying the missing key

#### Scenario: All current CliOpts keys are covered

- **WHEN** the registry-coverage test runs against the current `COMMAND_REGISTRY`
- **THEN** every key in a representative `CliOpts` object SHALL appear in at least one entry's `allowedFlags`
- **AND** the test SHALL pass

### Requirement: Golden CLI parsing tests SHALL cover every command × disallowed-flag combination currently guarded in main()

Unit tests SHALL invoke `buildCmd().parse(argv)` on synthetic argument slices for every known command × disallowed-flag pairing that `main()` currently rejects via a hand-written guard, and SHALL assert that the process would exit with code 2.

#### Scenario: Existing merge + disallowed-flag rejections are covered by golden tests

- **WHEN** the golden CLI test suite runs the 'merge' command with flags outside its allowedFlags (e.g. `--json`, `--status`, `--detach`)
- **THEN** each test case SHALL assert the CLI exits with code 2 before dispatching any handler

#### Scenario: Existing intake + disallowed-flag rejections are covered by golden tests

- **WHEN** the golden CLI test suite runs `pipeline intake` with each flag from the current intake-conflict list (e.g. `--status`, `--cleanup`, `--unblock`)
- **THEN** each test case SHALL assert the CLI exits with code 2
