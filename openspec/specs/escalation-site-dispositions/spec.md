# escalation-site-dispositions Specification

## Purpose
TBD - created by archiving change escalation-per-site-safety-dispositions. Update Purpose after archive.
## Requirements
### Requirement: Every escalation site SHALL declare a closed safety disposition

The engine SHALL maintain a machine-readable inventory of production escalation sites — every
production call that blocks an issue, parks at `needs-human`, emits `human_intervention` as an
off-ramp, or otherwise escalates out of normal advance progress. Each inventory entry SHALL
declare exactly one closed safety disposition:

- `deliberately-fail-closed` — integrity, attestation, or irreversible-safety sites; the site
  SHALL NOT perform automatic retry before escalating.
- `transient-retryable` — infrastructure-mechanical sites eligible for a bounded retry-with-backoff
  wrapper before escalation.
- `reconcile-owned` — sites whose recovery belongs to the reconciler / attempt-ledger layer; the
  site SHALL escalate with a typed reason and SHALL NOT invent a local destructive recovery path.

Disposition is orthogonal to the canonical stage-diagnostic reason code: disposition answers
whether the site may retry before escalating; the reason code answers what failed. The inventory
SHALL be the starting input for needs-human-rate and infrastructure-park metrics denominators.

#### Scenario: Disposition enum is closed and total over inventory rows

- **WHEN** the escalation-site inventory is loaded
- **THEN** every entry SHALL carry exactly one of `deliberately-fail-closed`,
  `transient-retryable`, or `reconcile-owned`
- **AND** no other disposition string SHALL be accepted

#### Scenario: Inventory covers the audit's named zero-retry classes

- **WHEN** the inventory is inspected for the 2026-07-31 census starting set
- **THEN** it SHALL include entries for zero-retry `getGhActor` fail-closed sites, zero-retry
  push sites, worktree-missing parks, label/gh mutation fail-closed paths, pipeline-imposed
  format parks, and review non-convergence / recurrence / round-ceiling escalation surfaces
- **AND** each entry SHALL name module path, stable site id, trigger, disposition, and canonical
  reason projection or ownership note

#### Scenario: Attestation sites remain deliberately fail-closed

- **WHEN** a site uses `getGhActor` (or equivalent actor identity) as part of review-SHA or other
  attestation integrity
- **THEN** its disposition SHALL be `deliberately-fail-closed`
- **AND** the site SHALL NOT be wrapped by a transient push/gh retry that would mask missing
  attestation identity

#### Scenario: Reconcile-owned sites do not grow local destructive recovery

- **WHEN** a site is dispositioned `reconcile-owned`
- **THEN** the advance path SHALL escalate with a typed canonical reason
- **AND** SHALL NOT perform force worktree destroy, force-push, or other destructive local recovery
  reserved for the reconciler layer

---

### Requirement: New production blocker sites SHALL fail a drift guard without a disposition

The test suite SHALL include a drift-guard that discovers production escalation emitters under
`core/scripts/` (at minimum every `setBlocked(` call site, and documented equivalent park /
`needs-human` / off-ramp emitters) and asserts each discovered site has a matching inventory
entry. Adding a new emitter without a disposition entry SHALL fail CI. Residual undiscovered
historical sites SHALL default to `deliberately-fail-closed` until explicitly dispositioned —
never to open retry.

#### Scenario: Missing inventory entry fails the guard

- **WHEN** a new production `setBlocked(` call site is added without a corresponding inventory row
- **THEN** the disposition drift-guard test SHALL fail
- **AND** the failure SHALL identify the file or site key that lacks a disposition

#### Scenario: Declared site passes the guard

- **WHEN** every discovered production escalation emitter has a matching inventory disposition
- **THEN** the disposition drift-guard test SHALL pass

#### Scenario: Unknown sites do not default to transient-retryable

- **WHEN** an emitter is discovered that is not yet dispositioned
- **THEN** the engine SHALL treat it as `deliberately-fail-closed` for wrapper eligibility
- **AND** SHALL NOT apply a transient retry wrapper to it until the inventory row is explicit

---

### Requirement: Bounded retry wrappers SHALL apply only to transient-retryable sites

The engine SHALL provide bounded retry-with-backoff wrappers exclusively for sites whose
inventory disposition is `transient-retryable`. Wrapper classes SHALL include at least:

