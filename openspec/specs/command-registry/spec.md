# command-registry Specification

## Purpose
TBD - created by archiving change command-registry. Update Purpose after archive.
## Requirements
### Requirement: The pipeline CLI SHALL maintain a declarative command registry

The pipeline CLI SHALL maintain a `COMMAND_REGISTRY` constant in `core/scripts/command-registry.ts` mapping each recognized command keyword to a `CommandEntry` record. Each `CommandEntry` SHALL declare at minimum: `needsIssueNumber` (boolean), `allowedFlags` (a `Set<string>` of Commander option attribute names, or the sentinel `"all"` for the advance command), `mutatesGitHub` (boolean), `needsConfig` (boolean), `needsGhAuth` (boolean), and `supportsJson` (boolean). The registry SHALL be the single authoritative source for command dispatch routing and flag validation. The registry SHALL include entries for the operations promoted from mode-selecting flags to positional sub-command keywords by this change — `status`, `unblock`, `override`, and `cleanup` — and `cleanup` SHALL be dispatched as an actual positional keyword (`pipeline cleanup`), not only as the legacy `--cleanup` flag mode.

#### Scenario: Every recognized command keyword has a registry entry

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** it SHALL contain entries for every keyword the pipeline CLI recognizes: advance (the default/numeric case), init, doctor, release, intake, triage, merge, sweep, refine-spec, logs, summary, path, config, run, improve, scoreboard, roadmap, cleanup, remove-worktree, **status, unblock, and override**
- **AND** `lookupCommand("status")`, `lookupCommand("unblock")`, `lookupCommand("override")`, and `lookupCommand("cleanup")` SHALL each return a non-null entry
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

### Requirement: The CLI SHALL resolve flag-only modes to their registry entries before flag validation

When `numArg` is absent or numeric (i.e., no named subcommand is present) and a flag-only mode option is active (`--removeWorktree`, `--cleanup`, or `--init`), the CLI SHALL derive an `effectiveCommandKey` mapping to the respective registry entry (`"remove-worktree"`, `"cleanup"`, or `"init"`) and use that entry for flag validation. This prevents flag-only modes from silently inheriting the advance entry's `allowedFlags: "all"` sentinel, which would allow any flag to pass through unchecked.

When a named subcommand is present in `numArg`, the subcommand entry governs validation and the flag-only mode override SHALL NOT apply.

#### Scenario: --init flag-only mode rejects flags outside its allowlist

- **WHEN** the user invokes `pipeline --init --dry-run`
- **THEN** the CLI SHALL resolve the effective command key to `"init"` (not `"advance"`)
- **AND** `--dry-run` (attribute name `dryRun`) SHALL cause exit with code 2 because `dryRun` is not in `init.allowedFlags`
- **AND** the error message SHALL state that `--init` mode does not support the flag

#### Scenario: --cleanup flag-only mode rejects flags outside its allowlist

- **WHEN** the user invokes `pipeline --cleanup --dry-run`
- **THEN** the CLI SHALL resolve the effective command key to `"cleanup"`
- **AND** `--dry-run` SHALL cause exit with code 2 because `dryRun` is not in `cleanup.allowedFlags`

#### Scenario: --remove-worktree flag-only mode rejects flags outside its allowlist

- **WHEN** the user invokes `pipeline 42 --remove-worktree --dry-run`
- **THEN** the CLI SHALL resolve the effective command key to `"remove-worktree"`
- **AND** `--dry-run` SHALL cause exit with code 2 because `dryRun` is not in `remove-worktree.allowedFlags`

#### Scenario: Named subcommand governs validation when combined with a flag-only mode option

- **WHEN** the user invokes `pipeline intake --cleanup`
- **THEN** the `intake` registry entry SHALL govern validation (not the `cleanup` entry)
- **AND** `--cleanup` (attribute name `cleanup`) SHALL be rejected because it is not in `intake.allowedFlags`

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

### Requirement: Legacy mode-selecting flags SHALL still work and SHALL emit a single deprecation notice

For one major version, the legacy mode-selecting flag forms — `--status`, `--summary`, `--unblock`, `--override`, `--init`, and `--cleanup` — SHALL continue to perform their existing operation unchanged AND SHALL print exactly one deprecation notice naming the replacement `pipeline:<command>` (and `pipeline <command>`) form. The notice SHALL be written to stderr so machine-readable stdout contracts (e.g. `--status --json`) are byte-for-byte unchanged, and the operation's exit code SHALL be unchanged. These flag forms are slated for removal in the next major version; this change SHALL NOT remove them. The `--doctor` preflight-gate flag is a behavior modifier (run preflight, then advance) and SHALL NOT be treated as deprecated.

