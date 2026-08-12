## ADDED Requirements

### Requirement: Pre-merge entry SHALL treat prior-head blocking keys as non-authoritative until re-evaluated at the live head

At pre-merge SHA-gate / delta entry, before applying a residual block from durable `pipeline-blocking-keys` markers or an equivalent residual finding set, the pipeline SHALL compare the marker’s recorded reviewed SHA (or associated head) to the live open PR head pin. When they differ, the pipeline SHALL treat those keys as lacking blocking authority for the live head and SHALL re-enter delta evaluation (or the existing conservative re-review path) at the live head rather than calling `setBlocked` solely from the prior-head marker set. This gate-start rule is additive to the existing mid-review superseded-verdict requirements and does not remove re-validation of a just-produced verdict.

#### Scenario: Gate start with prior-head keys re-evaluates at live head

- **WHEN** durable blocking keys for finding set F were recorded against reviewed SHA `H_fail`
- **AND** the live open PR head is `H_green` where `H_green ≠ H_fail`
- **AND** pre-merge re-enters the SHA gate / delta path
- **THEN** the pipeline SHALL NOT `setBlocked` solely because F remains listed for `H_fail`
- **AND** SHALL run delta evaluation (or conservative re-review) against `H_green` before a new block disposition

#### Scenario: Pipeline-internal-only tip advance still re-evaluates prior-head residual keys

- **WHEN** durable blocking keys for finding set F were recorded against reviewed SHA `H_fail`
- **AND** the live open PR head is `H_green` where `H_green ≠ H_fail`
- **AND** every commit since `H_fail` is pipeline-internal under the existing classifier
- **THEN** the pipeline SHALL NOT `setBlocked` solely because F remains listed for `H_fail`
- **AND** SHALL re-enter delta evaluation or conservative re-review at `H_green`
- **AND** SHALL NOT silent-approve residual keys solely because the tip advance was pipeline-internal

#### Scenario: Same-head keys still enforce residual block

- **WHEN** durable blocking keys were recorded against reviewed SHA H
- **AND** the live open PR head is still H
- **AND** the keys are not overridden and findings remain blocking under policy
- **THEN** pre-merge SHALL still block under existing residual-finding contracts for H

#### Scenario: Mid-review supersession non-regression

- **WHEN** a delta verdict is produced against SHA A and re-validation finds live head B ≠ A
- **THEN** the existing superseded-verdict requirements SHALL still apply
- **AND** this gate-start rule SHALL NOT re-authorize blocking on the superseded A verdict

---

### Requirement: Stale docs-freshness delta claims SHALL not block a green live head without re-evaluation

When a prior delta or autofix path claimed docs-stale / CHANGELOG / `generate-docs --check` failures against a head that is no longer the live PR head, the pipeline SHALL NOT keep pre-merge blocked on that claim alone while the live head is green on CI and has not been re-evaluated as still broken. Re-evaluation at the live head that still finds a docs-freshness defect MAY block under normal policy.

#### Scenario: Prior-head docs-stale claim cleared by live-head re-eval path

- **WHEN** a blocking docs-stale finding was recorded only against `H_fail`
- **AND** live head is `H_green` with green github checks
- **AND** re-evaluation at `H_green` does not re-assert a blocking docs-stale finding
- **THEN** pre-merge SHALL NOT remain `needs-human` solely for the prior-head docs-stale claim

#### Scenario: Live-head docs-stale still blocks

- **WHEN** delta or deterministic check at live head H finds a blocking docs-freshness defect
- **THEN** pre-merge SHALL route that finding through the existing fix-round / residual block path for H
