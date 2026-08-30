# issue-implementation-readiness-gate Specification

## Purpose
Opt-in admission gate that evaluates a freshly fetched GitHub issue through the resolved Implementer planning treatment before any delivery worktree or planning/implementation harness starts, and that holds thin issues at `pipeline:needs-spec` with one hash-bound refinement comment.

## Requirements

### Requirement: The issue-readiness gate SHALL be disabled by default and SHALL leave every pickup path unchanged while disabled

When `issue_readiness.enabled` is `false` or the `issue_readiness` block is absent, every direct advance, queue, loop, train, and ship pickup path SHALL keep its current admission, worktree, and harness behavior. The gate SHALL NOT fetch for evaluation, SHALL NOT invoke a model, SHALL NOT write the owned comment, and SHALL NOT add `pipeline:needs-spec`.

#### Scenario: Disabled config admits a thin issue the way current pickup does

- **WHEN** `issue_readiness.enabled` is `false`
- **AND** a thin `pipeline:ready` issue is picked up by direct advance
- **THEN** the run SHALL proceed into the existing ready-to-planning flow
- **AND** no issue-readiness model call SHALL occur
- **AND** the issue SHALL NOT receive `pipeline:needs-spec`

#### Scenario: Absent block equals disabled

- **WHEN** `.github/pipeline.yml` omits `issue_readiness`
- **AND** any pickup path starts a `pipeline:ready` issue
- **THEN** behavior SHALL match `enabled: false`

### Requirement: This repository SHALL enable the gate as the initial dogfood consumer

The committed `.github/pipeline.yml` in the agent-pipeline repository SHALL set `issue_readiness.enabled` to `true`. A different repository that omits the block or sets `enabled: false` SHALL remain ungated.

#### Scenario: agent-pipeline config opts in

- **WHEN** this repository's `.github/pipeline.yml` is loaded
- **THEN** `issue_readiness.enabled` SHALL be `true`

#### Scenario: Another repository stays ungated unless it opts in

- **WHEN** a repository has no `issue_readiness` block
- **THEN** the gate SHALL NOT run

### Requirement: Every GitHub issue pickup path SHALL call one shared gate before worktree create or delivery harness invoke

Direct `pipeline <issue>` / advance / single, queue item dispatch, loop or supervisor redispatch, train, and ship SHALL invoke the same gate function before creating a worktree and before invoking the planning or implementation delivery harness. No pickup path SHALL start delivery of a `pipeline:ready` issue while the gate is enabled without that call. Mid-flight stages (`planning` and later) SHALL NOT re-run the gate.

#### Scenario: Direct single hits the gate before planning

- **WHEN** `issue_readiness.enabled` is `true`
- **AND** the operator runs direct advance on a `pipeline:ready` issue
- **THEN** the shared gate SHALL run before live-planning marker claim, worktree create, and planning authoring

#### Scenario: Queue item dispatch hits the same gate

- **WHEN** queue selects a `pipeline:ready` issue while the gate is enabled
- **THEN** that item's run SHALL call the same gate function before worktree create or delivery harness invoke

#### Scenario: Loop, train, and ship hit the same gate

- **WHEN** loop redispatch, train, or ship starts a `pipeline:ready` issue while the gate is enabled
- **THEN** that start SHALL call the same gate function before worktree create or delivery harness invoke

#### Scenario: Mid-flight redispatch skips the gate

- **WHEN** an issue already carries `pipeline:implementing` (or any stage after `ready`)
- **THEN** the gate SHALL NOT evaluate the issue body
- **AND** the existing stage handler SHALL run

### Requirement: The gate SHALL evaluate a freshly fetched title, body, and labels

Immediately before evaluation or verdict reuse, the gate SHALL re-fetch the authoritative GitHub issue title, body, and labels. It SHALL NOT evaluate stale queue inventory, a prior-run snapshot, or the text of an earlier comment as the issue body.

#### Scenario: Stale queue text is not evaluated

