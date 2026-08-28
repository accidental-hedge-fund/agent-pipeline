## ADDED Requirements

### Requirement: Merge-mode train SHALL continue independent remaining work after a contained hold

When `--merge` is provided and one selected item reaches a **contained** per-item hold — blocked, `pipeline:needs-human`, waiting, a non-ready terminal, or a non-ok advance outcome — after resume and the single recover-parked pass, the train SHALL hold that item and SHALL continue the remaining selected set. A hold is contained when no merge mutation for that item is in flight and the last proven merge-result containment for the train is unchanged (or no merge has occurred). The train SHALL NOT whole-train STOP with `will not implement another sibling`, `will not implement #<n> while #<h> is blocked/parked`, or an equivalent abandonment solely because that item is held.

Remaining items with no direct or transitive `Depends on` path to any held item SHALL stay eligible for later advance waves and for serial merge when they reach `pipeline:ready-to-deploy`. Merge-first, serial merge, and base-containment law SHALL still apply: the train SHALL NOT implement a newer sibling while an earlier ready-to-deploy open mergeable PR remains unmerged, and it SHALL NOT merge a held item.

An **uncontained** failure SHALL still STOP the train without starting remaining work. Uncontained includes: a merge-result not contained in the fetched configured base, a merge mutation started for an item whose containment is unproven, and independence that cannot be proven from declared dependencies.

#### Scenario: Contained block continues independent remaining issues

- **WHEN** `pipeline train --merge --issues 279,269,268,267` has merged 279 and 269
- **AND** 268 then reaches a contained hold (blocked, waiting, needs-human, or non-ready) with no merge in flight
- **AND** 267 has no `Depends on` path to 268
- **THEN** the train SHALL hold 268
- **AND** SHALL advance 267 in a later wave
- **AND** SHALL NOT exit before 267 starts solely because 268 is held
- **AND** SHALL NOT emit `will not implement another sibling` as the terminal reason for abandoning 267

#### Scenario: Already-blocked item at start does not abandon independents

- **WHEN** `pipeline train --merge --issues 1074,1073` starts
- **AND** 1074 already carries `blocked` (or `pipeline:needs-human`)
- **AND** 1073 is independent of 1074 and is eligible to advance
- **THEN** the train SHALL hold 1074
- **AND** SHALL advance 1073
- **AND** SHALL NOT STOP with `will not implement #1073 while #1074 is blocked/parked`

#### Scenario: Waiting contained hold continues independents

- **WHEN** a merge-mode train item ends an advance wave `waiting` (for example CI still running) with no merge in flight and last proven base containment unchanged
- **AND** another selected item is independent and still schedulable
- **THEN** the train SHALL hold the waiting item
- **AND** SHALL continue the independent item
- **AND** SHALL NOT treat that waiting outcome as a reason to abandon the remaining selected set

#### Scenario: Independent ready-to-deploy sibling still merges after a park

- **WHEN** item P is held after a contained park or block
- **AND** item S is ready-to-deploy, independent of P, and has an open mergeable PR
- **THEN** the merge wave SHALL invoke the existing merge surface for S
- **AND** SHALL NOT merge P while P remains held
- **AND** SHALL NOT abort before that independent merge solely because P is held

#### Scenario: Uncontained containment failure still STOP

- **WHEN** a merge-mode train item's merge-result is not contained in the fetched configured base
- **THEN** the train SHALL STOP with a containment-class blocker
- **AND** it SHALL NOT start remaining work after that uncontained failure

#### Scenario: Merge-first still blocks implement while an open ready-to-deploy PR remains

- **WHEN** a merge-mode train has an earlier selected item at `pipeline:ready-to-deploy` with an open mergeable PR
- **AND** a later independent item is not yet ready-to-deploy
- **THEN** the train SHALL merge the ready-to-deploy PR (or STOP on that merge gate) before any plan or implement of the later item
- **AND** a contained hold of a different non-ready item SHALL NOT weaken this merge-first rule

---

### Requirement: Train independence SHALL exclude direct and transitive dependents of held items

A remaining selected item SHALL count as **independent** of the held set when it has no direct or transitive declared `Depends on` path to any held item. Direct and transitive dependents of a held item SHALL themselves be held with terminal `dependency-skipped`. They SHALL NOT enter an advance wave and SHALL NOT be merged while that ancestor remains held.

Independence SHALL be computed from the declared dependency graph resolved at train start for the frozen selected set. A missing or unknown edge SHALL fail closed as a code dependency, as today. A remaining item that a held item depends on (a prerequisite of the held item) SHALL NOT be skipped solely because of that reverse edge.

#### Scenario: Direct dependent is dependency-skipped

- **WHEN** merge-mode train holds item 268
- **AND** item 270 declares `Depends on: #268`
- **THEN** the train SHALL record 270 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 270 while 268 remains held

#### Scenario: Transitive dependent is dependency-skipped

- **WHEN** merge-mode train holds item 268
- **AND** item 270 declares `Depends on: #268`
- **AND** item 271 declares `Depends on: #270`
- **THEN** the train SHALL record 271 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 271 while 268 remains held

#### Scenario: Independent peer of a held item still runs

- **WHEN** merge-mode train holds item 268
- **AND** item 267 has no direct or transitive `Depends on` path to 268
- **THEN** 267 SHALL remain eligible to advance and, if it reaches ready-to-deploy, to merge
- **AND** 267 SHALL NOT be recorded as `dependency-skipped`

#### Scenario: Prerequisite of a held item is not skipped for the reverse edge

- **WHEN** item 268 declares `Depends on: #267` and 268 is held
- **AND** 267 has no `Depends on` path to 268 and is not yet finished
- **THEN** 267 SHALL remain eligible to advance
- **AND** SHALL NOT be recorded as `dependency-skipped` solely because 268 depends on it

