## MODIFIED Requirements

### Requirement: Engine-known non-product scratch paths SHALL NOT hard-block gate trust alone

The pipeline SHALL classify uncommitted paths into unknown product dirt vs non-product
scratch vs pipeline-owned harness leftovers (see `harness-mutation-ownership`)
before format and test gates decide that a worktree is too dirty to trust
(pre-run dirty check) or that a passing command left untrusted artifacts
(post-run dirty check). When the only uncommitted paths match the engine-known
non-product scratch set (and any configured extensions of that set), the gate
SHALL treat the worktree as clean enough for trust and SHALL proceed to run the
gate command (or, if an implementation restores those scratch paths first, SHALL
proceed after restore). The engine-known set MUST include at least:

- planning scratch under `tasks/**` (including `tasks/todo.md`);
- paths matching `.pipeline-prompt-*` at the worktree root;
- pipeline-owned challenge-response dumps matching
  `artifacts/challenge-response-*.json` (worktree-relative under `artifacts/`
  only).

Unknown product-relevant uncommitted paths (including source under product trees such as
`core/`, generated `plugin/`, OpenSpec product paths under `openspec/`, and any
path not matching the non-product set and not classified as pipeline-owned
harness leftovers) SHALL still cause a hard block with
attempts 0 until committed. Pipeline-owned harness leftovers SHALL NOT hard-block
gate trust as unknown product dirt; ownership checkpoint SHALL run first (see
`harness-mutation-ownership`). Recognized lockfiles remain handled by lockfile fold
(`implement-commit-lockfile-inclusion` / `fix-commit-lockfile-inclusion`) and
SHALL NOT be reclassified as ignorable scratch by this capability. The engine
SHALL NOT treat the entire `artifacts/**` tree as scratch solely because
challenge-response dumps live under `artifacts/`.

#### Scenario: Scratch-only dirty worktree allows the test gate to run

- **WHEN** the worktree’s porcelain status lists only non-product scratch paths
  (e.g. modified `tasks/todo.md` and/or an untracked `.pipeline-prompt-*` file
  and/or an untracked `artifacts/challenge-response-*.json` dump)
- **AND** no product path is uncommitted
- **AND** the test gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL NOT return a dirty-worktree hard block solely for those
  scratch paths
- **AND** the gate SHALL proceed to invoke the configured or detected test/build
  command (unless an optional restore of those paths runs first and then the
  command is invoked)

#### Scenario: Product dirty still hard-blocks

- **WHEN** the worktree has an uncommitted product path (e.g. `core/scripts/foo.ts`)
- **AND** that path is unknown product dirt (not a pipeline-owned harness leftover)
- **AND** the test or format gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL block with attempts 0
- **AND** SHALL NOT invoke the test/build fix harness for that dirt
- **AND** the `blockReason` SHALL disclose the product path

#### Scenario: Mixed scratch and product dirt blocks on product

- **WHEN** the worktree has both non-product scratch (e.g. `tasks/todo.md` or
  `artifacts/challenge-response-1010.json`) and a product path uncommitted
- **AND** that product path is unknown product dirt
- **THEN** the gate SHALL hard-block
- **AND** the blocking reason SHALL identify the product path as the trust
  failure
- **AND** the gate SHALL NOT treat the presence of scratch alone as sufficient
  to pass the dirty check

#### Scenario: Post-run dirt that is scratch-only does not fail a passing command

- **WHEN** the test/build command exits 0
- **AND** the only uncommitted paths after the run match the non-product scratch
  set
- **THEN** the gate SHALL NOT hard-block solely because of that scratch
- **AND** SHALL report a pass for the dirty-trust aspect of the post-run check

#### Scenario: Lockfile fold remains orthogonal

- **WHEN** the worktree has an uncommitted recognized lock file
  (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`)
- **THEN** this capability SHALL NOT classify that lock as ignorable scratch
- **AND** the existing lockfile fold path SHALL remain responsible for including
  the lock before gates (per `implement-commit-lockfile-inclusion`)

## ADDED Requirements

### Requirement: Pipeline-owned harness leftovers SHALL NOT hard-block gate trust as unknown product dirt

When format-gate or test-gate dirty-trust classification reports pipeline-owned harness leftovers and no unknown product dirt, the gate SHALL NOT hard-block with attempts 0 solely for those leftovers. The engine SHALL checkpoint or otherwise recover those leftovers under `harness-mutation-ownership` before treating the worktree as unknown-dirty. Unknown product dirt still hard-blocks with path disclosure. Owned leftovers SHALL NOT be reclassified as engine-known scratch.

#### Scenario: Owned leftovers do not mint a dirty-trust hard block

- **WHEN** porcelain lists uncommitted product paths classified as pipeline-owned harness leftovers
- **AND** no unknown product path is uncommitted
- **AND** the test or format gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL NOT return a dirty-worktree hard block solely for those leftovers
- **AND** SHALL NOT treat those paths as engine-known scratch

#### Scenario: Unknown product dirt still hard-blocks beside leftovers

- **WHEN** porcelain lists both owned leftover path `P` and unknown product path `U`
- **AND** the test or format gate evaluates dirty trust after ownership checkpoint of `P`
- **THEN** the gate SHALL still hard-block on `U` when `U` remains uncommitted
- **AND** the block reason SHALL disclose `U`