1. Transient gh read and label-mutation calls (HTTP 5xx, rate-limit, network blips).
2. Push after a re-sync currency check against the expected remote / reviewed head.
3. Worktree rematerialization from the PR branch or verified remote tip after a dirty-work check.
4. Pipeline-imposed format self-fixes (fix commit subject, implement commit ref, verdict section
   formats the pipeline owns).

Wrappers SHALL use injectable deps (sleep, gh, git, worktree seams) for unit tests. On budget
exhaustion the site SHALL escalate with the canonical stage-diagnostic reason code for the
failure class and SHALL NOT reclassify the failure as product judgment or human authority solely
because retries exhausted.

#### Scenario: Transient-retryable site retries before park

- **WHEN** a `transient-retryable` gh label edit fails once with HTTP 504 and succeeds on retry
  within budget
- **THEN** the wrapper SHALL retry with backoff and return success
- **AND** the issue SHALL NOT be parked as a product or human-authority block for that blip

#### Scenario: Deliberately-fail-closed site is not wrapped

- **WHEN** a `deliberately-fail-closed` attestation site fails
- **THEN** the engine SHALL escalate on the first failure without a transient retry wrapper
- **AND** the failure SHALL retain its integrity-oriented typed reason

#### Scenario: Exhausted transient budget stays engine-owned

- **WHEN** a `transient-retryable` wrapper exhausts its configured attempt budget
- **THEN** the escalation SHALL carry a canonical infrastructure or engine-owned reason code
- **AND** SHALL NOT emit `human_intervention` or create a human hold solely from budget exhaustion

#### Scenario: Push retry requires currency check

- **WHEN** a push wrapper retries after a transient failure
- **THEN** it SHALL re-sync and verify local HEAD is still the owned/reviewed candidate before
  retrying
- **AND** it SHALL NOT force-push

#### Scenario: Worktree rematerialize refuses dirty destroy

- **WHEN** a worktree rematerialize wrapper finds a dirty or local-only unpushed candidate
- **THEN** it SHALL refuse force-destruction
- **AND** it SHALL escalate with a typed worktree creation/missing reason rather than destroying
  operator work

---

### Requirement: Review findings and authority decisions SHALL never auto-retry as blind replay

Review findings and authority decisions SHALL never auto-retry as blind replay of the same
review without candidate movement. Sites whose failure mode is unresolved review findings,
operator authority decisions, or `human-decision-required` evidence SHALL NOT be dispositioned
as open-ended auto-retry. A typed blocking finding MAY execute bounded `remediate → re-review`
while recovery budget remains (the shipped autonomous recovery behavior). Blind replay,
suppression, or override of findings without the operator override protocol is forbidden.
Review non-convergence, exact-key recurrence, surface recurrence, and round-ceiling exhaustion
SHALL inventory as engine-owned recovery surfaces (not human-authority defaults).

#### Scenario: Unresolved correctness finding stays engine-owned

- **WHEN** a valid unresolved correctness or spec finding blocks after review
- **THEN** the site disposition and reason projection SHALL route to engine-owned
  `review-findings` or `implementation-ci` recovery
- **AND** SHALL NOT grant human authority without current attested authority evidence

#### Scenario: Blind review replay is forbidden

- **WHEN** the same candidate is still current and no remediation commit has landed
- **THEN** the engine SHALL NOT disposition the path as an unbounded auto-retry of the identical
  review invocation solely to clear a block

---

### Requirement: Human authority emission SHALL require the canonical authority predicate

Human authority emission SHALL require the canonical stage-diagnostic authority predicate
(current `human-decision-required` diagnostic with candidate-bound authority evidence).
Production transitions to `needs-human` and emissions of `human_intervention` that act as
authority classifiers SHALL pass through that predicate. A drift guard SHALL fail when a
production call site performs such a transition or emission without that predicate or without
an explicit inventory exemption for reporting-only (non-authority) metrics emitters. Mechanical
recovery exhaustion, infrastructure timeouts, and review-policy recurrence SHALL NOT satisfy
the predicate.

#### Scenario: Direct needs-human without authority predicate fails the guard

- **WHEN** a production path transitions to `needs-human` or emits authority-class
  `human_intervention` without invoking the canonical authority predicate
- **AND** the site is not listed as a reporting-only exemption
- **THEN** the authority drift-guard test SHALL fail

#### Scenario: Mechanical exhaustion cannot mint human authority

- **WHEN** repair budget, transient wrapper budget, or recovery recipe budget is exhausted
- **THEN** the engine SHALL record a typed engine-owned terminal or recoverable failure
- **AND** SHALL NOT emit `human_intervention` or create a human hold solely from that exhaustion
)