- **WHEN** queue inventory captured a thin body
- **AND** the live GitHub issue body has since gained executable acceptance criteria
- **THEN** the gate SHALL evaluate the live body
- **AND** SHALL NOT use the inventory snapshot as the evaluated text

#### Scenario: Prior comment is not the evaluated body

- **WHEN** an owned refinement comment contains a proposed body
- **AND** the live issue body is still the original text
- **THEN** the gate SHALL hash and evaluate the live issue title and body, not the comment's proposed body

### Requirement: The gate SHALL invoke the resolved Implementer with the active planning treatment

When a model call is required, the gate SHALL invoke the resolved Implementer from `harnesses.implementer` using `models.planning` and `effort.planning`, including normal `auto` routing for those keys. The gate SHALL NOT invoke the Reviewer. The gate SHALL NOT hard-code a provider, model, or harness name.

#### Scenario: Planning treatment is propagated

- **WHEN** config sets `harnesses.implementer: grok`, `models.planning: grok-4.6`, and `effort.planning: high`
- **AND** the gate makes a model call
- **THEN** the invocation SHALL use implementer `grok` with planning model `grok-4.6` and effort `high`
- **AND** the Reviewer SHALL NOT be invoked

#### Scenario: Auto routing uses the planning stage expansion

- **WHEN** `models.planning` or `effort.planning` is `auto`
- **AND** the gate makes a model call
- **THEN** the invoked model and effort SHALL equal the resolved `planning` auto-routing result for the implementer harness

### Requirement: The gate SHALL accept only a structured ready or needs_spec verdict and SHALL admit on semantic completeness

The model response SHALL be valid JSON whose `verdict` is exactly `ready` or `needs_spec`. Semantic readiness SHALL require a clear problem/outcome, observable acceptance criteria, scope constraints or non-goals, and no unresolved contradiction. Canonical headings SHALL NOT be required for admission. Missing headings MAY appear in a `needs_spec` proposed body.

#### Scenario: Semantically complete issue without canonical headings is ready

- **WHEN** the freshly fetched body states a clear outcome, checkable acceptance criteria, explicit non-goals, and no contradiction
- **AND** it omits the Summary / User story headings
- **THEN** the verdict SHALL be `ready`
- **AND** the issue SHALL be admitted to the existing planning flow

#### Scenario: Missing observable acceptance criteria is needs_spec

- **WHEN** the body describes a problem but has no observable acceptance criteria
- **THEN** the verdict SHALL be `needs_spec`

#### Scenario: Unresolved contradiction is needs_spec

- **WHEN** the body contains two acceptance criteria that cannot both be true
- **THEN** the verdict SHALL be `needs_spec`

### Requirement: A needs_spec result SHALL write or update exactly one hash-and-treatment-bound Pipeline-authored comment

On `needs_spec` the gate SHALL create or update exactly one Pipeline-authored GitHub comment. The comment SHALL be bound to the evaluated title/body hash and the resolved planning treatment through an engine-owned marker. The comment body SHALL list concrete deficiencies and a proposed revised body that preserves author intent and contains the headings Summary, User story, Acceptance criteria, Out of scope, and Open questions, in that order. The gate SHALL treat a comment as owned only when GitHub authorship matches the pipeline actor and the body carries a verified Pipeline attestation for an issue-readiness kind together with a well-formed binding marker. A foreign or malformed marker-bearing comment SHALL be ignored: the gate SHALL NOT reuse its verdict and SHALL NOT update that comment. The gate SHALL NOT create a second owned comment for the same issue.

#### Scenario: First rejection posts one owned comment

- **WHEN** the gate returns `needs_spec` and no owned comment exists
- **THEN** the gate SHALL post one comment containing deficiencies, the proposed revised body, and the binding marker

#### Scenario: Later evaluation updates the same comment

- **WHEN** an owned comment already exists
- **AND** a new evaluation produces `needs_spec` under a new hash or treatment
- **THEN** the gate SHALL update that comment in place
- **AND** SHALL NOT post an additional owned comment

#### Scenario: Foreign marker is not patched

