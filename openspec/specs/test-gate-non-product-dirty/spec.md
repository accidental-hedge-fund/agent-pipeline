# test-gate-non-product-dirty Specification

## Purpose
TBD - created by archiving change implement-test-gate-non-product-dirty. Update Purpose after archive.
## Requirements
### Requirement: Engine-known non-product scratch paths SHALL NOT hard-block gate trust alone

The pipeline SHALL classify uncommitted paths into product dirt vs non-product
scratch before format and test gates decide that a worktree is too dirty to trust
(pre-run dirty check) or that a passing command left untrusted artifacts
(post-run dirty check). When the only uncommitted paths match the engine-known
non-product scratch set (and any configured extensions of that set), the gate
SHALL treat the worktree as clean enough for trust and SHALL proceed to run the
gate command (or, if an implementation restores those scratch paths first, SHALL
proceed after restore). The engine-known set MUST include at least
`tasks/todo.md` and paths matching `.pipeline-prompt-*` at the worktree root.
Product-relevant uncommitted paths (including source under product trees such as
`core/`, generated `plugin/`, OpenSpec product paths under `openspec/`, and any
path not matching the non-product set) SHALL still cause a hard block with
attempts 0 until committed. Recognized lockfiles remain handled by lockfile fold
(`implement-commit-lockfile-inclusion` / `fix-commit-lockfile-inclusion`) and
SHALL NOT be reclassified as ignorable scratch by this capability.

#### Scenario: Scratch-only dirty worktree allows the test gate to run

- **WHEN** the worktree’s porcelain status lists only non-product scratch paths
  (e.g. modified `tasks/todo.md` and/or an untracked `.pipeline-prompt-*` file)
- **AND** no product path is uncommitted
- **AND** the test gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL NOT return a dirty-worktree hard block solely for those
  scratch paths
- **AND** the gate SHALL proceed to invoke the configured or detected test/build
  command (unless an optional restore of those paths runs first and then the
  command is invoked)

#### Scenario: Product dirty still hard-blocks

- **WHEN** the worktree has an uncommitted product path (e.g. `core/scripts/foo.ts`)
- **AND** the test or format gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL block with attempts 0
- **AND** SHALL NOT invoke the test/build fix harness for that dirt
- **AND** the `blockReason` SHALL disclose the product path

#### Scenario: Mixed scratch and product dirt blocks on product

- **WHEN** the worktree has both non-product scratch (e.g. `tasks/todo.md`) and a
  product path uncommitted
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

---

### Requirement: Configured scratch extension globs SHALL NOT waive product dirt

Configured extensions of the non-product scratch set (`test_gate.non_product_dirty_globs`) SHALL be constrained so they cannot exempt product-relevant paths from the dirty trust gate. Patterns capable of matching product trees or the whole repository (including at least `**`, `core/**`, `plugin/**`, and `openspec/**`) SHALL be rejected at config validation and SHALL be ignored at classify time. Classification SHALL remain fail-closed: an unsafe or over-broad extension MUST NOT cause an uncommitted product path to be treated as scratch.

#### Scenario: Hostile repo-wide extension does not waive product dirt

- **WHEN** `non_product_dirty_globs` includes `**` or another pattern that would
  match product paths under `core/`, `plugin/`, or `openspec/`
- **AND** porcelain reports an uncommitted product path (e.g. `core/scripts/foo.ts`)
- **THEN** the gate SHALL still hard-block on that product path
- **AND** SHALL NOT treat the product path as non-product scratch solely because
  of the hostile extension

#### Scenario: Narrow non-product extension remains allowed

- **WHEN** `non_product_dirty_globs` includes a narrow non-product namespace
  (e.g. `notes/**`)
- **AND** porcelain reports only that namespace dirty (plus optional engine-known
  scratch)
- **THEN** the gate SHALL treat those paths as non-product scratch for trust

---

### Requirement: Format auto-fix and test-fix salvage commits SHALL be product-path-only

