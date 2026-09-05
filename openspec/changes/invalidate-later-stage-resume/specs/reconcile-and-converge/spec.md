## ADDED Requirements

### Requirement: Later-stage resume SHALL consume review-currency reconcile outputs

Later-stage dispatch (`visual-gate`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`) SHALL obtain reuse, re-review, or fail-closed disposition from the existing review-verdict currency reconcile surface. It SHALL NOT encode a second supersession tree in the later-stage handler. Observed evidence SHALL include reviewed SHA, current HEAD, pipeline-internal commit classification, and observation failure. Recurrence, ceiling, and pending-check evidence SHALL NOT authorize later-stage reuse of a superseded verdict.

When reconcile reports current currency, the later stage MAY run. When reconcile reports superseded currency, or unknown currency with a readable HEAD that differs from the reviewed SHA, the engine SHALL NOT dispatch the later stage and SHALL route to `review-1` as specified by `review-sha-gating`. When observation fails, reconcile SHALL fail closed and the later stage SHALL NOT run.

#### Scenario: Later-stage dispatch uses the shared reconcile surface

- **WHEN** advance is about to dispatch `visual-gate`, `eval-gate`, `shipcheck-gate`, or `ready-to-deploy`
- **THEN** it SHALL obtain currency disposition from the review-currency reconcile surface
- **AND** SHALL NOT decide reuse from the later-stage label alone

#### Scenario: Superseded reconcile output blocks later-stage dispatch

- **WHEN** review-currency reconcile reports the reviewed SHA as superseded by developer or fix commits
- **THEN** later-stage dispatch SHALL NOT run
- **AND** SHALL follow the `review-1` routing specified by `review-sha-gating`

#### Scenario: Observation failure does not reuse a later-stage label

- **WHEN** review-currency reconcile cannot observe PR HEAD or the commit list
- **THEN** it SHALL return fail-closed
- **AND** the later stage SHALL NOT run as if review currency already held