- **WHEN** the only marker-bearing comment is not Pipeline-authored
- **AND** a new evaluation produces `needs_spec`
- **THEN** the gate SHALL post a new Pipeline-authored comment
- **AND** SHALL NOT update the foreign comment

#### Scenario: Concurrent first rejection retains one owned comment

- **WHEN** two hosts both list comments before either creates the first owned comment
- **AND** both evaluations produce `needs_spec`
- **THEN** the gate SHALL reconcile to exactly one Pipeline-authored owned comment before returning a verdict
- **AND** SHALL NOT leave two owned comments on the issue

### Requirement: A needs_spec result SHALL move the issue to pipeline:needs-spec and SHALL NOT start delivery

On `needs_spec` the gate SHALL transition the issue from `pipeline:ready` to `pipeline:needs-spec`. It SHALL NOT create a worktree. It SHALL NOT invoke the planning authoring harness or the implementation delivery harness. Queue and loop output SHALL name the structured `needs_spec` reason. Independent eligible issues SHALL continue.

#### Scenario: Rejected issue is labeled needs-spec with no worktree

- **WHEN** the gate returns `needs_spec` for issue N
- **THEN** issue N SHALL carry `pipeline:needs-spec` and SHALL NOT carry `pipeline:ready`
- **AND** no worktree SHALL be created for N
- **AND** planning and implementation delivery harnesses SHALL NOT be invoked for N

#### Scenario: Independent sibling continues

- **WHEN** a queue or loop batch contains rejected issue A and independent eligible issue B
- **THEN** A SHALL move to `pipeline:needs-spec`
- **AND** B SHALL remain eligible and SHALL continue

### Requirement: The gate SHALL NOT edit the issue body, milestone, unrelated labels, or project files

The gate's GitHub writes SHALL be only the owned comment and, on `needs_spec`, the `pipeline:needs-spec` label transition. It SHALL NOT patch the issue body, change the milestone, add or remove unrelated labels, or modify project files.

#### Scenario: Rejection does not rewrite the issue body

- **WHEN** the gate returns `needs_spec`
- **THEN** the GitHub issue body SHALL be unchanged
- **AND** the milestone SHALL be unchanged
- **AND** no project file SHALL be written

### Requirement: Unchanged title, body, and treatment SHALL reuse the recorded verdict without another model call or comment

The gate SHALL persist the bound verdict in the owned comment for both `ready` and `needs_spec`. When a fresh fetch matches the recorded title/body hash and resolved planning treatment on a verified Pipeline-authored comment, the gate SHALL reuse that verdict and SHALL NOT invoke the model and SHALL NOT post a new comment. A foreign or malformed marker-bearing comment SHALL NOT satisfy this reuse. A change to title, body, or resolved planning treatment SHALL invalidate the record and SHALL evaluate again.

#### Scenario: Unchanged thin issue reuses needs_spec

- **WHEN** an owned comment records `needs_spec` for hash H and treatment T
- **AND** a later pickup fetches the same title, body, and treatment
- **THEN** the gate SHALL reuse `needs_spec`
- **AND** SHALL NOT invoke the model
- **AND** SHALL NOT post a new comment
- **AND** the issue SHALL be at `pipeline:needs-spec`

#### Scenario: Body change invalidates the record

- **WHEN** the live body no longer matches the recorded hash
- **THEN** the gate SHALL evaluate again with a model call

#### Scenario: Treatment change invalidates the record

- **WHEN** the resolved planning model, effort, or implementer harness differs from the recorded treatment
- **AND** the title and body are unchanged
- **THEN** the gate SHALL evaluate again with a model call

#### Scenario: Unchanged ready verdict is reused

- **WHEN** an owned comment records `ready` for the current hash and treatment
- **AND** the issue is again at `pipeline:ready`
- **THEN** the gate SHALL admit without a model call
- **AND** SHALL NOT post a new comment

#### Scenario: Foreign ready marker is not reused

- **WHEN** a collaborator comment contains a matching ready marker for the current hash and treatment
- **AND** that comment is not a verified Pipeline-authored comment
- **THEN** the gate SHALL NOT admit from that comment
- **AND** SHALL invoke the Implementer

