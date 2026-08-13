## ADDED Requirements

### Requirement: Evidence bundle SHALL record pre-code attestation gate outcomes

The evidence bundle SHALL record a pre-code attestation section for every run that reaches the
`pre-code-attestation` stage position. The section SHALL include at least: whether the gate was
enabled, the trigger evaluation result (`triggered`, `matched`, `reason`), and when triggered: dossier
revision or content hash, attestation decision records (if any), authorization resolution summary,
and wait or integrity outcome codes. Inert skips SHALL still record `gate-disabled` or
`no-trigger-matched`.

#### Scenario: inert skip recorded

- **WHEN** the pre-code attestation stage advances with reason `gate-disabled`
- **THEN** the finalized evidence bundle SHALL include that reason under the pre-code attestation section

#### Scenario: approve recorded with hashes

- **WHEN** a triggered run accepts an approve attestation
- **THEN** the evidence bundle SHALL include the dossier hash/revision, policy hash/revision, actor, decision, and authorization resolution summary

#### Scenario: reject and unauthorized attempts preserved

- **WHEN** a reject decision or unauthorized approve attempt occurs
- **THEN** the evidence bundle SHALL preserve that outcome
- **AND** SHALL NOT omit it solely because implementing never started

---

### Requirement: Evidence bundle SHALL record contract-to-evidence trace rows for triggered runs

For triggered runs with an approved dossier, the evidence bundle SHALL include trace rows mapping
each accepted `objective_id` (and content hash) to its final verification status: verified by
repo-native evidence, `unverified_exception` for affirmed `Untestable:` cases, or missing. Missing
required traces SHALL be visible as failures, not silent omissions.

#### Scenario: verified objective row

- **WHEN** an approved objective has matching final test or eval evidence
- **THEN** the bundle trace row SHALL mark it verified with a reference to that evidence

#### Scenario: untestable exception row

- **WHEN** an approved objective carries an affirmed `Untestable:` exception
- **THEN** the bundle trace row SHALL mark `unverified_exception`
- **AND** SHALL NOT mark it as test-proven

#### Scenario: missing trace is visible

- **WHEN** an approved objective has no verification evidence and no untestable exception
- **THEN** the bundle SHALL record the objective as missing verification
- **AND** readiness composition consumers SHALL be able to fail safely on that row
)
