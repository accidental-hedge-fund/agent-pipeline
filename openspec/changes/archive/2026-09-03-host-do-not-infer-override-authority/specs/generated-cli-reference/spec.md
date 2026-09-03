## ADDED Requirements

### Requirement: Generated CLI override summary SHALL name operator-supplied authority

The generated `docs/cli.md` entry for `pipeline override` SHALL state that the exact disposition (`"<key>: <reason>"`) is operator-supplied or explicitly approved. The summary SHALL NOT present override as an ordinary autonomous host command. Usage grammar SHALL remain `pipeline override <n> "<key>: <reason>"`. Governed recording, evidence, expiry, renewal, and auto-resume behavior SHALL stay documented as existing override behavior, not as host-inferred authorization. The docs generator check mode SHALL fail when the committed `docs/cli.md` override summary drifts from that wording.

#### Scenario: CLI reference labels override as operator-supplied

- **WHEN** a reader inspects the generated `docs/cli.md` `override` command summary
- **THEN** the summary SHALL state that the exact disposition is operator-supplied or explicitly approved
- **AND** the usage line SHALL still be `pipeline override <n> "<key>: <reason>"`

#### Scenario: Stale autonomous override summary fails docs check

- **WHEN** `docs/cli.md` describes override only as disposing a finding and auto-resuming, with no operator-supplied qualifier
- **THEN** the docs generator check mode SHALL fail
- **AND** `node scripts/build.mjs --check` SHALL still be the sole host-SKILL freshness gate
