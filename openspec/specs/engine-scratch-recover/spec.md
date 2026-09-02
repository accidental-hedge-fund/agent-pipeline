# engine-scratch-recover Specification

## Purpose
Deterministically classify and recover engine-owned scratch porcelain so scratch-only dirt unlinks and clears without escalating to needs-human or train STOP, while product dirt stays fail-closed.

## Requirements

### Requirement: Engine-owned scratch-only porcelain SHALL recover without needs-human escalation

When worktree porcelain lists only paths in the engine-known non-product scratch set (including at least pipeline-owned `artifacts/challenge-response-*.json` dumps and existing pipeline-internal markers / planning scratch already treated as non-product), the pipeline SHALL treat that state as **engine scratch**, not product dirt and not a human-authority hold. Every dirt gate that can call `setBlocked` on worktree porcelain (including pre-merge OpenSpec archive cleanliness, format-gate and test-gate dirty trust, salvage product-path selection, and any sibling porcelain cleanliness check) SHALL classify porcelain via the shared non-product classifier (`classifyWorktreeDirt` / `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` or an equivalent pure helper that is the single source of that set). When residual product dirt is empty after classification, the gate SHALL best-effort unlink or restore only the engine-known scratch paths (same spirit as marker-only cleanup of `.pipeline-rebase-attempted`) and SHALL NOT set `pipeline:blocked` or transition to `pipeline:needs-human` solely for that scratch-only porcelain. Uncommitted product paths under `core/`, generated `plugin/`, dirty product `openspec/` content, recognized lockfiles handled by lockfile fold (not scratch), and other non-scratch paths SHALL still hard-block. The engine SHALL NOT waive the entire `artifacts/**` tree as scratch. Engine scratch SHALL NOT be auto-committed into the product tree.

#### Scenario: Challenge-response-only porcelain does not needs-human

- **WHEN** porcelain lists only `?? artifacts/challenge-response-N.json` (or an equivalent engine-known scratch path already in the shared non-product set)
- **AND** no product path is uncommitted
- **AND** any dirt gate that can `setBlocked` on porcelain evaluates cleanliness
- **THEN** the pipeline SHALL NOT set `pipeline:blocked` solely for that porcelain
- **AND** SHALL NOT transition the item to `pipeline:needs-human` solely for that porcelain
- **AND** SHALL NOT call `setBlocked` with kind `needs-human` or `human-decision-required` solely for that porcelain

#### Scenario: Scratch-only porcelain is unlinked without setBlocked

- **WHEN** porcelain is scratch-only under the engine-known set at a dirt gate
- **THEN** the gate SHALL best-effort unlink or restore those engine-known scratch paths
- **AND** SHALL proceed without `setBlocked` when product dirt remains empty
- **AND** SHALL NOT stage or commit the scratch into the product tree

#### Scenario: Product dirt still hard-blocks

- **WHEN** porcelain includes an uncommitted path under `core/` or other product/non-scratch paths
- **THEN** the pipeline SHALL hard-block with product-path disclosure
- **AND** SHALL NOT treat co-present engine scratch as sufficient to pass cleanliness

#### Scenario: Dirty openspec product path still hard-blocks

- **WHEN** porcelain includes a dirty product path under `openspec/` (not solely engine-known scratch outside that tree)
- **THEN** the pipeline SHALL hard-block
- **AND** SHALL NOT treat engine-known scratch alone as sufficient to pass cleanliness

#### Scenario: Broad artifacts tree is not waived

- **WHEN** porcelain includes an untracked path under `artifacts/` that is not an engine-known scratch pattern
- **THEN** the pipeline SHALL NOT classify that path as ignorable engine scratch solely because it lives under `artifacts/`

#### Scenario: Shared classifier is required at every porcelain dirt gate

- **WHEN** a production dirt gate decides whether porcelain warrants `setBlocked`
- **THEN** it SHALL use the shared non-product classifier (or an equivalent pure helper that shares `ENGINE_NON_PRODUCT_SCRATCH_GLOBS`)
- **AND** SHALL NOT maintain a parallel ad-hoc scratch path list that can drift from the shared set

---

### Requirement: Scratch recovery SHALL unlink engine scratch before implementer repair