### Requirement: The gate SHALL no-op when the live stage is no longer ready

The gate SHALL require the freshly fetched pipeline stage to be `ready` before evaluation or verdict reuse. Immediately before any GitHub mutation or `ready` admission, the gate SHALL re-fetch title, body, and labels. It SHALL require the live stage to still be `ready` and the live title/body hash (with the resolved planning treatment) to match the evaluated input. If the live stage is any other value, the gate SHALL return a typed `stale-dispatch` outcome. That outcome SHALL NOT write the owned comment and SHALL NOT add `pipeline:needs-spec`. When the first fetch already shows a non-ready stage, the gate SHALL NOT invoke the model. If the live hash does not match, the gate SHALL NOT persist that verdict and SHALL NOT start planning; it SHALL restart evaluation against the live input. Restarts SHALL be bounded to at most three evaluation attempts including the first. Exhausting that budget SHALL be typed `gate-unavailable` with no GitHub mutation.

After a `needs_spec` label write, the gate SHALL re-fetch and inspect the complete set of pipeline stage labels, not only `pickStage()`. `needs_spec` is committed only when that set is exactly `pipeline:needs-spec`. Any simultaneous non-`needs-spec` pipeline stage SHALL be `stale-dispatch`, never `needs_spec`. On every stale result after a write, the gate SHALL remove the gate-added `pipeline:needs-spec` overlay and re-fetch to confirm cleanup. If cleanup cannot be confirmed, the outcome SHALL be typed `mutation-failed`.

After every ready-comment write, the gate SHALL re-fetch and SHALL require both `pipeline:ready` and the evaluated title/body hash before returning `ready`. If the live hash differs, the gate SHALL restore or remove the stale bound record and SHALL restart evaluation within the existing restart budget; it SHALL NOT admit on that attempt. If the live stage differs, the gate SHALL restore or remove the stale bound record and SHALL return `stale-dispatch`.

#### Scenario: Fresh fetch shows a later stage

- **WHEN** the freshly fetched labels include `pipeline:planning` or any stage other than `pipeline:ready`
- **THEN** the outcome SHALL be `stale-dispatch`
- **AND** the Implementer SHALL NOT be invoked
- **AND** no comment or label write SHALL occur

#### Scenario: Stage changes before needs_spec mutation

- **WHEN** the first fetch shows `pipeline:ready` and evaluation returns `needs_spec`
- **AND** a live re-fetch immediately before mutation shows a stage other than `pipeline:ready`
- **THEN** the outcome SHALL be `stale-dispatch`
- **AND** the gate SHALL NOT write the owned comment
- **AND** the gate SHALL NOT add `pipeline:needs-spec`

#### Scenario: Body changes during evaluation

- **WHEN** the first fetch is body B0 and the Implementer returns `ready` for B0
- **AND** a live re-fetch before persist shows body B1 with stage still `ready`
- **THEN** the gate SHALL NOT persist a B0-bound `ready` record
- **AND** SHALL NOT start planning on B1 without evaluating B1
- **AND** SHALL evaluate B1 (or reuse a B1-bound record)

#### Scenario: Stage changes between needs-spec label writes

- **WHEN** the gate has added `pipeline:needs-spec`
- **AND** a concurrent dispatcher has moved the issue to a later stage before the label transition is confirmed
- **THEN** the outcome SHALL be `stale-dispatch`
- **AND** the gate SHALL remove the `pipeline:needs-spec` overlay
- **AND** the gate SHALL NOT return `needs_spec` while any other pipeline stage label remains
- **AND** if overlay removal cannot be confirmed, the outcome SHALL be `mutation-failed`

#### Scenario: Title or body changes during ready-comment persistence

- **WHEN** the Implementer returns `ready` for body B0
- **AND** a live re-fetch after the ready-comment write shows body B1 with stage still `ready`
- **THEN** the gate SHALL NOT admit on that attempt
- **AND** SHALL restore or remove the B0-bound record
- **AND** SHALL evaluate B1 within the existing restart budget

