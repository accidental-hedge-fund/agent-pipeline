## MODIFIED Requirements

### Requirement: Engine-known non-product scratch paths SHALL NOT hard-block gate trust alone

The pipeline SHALL classify uncommitted paths into product dirt vs non-product
scratch before format and test gates decide that a worktree is too dirty to trust
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

Product-relevant uncommitted paths (including source under product trees such as
`core/`, generated `plugin/`, OpenSpec product paths under `openspec/`, and any
path not matching the non-product set) SHALL still cause a hard block with
attempts 0 until committed. Recognized lockfiles remain handled by lockfile fold
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
- **AND** the test or format gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL block with attempts 0
- **AND** SHALL NOT invoke the test/build fix harness for that dirt
- **AND** the `blockReason` SHALL disclose the product path

#### Scenario: Mixed scratch and product dirt blocks on product

- **WHEN** the worktree has both non-product scratch (e.g. `tasks/todo.md` or
  `artifacts/challenge-response-1010.json`) and a product path uncommitted
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

## ADDED Requirements

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
