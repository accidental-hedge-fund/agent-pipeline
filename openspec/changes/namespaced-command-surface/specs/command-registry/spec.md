## MODIFIED Requirements

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

## ADDED Requirements

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
