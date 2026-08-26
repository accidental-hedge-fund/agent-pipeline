## MODIFIED Requirements

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

## ADDED Requirements

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