For the engine-scratch / `workflow-engine-defect` recovery path, the autonomous recovery recipe set SHALL include a deterministic action named `unlink_engine_scratch` (or an equivalent stable action id with the same contract) that removes or restores only engine-known scratch paths and, when the active block was caused by scratch-only dirt, clears `pipeline:blocked`. That action SHALL be ordered **ahead of** any implementer `repair_pipeline_item` (or equivalent harness repair) for the same class in the default recovery policy. A successful scratch-only recovery SHALL resume the current stage / normal advance without creating a human hold and without a harness repair round. The recipe SHALL NOT auto-commit scratch into the product tree and SHALL NOT invoke the implementer repair harness when unlink alone clears the block. When porcelain after unlink still has product dirt, the recipe SHALL fail closed without clearing the block solely as “scratch recovered,” so a later product-dirt path can run.

#### Scenario: Scratch-only recovery unlinks and does not repair

- **WHEN** a recoverable diagnostic projects to engine-scratch / `workflow-engine-defect` with porcelain that is scratch-only under the engine-known set
- **THEN** the controller SHALL claim and execute `unlink_engine_scratch` before `repair_pipeline_item`
- **AND** after unlink, when no product dirt remains, it SHALL clear `pipeline:blocked` if present for that scratch cause
- **AND** it SHALL NOT invoke `repair_pipeline_item` for that attempt
- **AND** it SHALL NOT open a harness repair round for that attempt

#### Scenario: Recipe order places unlink ahead of implementer repair

- **WHEN** the default permitted recipe sequence for `workflow-engine-defect` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for scratch-only evidence

#### Scenario: Mechanical scratch recover is not a human hold

- **WHEN** `unlink_engine_scratch` succeeds for scratch-only evidence
- **THEN** the controller SHALL NOT create a human hold or emit `human_intervention` solely for that recover
- **AND** the item SHALL re-enter normal whole-item execution when otherwise eligible

#### Scenario: Product dirt after unlink fails closed without false clear

- **WHEN** `unlink_engine_scratch` runs and product dirt remains after unlink
- **THEN** the recipe SHALL NOT clear `pipeline:blocked` solely as a successful scratch recover
- **AND** SHALL NOT invoke `repair_pipeline_item` as if scratch-only succeeded

### Requirement: Residual engine-scratch blocks SHALL use harness-failure not needs-human

When a dirt gate or recovery path must still emit a block for an engine-scratch / factory-defect residual after classification (for example: classification or status probe failure on a path that is not product dirt, or an engine-owned scratch cleanup failure that cannot safely proceed), the block kind SHALL be `harness-failure` so stage-diagnostic projection yields `workflow-engine-defect` with disposition recover. The pipeline SHALL NOT use `needs-human` or `human-decision-required` for that residual. True human authority remains a closed class (`specification-decision` / `missing-authority` / attested `human-decision-required` only). Product-relevant dirt MAY keep its established product / workspace-dirt block kinds; this requirement applies to the engine-scratch residual class, not to product dirt.

#### Scenario: Residual engine-scratch block is harness-failure

- **WHEN** a dirt gate must still `setBlocked` for an engine-scratch residual that is not product dirt and is not true human authority
- **THEN** the call SHALL use blocker kind `harness-failure`
- **AND** SHALL NOT use `needs-human` or `human-decision-required`
- **AND** stage-diagnostic projection SHALL place the outcome in `workflow-engine-defect` (recover)

#### Scenario: True human authority is unchanged

- **WHEN** fresh evidence carries attested `human-decision-required` with matching authority evidence
- **THEN** the pipeline SHALL still create a human hold per existing human-authority rules
- **AND** SHALL NOT reclassify that evidence as engine-scratch residual

---

### Requirement: Porcelain dirt sites SHALL pass a shared-classifier drift guard

The test suite SHALL maintain a machine-readable inventory (or equivalent discoverable set) of production dirt gates that call `setBlocked` (or equivalent park) based on worktree porcelain. For each such site the inventory SHALL record whether the site uses the shared non-product classifier **and** whether a dirt-trust site consults harness mutation ownership (`harness-mutation-ownership`) before treating product porcelain as unknown dirt. A drift-guard unit test SHALL fail when a new production porcelain dirt / `setBlocked` site is added without an inventory or disposition update that states how the site classifies engine-known scratch. The guard SHALL also fail when a dirt-trust site that can refuse auto-fix or resume on product porcelain is added without a disposition that states how the site classifies pipeline-owned harness leftovers. The guard’s purpose is to stop the next path-shaped mole where a new site hard-blocks on scratch-only porcelain without `classifyWorktreeDirt`, or hard-blocks pipeline-owned leftovers as unknown dirt without ownership consultation.

#### Scenario: Missing inventory entry fails the guard

- **WHEN** a new production porcelain dirt gate that can `setBlocked` is added without a matching inventory / disposition row
- **THEN** the shared-classifier drift-guard test SHALL fail
- **AND** the failure SHALL identify the module or site key that lacks a disposition