#### Scenario: Deprecated flag performs the operation and warns

- **WHEN** the user runs `pipeline 42 --status`
- **THEN** the read-only status of issue 42 SHALL be produced exactly as before
- **AND** exactly one deprecation notice SHALL be printed to stderr pointing to `pipeline:status` / `pipeline status 42`
- **AND** the process exit code SHALL be identical to the pre-change `--status` behavior

#### Scenario: Deprecation notice does not corrupt machine-readable output

- **WHEN** the user runs `pipeline 42 --status --json`
- **THEN** stdout SHALL contain only the same JSON payload as before this change
- **AND** the deprecation notice SHALL appear on stderr, not stdout

#### Scenario: The preflight-gate flag is not deprecated

- **WHEN** the user runs `pipeline 42 --doctor`
- **THEN** the preflight checks SHALL run and, on success, the advance loop SHALL proceed
- **AND** no deprecation notice SHALL be emitted for `--doctor`

---

### Requirement: The `run` keyword SHALL be collapsed into `--detach` at the user-facing surface

The detached-launch surface SHALL be `pipeline N --detach`: the `--detach` modifier SHALL be honored on the base advance command and SHALL perform the same detached launch that `pipeline run N --detach` performs. No `pipeline:run` host command entry SHALL be created. The legacy `run` keyword SHALL be retained as an undocumented, deprecated alias (still dispatching) so the detached-launcher internals are not destabilized; it SHALL NOT appear in advertised help or documentation as a recommended surface.

#### Scenario: Detached launch via the base advance command

- **WHEN** the user runs `pipeline 42 --detach`
- **THEN** the pipeline SHALL start a detached background run for issue 42, reaching the same detached-launch entry point as `pipeline run 42 --detach`

#### Scenario: No `pipeline:run` host entry

- **WHEN** the host command surface is enumerated
- **THEN** there SHALL be no `pipeline:run` / `$pipeline:run` entry
- **AND** the legacy `pipeline run 42` keyword SHALL still dispatch (undocumented) without error

---

### Requirement: The `--detach` dispatch SHALL guard against incompatible arguments before launching

The `--detach` mode-switch SHALL perform two safety checks **before** dispatching the detached-advance launch: first, it SHALL verify that the issue number is the only positional argument (no extra tokens such as `config validate`); second, it SHALL verify that no mode-selector flag (`--status`, `--summary`, `--unblock`, `--override`) is active alongside `--detach`. Both violations SHALL cause the process to exit with code 2 and print an explanatory message to stderr; no background process SHALL be launched. These two safety checks SHALL apply uniformly whether `--detach` is invoked via the canonical `pipeline N --detach` form or via the legacy `pipeline run N --detach` alias.

#### Scenario: Extra positionals with `--detach` are rejected before launch

- **WHEN** the user runs `pipeline 42 config validate --detach`
- **THEN** the process SHALL exit with code 2
- **AND** stderr SHALL contain "unexpected argument" (case-insensitive)
- **AND** no detached background process SHALL be launched

#### Scenario: Mode-selector flag combined with `--detach` is rejected

- **WHEN** the user runs `pipeline 42 --status --detach`
- **THEN** the process SHALL exit with code 2
- **AND** stderr SHALL contain a message naming the conflicting flag and explaining that `--detach` cannot be combined with it
- **AND** no detached background process SHALL be launched

#### Scenario: Mode-selector flag combined with `--detach` via the `run` alias is also rejected

- **WHEN** the user runs `pipeline run 42 --status --detach`
- **THEN** the process SHALL exit with code 2
- **AND** stderr SHALL contain a message indicating that `--detach` cannot be combined with `--status`
- **AND** no detached background process SHALL be launched

---

### Requirement: The `unblock` and `override` positional keywords SHALL honor the kill switch

The positional `pipeline unblock <N> "<answer>"` and `pipeline override <N> "<spec>"` keyword handlers SHALL check the kill-switch state after validating their arguments and before performing any GitHub mutation. When the kill-switch file (`/tmp/pipeline-<domain>.disabled`) is present, each SHALL print an explanatory message to stderr and exit with code 0, mirroring the same guard applied in the legacy `pipeline N --unblock` / `pipeline N --override` flag paths.

#### Scenario: `pipeline unblock` respects an active kill switch

- **WHEN** the kill-switch file `/tmp/pipeline-<domain>.disabled` is present
- **AND** the user runs `pipeline unblock 42 "fixed in #99"`
- **THEN** the process SHALL exit with code 0
- **AND** stderr SHALL contain a message indicating the kill switch is active
- **AND** no GitHub mutation (block-clear) SHALL be performed