#### Scenario: Drift budget exhausted is gate-unavailable

- **WHEN** live title or body changes on every re-fetch until the restart budget is exhausted
- **THEN** the outcome SHALL be `gate-unavailable`
- **AND** no owned comment SHALL be written
- **AND** the issue SHALL remain on `pipeline:ready`

### Requirement: Triage to ready SHALL be an admission request, not a bypass of the gate

After an author applies a proposed body, `pipeline triage <N> --stage ready` SHALL remain the re-admission request. That command SHALL NOT invoke the issue-implementation-readiness gate model. It SHALL still be subject to the Decisions-artifact validator specified by `grill-then-ready-refinement` before any ready label write. When the ready label is set, the next pickup SHALL re-fetch and SHALL require a `ready` verdict from this gate before any worktree or delivery harness starts. An unchanged body that this gate previously rejected SHALL reuse `needs_spec` and return the issue to `pipeline:needs-spec`. #1238 owned comments SHALL remain verdict evidence. They SHALL NOT replace the issue body as the specification.

#### Scenario: Fresh body must pass before delivery

- **WHEN** an author updates the issue body and runs `pipeline triage N --stage ready`
- **AND** the Decisions-artifact validator permits the ready label write
- **AND** the next pickup evaluates the new body as `ready`
- **THEN** delivery MAY start
- **AND** triage itself SHALL NOT have invoked the gate model

#### Scenario: Unchanged body after triage is not a bypass

- **WHEN** an issue at `pipeline:needs-spec` is triaged to `pipeline:ready` without a body change
- **AND** the next pickup runs while the gate is enabled
- **THEN** the gate SHALL reuse `needs_spec`
- **AND** SHALL move the issue back to `pipeline:needs-spec`
- **AND** SHALL NOT create a worktree

#### Scenario: Grill-ready is not a pickup bypass

- **WHEN** `--stage ready` has set `pipeline:ready` after a complete Decisions artifact
- **AND** a pickup path runs with `issue_readiness.enabled` true
- **THEN** this gate SHALL still evaluate the freshly fetched title and body
- **AND** SHALL NOT skip that evaluation because a Decisions artifact is present

### Requirement: Provider, harness, timeout, or schema failure SHALL be typed gate-unavailable with no fallback

When the Implementer cannot be invoked, times out, or returns a response that fails the verdict schema, the outcome SHALL be typed `gate-unavailable`. A `needs_spec` response whose `proposed_body` omits the required headings or lists them out of order SHALL fail the verdict schema. When pipeline-actor lookup fails or returns no actor, the outcome SHALL be typed `gate-unavailable`; the gate SHALL NOT invoke the Implementer and SHALL NOT write GitHub mutations until ownership can be verified. The gate SHALL NOT fall back to a structural heuristic, the Reviewer, another provider, or another model. Direct single invocation SHALL fail with a non-zero exit and SHALL NOT start delivery. Multi-item runs SHALL block the affected issue and its selected dependents for that run and SHALL continue independent selected issues. The gate SHALL NOT write GitHub mutations on `gate-unavailable`. The issue SHALL remain on `pipeline:ready`. The gate SHALL NOT report `gate-unavailable` after a GitHub comment or label write from this attempt has occurred.

#### Scenario: Direct single fails visibly

- **WHEN** the admission harness times out during `pipeline single` on issue N
- **THEN** the process SHALL exit non-zero
- **AND** N SHALL NOT gain a worktree
- **AND** N SHALL NOT be labeled `pipeline:needs-spec`

#### Scenario: Schema failure is gate-unavailable, not needs_spec

- **WHEN** the model returns JSON without a `verdict` field
- **THEN** the outcome SHALL be `gate-unavailable`
- **AND** the issue SHALL NOT be labeled `pipeline:needs-spec`

#### Scenario: Actor lookup failure is gate-unavailable