#### Scenario: Inventoried shared-classifier site passes the guard

- **WHEN** every discovered production porcelain dirt / `setBlocked` site has an inventory row stating shared-classifier use (or an explicit non-dirt-gate disposition)
- **THEN** the drift-guard test SHALL pass

#### Scenario: Ad-hoc scratch list without shared classifier fails closed in intent

- **WHEN** an inventoried dirt site is declared to bypass the shared classifier without a documented exception disposition
- **THEN** the drift-guard or site disposition check SHALL fail CI
- **AND** SHALL NOT treat an undeclared parallel path list as compliant

#### Scenario: Dirt-trust site without ownership consultation fails the guard

- **WHEN** a production dirt-trust site can refuse auto-fix or implementing-resume on product porcelain
- **AND** its inventory row does not state ownership consultation (or an explicit exception)
- **THEN** the drift-guard test SHALL fail
- **AND** the failure SHALL identify the site that would treat owned leftovers as unknown dirt

### Requirement: Scratch-only composition regressions SHALL be guarded by automated tests

In addition to product scratch-recover contracts (shared classifier, unlink without `setBlocked` for scratch-only porcelain, residual engine blocks as `harness-failure` / `workflow-engine-defect`, `unlink_engine_scratch` before `repair_pipeline_item`), the test suite SHALL include automated composition coverage that fails when those contracts regress on the ship path. At minimum the suite SHALL fail if: (1) scratch-only engine porcelain parks as `pipeline:needs-human` or block kind `needs-human` / `human-decision-required`, or `setBlocked` solely for that porcelain; (2) scratch-only recovery invokes `repair_pipeline_item` for that attempt instead of deterministic unlink/clear. Product dirt hard-blocks remain correct and SHALL NOT be treated as composition failures. Tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Scratch-only needs-human composition fails CI

- **WHEN** a hermetic test presents scratch-only porcelain under the engine-known set to a dirt gate or recovery composition path
- **AND** the system under test escalates as `needs-human` / `pipeline:needs-human` or `setBlocked` solely for that porcelain
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Scratch-only repair composition fails CI

- **WHEN** a hermetic test drives scratch-only recovery
- **AND** the system under test invokes `repair_pipeline_item` for that attempt without successful scratch-only unlink/clear
- **THEN** the test SHALL fail

#### Scenario: Product dirt hard-block is not a composition failure

- **WHEN** porcelain includes product paths and the gate hard-blocks with product disclosure
- **THEN** the scratch-only composition suite SHALL NOT fail solely for that hard-block

### Requirement: Review-findings recovery SHALL prep-unlink engine scratch before implementer repair

For durable class `review-findings`, the autonomous recovery recipe set SHALL include deterministic action `unlink_engine_scratch` ordered **ahead of** `repair_pipeline_item` in the default recovery policy. When that action runs under `review-findings` and porcelain lists engine-known scratch under the shared non-product set (including at least `artifacts/challenge-response-*.json`) with empty product dirt, it SHALL remove or restore only those engine-known scratch paths so a later `repair_pipeline_item` claim observes a product-clean tree. That preparatory unlink SHALL NOT auto-commit scratch into the product tree, SHALL NOT invoke the implementer, SHALL NOT clear `pipeline:blocked` solely as a successful findings recovery while blocking review findings still apply at the same candidate, and SHALL NOT consume the findings class retry or repeated-evidence budget. When no engine-known scratch is present, the action SHALL fail closed as not-applicable so the next configured recipe (`repair_pipeline_item`) can run in the same recovery sequence. Product dirt after classification SHALL still fail closed.

**Authoritative cleanup boundary:** Engine-known scratch cleanup for this recovery path SHALL occur only via the `unlink_engine_scratch` action. `repair_pipeline_item` SHALL NOT perform a second best-effort strip of engine scratch; residual porcelain after prep SHALL surface as dirt-blocked repair evidence under the shared classifier.

This requirement does not change the terminal scratch-only recover path for `workflow-engine-defect` (unlink, clear blocked when scratch-only, no harness round).

#### Scenario: Findings class policy places unlink before repair

- **WHEN** the default permitted recipe sequence for `review-findings` is inspected under test
- **THEN** `unlink_engine_scratch` SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is the only default recipe or is ordered first

#### Scenario: Scratch present under findings is unlinked as prep