The format-gate auto-fix path and the test-fix salvage path SHALL stage and
commit product paths only when non-product scratch is dirty or already staged.
Pre-staged scratch (e.g. `tasks/todo.md`) SHALL be unstaged or otherwise
excluded so it does not enter the auto-format or salvage commit. Scratch-only
dirt after a test-fix harness exit SHALL NOT invoke salvage at all.

#### Scenario: Pre-staged scratch does not enter auto-format commit

- **WHEN** `tasks/todo.md` is already staged
- **AND** an auto-format command produces a product-path change
- **THEN** the auto-format commit SHALL include the product path
- **AND** SHALL NOT include `tasks/todo.md`

#### Scenario: Scratch-only post-fix dirt skips salvage

- **WHEN** the test-fix harness exits without a new commit
- **AND** the only uncommitted paths are non-product scratch
- **THEN** the pipeline SHALL NOT invoke salvage for that dirt alone

#### Scenario: Mixed dirt salvages product paths only

- **WHEN** the test-fix harness exits without a new commit
- **AND** both product paths and scratch are uncommitted
- **THEN** salvage MAY run to capture product work
- **AND** the salvage commit SHALL NOT include non-product scratch paths

---

### Requirement: Non-product scratch classification SHALL be shared and injectable

The product-vs-scratch classification used for gate trust SHALL be implemented as
a pure, unit-testable helper (or equivalent injectable seam) shared by the test
gate and the format gate pre-flight dirty check on the implement certification
path. Unit tests SHALL drive classification and gate outcomes with fake porcelain
/ dirty seams and SHALL perform no real git, network, or subprocess calls. The
test suite SHALL include a regression that bites without the scratch exemption
(scratch-only porcelain would hard-block) and a fail-closed case for product dirt.

#### Scenario: Shared classification used on implement certification path

- **WHEN** post-implementation format and test gates run after implement (or
  resume-from-implementing)
- **AND** porcelain reports only engine-known scratch
- **THEN** neither the format gate pre-flight dirty refusal nor the test gate
  pre-run dirty check SHALL hard-block solely for that scratch

#### Scenario: Unit regression bites without scratch exemption

- **WHEN** the non-product scratch exemption is removed or disabled
- **AND** porcelain reports only `tasks/todo.md` (or another engine-known scratch
  path)
- **THEN** the regression test SHALL fail, proving the exemption is what allows
  the gate to proceed

#### Scenario: Classification is pure and injectable

- **WHEN** a unit test supplies a known list of porcelain paths including only
  scratch, only product, and mixed sets
- **THEN** the classifier SHALL return empty product dirt for scratch-only and
  non-empty product dirt for the other sets
- **AND** the test SHALL perform no real git, network, or subprocess call

---

### Requirement: Scratch-only dirt SHALL NOT be worded as test/build failure or fix exhaustion

The pipeline SHALL NOT emit an operator-facing blocker that claims the test/build
command failed or that fix attempts were exhausted when the only dirt is
non-product scratch and the gate proceeds. When the gate blocks on **product**
dirt, the reason SHALL remain a dirty-worktree trust refusal (not test-command
exhaustion), consistent with `test-build-gate` dirty-vs-exhaustion wording, and
SHALL disclose product paths so operators and recovery can distinguish product
commit obligations from scratch.

#### Scenario: Scratch-only does not mint a test-gate-exhausted style hold

- **WHEN** porcelain is scratch-only and the gate proceeds (or restores scratch
  then proceeds)
- **THEN** the pipeline SHALL NOT set a durable/operator blocker whose primary
  reason claims test/build command failure or fix-attempt exhaustion for that
  dirt alone

#### Scenario: Product dirty block discloses product paths without exhaustion wrapper

- **WHEN** product paths are dirty and the gate blocks
- **THEN** the operator-facing reason SHALL identify uncommitted product changes
- **AND** SHALL NOT claim “failed after N fix attempt(s)” or that the repo’s own
  test/build command is still failing solely due to that pre-run dirt

