## MODIFIED Requirements

### Requirement: Legacy mode-selecting flags SHALL still work and SHALL emit a single deprecation notice

For one major version, the legacy mode-selecting flag forms — `--status`, `--summary`, `--unblock`, `--override`, `--init`, and `--cleanup` — SHALL continue to perform their existing operation unchanged AND SHALL print exactly one deprecation notice naming the replacement `pipeline <command>` form. The notice SHALL be written to stderr so machine-readable stdout contracts (e.g. `--status --json`) are byte-for-byte unchanged, and the operation's exit code SHALL be unchanged. `pipeline summary <positive-integer>` SHALL preserve the legacy issue-scoped behavior by selecting the latest summary for that issue (with the same legacy fallback), while a nonnumeric `pipeline summary <run-id>` SHALL retain exact-run selection. These flag forms are slated for removal in the next major version; this change SHALL NOT remove them. The `--doctor` preflight-gate flag is a behavior modifier (run preflight, then advance) and SHALL NOT be treated as deprecated.

#### Scenario: Deprecated flag performs the operation and warns

- **WHEN** the user runs `pipeline 42 --status`
- **THEN** the read-only status of issue 42 SHALL be produced exactly as before
- **AND** exactly one deprecation notice SHALL be printed to stderr pointing to `pipeline status 42`
- **AND** the process exit code SHALL be identical to the pre-change `--status` behavior

#### Scenario: Deprecation notice does not corrupt machine-readable output

- **WHEN** the user runs `pipeline 42 --status --json`
- **THEN** stdout SHALL contain only the same JSON payload as before this change
- **AND** the deprecation notice SHALL appear on stderr, not stdout

#### Scenario: Direct numeric summary preserves issue-scoped selection

- **WHEN** the user migrates `pipeline 42 --summary` to `pipeline summary 42`
- **THEN** the CLI SHALL print the most recent summary for issue 42 with the same legacy fallback behavior
- **AND** it SHALL NOT reinterpret `42` as an exact run-directory id

#### Scenario: The preflight-gate flag is not deprecated

- **WHEN** the user runs `pipeline 42 --doctor`
- **THEN** the preflight checks SHALL run and, on success, the advance loop SHALL proceed
- **AND** no deprecation notice SHALL be emitted for `--doctor`

---

### Requirement: The `run` keyword SHALL be collapsed into `--detach` at the user-facing surface

The detached-launch surface SHALL be `pipeline N --detach`: the `--detach` modifier SHALL be honored on the base advance command and SHALL perform the same detached launch that `pipeline run N --detach` performs. No `run` entry SHALL be advertised in host SKILL command tables. The legacy `run` keyword SHALL be retained as an undocumented, deprecated alias (still dispatching) so the detached-launcher internals are not destabilized; it SHALL NOT appear in advertised help or documentation as a recommended surface.

#### Scenario: Detached launch via the base advance command

- **WHEN** the user runs `pipeline 42 --detach`
- **THEN** the pipeline SHALL start a detached background run for issue 42, reaching the same detached-launch entry point as `pipeline run 42 --detach`

#### Scenario: No advertised run host entry

- **WHEN** the host command surface is enumerated
- **THEN** there SHALL be no advertised `run` entry in the host SKILL command table
- **AND** the legacy `pipeline run 42` keyword SHALL still dispatch (undocumented) without error

---
