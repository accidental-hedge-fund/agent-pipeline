# review-ceiling-demote-and-advance Specification

## Purpose
TBD - created by archiving change review-ceiling-demote-and-advance. Update Purpose after archive.
## Requirements
### Requirement: High or critical findings SHALL hard-park at the round ceiling regardless of ceiling_action

At the `max_adversarial_rounds` round-budget ceiling, the pipeline SHALL partition
the still-blocking findings into a **high/critical** set
(`severityRank(severity) >= severityRank("high")`) and a **below-high** set (the
rest). When the high/critical set is non-empty, the pipeline SHALL post the
existing "Review ceiling reached" punch-list comment and transition to
`needs-human` — identical to the behavior before this capability — and SHALL NOT
demote, advance, or file a follow-up issue. This park SHALL occur regardless of
the configured `review_policy.ceiling_action`.

#### Scenario: A high finding present at the ceiling parks at needs-human

- **WHEN** a review round hits the `max_adversarial_rounds` ceiling with at least one `high`- or `critical`-severity blocking finding still present
- **AND** `review_policy.ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL transition to `needs-human`
- **AND** the pipeline SHALL NOT file a follow-up issue and SHALL NOT demote any finding

#### Scenario: Mixed severities with a critical present still park

- **WHEN** the ceiling is hit with a mix of `medium` and `critical` blocking findings
- **AND** `review_policy.ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL transition to `needs-human` without demoting the `medium` findings

### Requirement: ceiling_action park SHALL preserve the current hard-park behavior

The round-budget ceiling SHALL preserve its prior hard-park behavior for every
finding severity when `review_policy.ceiling_action` is `park` (the default): the
pipeline SHALL post the "Review ceiling reached" punch-list and transition to
`needs-human`, and SHALL NOT demote findings, record dispositions, or file a
follow-up issue.

#### Scenario: Default park hard-parks even when all findings are below high

- **WHEN** the ceiling is hit with only `medium` blocking findings
- **AND** `review_policy.ceiling_action` is `park`
- **THEN** the item SHALL transition to `needs-human`
- **AND** the pipeline SHALL NOT file a follow-up issue and SHALL NOT demote any finding

### Requirement: Below-high findings at the ceiling SHALL demote and advance under demote_and_advance

The pipeline SHALL demote the below-high blocking findings to advisory and advance
the item to the normal next stage (`pre-merge`) instead of `needs-human` when
`review_policy.ceiling_action` is `demote_and_advance`, the round-budget ceiling
is hit, the high/critical set is empty, and at least one below-high blocking
finding remains. As part of demotion the pipeline SHALL post an audited demotion
comment on the item that itemizes each demoted finding (title, severity, category,
`override-key`, and location).

#### Scenario: Only medium findings at the ceiling advance to pre-merge

- **WHEN** the ceiling is hit with only `medium` blocking findings, the high/critical set is empty, and `review_policy.ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL transition to `pre-merge` (not `needs-human`)
- **AND** an audited demotion comment listing each demoted finding SHALL be posted

#### Scenario: No below-high findings means nothing to demote

- **WHEN** the ceiling branch is reached with an empty blocking set
- **THEN** the pipeline SHALL follow its existing non-blocking advance path and SHALL NOT post a demotion comment or file a follow-up issue

### Requirement: Demoted findings SHALL be captured in a single tracked follow-up issue

When findings are demoted at the ceiling, the pipeline SHALL create exactly one
follow-up GitHub issue that captures every demoted finding with its title,
severity, category, and `override-key`, and that back-links the original issue.
No demoted finding SHALL be omitted from the follow-up issue. The follow-up issue
SHALL NOT carry a `pipeline:` stage label, so it does not auto-enter the pipeline.

#### Scenario: Every demoted finding appears in the follow-up issue

- **WHEN** three `medium` findings are demoted at the ceiling under `demote_and_advance`
- **THEN** exactly one follow-up issue SHALL be created
- **AND** its body SHALL list all three findings with their titles, severities, categories, and `override-key`s
- **AND** its body SHALL reference the original issue number

#### Scenario: Follow-up issue is filed at most once per item

- **WHEN** an item re-enters the ceiling after a prior demotion already filed a follow-up issue recorded by a `pipeline-ceiling-followup` marker
- **THEN** the pipeline SHALL NOT create a second follow-up issue
- **AND** SHALL re-use the recorded follow-up issue number

### Requirement: Demoted findings SHALL be recorded as audited dispositions so pre-merge does not re-park

For each finding demoted at the ceiling, the pipeline SHALL record an audited
override disposition keyed by the finding's `findingKey` (the same
`pipeline-override` sentinel that `extractOverrides` reads), with a disposition
that references the follow-up issue. As a result, the pre-merge review-SHA gate's
`unresolved = recorded − overrides` computation SHALL yield no unresolved blocking
keys for the demoted findings, so the item SHALL advance through pre-merge to
`ready-to-deploy` without re-parking at `needs-human`.

#### Scenario: Recorded dispositions cover the demoted keys at pre-merge

- **WHEN** the demote path records an override disposition for each demoted finding's `findingKey`
- **AND** the pre-merge review-SHA gate later reconciles the recorded blocking keys against the overrides
- **THEN** the set of unresolved blocking keys for the demoted findings SHALL be empty
- **AND** the item SHALL NOT re-park at `needs-human` on account of the demoted findings

### Requirement: The recurrence early-park SHALL NOT be governed by ceiling_action

The `review-loop-recurrence` early park SHALL NOT be relaxed by
`review_policy.ceiling_action`: a blocking finding re-emitted with an unchanged
`findingKey` after a fix round SHALL continue to transition to `needs-human`. Only
the `max_adversarial_rounds` round-budget ceiling SHALL be governed by
`ceiling_action`.

#### Scenario: Recurrence park ignores demote_and_advance

- **WHEN** a blocking `medium` finding recurs with an unchanged `findingKey` after a fix round
- **AND** `review_policy.ceiling_action` is `demote_and_advance`
- **THEN** the item SHALL still transition to `needs-human` via the recurrence early-park
- **AND** the pipeline SHALL NOT demote the finding or file a follow-up issue

### Requirement: Follow-up issue and comment writes use the shared async gh transport

The default implementations for follow-up issue creation (`defaultCreateIssue`) and issue comment posting (`defaultAddIssueComment`) in the review stage SHALL delegate to the `createIssue` and `addIssueComment` helpers exported from `gh.ts`, which are built on `ghRun`. These defaults SHALL NOT call `spawnSync` directly. The `deps.createIssue` and `deps.addIssueComment` injection seam interfaces SHALL remain unchanged so unit tests continue to use fake implementations without modification.

#### Scenario: Follow-up issue creation inherits timeout enforcement

- **WHEN** the ceiling action files a new follow-up issue via the default `createIssue` implementation
- **THEN** the underlying `gh` call SHALL be subject to the `ghRun` timeout (default 30 s) and SHALL throw rather than hang if `gh` does not respond in time

#### Scenario: Follow-up comment posting inherits rate-limit retry

- **WHEN** the ceiling action appends findings to an existing follow-up via the default `addIssueComment` implementation
- **AND** `gh issue comment` returns a rate-limit error on the first attempt
- **THEN** the call SHALL be retried with exponential backoff up to three attempts before failing

#### Scenario: Dep injection seam is unchanged

- **WHEN** a unit test injects a fake `deps.createIssue` or `deps.addIssueComment`
- **THEN** the fake SHALL be called exactly as before — the change to the default implementation SHALL NOT alter the `AdvanceReviewDeps` interface or the call sites that reference it

