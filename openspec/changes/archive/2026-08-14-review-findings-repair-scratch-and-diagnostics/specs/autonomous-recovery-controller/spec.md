## MODIFIED Requirements

### Requirement: Review recovery SHALL perform substantive repair before redispatch

The default policy for durable class `review-findings` SHALL list the deterministic preparatory action `unlink_engine_scratch` before `repair_pipeline_item`, with bounded retry and repeated-evidence budgets. Stage-local auto-loop SHALL not consume this block. Preparatory unlink SHALL remove engine-known scratch when present so the subsequent repair claim observes a product-clean tree; unlink alone SHALL NOT satisfy recovery for this class while blocking findings still apply at the same candidate. A successful recovery for this class SHALL prove a new remote candidate from substantive repair before the normal whole-item pipeline is redispatched.

Controller semantics for preparatory unlink under this class SHALL be:

- A successful prep unlink (scratch removed) or a no-scratch not-applicable result SHALL advance to `repair_pipeline_item` in the **same recovery sequence** (same blocked-recovery cycle when a candidate head exists).
- Preparatory unlink SHALL NOT mark the item recovered, SHALL NOT clear `pipeline:blocked` solely as findings success, and SHALL NOT consume the class `retry_budget` or repeated-evidence budget as if a repair attempt failed.
- When no engine-known scratch is present at claim time, the controller SHALL still claim `repair_pipeline_item` within the class budget (unlink no-op or not-applicable SHALL NOT mark the item recovered and SHALL NOT permanently prevent repair).

#### Scenario: Default review-findings policy orders unlink before repair

- **WHEN** the default recovery policy entry for durable class `review-findings` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item` in the recipes list
- **AND** a unit test SHALL fail if the default order lists only `repair_pipeline_item` or places implementer repair before unlink

#### Scenario: Challenge-response scratch unlinks before findings repair

- **WHEN** a recoverable diagnostic projects to `review-findings` with a current candidate
- **AND** the managed worktree porcelain includes engine-known scratch such as `artifacts/challenge-response-*.json` and no product dirt under the shared classifier
- **THEN** the controller SHALL claim and execute `unlink_engine_scratch` before claiming `repair_pipeline_item` for that recovery sequence
- **AND** the subsequent `repair_pipeline_item` attempt SHALL observe a worktree free of that engine-known scratch

#### Scenario: Unlink alone is not review repair

- **WHEN** `unlink_engine_scratch` runs for class `review-findings` and removes engine-known scratch
- **AND** blocking review findings still apply at the same candidate
- **THEN** that unlink attempt SHALL NOT count as successful substantive recovery for the findings class
- **AND** SHALL NOT clear `pipeline:blocked` solely as if the findings were fixed
- **AND** recovery SHALL proceed to `repair_pipeline_item` in the same recovery sequence rather than redispatch as recovered

#### Scenario: Prep unlink does not consume findings repair budget

- **WHEN** class is `review-findings` and preparatory `unlink_engine_scratch` runs (scratch removed or not-applicable)
- **THEN** `recovery_budgets_remaining` for `review-findings` SHALL be unchanged by that prep step
- **AND** `repeated_evidence_count` for the item SHALL be unchanged by that prep step (including on failed completion)
- **AND** a following `repair_pipeline_item` claim in the same sequence SHALL still be able to charge against the full configured class retry budget
- **AND** preparatory fall-through failures SHALL NOT exhaust `repeated_evidence_limit` before the configured implementer repair attempts complete

#### Scenario: No-scratch findings path still reaches repair

- **WHEN** class is `review-findings` and porcelain has no engine-known scratch paths
- **THEN** recovery SHALL still claim `repair_pipeline_item` within the class budget in the same recovery sequence
- **AND** SHALL NOT terminate as recovered solely because unlink was not applicable

#### Scenario: Label clearing is not review repair

- **WHEN** a review finding remains blocking at the same candidate
- **THEN** clearing `blocked` and redispatching without candidate movement SHALL NOT satisfy recovery
- **AND** successful recovery for the class SHALL require substantive repair that proves a new remote candidate

#### Scenario: Stale repair-only default migrates; custom policy preserved

- **WHEN** a persisted contract carries the exact pre-#1060 default `review-findings` entry with only `repair_pipeline_item` and the historical default budgets/backoff
- **THEN** `upgradeContractForRecovery` SHALL replace that entry with the current default recipes including preparatory unlink
- **WHEN** a persisted `review-findings` entry differs from that exact stale default (custom recipes, budgets, or backoff)
- **THEN** upgrade SHALL leave that custom entry unchanged

## ADDED Requirements

### Requirement: repair_pipeline_item failure evidence SHALL distinguish non-commit outcomes

When the `repair_pipeline_item` recovery executor completes without a committed and pushed repair (`fix-committed`), it SHALL return failure evidence that distinguishes at least: (1) implementer-reported clean no-change (`noop-clean` or equivalent), including any implementer diagnostic text; (2) commit or pre-invoke refusal caused by residual worktree dirt/porcelain, including a path summary when available from the shared porcelain classifier; (3) harness or executor error with no commit, including the non-success status identifier and a bounded harness or shared-round diagnostic/output tail when any output was captured. Evidence SHALL include a stable category identifier among `noop-clean`, `dirt-blocked`, `harness-error`, and `no-diagnostic`. The executor SHALL NOT collapse every non-success status into a single generic string that omits status and diagnostic when those values exist. When no diagnostic was captured, evidence SHALL state that absence explicitly rather than implying an implementer ran to a silent no-op. That evidence string SHALL be the value consumed by the recovery completion path and `loop_recovery_action_executed` event fields so the supervisor/dashboard see the typed failure, not only a local executor log line. Dirt-blocked classification SHALL use the shared porcelain classifier and recognized engine-scratch path set only; product dirt SHALL remain fail-closed; `artifacts/**` SHALL NOT be waived broadly. Committed-but-unpushed reconcile failures and harness crashes SHALL NOT be labeled as clean no-change.

#### Scenario: No-commit with harness output is debuggable

- **WHEN** the configured implementer or shared harness-round finishes without producing a committed and pushed repair
- **AND** a non-success status and harness or diagnostic output exist
- **THEN** the recovery result error or evidence string SHALL include that status, category `harness-error` (or the mapped non-noop category), and a bounded output/diagnostic tail
- **AND** SHALL NOT equal only the generic phrase that the implementer did not produce a committed and pushed repair with no further detail
- **AND** the supervisor event `loop_recovery_action_executed` for that attempt SHALL carry the same evidence/error content

#### Scenario: Implementer clean no-change remains explicit

- **WHEN** the repair path returns an implementer clean no-change / `noop-clean` outcome
- **THEN** the recovery result SHALL state that the implementer inspected the candidate and produced no verifiable change
- **AND** SHALL include category `noop-clean` and the implementer diagnostic when present

#### Scenario: Dirt-blocked repair discloses porcelain cause

- **WHEN** repair refuses to commit or invoke because residual worktree dirt/porcelain blocks a safe repair
- **THEN** the recovery result SHALL identify the dirt-blocked condition (category `dirt-blocked`)
- **AND** SHALL include a path summary or classification hint from the shared classifier when porcelain is available
- **AND** SHALL NOT treat product dirt as engine-scratch-only success

#### Scenario: Missing diagnostic is explicit

- **WHEN** repair ends without a committed push and no diagnostic or harness output was captured
- **THEN** evidence SHALL include the non-success status and an explicit statement that no diagnostic was captured
- **AND** SHALL use category `no-diagnostic` rather than implying a silent implementer no-op
