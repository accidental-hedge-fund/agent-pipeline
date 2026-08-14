## MODIFIED Requirements

### Requirement: Review recovery SHALL perform substantive repair before redispatch

The default policy for durable class `review-findings` SHALL list the deterministic preparatory action `unlink_engine_scratch` before `repair_pipeline_item`, with bounded retry and repeated-evidence budgets. Stage-local auto-loop SHALL not consume this block. Preparatory unlink SHALL remove engine-known scratch when present so the subsequent repair claim observes a product-clean tree; unlink alone SHALL NOT satisfy recovery for this class while blocking findings still apply at the same candidate. A successful recovery for this class SHALL prove a new remote candidate from substantive repair before the normal whole-item pipeline is redispatched. When no engine-known scratch is present, the controller SHALL still claim `repair_pipeline_item` for the class (unlink no-op or not-applicable SHALL NOT mark the item recovered and SHALL NOT permanently prevent repair within the class budget).

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
- **AND** recovery SHALL proceed to `repair_pipeline_item` (or remain blocked for repair) rather than redispatch as recovered

#### Scenario: No-scratch findings path still reaches repair

- **WHEN** class is `review-findings` and porcelain has no engine-known scratch paths
- **THEN** recovery SHALL still claim `repair_pipeline_item` within the class budget
- **AND** SHALL NOT terminate as recovered solely because unlink was not applicable

#### Scenario: Label clearing is not review repair

- **WHEN** a review finding remains blocking at the same candidate
- **THEN** clearing `blocked` and redispatching without candidate movement SHALL NOT satisfy recovery
- **AND** successful recovery for the class SHALL require substantive repair that proves a new remote candidate

## ADDED Requirements

### Requirement: repair_pipeline_item failure evidence SHALL distinguish non-commit outcomes

When the `repair_pipeline_item` recovery executor completes without a committed and pushed repair (`fix-committed`), it SHALL return failure evidence that distinguishes at least: (1) implementer-reported clean no-change (`noop-clean` or equivalent), including any implementer diagnostic text; (2) commit or pre-invoke refusal caused by residual worktree dirt/porcelain, including a path summary when available; (3) harness or executor error with no commit, including the non-success status identifier and a bounded harness or shared-round diagnostic/output tail when any output was captured. The executor SHALL NOT collapse every non-success status into a single generic string that omits status and diagnostic when those values exist. When no diagnostic was captured, evidence SHALL state that absence explicitly rather than implying an implementer ran to a silent no-op.

#### Scenario: No-commit with harness output is debuggable

- **WHEN** the configured implementer or shared harness-round finishes without producing a committed and pushed repair
- **AND** a non-success status and harness or diagnostic output exist
- **THEN** the recovery result error or evidence string SHALL include that status and a bounded output/diagnostic tail
- **AND** SHALL NOT equal only the generic phrase that the implementer did not produce a committed and pushed repair with no further detail

#### Scenario: Implementer clean no-change remains explicit

- **WHEN** the repair path returns an implementer clean no-change / `noop-clean` outcome
- **THEN** the recovery result SHALL state that the implementer inspected the candidate and produced no verifiable change
- **AND** SHALL include the implementer diagnostic when present

#### Scenario: Dirt-blocked repair discloses porcelain cause

- **WHEN** repair refuses to commit or invoke because residual worktree dirt/porcelain blocks a safe repair
- **THEN** the recovery result SHALL identify the dirt-blocked condition
- **AND** SHALL include a path summary or classification hint when porcelain is available
