# issue-context-snapshot — delta for operator-surface comments (#484)

## ADDED Requirements

### Requirement: Operator-surface comments are self-acknowledging
The pipeline SHALL classify as **operator-surface** every comment body it renders in direct
response to an operator CLI invocation that embeds operator-supplied free text — namely the
`unblocked` (`## Pipeline: Unblocked`), `finding-override` (`## Pipeline: Finding override`),
and `scope-override` (`## Pipeline: Scope override`) kinds of `PIPELINE_COMMENT_KINDS`. Each
operator-surface kind SHALL be posted through the attesting helper (`verify:
"pipeline-attest"`), so its `bodyHash` binds the full rendered body including the verbatim
operator text.

The unacknowledged-human-input gate SHALL treat an operator-surface comment that is authored
by a trusted actor (the authenticated pipeline actor or a `cfg.trusted_override_actors`
entry) AND is verified pipeline output per `isVerifiedPipelineOutput` as an **acknowledgement
anchor**: it SHALL NOT itself be counted as unacknowledged human input, comments at or before
it SHALL be treated as dismissed, and the objection-language scan (`NEGATION_PATTERNS`) SHALL
NOT be applied to it. An operator invoking `pipeline unblock` or `pipeline override` has been
heard by construction, so change-request wording in the answer or override reason SHALL NOT
gate the run that invocation was issued to resume.

Operator-surface status SHALL be determined from the comment kind recorded in the attestation
payload against the registry, NOT by matching heading literals; the pre-existing hard-coded
`## Pipeline: Scope override` heading anchor SHALL be replaced by this rule rather than
retained alongside it.

This exemption SHALL NOT be widened beyond operator-authored embedded text: the
`pre-planning-context` comment, which embeds *third-party* human comment excerpts the
pipeline scraped, SHALL remain unattested and SHALL NOT act as an acknowledgement anchor.
Trust remains required and attestation remains tamper-evidence rather than identity: an
operator-surface heading from a non-trusted author, or one whose body fails verification,
SHALL still be counted as unacknowledged human input.

#### Scenario: Unblock answer containing change-request wording does not gate the resume
- **WHEN** an item is blocked at a fix round and the operator runs `pipeline unblock <N> "don't retry the call — batch it instead"`
- **AND** the resulting trusted-actor `## Pipeline: Unblocked` comment is the only comment posted after the plan anchor
- **THEN** `findUnacknowledgedComments` SHALL return zero unacknowledged comments
- **AND** the resumed fix round SHALL NOT post `## Pipeline: New human input detected`, SHALL NOT set `pipeline:blocked`, and SHALL require no hand-posted scope-override comment or manual label edit

#### Scenario: Override reason containing change-request wording does not gate the resume
- **WHEN** the operator runs `pipeline override` and the resulting trusted-actor `## Pipeline: Finding override` or `## Pipeline: Scope override` comment carries a `### Reason` containing objection wording (e.g. "revert", "instead")
- **AND** the comment is verified pipeline output
- **THEN** it SHALL NOT be counted as unacknowledged human input
- **AND** the auto-resumed advance loop SHALL proceed past the gate

#### Scenario: Operator-surface comment dismisses earlier unacknowledged comments
- **WHEN** an unacknowledged human comment is posted after the plan anchor
- **AND** the operator then unblocks the item, producing a verified trusted-actor `## Pipeline: Unblocked` comment after that human comment
- **THEN** the earlier human comment SHALL no longer be counted as unacknowledged
- **AND** the gate SHALL NOT require an additional `## Pipeline: Scope override` comment

#### Scenario: Third-party comment posted after the unblock still gates
- **WHEN** a verified trusted-actor `## Pipeline: Unblocked` comment is followed by a genuine human comment from a third party before the run resumes
- **THEN** that later comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL block the stage boundary and post the `## Pipeline: New human input detected` warning

#### Scenario: Forged operator-surface comment from a non-trusted author still gates
- **WHEN** a comment beginning with `## Pipeline: Unblocked` (or an override heading) and carrying a copied attestation marker is posted after the plan anchor by an author who is neither the pipeline actor nor a `trusted_override_actors` entry
- **THEN** that comment SHALL be counted as unacknowledged human input and SHALL NOT act as an acknowledgement anchor

#### Scenario: Text appended to an operator-surface comment breaks its exemption
- **WHEN** a trusted actor posts an operator-surface body with additional human objection text appended after the attestation marker line
- **THEN** `isVerifiedPipelineOutput` SHALL return false
- **AND** the comment SHALL be counted as unacknowledged human input

#### Scenario: Registry marks exactly the operator-driven kinds
- **WHEN** the drift-guard test enumerates `PIPELINE_COMMENT_KINDS`
- **THEN** `unblocked`, `finding-override`, and `scope-override` SHALL be listed with `verify: "pipeline-attest"` and marked operator-surface
- **AND** no other kind SHALL be marked operator-surface
- **AND** each SHALL render through its real builder to a body that satisfies `isVerifiedPipelineOutput`

#### Scenario: Pre-planning context comment remains exempt and non-anchoring
- **WHEN** a `## Pre-Planning Context` comment embedding third-party human excerpts exists
- **THEN** it SHALL remain unattested
- **AND** it SHALL NOT act as an acknowledgement anchor for comments posted before it
