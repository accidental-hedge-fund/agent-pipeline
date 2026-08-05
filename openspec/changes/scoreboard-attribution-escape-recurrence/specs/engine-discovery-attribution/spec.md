## ADDED Requirements

### Requirement: Discovery channel SHALL be a closed four-value vocabulary

The engine SHALL define a closed `DiscoveryChannel` set with exactly these members:
`live-run`, `review-batch`, `papercut-autofile`, and `manual`. Every auto-filed issue,
blocker comment, and run-ledger event that carries discovery attribution SHALL use one of
these values. Values outside the set SHALL be rejected at write time or normalized to a
documented residual only when reading historical garbage (scoreboard diagnostics), never
written by current producers. Auto-file category provenance markers (papercut, correction,
durable-run-blocker) SHALL remain distinct from discovery-channel; all three auto-file
categories SHALL write `discovery-channel` as `papercut-autofile`.

#### Scenario: Closed set has four members

- **WHEN** a producer stamps discovery-channel on a new artifact
- **THEN** the channel value SHALL be exactly one of `live-run`, `review-batch`,
  `papercut-autofile`, or `manual`

#### Scenario: All auto-file categories share papercut-autofile channel

- **WHEN** the engine auto-files a papercut, correction, or durable-run-blocker issue
- **THEN** the discovery-channel stamp SHALL be `papercut-autofile`
- **AND** the category-specific provenance marker SHALL still identify which auto-file
  family created the issue

#### Scenario: Live advance defaults to live-run

- **WHEN** a normal issue advance or durable-loop item execution emits a run-ledger event
  that carries discovery-channel without a more specific batch context
- **THEN** the discovery-channel SHALL be `live-run`

---

### Requirement: Engine identity stamps SHALL carry version and commit SHA when resolvable

Producers SHALL stamp auto-filed issue bodies, engine-posted blocker comments, and
run-ledger events required to carry engine attribution with the producing engine `version`
string and `commit_sha` when those values are resolvable from the running engine identity.
When version or commit SHA cannot be resolved, the stamp SHALL record an explicit
unresolved marker (for example `unknown` or a null field with a sibling missingness flag)
rather than omitting identity so silently that consumers treat the artifact as
pre-attribution history. Producers SHALL NOT invent a SHA.

#### Scenario: Resolvable identity is stamped on auto-file body

- **WHEN** the engine auto-files an issue and engine version `1.31.0` and commit SHA
  `abc123…` are resolvable
- **THEN** the issue body SHALL contain machine-readable markers or fields for version
  `1.31.0` and that commit SHA
- **AND** the existing category provenance marker SHALL still be present

#### Scenario: Unresolvable SHA is explicit

- **WHEN** the engine version is known but the engine root is not a git checkout (or SHA
  resolution fails)
- **THEN** the stamp SHALL still include the version
- **AND** the commit SHA field or marker SHALL be an explicit unresolved value
- **AND** the write SHALL succeed without inventing a SHA

#### Scenario: Blocker comment carries the same identity contract

- **WHEN** the engine posts a blocker comment that parks or blocks an issue
- **THEN** the comment body SHALL include engine version and commit SHA (or explicit
  unresolved markers) and discovery-channel when known

---

### Requirement: Run-ledger events SHALL carry or inherit engine and discovery attribution

The engine SHALL ensure run-ledger events that create or classify defects, blockers, human
interventions, recovery attempt/result outcomes, or auto-file outcomes either (a) include
additive fields `engine_version`, `engine_commit_sha`, and `discovery_channel`, or
(b) inherit those values from the run's `run.json` engine identity and a documented
run-level discovery-channel default, with inheritance proven by tests. Historical events
lacking fields SHALL remain readable; consumers SHALL count them under missing-attribution
evidence rather than crash.

#### Scenario: Event includes additive attribution fields

- **WHEN** a new `human_intervention` or recovery-result event is appended under a run
  whose engine identity is known
- **THEN** the persisted event SHALL expose engine version, engine commit SHA (or explicit
  unresolved), and discovery-channel either inline or via the documented inheritance rule
  used by scoreboard collectors

#### Scenario: Historical event without fields does not crash consumers

- **WHEN** a scoreboard or attribution consumer reads a pre-change event missing the new
  fields
- **THEN** it SHALL continue aggregation
- **AND** it SHALL record missing-attribution evidence for that event rather than treating
  missing as a fabricated channel or version

---

### Requirement: GitHub-facing stamps SHALL be additive HTML comment markers

On GitHub issue bodies and blocker comments, engine and discovery attribution SHALL be
expressed as stable HTML comment markers parseable offline, additive to any existing
provenance markers. Markers SHALL pass through existing sanitization (secrets redacted;
injection denylist applied). Stamping SHALL NOT remove or rename existing
`<!-- pipeline:*-auto-filed -->` category markers used for cross-host rate-cap
reconciliation.

#### Scenario: Category marker preserved after attribution stamp

- **WHEN** an auto-filed papercut issue body is created
- **THEN** it SHALL contain the papercut auto-file provenance marker
- **AND** it SHALL contain engine version/SHA and discovery-channel markers
- **AND** rate-cap reconciliation that keys on the category marker SHALL still recognize
  the issue

#### Scenario: Secret-shaped text in free-form nearby fields is redacted

- **WHEN** adjacent free-text evidence in the same body would include a secret pattern
- **THEN** sanitization SHALL redact that span before create
- **AND** the attribution markers SHALL still be written
