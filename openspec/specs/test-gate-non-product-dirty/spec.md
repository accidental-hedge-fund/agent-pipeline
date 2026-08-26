# test-gate-non-product-dirty Specification

## Purpose
TBD - created by archiving change implement-test-gate-non-product-dirty. Update Purpose after archive.

## Requirements

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

### Requirement: Pipeline challenge-response dumps SHALL classify as non-product scratch for gate trust

The shared product-vs-scratch classifier SHALL treat uncommitted paths matching
the engine-known pattern `artifacts/challenge-response-*.json` as non-product
scratch. When porcelain lists only such path(s) (optionally mixed with other
engine-known scratch), `productDirtyPaths` SHALL be empty for that set, and
format/test gate trust checks SHALL NOT hard-block or mint a
`test-gate-exhausted` (or equivalent product-dirt exhaustion) blocker solely for
that dirt. Challenge-response dumps SHALL NOT be auto-committed into the product
tree by format auto-fix or test-fix salvage. Paths under product namespaces
and non-matching paths under `artifacts/` (paths that do not match
`artifacts/challenge-response-*.json`) SHALL remain product dirt unless covered
by another engine-known or safe config extension rule.

#### Scenario: Challenge-response-only porcelain is scratch

- **WHEN** porcelain path list is exactly
  `artifacts/challenge-response-1010.json` (or another
  `artifacts/challenge-response-*.json` basename)
- **THEN** classification SHALL place that path in scratch
- **AND** product dirt SHALL be empty

#### Scenario: Challenge-response-only dirt does not hard-block the test gate

- **WHEN** the worktree’s only uncommitted path is
  `artifacts/challenge-response-<N>.json`
- **AND** the test gate evaluates pre-run (or post-pass) dirty trust
- **THEN** the gate SHALL NOT hard-block solely for that path
- **AND** SHALL NOT set a durable blocker whose primary kind/reason is
  test/build fix exhaustion for that dirt alone
- **AND** SHALL proceed to run the test/build command when this is the pre-run
  check (or report pass for post-run dirty-trust when the command already
  exited 0)

#### Scenario: Challenge-response plus product path still product-blocks

- **WHEN** porcelain lists both `artifacts/challenge-response-1010.json` and
  `core/scripts/foo.ts`
- **THEN** product dirt SHALL include `core/scripts/foo.ts`
- **AND** the gate SHALL hard-block
- **AND** the block reason SHALL disclose the product path
- **AND** SHALL NOT treat the challenge-response path as sufficient to waive the
  product path

#### Scenario: Non-matching artifacts path remains product dirt

- **WHEN** porcelain lists an uncommitted path under `artifacts/` that does not
  match `artifacts/challenge-response-*.json` (e.g. `artifacts/other-notes.md`)
- **AND** no engine-known or safe config extension classifies that path as
  scratch
- **THEN** classification SHALL treat that path as product dirt
- **AND** the gate SHALL hard-block on pre-run dirty trust for that path alone

#### Scenario: Challenge-response is not folded into auto-format or salvage commits

- **WHEN** format auto-fix or test-fix salvage runs with mixed dirt including
  `artifacts/challenge-response-*.json` and a product path
- **THEN** any auto-format or salvage commit SHALL include the product path only
- **AND** SHALL NOT stage or commit the challenge-response dump

### Requirement: Scratch-only dirt SHALL NOT escalate as needs-human at format or test dirt gates

When format-gate or test-gate dirty-trust checks classify porcelain as engine-known non-product scratch only (shared classifier / engine-known set including `artifacts/challenge-response-*.json`, planning scratch under `tasks/**`, and `.pipeline-prompt-*`), the gate SHALL NOT set `pipeline:blocked` and SHALL NOT call `setBlocked` with kind `needs-human` or `human-decision-required` solely for that scratch. The gate SHALL proceed (or restore/unlink scratch then proceed) consistent with existing non-product dirty trust rules. Product dirt remains fail-closed with path disclosure under the established dirty-trust block path.

#### Scenario: Challenge-response-only does not needs-human at the test gate

- **WHEN** porcelain lists only `?? artifacts/challenge-response-N.json`
- **AND** the test gate evaluates pre-run dirty trust
- **THEN** the gate SHALL NOT set `pipeline:blocked` solely for that path
- **AND** SHALL NOT call `setBlocked` with kind `needs-human` or `human-decision-required` solely for that path
- **AND** SHALL proceed to invoke the test/build command (or restore scratch first and then proceed)

#### Scenario: Challenge-response-only does not needs-human at the format gate

- **WHEN** porcelain lists only engine-known scratch including a challenge-response dump
- **AND** the format gate evaluates pre-flight dirty trust on the implement certification path
- **THEN** the format gate SHALL NOT refuse solely for that scratch with `needs-human` or `human-decision-required`
- **AND** SHALL treat the worktree as clean enough for trust

#### Scenario: Product dirt at format or test gate still blocks

- **WHEN** porcelain includes an uncommitted product path under `core/` or dirty product `openspec/`
- **AND** the format or test gate evaluates dirty trust
- **THEN** the gate SHALL still hard-block with product-path disclosure
- **AND** SHALL NOT waive the product block because engine scratch is also present

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
