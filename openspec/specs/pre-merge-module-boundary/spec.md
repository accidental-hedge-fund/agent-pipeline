# pre-merge-module-boundary Specification

## Purpose
TBD - created by archiving change split-pre-merge-modules. Update Purpose after archive.
## Requirements
### Requirement: Pre-merge stage SHALL be split into domain modules with a thin facade

The pre-merge stage implementation SHALL NOT live as a single monolithic module that owns SHA-gate, OpenSpec archive, CI-gate, and conflict-rebase bodies together. The pipeline SHALL provide distinct modules under `core/scripts/stages/` for at least these domains:

1. **SHA-gate** — review-SHA currency, delta re-review orchestration helpers, and `enforceReviewShaGate` (and its deps surface)
2. **OpenSpec archive** — active-change guard, archive-already-done detection, and `maybeArchiveOpenspec`
3. **CI gate** — CI recovery-marker persistence and CI failure / zero-run recovery paths used at pre-merge
4. **Conflict / rebase** — merge-conflict recovery, rebase-attempted markers, and rebase-and-push helpers

`core/scripts/stages/pre_merge.ts` SHALL act as a thin facade (and optional thin orchestration entry) that re-exports the public pre-merge surface, following the same structural pattern as `core/scripts/stages/review.ts`.

#### Scenario: Domain modules exist for the four pre-merge domains

- **WHEN** the stages directory is inspected after this change
- **THEN** SHA-gate, OpenSpec archive, CI-gate, and conflict/rebase implementation bodies SHALL each reside in a dedicated module file under `core/scripts/stages/` (not only as nested local functions inside a single god-file)
- **AND** those modules SHALL be distinct from each other and from unrelated stage modules

#### Scenario: pre_merge.ts is a facade rather than the sole implementation home

- **WHEN** `core/scripts/stages/pre_merge.ts` is inspected after this change
- **THEN** it SHALL re-export public symbols from the domain modules (star-export or explicit named re-exports)
- **AND** it SHALL NOT be the only file containing the full implementation of `enforceReviewShaGate`, `maybeArchiveOpenspec`, CI recovery-marker persistence, and conflict rebase helpers

#### Scenario: Pattern matches the review split

- **WHEN** the pre-merge module layout is compared to the review stage layout
- **THEN** pre-merge SHALL follow the same structural idea: focused domain modules plus a thin `pre_merge.ts` re-export facade analogous to `review.ts` re-exporting `review-parsing` / `review-rendering` / `review-acquisition` / `review-routing`

---

### Requirement: Existing pre_merge import paths SHALL keep resolving the public surface

Production and test import sites that currently import from `core/scripts/stages/pre_merge.ts` (or `./pre_merge.ts` / `../stages/pre_merge.ts` equivalents) SHALL continue to obtain the same publicly exported symbols after the split without a mandatory mass rewrite of import paths. Domain modules MAY be imported directly by new code or targeted tests, but the facade path remains the supported compatibility surface.

#### Scenario: pipeline-run still imports the pre_merge stage facade

- **WHEN** `pipeline-run.ts` (or the advance dispatcher that loads pre-merge) imports the pre-merge stage module
- **THEN** it SHALL continue to resolve stage entrypoints such as `advance` / `advancePolling` through the `pre_merge` facade path
- **AND** pre-merge stage dispatch behavior SHALL remain available without requiring a new import path for the facade

#### Scenario: Tests importing from pre_merge.ts still resolve symbols

- **WHEN** an existing unit test imports symbols such as `enforceReviewShaGate`, `maybeArchiveOpenspec`, `performPreMergeAutoFix`, `advance`, or CI recovery helpers from `../scripts/stages/pre_merge.ts`
- **THEN** those imports SHALL continue to resolve to the same exported bindings (via re-export if the body moved)
- **AND** the test SHALL NOT be required to switch to deep domain paths solely because of the split

#### Scenario: Missing re-export is a regression

- **WHEN** a production or existing-test consumer imports a symbol that was publicly exported from `pre_merge.ts` before the split
- **THEN** the facade SHALL still export that symbol
- **AND** when a facade/export smoke or equivalent regression check is present, it SHALL fail if a required public re-export from its canary list is dropped

---

### Requirement: The split SHALL be move-only with respect to pre-merge product behavior

Relocating pre-merge code into domain modules SHALL NOT intentionally change pre-merge product outcomes. Living behavioral contracts remain authoritative, including at least:

- review-SHA gate currency, pipeline-internal commit exemption, delta re-review, and unresolved blocking-key holds (`review-sha-gating` and related)
- OpenSpec archive fail-closed / active-change guard outcomes
- pre-merge CI gate certification, recovery markers, and exhausted/zero-run block reasons (`pre-merge-ci-gate`)
- early/CI conflict detection and rebase-attempt bounds (`pre-merge-conflict-detection`)
- pre-merge bounded auto-fix outcomes (`pre-merge-fix-round`) when auto-fix remains in the pre-merge surface

