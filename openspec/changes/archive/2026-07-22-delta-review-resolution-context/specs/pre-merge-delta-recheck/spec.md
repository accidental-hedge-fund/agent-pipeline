## ADDED Requirements

### Requirement: The pre-merge delta review SHALL carry a resolved-finding verification context

The pipeline SHALL derive, from the prior-round digest already built for the pre-merge delta review,
the set of prior blocking findings whose recorded resolution is `resolved-by-fix` or `overridden`,
and SHALL render them into the delta-review prompt as a resolved-finding verification section. Each
entry SHALL carry the finding key, the surface (file and category) recorded for it, the finding
title, the round that settled it, and its disposition. The section SHALL be derived only from the
digest — the pipeline SHALL NOT introduce a separate durable artifact, comment marker, or run-local
store for it — and SHALL therefore inherit the digest's trust model and fail-closed behavior.

#### Scenario: Settled findings are rendered into the delta prompt

- **WHEN** a pre-merge delta review is built and the prior-round digest contains findings resolved
  by fix and/or settled by override
- **THEN** the delta-review prompt SHALL contain a resolved-finding verification section
- **AND** the section SHALL list each such finding's key, surface, title, settling round, and
  disposition (`resolved-by-fix` or `overridden`)
- **AND** findings that were advisory-only or still outstanding SHALL NOT appear in it

#### Scenario: Fail-closed digest yields no verification context

- **WHEN** the prior-round digest is empty because the authenticated actor could not be resolved
- **THEN** the delta-review prompt SHALL contain no resolved-finding verification section

### Requirement: The verification section SHALL require HEAD-state evidence to re-assert a settled finding

The resolved-finding verification section SHALL instruct the reviewer that each listed finding is
presumed resolved at the current head, and that re-asserting it as blocking requires citing the
current state of the code (the file content supplied in the prompt). The instruction SHALL state
explicitly that the finding's absence from the narrow delta diff — for example "outside this
delta's narrow fixes" or "these commits do not address it" — is NOT sufficient grounds to re-assert
it, and that a reviewer unable to verify persistence against the supplied file state SHALL NOT
raise the finding as blocking.

#### Scenario: Instruction text is present and drift-guarded

- **WHEN** the resolved-finding verification section is rendered
- **THEN** it SHALL state that listed findings are presumed resolved at HEAD
- **AND** SHALL require current-file-state evidence for any re-assertion
- **AND** SHALL reject narrow-delta-scope rationale as grounds for re-assertion
- **AND** a test SHALL pin this instruction so the prompt cannot silently drop it

### Requirement: The delta review SHALL supply HEAD file state for settled findings' surfaces

For each distinct file named by a settled finding's surface, the pipeline SHALL read that file's
content at the reviewed head from the delta reviewer's worktree — the same directory the delta diff
is computed from — and SHALL include it in the delta-review prompt labelled with its repository
path. Reads SHALL go through an injectable seam so unit tests perform no filesystem access. Files
SHALL be emitted deduplicated and in ascending path order. Content SHALL be bounded by a per-file
and a total byte cap, and any trimmed content SHALL be marked as truncated in-band. A file that is
absent or unreadable at the head SHALL be rendered as an explicit not-present note rather than
silently omitted.

#### Scenario: Settled surfaces' files are injected at HEAD

- **WHEN** the digest carries settled findings whose surfaces name `core/scripts/a.ts` and
  `core/scripts/b.ts`
- **THEN** the delta-review prompt SHALL include the head content of both files read from the delta
  worktree path
- **AND** each SHALL be labelled with its repository path
- **AND** the files SHALL appear in ascending path order with duplicates collapsed

#### Scenario: Oversized content is truncated and disclosed

- **WHEN** an injected file exceeds the per-file cap, or the accumulated content exceeds the total
  cap
- **THEN** the emitted content SHALL be trimmed at the cap
- **AND** the trimmed entry SHALL be marked as truncated in the prompt

#### Scenario: Missing file at HEAD is disclosed, not dropped

- **WHEN** a settled finding's surface names a file that does not exist at the reviewed head
- **THEN** the prompt SHALL render an explicit note that the file is not present at HEAD
- **AND** SHALL NOT omit the entry silently

### Requirement: Injected resolution context and file state SHALL be fenced as untrusted evidence

The resolved-finding verification section and the injected file content SHALL be sanitized and
fenced on the same terms as the cross-round digest: fences SHALL be chosen so embedded content
cannot escape them, and the surrounding text SHALL mark the content as external evidence to be
evaluated, not as instructions to be followed.

#### Scenario: Embedded fences and directives cannot escape

- **WHEN** an injected file's content contains a code fence or text resembling reviewer
  instructions
- **THEN** the rendered section SHALL keep that content inside its fence
- **AND** SHALL label it as untrusted external evidence

### Requirement: An unverified re-assertion of a settled finding SHALL be demoted to advisory

The pipeline SHALL partition as advisory rather than blocking any pre-merge delta finding whose
surface matches a settled finding's surface and whose body cites no evidence drawn from the
supplied head file state. The demotion SHALL reuse the existing
settled-finding demotion path rather than introducing a parallel mechanism, and SHALL name the
settled finding and its settling round in both the posted review comment and the emitted run event,
with a reason distinguishing it from an unacknowledged reversal. A delta finding on a settled
surface that does cite current file state SHALL remain blocking under the normal severity and
confidence policy.

#### Scenario: Narrow-delta rationale is demoted

- **WHEN** a delta finding re-asserts a settled finding's surface with the rationale that the delta
  does not address it, citing no head file state
- **THEN** the finding SHALL be classified advisory, not blocking
- **AND** the review comment and the run event SHALL name the settled finding key and its settling
  round
- **AND** the run SHALL NOT require an audited override to advance

#### Scenario: Verified regression on a settled surface still blocks

- **WHEN** a delta finding on a settled surface cites the current head file state as evidence that
  the behavior regressed
- **THEN** the finding SHALL be evaluated under the normal severity and confidence policy
- **AND** SHALL block when it meets the policy's blocking threshold

### Requirement: The delta path SHALL be unchanged when there is no settled history

When the prior-round digest carries no settled findings, the pipeline SHALL render no
resolved-finding verification section, SHALL perform no head file reads, and SHALL produce a
delta-review prompt identical to the one produced before this change. No finding SHALL be demoted by
the settled-surface evidence rule in that case.

#### Scenario: First delta round is a no-op

- **WHEN** a pre-merge delta review runs with a digest containing no resolved or overridden findings
- **THEN** the prompt SHALL contain no resolved-finding verification section and no injected file
  content
- **AND** no file read SHALL be attempted
- **AND** every returned finding SHALL be partitioned exactly as it is today

### Requirement: Regression coverage SHALL pin the #451 re-assertion history

The repository SHALL carry a regression fixture replaying the #451 case: a prior-round history in
which findings `ac3bdbd2`, `4040cada`, and `edfd3cf1` are recorded blocking and then settled on
their recorded surfaces, followed by a narrow delta whose review re-asserts all three with
narrow-delta rationale and no head-state evidence. The fixture SHALL assert that all three are
demoted to advisory, that the delta round advances without an audited override, and that the
prompt built for that delta carries the verification section and the head content of the settled
surfaces' files.

#### Scenario: #451 history replays without overrides

- **WHEN** the #451 fixture history is replayed through the pre-merge delta path
- **THEN** all three re-asserted findings SHALL be advisory
- **AND** the run SHALL advance without recording an override disposition
- **AND** the assertions SHALL fail against the pre-change behavior