- **WHEN** recovery claims `unlink_engine_scratch` for class `review-findings`
- **AND** porcelain is engine-scratch-only under the shared classifier (for example `?? artifacts/challenge-response-N.json`)
- **THEN** the action SHALL unlink or restore those engine-known scratch paths
- **AND** SHALL NOT stage or commit the scratch into the product tree
- **AND** SHALL NOT treat the attempt as successful substantive findings recovery that clears the findings block solely via unlink
- **AND** a following `repair_pipeline_item` claim in the same recovery sequence SHALL see no remaining engine-known scratch from that set

#### Scenario: No scratch under findings falls through to repair

- **WHEN** recovery claims `unlink_engine_scratch` for class `review-findings`
- **AND** porcelain has no engine-known scratch paths
- **THEN** the action SHALL NOT clear the findings block as recovered
- **AND** SHALL return a not-applicable / try-next-recipe failure so `repair_pipeline_item` remains reachable in the same recovery sequence

#### Scenario: Product dirt remains fail-closed under findings unlink

- **WHEN** recovery claims `unlink_engine_scratch` for class `review-findings`
- **AND** porcelain includes product dirt under the shared classifier
- **THEN** the action SHALL fail closed without deleting product paths
- **AND** SHALL NOT clear `pipeline:blocked` as recovered

#### Scenario: Workflow-engine-defect terminal scratch recover is unchanged

- **WHEN** a recoverable diagnostic projects to engine-scratch / `workflow-engine-defect` with scratch-only porcelain
- **THEN** the controller SHALL still claim and execute `unlink_engine_scratch` before `repair_pipeline_item`
- **AND** after unlink, when no product dirt remains, it SHALL clear `pipeline:blocked` if present for that scratch cause
- **AND** it SHALL NOT invoke `repair_pipeline_item` for that attempt when unlink alone clears the scratch-only block

### Requirement: Residual owned-leftover blocks SHALL use harness-failure not needs-human

When a dirt-trust gate or recovery path must still emit a block for pipeline-owned harness leftovers after classification (for example checkpoint failed and no unknown product dirt remains, or ownership evidence is present but checkpoint cannot run), the block kind SHALL be `harness-failure` so stage-diagnostic projection yields `workflow-engine-defect` with disposition recover. The pipeline SHALL NOT use `needs-human` or `human-decision-required` for that leftover residual. True human authority remains a closed class. Unknown product dirt MAY keep its established unknown-dirt block. Engine-known scratch remains the scratch class and SHALL NOT be used to waive product leftovers.

#### Scenario: Residual owned-leftover block is harness-failure

- **WHEN** a dirt gate must still `setBlocked` for pipeline-owned leftovers that are not unknown product dirt and are not true human authority
- **THEN** the call SHALL use blocker kind `harness-failure`
- **AND** SHALL NOT use `needs-human` or `human-decision-required`
- **AND** stage-diagnostic projection SHALL place the outcome in `workflow-engine-defect` (recover)

#### Scenario: Unknown product dirt is unchanged

- **WHEN** remaining porcelain is unknown product dirt
- **THEN** the gate MAY still refuse auto-fix under existing unknown-dirt rules
- **AND** SHALL NOT reclassify that unknown dirt as engine scratch or as a human-authority hold solely because an owned leftover was also present earlier

### Requirement: Unknown dirt SHALL be preserved or quarantined and never deleted

When worktree porcelain includes paths that are not in the engine-known non-product scratch set, the shared materialization and scratch-recovery paths SHALL preserve those paths or quarantine them so lookup cannot treat the tree as a clean present worktree. The pipeline SHALL report unknown or unclassified dirt as inconsistency. The pipeline SHALL NOT delete unknown work. Pipeline-owned scratch MAY still be unlinked or restored as specified by the existing scratch-only recovery requirement. Known product dirt SHALL still fail closed.

#### Scenario: Unclassified porcelain is not deleted

- **WHEN** porcelain includes an untracked path that is not in `ENGINE_NON_PRODUCT_SCRATCH_GLOBS` (or the equivalent shared classifier set)
- **THEN** materialization and scratch recovery SHALL NOT unlink, `git clean`, or otherwise delete that path
- **AND** SHALL emit an inconsistency observation
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Quarantine does not destroy unknown work

- **WHEN** materialization cannot proceed because of unknown dirt
- **THEN** the seam MAY refuse reuse or quarantine the path so later lookup does not classify it as a clean present worktree
- **AND** the unknown files SHALL still exist after the refusal
- **AND** the adapter SHALL NOT treat the refusal as a reason to delete the tree

#### Scenario: Scratch-only dirt still unlinks

- **WHEN** porcelain lists only engine-known scratch paths
- **THEN** the existing `unlink_engine_scratch` treatment MAY remove or restore those scratch paths
- **AND** SHALL NOT delete any non-scratch path