#### Scenario: `pipeline override` respects an active kill switch

- **WHEN** the kill-switch file `/tmp/pipeline-<domain>.disabled` is present
- **AND** the user runs `pipeline override 42 "abc123: deferred #99"`
- **THEN** the process SHALL exit with code 0
- **AND** stderr SHALL contain a message indicating the kill switch is active
- **AND** no GitHub mutation (disposition record) SHALL be performed

### Requirement: The CLI SHALL universally tolerate the host-injected `--profile` flag on every command

The CLI SHALL treat the `profile` option as universally allowed during
per-command flag validation. Because the generated host wrapper
(`hosts/_shared/entry.template.mjs`) unconditionally appends `--profile
<profile>` to every core invocation, `profile` SHALL never be reported as an
offending flag for any registered command, regardless of whether that command's
`allowedFlags` set declares it, and regardless of whether the command consumes
the profile value. A registered `UNIVERSAL_FLAGS` set (containing at least
`profile`) SHALL be the single authoritative source of the flags exempted this
way, so that the exemption is explicit and testable rather than implicit. A
command that does not use the profile SHALL ignore the injected value and behave
identically to an invocation without it.

This tolerance SHALL NOT weaken the allowlist for any other flag: an
explicitly-provided option that is neither in the command's `allowedFlags` nor
in `UNIVERSAL_FLAGS` SHALL still be reported as offending and cause exit code 2.

#### Scenario: Profile-free command accepts the wrapper-injected profile

- **WHEN** a profile-free command (e.g. `refine-spec`, `scoreboard`, or
  `release`) is invoked through the host wrapper, which appends `--profile
  <profile>`
- **THEN** the flag-validation check SHALL NOT report `profile` as an offending
  flag
- **AND** the CLI SHALL NOT exit with the `cannot be combined with --profile`
  error
- **AND** the command SHALL proceed to its normal dispatch and behave identically
  to the same invocation without `--profile`

#### Scenario: Profile tolerance does not loosen the allowlist for other flags

- **WHEN** a profile-free command is invoked with an explicitly-provided option
  that is neither in its `allowedFlags` set nor in `UNIVERSAL_FLAGS` (e.g.
  `pipeline scoreboard --bogus`)
- **THEN** that option SHALL be reported as offending
- **AND** the CLI SHALL exit with code 2 naming the unsupported flag

#### Scenario: UNIVERSAL_FLAGS is the single source of universal tolerance

- **WHEN** the flag-validation logic is inspected
- **THEN** the set of flags tolerated on every command SHALL be sourced from a
  single `UNIVERSAL_FLAGS` constant
- **AND** `UNIVERSAL_FLAGS` SHALL contain `profile`
- **AND** the fix SHALL NOT be implemented by adding `profile` to individual
  per-command `allowedFlags` sets nor by a wrapper-side per-command exemption

#### Scenario: Wrapper-composed invocation matches direct invocation

- **WHEN** the host wrapper composes its argument list as
  `[...passthrough, "--profile", <profile>]` for a profile-free command
- **THEN** driving that argument list through the CLI's flag-validation path
  SHALL produce no offending flags
- **AND** the outcome SHALL match invoking the same command directly without the
  appended `--profile`

### Requirement: The command registry SHALL include a non-mutating correction entry

The `COMMAND_REGISTRY` in `core/scripts/command-registry.ts` SHALL include an entry for the
`correction` command keyword so that dispatch routing and allowlist-based flag validation cover
it through the single authoritative registry, without a per-command conflict list elsewhere.
The `correction` entry SHALL declare `mutatesGitHub: false` (its only side effect is appending
one `correction_event`), and its declared `allowedFlags` SHALL be limited to the flags the
`correction record` action needs. The entry SHALL NOT reuse the advance, unblock, override,
merge, or deploy handlers.

#### Scenario: correction is a recognized command keyword

- **WHEN** the `COMMAND_REGISTRY` is inspected
- **THEN** `lookupCommand("correction")` SHALL return a non-null entry
- **AND** the entry SHALL declare `mutatesGitHub: false`

#### Scenario: correction flag validation runs through the registry

- **WHEN** the `correction` command is invoked with a flag not in its `allowedFlags`
- **THEN** the CLI SHALL reject it with exit code 2 before any side effect, via the same allowlist-based validation used for every other registered command

#### Scenario: correction entry is not wired to a mutating handler

- **WHEN** the `correction` entry's handler is inspected
- **THEN** it SHALL NOT be the advance, unblock, override, merge, or deploy handler