- **WHEN** pipeline-actor lookup throws or returns no actor
- **AND** a Pipeline-authored readiness comment is already present
- **THEN** the outcome SHALL be `gate-unavailable`
- **AND** the Implementer SHALL NOT be invoked
- **AND** no new comment SHALL be created

#### Scenario: Draft missing a required heading is gate-unavailable

- **WHEN** the model returns `needs_spec` with a `proposed_body` that omits one of Summary, User story, Acceptance criteria, Out of scope, or Open questions
- **THEN** the outcome SHALL be `gate-unavailable`
- **AND** the issue SHALL NOT be labeled `pipeline:needs-spec`
- **AND** no owned comment SHALL be written

#### Scenario: Draft with headings out of order is gate-unavailable

- **WHEN** the model returns `needs_spec` with a `proposed_body` that contains the required headings in an order other than Summary, User story, Acceptance criteria, Out of scope, Open questions
- **THEN** the outcome SHALL be `gate-unavailable`
- **AND** no GitHub mutation SHALL occur

#### Scenario: Selected dependents are blocked; independents continue

- **WHEN** a loop or train run has selected issue A, dependent B, and independent C
- **AND** A's gate result is `gate-unavailable`
- **THEN** A and B SHALL be blocked for that run
- **AND** C SHALL remain eligible
- **AND** no reviewer or alternate-model fallback SHALL run for A

### Requirement: A GitHub write sequence SHALL be re-fetched and SHALL NOT be reported as gate-unavailable after a mutation

The gate SHALL treat the owned comment persist and the `ready` → `needs-spec` label transition as a verified write sequence. After a write attempt fails, the gate SHALL re-fetch GitHub state. When the desired comment and `pipeline:needs-spec` without `pipeline:ready` already hold, the gate SHALL return `needs_spec`. When the live stage is still `ready`, the gate SHALL retry remaining writes. The gate SHALL re-fetch labels immediately before each label write and SHALL NOT add `pipeline:needs-spec` when the live stage is no longer `ready`. `gate-unavailable` SHALL mean no GitHub mutation from this attempt remains. When a write cannot be completed or compensated, the gate SHALL return typed `mutation-failed`, which SHALL fence delivery and SHALL NOT start planning.

#### Scenario: Comment write succeeds and first label add fails

- **WHEN** persist of the owned comment succeeds
- **AND** the first add of `pipeline:needs-spec` fails
- **AND** a retry of the label transition succeeds
- **THEN** the outcome SHALL be `needs_spec`
- **AND** SHALL NOT be `gate-unavailable`

#### Scenario: Comment write succeeds and label add does not complete

- **WHEN** persist of the owned comment succeeds
- **AND** adding `pipeline:needs-spec` keeps failing
- **THEN** the outcome SHALL be `mutation-failed`
- **AND** SHALL NOT be `gate-unavailable`
- **AND** delivery SHALL NOT start

#### Scenario: Label add succeeds and first label remove fails

- **WHEN** adding `pipeline:needs-spec` succeeds
- **AND** the first remove of `pipeline:ready` fails
- **AND** a retry remove succeeds
- **THEN** the outcome SHALL be `needs_spec`
- **AND** SHALL NOT be `gate-unavailable`

#### Scenario: Stage is no longer ready after comment persist

- **WHEN** persist of the owned comment succeeds
- **AND** the next live fetch shows a stage other than `pipeline:ready`
- **THEN** the gate SHALL NOT add `pipeline:needs-spec`
- **AND** SHALL NOT report `gate-unavailable`

### Requirement: Gate I/O SHALL be injectable so unit tests perform no real network, git, or subprocess calls

All GitHub reads and writes, time, and harness invocation used by the gate SHALL go through a `deps` seam. Unit tests SHALL supply fakes and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Fake deps prove rejection side effects

- **WHEN** a unit test drives the gate with fake GitHub and harness deps and a `needs_spec` verdict
- **THEN** the fakes SHALL record one owned comment write and the `ready` → `needs-spec` label transition
- **AND** the fakes SHALL record zero worktree and zero planning-authoring calls
- **AND** no real network, git, or subprocess call SHALL occur