Policy rewrites of those contracts are out of scope for this capability.

#### Scenario: Existing pre-merge regression suite remains the behavior oracle

- **WHEN** the pre-merge unit/regression tests (SHA-gate, OpenSpec archive, CI mode/recovery, conflict detection, auto-fix, convergence, and related) run after the split with injectable deps only
- **THEN** they SHALL pass without relaxing assertions to accommodate the move
- **AND** the suite SHALL continue to use fakes for gh/harness/worktree I/O (no real network, git, or subprocess in unit tests)

#### Scenario: No intentional SHA-gate policy rewrite in the split

- **WHEN** the change that introduces the module split is reviewed for product behavior
- **THEN** it SHALL NOT rewrite SHA-gate policy rules (currency classification, supersession ceilings, allowlisted identity, blocking-key re-evaluation) as part of the structural move
- **AND** any discovered policy bug fix SHALL be tracked separately rather than silently folded into the move-only PR

#### Scenario: No harness-round extraction required by this split

- **WHEN** this module-boundary change is implemented
- **THEN** it SHALL NOT require extracting a shared harness-round helper as a dependency of completion
- **AND** harness-round extraction remains a sibling concern outside this capability

---

### Requirement: Domain modules SHALL NOT import the pre_merge facade

Pre-merge domain modules SHALL form an acyclic graph relative to the facade: the facade MAY import domain modules; domain modules MUST NOT import `pre_merge.ts` / the facade to obtain types or helpers. Shared pure types or constants needed by multiple domains SHALL live in a leaf domain module or a small neutral helper, not in the facade.

#### Scenario: No domain → facade import cycle

- **WHEN** a SHA-gate, OpenSpec archive, CI-gate, or conflict-rebase domain module is inspected for imports
- **THEN** it SHALL NOT import from `./pre_merge.ts` / `pre_merge.ts` as a value or type dependency
- **AND** the facade remains free to import those domain modules

#### Scenario: Classifier stays in the neutral pipeline-commits module

- **WHEN** pipeline-internal commit classification is needed by SHA-gate or related pre-merge logic
- **THEN** classification SHALL continue to come from the neutral `pipeline-commits` module (directly or via existing re-export)
- **AND** the split SHALL NOT move `isPipelineInternalCommit` back into a stage god-module as the sole owner

---

### Requirement: Core changes SHALL keep the generated plugin mirror in sync

Any edit under `core/` that participates in this split SHALL be accompanied by regenerating the `plugin/` mirror via `node scripts/build.mjs` in the same change. CI’s mirror check (`node scripts/build.mjs --check`) SHALL pass.

#### Scenario: Mirror check passes after the split

- **WHEN** the split lands under `core/scripts/stages/`
- **THEN** `node scripts/build.mjs --check` SHALL report the mirror in sync
- **AND** regenerated `plugin/` contents for the moved modules SHALL be included in the same change set

### Requirement: Pre-merge domain modules SHALL expose reconcile-shaped surfaces

Pre-merge domain modules (SHA-gate, OpenSpec archive, CI gate, conflict/rebase) SHALL expose
`reconcile(observedState) → actions` (or equivalent named exports) that derive gate actions from
authoritative observed state, rather than only encoding irreversible linear side effects in a fixed
gate order. The thin `pre_merge.ts` facade MAY sequence those reconcile results. This requirement
coordinates with the pre-merge module split (#628) without requiring that split's full move-only
body to land in the same change; new consolidation for attempt ledger and currency SHALL land behind
reconcile-shaped APIs so a later split does not reintroduce private marker authorities.

#### Scenario: CI domain reconcile returns attempt-aware actions

- **WHEN** the CI-gate domain reconcile runs with observed definitive red checks and ledger state
  for head `H`
- **THEN** it SHALL return ordered recovery or escalate actions based on remaining ledger budget
- **AND** SHALL NOT require a private in-module marker file as sole authority

#### Scenario: SHA-gate domain reconcile returns currency actions

- **WHEN** the SHA-gate domain reconcile runs with reviewed SHA, HEAD, and blocking-key evidence
- **THEN** it SHALL return reuse, re-review, or hold actions
- **AND** SHALL NOT independently terminalize to human hold without authority evidence

#### Scenario: Facade may sequence without owning private books

- **WHEN** the pre_merge facade advances an issue through pre-merge
- **THEN** it MAY order domain reconcile results
- **AND** attempt authority SHALL remain the stage-attempt ledger rather than facade-local maps