---

### Requirement: Train SHALL freeze the selected issue set at start

The train SHALL resolve the selected issue set once at admission (`--issues` as given, or the freeze-eligible snapshot of `--milestone`) and SHALL use that ordered list for the rest of the run. The train SHALL NOT re-query GitHub to admit newly filed issues into the current work list, including engine-class live siblings assigned the same milestone after start. Filing those siblings MAY still occur under existing engine-class law. They SHALL wait for a later train or ship run.

#### Scenario: Explicit issue list does not grow mid-run

- **WHEN** `pipeline train --merge --issues 279,269,268,267` is admitted
- **AND** a new issue 1288 is filed on the same milestone while 268 is held
- **THEN** the current train work list SHALL remain `[279, 269, 268, 267]`
- **AND** 1288 SHALL NOT be advanced or merged in that run

#### Scenario: Milestone snapshot does not admit a mid-run sibling

- **WHEN** `pipeline train --merge --milestone v1.39.13` resolves freeze-eligible issues at start
- **AND** an engine-class live sibling is filed into that milestone after start
- **THEN** that sibling SHALL NOT join the current train's ordered issue list
- **AND** the train SHALL continue only the snapshot it resolved at start

---

### Requirement: Merge-mode train SHALL exit non-zero with structured completed, held, and dependency-skipped items

When `--merge` is provided and any selected item remains held or `dependency-skipped` after the train has merged every eligible independent ready-to-deploy item, the process SHALL exit non-zero, `train_status.complete` SHALL be false, and `next_action` SHALL be `stopped`. The stdout `train_status` object (`schema_version` remains `1`) SHALL include every selected issue in `items`. Completed, held, and dependency-skipped items SHALL be distinguishable from `items` (and optional additive summary fields) without parsing `blocker` prose.

A held item SHALL keep its per-item terminal (`blocked`, `needs-human`, `error`, `parked`, or equivalent). A skipped dependent SHALL use terminal `dependency-skipped`. A merged or already-integrated independent SHALL remain `ready-to-deploy` / `already-integrated` with `integrated: true`. Silence (omitting never-started issues from `items`) SHALL NOT satisfy this requirement.

#### Scenario: Partial success lists every selected issue

- **WHEN** a merge-mode JSON train selects 279, 269, 268, 267, 266
- **AND** 279 and 269 merge
- **AND** 268 is held after a contained wait or block
- **AND** 267 and 266 are independent and reach integrated
- **THEN** stdout SHALL parse as one `train_status` object
- **AND** `items` SHALL contain 279, 269, 268, 267, and 266
- **AND** 279 and 269 SHALL be completed/integrated
- **AND** 268 SHALL be held
- **AND** 267 and 266 SHALL be completed/integrated
- **AND** `complete` SHALL be false
- **AND** the process exit code SHALL be non-zero

#### Scenario: Dependency-skipped is a distinct item terminal

- **WHEN** 268 is held and 270 is skipped because it depends on 268
- **THEN** the `items` entry for 270 SHALL use terminal `dependency-skipped`
- **AND** a caller SHALL be able to distinguish 270 from 268 without reading `blocker`

#### Scenario: All-held remaining work still names every item

- **WHEN** every remaining selected item is held or dependency-skipped
- **THEN** `items` SHALL still include each selected issue
- **AND** the train SHALL STOP with a blocker that names the held items
- **AND** it SHALL NOT omit never-started dependents from `items`

---

## MODIFIED Requirements

### Requirement: Train composition regressions SHALL be guarded by automated tests

In addition to the product train contracts (one multi-item advance wave per base-eligible frontier, code-dep merge barrier before child advance, serial merge waves, independent R2D sibling merge under proven independence, production multi-item loop wiring, merge-mode continuation after a contained hold), the test suite SHALL include automated composition coverage that fails when those contracts regress. At minimum the suite SHALL fail if: (1) train returns to N×`single` / multiple advance-wave calls for one multi-item frontier or production N×`single` wiring; (2) a code-dependent child is advanced before prerequisite merge-result containment; (3) a proven-independent already ready-to-deploy sibling is not merged (or the train aborts before that merge) solely because a peer is parked or blocked; (4) a contained hold or block on one merge-mode item causes the train to abandon a proven-independent remaining item or to omit that item from `train_status.items`. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: N×single frontier composition fails CI

- **WHEN** a hermetic train composition test observes more than one multi-item advance-wave call for a single multi-item base-eligible frontier, or production wiring defaults to N×`single`
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Independent R2D merge under partial failure is regression-guarded

- **WHEN** a hermetic test places one item parked/blocked and a proven-independent sibling at ready-to-deploy under merge mode
- **AND** the system under test fails to merge the independent sibling solely because of the parked peer
- **THEN** the test SHALL fail

#### Scenario: Code-dep barrier is regression-guarded

- **WHEN** a hermetic test models code dependency A→B without A’s merge-result on base
- **AND** the system under test advances B in an advance wave
- **THEN** the test SHALL fail

#### Scenario: Contained-hold sibling abandonment fails CI

- **WHEN** a hermetic merge-mode fixture holds issue 268 after a contained block or wait
- **AND** independent issues 267 and 266 remain on the frozen work list
- **AND** the system under test STOPs with `will not implement another sibling` (or omits 267 and 266 from `items`) without advancing them
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Transitive dependent skip is regression-guarded

- **WHEN** a hermetic merge-mode fixture holds 268 and models 271 depending transitively on 268
- **AND** the system under test advances or merges 271 while 268 remains held
- **THEN** the test SHALL fail
