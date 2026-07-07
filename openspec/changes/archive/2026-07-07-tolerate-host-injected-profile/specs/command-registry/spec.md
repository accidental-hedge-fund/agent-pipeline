## ADDED Requirements

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
