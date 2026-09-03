# integrated-train-mode Specification

## Purpose
TBD - created by archiving change add-integrated-train-mode. Update Purpose after archive.

## Requirements

### Requirement: The CLI SHALL provide an opt-in integrated train command

The Pipeline CLI SHALL expose a loop-isolated `train` command that accepts a work selector of at least one of: an explicit ordered issue list, or a milestone name that resolves to freeze-eligible pipeline issues. Freeze-eligible issues SHALL include open non-backlog pipeline issues and closed issues labeled `pipeline:ready-to-deploy`. The command SHALL NOT be reachable from `pipeline advance` stage dispatch. The command SHALL refuse to run when no work selector is provided. The command SHALL NOT refuse a milestone solely because every freeze-eligible issue is closed.

#### Scenario: Explicit issue list is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11,12`
- **THEN** the train SHALL resolve those issue numbers as the work list in the given order after dependency validation
- **AND** it SHALL NOT invoke advance-stage merge logic

#### Scenario: Milestone selector is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.34.0`
- **THEN** the train SHALL resolve the milestone's freeze-eligible issues into a dependency-ordered work list using existing declared-dependency discovery
- **AND** it SHALL refuse a cycle with a validation error

#### Scenario: All-closed ready-to-deploy milestone is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.39.13 --merge`
- **AND** every freeze-eligible issue in that milestone is closed, labeled `pipeline:ready-to-deploy`, and has a linked PR merged and contained in the fetched base
- **THEN** the train SHALL accept the milestone selector
- **AND** it SHALL NOT exit with `has no open issues` or an equivalent open-only empty-list error
- **AND** it SHALL record each item as already integrated

#### Scenario: Missing selector is refused

- **WHEN** an operator runs `pipeline train` with neither issues nor milestone
- **THEN** the command SHALL exit non-zero with an error naming the required selector

### Requirement: Default train advance SHALL stop each item at ready-to-deploy without merging

When `--merge` is not provided, the train SHALL advance work-list items through base-eligible frontiers via the loop/advance-wave facade until each item reaches a terminal stage of `pipeline:ready-to-deploy` or a typed per-item park/hold (`pipeline:needs-human` or equivalent). The train SHALL NOT call `mergePr` or the merge-queue apply path. A per-item park or `needs-human` hold SHALL exclude that item from further advance waves and SHALL NOT, by itself, abort advance of **proven-independent** remaining frontier members when the loop run contract still has schedulable work. When no schedulable independent work remains, train status SHALL name every held issue and park reason.

#### Scenario: Non-merge train leaves PRs unmerged

- **WHEN** a train without `--merge` finishes an item at `pipeline:ready-to-deploy`
- **THEN** the linked pull request SHALL remain open
- **AND** no merge API call SHALL be recorded for that item

#### Scenario: needs-human parks the train

- **WHEN** an item reaches `pipeline:needs-human` during a non-merge or merge train
- **AND** no proven-independent schedulable work remains on the work list
- **THEN** the train SHALL stop scheduling further forward items
- **AND** train status SHALL name the issue and park reason

#### Scenario: needs-human parks the item while independent peers continue

- **WHEN** an item reaches `pipeline:needs-human` (or equivalent typed hold) during a non-merge or merge train
- **AND** another work-list item is proven independent and still schedulable
- **THEN** the train SHALL exclude the held item from further advance waves
- **AND** SHALL continue scheduling the independent item
- **AND** train status SHALL name the held issue and park reason

#### Scenario: All remaining work held stops the train

- **WHEN** every non-done work-list item is held, blocked after resume attempts, or otherwise non-schedulable
- **THEN** the train SHALL stop with status naming each held issue and reason
- **AND** it SHALL NOT invent merge or advance authority to force progress

---

### Requirement: Train merge mode SHALL integrate each item before starting the next

When `--merge` is provided, the train SHALL integrate work through **base-eligible frontiers** rather than a pure N× one-item serial advance of the entire list without frontier recomputation:

1. Compute the frontier of items whose code prerequisites are integrated (merge-result contained in the fetched base) and eligible to co-advance.
2. **Merge-first prelude:** for every work-list item that is already at `pipeline:ready-to-deploy` (or equivalent) with an open mergeable PR and is not already integrated, reconcile linked PR state, invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`, observe the merge-result, fetch the configured base, and prove the merge-result is contained in the fetched base tip ancestry. This prelude SHALL complete before any plan or implement mutation on any other work-list item. Merges are **serial**.
3. Run one advance wave for the remaining eligible frontier via the loop/advance-wave facade (recovery inside the wave). Pre-ready-to-deploy items MAY enter this wave only after step 2 has merged and contained every already-ready-to-deploy mergeable sibling on the work list.
4. For each frontier item that is at `pipeline:ready-to-deploy` (or equivalent) and not already integrated after that advance wave: reconcile linked PR state across open/closed/merged; if a merge mutation is required, resolve exactly one linked open PR, invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`, observe the merge-result, fetch the configured base, and prove the merge-result is contained in the fetched base tip ancestry — merges are **serial** within the merge wave.
5. Only after prerequisites are merged and contained may a code-dependent successor enter a later advance wave.
6. Pre-ready-to-deploy items SHALL NOT be short-circuited as integrated from a historical merged PR alone.
7. Concurrent capacity for **merge** under merge mode SHALL be one. Advance concurrency inside a frontier follows loop policy (may be >1 when proven independent).
8. The train SHALL NOT treat "no linked open PR" as a hard stop when reconciliation already established a merged linked PR for a ready-to-deploy item.

A log line that says `merge-first` without performing the prelude SHALL NOT satisfy this requirement. Planning or implementing a non-ready-to-deploy sibling while an earlier ready-to-deploy open mergeable PR remains open SHALL fail the train.

#### Scenario: Dependent starts only after prerequisite merge is contained

- **WHEN** issue A is a code prerequisite of issue B in the train
- **AND** A has just reached ready-to-deploy
- **THEN** the train SHALL merge A's pull request and prove base containment before B enters an advance wave
- **AND** B SHALL NOT advance while A's merge-result is not contained in the fetched base

#### Scenario: Squash merge uses merge-result containment not PR-head ancestry

- **WHEN** a squash merge produces merge commit R from reviewed head H
- **THEN** containment proof SHALL require R to be an ancestor of the fetched base tip (or equal to it)
- **AND** the train SHALL NOT require H itself to be an ancestor of the base

#### Scenario: Merge gates refuse unclean PRs

- **WHEN** the linked PR fails an existing `pipeline merge` gate (checks, stage, mergeability, or head)
- **THEN** the train SHALL stop without merging that PR
- **AND** train status SHALL name the gate failure

#### Scenario: Already-merged PR is idempotent success

- **WHEN** reconciliation shows a linked PR (resolved across open, closed, or merged state) is already merged and its merge-result is contained in the fetched base for an item at ready-to-deploy
- **THEN** the train SHALL treat the item as integrated and continue
- **AND** it SHALL NOT attempt a second merge mutation
- **AND** this SHALL hold even when the issue is closed and still labeled `pipeline:ready-to-deploy`

#### Scenario: Reopened pre-ready-to-deploy issue with historical merged PR is not skipped

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready` (or another pre-ready-to-deploy stage) whose only linked PR from prior work is already merged
- **THEN** the train SHALL NOT treat the item as already integrated from that historical PR alone
- **AND** it SHALL advance the item toward ready-to-deploy in an eligible frontier
- **AND** if a new open linked PR exists after advance, the train SHALL merge that PR under the normal merge path

#### Scenario: Already-R2D sibling is merged before any implement of a ready sibling

- **WHEN** the work list contains issue A labeled `pipeline:ready-to-deploy` with an open MERGEABLE PR
- **AND** issue B labeled `pipeline:ready` with no open PR
- **AND** `pipeline train --merge` starts
- **THEN** the first recorded mutation SHALL be the merge of A's pull request
- **AND** the train SHALL prove A's merge-result is contained in the fetched base before any plan or implement harness for B
- **AND** a fixture that plans or implements B first SHALL fail

### Requirement: Train status and events SHALL be machine-readable for supervisors

The train SHALL expose a status read model (CLI status and/or JSON events) that includes train identity, ordered issue list, current issue, current stage or item state, linked PR when known, last merge-result identity when known, next action, and blocker if stopped. Train identity SHALL include the durable train-level run ID published by the `train-event-stream` capability. Mid-flight supervisors SHALL read that run's generic `events.jsonl` (via `pipeline logs <train-run-id> --events`) rather than scraping unstructured train stdout. Notification failure by an external supervisor SHALL NOT change train or Pipeline state.

#### Scenario: Status names the current item and next action

- **WHEN** an operator or supervisor requests train status during an active train
- **THEN** the status SHALL include the current issue number and the next deterministic action (advance, merge, wait-for-base, complete, or stopped)

#### Scenario: Events do not authorize mutations

- **WHEN** train events are streamed to a notifier
- **THEN** those events SHALL be observational only
- **AND** they SHALL NOT grant merge or advance authority

#### Scenario: Status and events name the train run ID

- **WHEN** a train run store has been initialized
- **THEN** train status SHALL include that train `run_id`
- **AND** a supervisor SHALL be able to follow `.agent-pipeline/runs/<run_id>/events.jsonl` with `pipeline logs <run_id> --events`

### Requirement: Train JSON mode SHALL emit one final object on stdout

When `pipeline train` is invoked with `--json` and without `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_status`. That object SHALL include an additive `run_id` field set to the durable train-level run ID when the train run store was initialized (`schema_version` remains `1`). Additive `events_coverage` SHALL be one of `ok`, `degraded`, or `unknown` when present. When exclusive identity allocation succeeds and event init succeeds, `events_coverage` MAY be `ok` or omitted and `run_id` SHALL be set. When every exclusive create fails with `EEXIST`, that object SHALL omit `run_id`, SHALL omit `train_run_handoff`, and SHALL set `events_coverage` to `degraded`. When exclusive create fails with a non-`EEXIST` error before any claim succeeds, that object SHALL omit `run_id`, SHALL omit `train_run_handoff`, and SHALL set `events_coverage` to `unknown`. When store-file initialization fails after an exclusive claim, or a live-link append fails after a published store, or a later wave identity disagrees with the live link, that object SHALL set `events_coverage` to `degraded` and SHALL keep `run_id` when a store was published. Those coverage values SHALL NOT change merge decisions, which issues advance, retry behavior, exit status, or stdout object kind. When `pipeline train` is invoked with `--json` and `--dry-run`, stdout SHALL contain exactly one unfenced JSON object whose `kind` is `train_plan` as defined by the `train-dry-run` capability, and SHALL NOT emit `train_status` on that stdout stream. Nested `single` runs SHALL NOT write handoff, status, or terminal JSON objects to that stdout stream. `train_run_handoff` and train `events.jsonl` lines SHALL NOT appear on that stdout stream. Human diagnostics, `train_run_handoff`, and child progress MAY use stderr or the existing run event streams.

#### Scenario: Successful train output parses once

- **WHEN** a train advances two issues successfully with `--json`
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final
  `train_status` object
- **AND** no child-run JSON SHALL precede or follow that object

#### Scenario: Child progress remains observable

- **WHEN** a child issue run emits handoff or stage progress during a JSON train
- **THEN** that progress SHALL remain available through stderr and/or the exact
  child run's events
- **AND** it SHALL NOT corrupt the final train JSON object

#### Scenario: train_status carries run_id

- **WHEN** a JSON train initializes a train run store with id `train-2026-08-28T17-28-03-000Z`
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to
  `train-2026-08-28T17-28-03-000Z`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: JSON dry-run is train_plan not train_status

- **WHEN** a train is invoked with `--json` and `--dry-run` and planning succeeds
- **THEN** one `JSON.parse` of the complete stdout SHALL return an object whose `kind` is `train_plan`
- **AND** that stdout SHALL NOT contain a `train_status` object

#### Scenario: Exhausted allocation reports coverage on the same status object

- **WHEN** a JSON train cannot exclusively publish a train run directory
- **THEN** one `JSON.parse` of the complete stdout SHALL return the final `train_status` object
- **AND** that object SHALL include `events_coverage` equal to `degraded` or `unknown`
- **AND** that object SHALL omit `run_id`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: Published-store observation failure keeps run_id

- **WHEN** a JSON train published a store
- **AND** a later live-link append fails or a later wave identity disagrees
- **THEN** the stdout `train_status` object SHALL include `run_id` equal to the published id
- **AND** SHALL set `events_coverage` to `degraded`
- **AND** stdout SHALL still parse as exactly one `train_status` object

### Requirement: Train SHALL reconcile from GitHub and Pipeline truth on restart

On restart or resume of a named train, the implementation SHALL re-read live issue labels, pull-request merge state, and fetched base identity before performing a new mutation. The train SHALL NOT trust chat memory or a supervisor prompt as authoritative stage or merge state.

#### Scenario: Resume after process death does not double-merge

- **WHEN** a train process dies after a successful merge mutation but before the next item starts
- **THEN** a resumed train SHALL observe the merged PR and contained merge-result
- **AND** it SHALL NOT invoke merge again for that item

#### Scenario: Ambiguous ownership fails closed

- **WHEN** live ownership artifacts for the current issue are split or unreadable (for example conflicting active run records that block advance)
- **THEN** the train SHALL stop with a typed ownership or reconcile error
- **AND** it SHALL NOT delete unpushed commits to force progress

### Requirement: Train merge mode SHALL treat finished ready-to-deploy items with a merged linked PR as already integrated

When `--merge` is provided and an item carries `pipeline:ready-to-deploy` (or an equivalent ready-to-deploy terminal), the train SHALL reconcile linked pull-request state across open, closed, and merged PR states before requiring an open PR to merge. If reconciliation finds a linked PR that is already merged, the train SHALL treat the item as `already-integrated` (or an equivalent integrated skip), SHALL NOT attempt a merge mutation for that item, and SHALL continue to the next work-list item (or complete successfully when no further items remain). The train SHALL NOT stop with a "ready-to-deploy but has no linked open PR" class blocker for such finished items. When a merge-result commit OID is available, the train SHALL prove that OID is contained in the fetched configured base tip before counting the item as integrated; when the PR is observed merged but containment fails, the train SHALL stop with a containment (or observe) class blocker, not the no-open-PR blocker.

#### Scenario: Closed issue with merged PR and stale ready-to-deploy is skipped as integrated

- **WHEN** `pipeline train --merge` processes an issue that is closed, still labeled `pipeline:ready-to-deploy`, and has a linked pull request that is merged with a merge-result contained in the fetched base
- **THEN** the train SHALL record the item as already integrated
- **AND** it SHALL NOT stop the train for missing open PR
- **AND** it SHALL NOT invoke a merge mutation for that item
- **AND** it SHALL continue to the next item or complete with exit success for that path

#### Scenario: Open issue with since-merged PR and no open PR is skipped as integrated

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` whose only linked PR is already merged and whose merge-result is contained in the fetched base
- **THEN** the train SHALL treat the item as already integrated
- **AND** it SHALL continue without a second merge mutation

#### Scenario: Open ready-to-deploy issue with no linked PR still fails closed

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` that has no linked open PR and no linked merged PR
- **THEN** the train SHALL stop with a clear blocker in the "ready-to-deploy but has no linked open PR" class
- **AND** the train exit code SHALL be non-zero
- **AND** no later work-list item SHALL start after that stop

#### Scenario: Open ready-to-deploy issue with open PR still merges

- **WHEN** `pipeline train --merge` processes an open issue labeled `pipeline:ready-to-deploy` with a linked open pull request
- **THEN** the train SHALL invoke the existing merge surface for that PR
- **AND** it SHALL prove merge-result containment in the fetched base before starting the next item

### Requirement: Train SHALL advance base-eligible frontiers via one loop run per frontier

Train SHALL compose multi-item advance as a **two-wave facade** over the durable loop (or an injected equivalent advance-wave seam), not as a production N×`single` loop. After resolving the work list and declared dependencies, train SHALL repeat until the work list is complete or only non-progressing holds remain:

1. Compute the **base-eligible frontier**: items whose code prerequisites are already integrated on the configured base (merge-result contained in the fetched base tip) and that are eligible to co-advance under existing ownership/conflict rules (unknown overlap serializes).
2. **Advance wave:** invoke **one** multi-item loop/advance-wave call whose work list is exactly that frontier. Loop owns recovery, resume, and parallel disjoint advance within the wave.
3. If `--merge` is set, run a **merge wave** (see merge-mode requirements) for ready-to-deploy items in that frontier.
4. Recompute the frontier after base tip movement.

A code-dependent child (default for undeclared edge kind) SHALL NOT enter an advance wave until its parent’s merge-result is contained in the fetched base. Independent peers in the same frontier MAY co-advance when concurrency / `max_concurrent_worktrees` permits; `concurrency: 1` or `max_concurrent_worktrees: 1` remains serial advance. Train SHALL NOT invent a second recoverer and SHALL NOT call `repair_pipeline_item` itself; recovery remains loop’s job inside the advance wave.

#### Scenario: One advance-wave call per frontier, not N×single

- **WHEN** a train advance wave runs for a frontier of two independent issues
- **THEN** the train SHALL invoke exactly one multi-item loop/advance-wave call for that frontier
- **AND** a unit test with injected deps SHALL assert that call shape
- **AND** the production path SHALL NOT loop N×`single` for those frontier members

#### Scenario: Code-dependent child waits for base containment

- **WHEN** issue B declares `Depends on: #A` (code dependency / unknown kind fails closed as code dep)
- **AND** A’s merge-result is not yet contained in the fetched configured base
- **THEN** B SHALL NOT be included in an advance wave
- **AND** after A is merged and containment is proven, B MAY enter a later frontier

#### Scenario: Independent peers may co-advance under concurrency greater than one

- **WHEN** two issues share a frontier with no dependency edge and proven-disjoint ownership
- **AND** concurrency / `max_concurrent_worktrees` is greater than one
- **THEN** the advance wave MAY co-advance both under loop concurrency rules

#### Scenario: Concurrency one remains serial advance

- **WHEN** concurrency is 1 or `max_concurrent_worktrees` is 1
- **THEN** advance within a frontier SHALL remain serial
- **AND** merge waves SHALL remain serial regardless of concurrency

#### Scenario: Train does not call repair_pipeline_item

- **WHEN** an item inside an advance wave hits a recoverable engine diagnostic
- **THEN** recovery SHALL execute inside the loop/advance-wave path
- **AND** train SHALL NOT invoke `repair_pipeline_item` as a train-local recoverer

---

### Requirement: Train merge waves SHALL stay serial and SHALL NOT abort independent R2D siblings on a parked peer

When `--merge` is provided, after each advance wave the train SHALL run a **serial merge wave** for items in that frontier that are at `pipeline:ready-to-deploy` (or equivalent) and not already integrated: resolve the linked open PR when a mutation is required, invoke the existing `pipeline merge` surface, observe the merge-result, fetch the base, and prove squash-aware containment before the next merge in the wave. Merges SHALL never run inside loop and SHALL never run in parallel. Advance stages SHALL still never merge.

When one frontier member is parked or blocked and another is ready-to-deploy with **no** dependency edge to or from the parked item and independence is **proven** from declared deps and ownership/conflict ledger, the merge wave MAY merge the ready sibling. When independence cannot be proven, the train SHALL fail closed (serialize or stop) rather than merge an unproven pair. The parked/blocked item itself SHALL NOT be merged.

#### Scenario: Serial merge with base proof between merges

- **WHEN** two R2D items are eligible to merge in the same merge wave
- **THEN** the train SHALL merge them one at a time
- **AND** SHALL prove merge-result containment in the fetched base between merges
- **AND** SHALL NOT invoke merge from inside the advance/loop wave

#### Scenario: Independent R2D sibling merges while peer is parked

- **WHEN** item P is parked or blocked
- **AND** item S is ready-to-deploy with no dependency edge involving P and independence is proven
- **THEN** the merge wave MAY merge S
- **AND** SHALL NOT merge P while it remains blocked/parked
- **AND** the whole train SHALL NOT abort before that independent merge solely because P is parked

#### Scenario: Unproven independence fails closed

- **WHEN** item P is parked and item S is ready-to-deploy but independence cannot be proven from deps/ledger
- **THEN** the train SHALL NOT merge S under the independent-sibling rule
- **AND** SHALL fail closed with a typed blocker or serialize until independence is proven

### Requirement: Production train and ship entry points SHALL inject multi-item loop advance waves

When `pipeline train` runs in production (including the ship / Tugboat path that invokes train with merge authorization), the entry point SHALL supply a multi-item advance-wave function whose work list is the current base-eligible frontier and that runs the durable loop engine (or an equivalent multi-item advance-wave implementation that preserves loop recovery and co-advance rules). Production entry points SHALL NOT default to serial N× one-item `single` advance for frontier members, and SHALL NOT default to an adapter that only serializes single-item advances as the production path. Test doubles MAY inject fakes that record call shape without invoking the live loop engine. A thin single-item serial adapter MAY exist for tests or non-production adapters that lack a loop engine, but it SHALL NOT be the production train or ship wiring.

#### Scenario: Production train entry wires multi-item loop advance

- **WHEN** production `pipeline train` advances a frontier of two or more issues
- **THEN** the production entry point SHALL invoke one multi-item loop/advance-wave call for that frontier
- **AND** it SHALL NOT loop N× one-item `single` for those frontier members as the production path

#### Scenario: Ship train path matches train multi-item wiring

- **WHEN** the ship / Tugboat path runs train with merge authorization
- **THEN** it SHALL use the same multi-item loop/advance-wave production wiring class as `pipeline train`
- **AND** it SHALL NOT introduce a production N×`single` advance path

#### Scenario: Injected tests assert call shape without live network

- **WHEN** unit tests exercise frontier advance
- **THEN** they SHALL inject train/loop deps (or fakes) so no real network, git, or subprocess is required
- **AND** they SHALL be able to assert that one multi-item advance-wave call is made per frontier

---

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

### Requirement: Train merge wave SHALL not STOP the ship on in-budget UNKNOWN mergeability

Train merge waves SHALL not STOP the ship on first-read `mergeable: "UNKNOWN"`
when the shared merge surface resolves that PR to `MERGEABLE`/`CLEAN` within
its bounded retry budget.

When `--merge` is provided and the train invokes the existing issue-PR merge
surface for a ready-to-deploy item’s linked open PR, a first-read
`mergeable: "UNKNOWN"` that the shared merge surface resolves to
`MERGEABLE`/`CLEAN` within its bounded retry budget SHALL be treated as a
successful merge-gate pass for that item (subject to the surface’s other gates
and train’s post-merge base containment). The train SHALL merge that PR, prove
containment as today, and continue the work list / frontier.

The train SHALL **not** produce a first-attempt whole-train STOP whose sole
error is the merge surface’s immediate UNKNOWN refusal text of the form
`merge failed for #<issue> PR #<pr>: PR mergeability is not yet computed
(UNKNOWN)...` when a later in-budget re-read would have succeeded.

When the merge surface fails after exhausting the UNKNOWN budget, or fails for
a hard unclean state (`CONFLICTING`, `DIRTY`, failed checks, wrong stage, head
mismatch, etc.), the train SHALL still stop that merge step without merging,
name the gate failure in train status, and exit non-zero for that path as
today. The train SHALL NOT invent a second train-local UNKNOWN recoverer that
bypasses the shared merge surface.

#### Scenario: First UNKNOWN then MERGEABLE continues the train

- **WHEN** `pipeline train --merge` reaches a ready-to-deploy item whose linked open PR’s first mergeability read is `UNKNOWN`
- **AND** a later in-budget re-read on the shared merge surface is `MERGEABLE` with `mergeStateStatus: "CLEAN"`
- **AND** the remaining merge gates pass
- **THEN** the train SHALL complete the merge for that PR
- **AND** SHALL prove merge-result containment in the fetched base before starting the next dependent work
- **AND** SHALL NOT exit 1 solely because the first mergeability read was UNKNOWN
- **AND** a hermetic fixture with injected deps SHALL assert first-read UNKNOWN then success without a train STOP for that class

#### Scenario: #1059-class first-attempt UNKNOWN STOP is not legal when budget would succeed

- **WHEN** a unit or train fixture models the #1059 20:04Z class (first mergeability UNKNOWN, subsequent in-budget MERGEABLE+CLEAN)
- **THEN** the train SHALL NOT record a terminal error of only
  `merge failed for #<issue> PR #<pr>: PR mergeability is not yet computed (UNKNOWN)...`
  as the outcome of that merge step
- **AND** the regression SHALL fail if that first-attempt terminal is reintroduced for the in-budget success path

#### Scenario: Post-budget UNKNOWN still stops the merge step

- **WHEN** the shared merge surface exhausts its UNKNOWN retry budget and still reports UNKNOWN
- **THEN** the train SHALL stop the merge step without merging that PR
- **AND** train status SHALL name the merge failure
- **AND** the train exit for that path SHALL be non-zero

#### Scenario: CONFLICTING still does not merge

- **WHEN** the linked PR reports `mergeable: "CONFLICTING"` (or other hard unclean merge gate failure under the shared surface)
- **THEN** the train SHALL NOT merge that PR
- **AND** the train SHALL stop without treating CONFLICTING as an UNKNOWN retry success path

### Requirement: Train advance STOP and item errors SHALL quote structured loop stop evidence before raw exit code

When a train advance wave (or a legacy single-item advance adapter used only where that path still exists) ends with a non-ok outcome or causes train to record a STOP / hold `error` / `train_status.blocker` string attributable to that advance attempt, the pipeline SHALL compose the human-visible reason from structured loop evidence for that attempt when present, in this priority order:

1. the last `loop_run_stopped.reason` value for the attempt’s loop run (for example `supervisor_no_progress`, `dependency_deadlock`, `recovery_exhausted` when emitted as that reason);
2. the last `loop_item_blocked.class` value plus the blocked issue identity;
3. the last blocker comment first line and/or `blocker_kind` when available from that attempt’s blocker evidence;
4. only then the raw process exit code (or engine failure message).

The composed string SHALL include the relevant issue number when the failure is attributable to a specific work-list issue. When any of (1)–(3) are present, the human-visible train STOP reason, per-item `error`, and `train_status.blocker` SHALL NOT consist solely of an exit-only phrase such as `pipeline single exited with code 1` or `pipeline advance exited with code 1`. When no structured loop evidence is available for the attempt, the pipeline SHALL still include the exit code or engine failure message and SHALL NOT invent a stop class or block class name. Non-zero train exit and incomplete status semantics SHALL remain non-zero / incomplete on failure; this requirement changes only the diagnostic text, not success masking. Production train SHALL continue to use multi-item loop advance waves for frontiers and SHALL NOT switch to N×`single` solely to attach this message.

#### Scenario: supervisor_no_progress appears in train blocker

- **WHEN** a train advance wave ends non-ok for issue N
- **AND** the attempt’s loop events include a last `loop_run_stopped` whose reason is `supervisor_no_progress`
- **THEN** the train’s human-visible STOP reason or `train_status.blocker` (and the matching per-item `error` when the failure is attributed to that item) SHALL contain `supervisor_no_progress`
- **AND** SHALL contain the issue number N
- **AND** SHALL NOT be only an exit-only phrase such as `pipeline advance exited with code 1` or `pipeline single exited with code 1`

#### Scenario: loop_item_blocked class is quoted with issue

- **WHEN** a train advance attempt records a last `loop_item_blocked` event with class `recovery_exhausted` for issue N
- **AND** that evidence is used under the priority order (for example no higher-priority stop reason, or the composed string still includes the class)
- **THEN** the human-visible train item error or STOP / blocker text SHALL contain `recovery_exhausted`
- **AND** SHALL identify issue N

#### Scenario: exit code only when no loop evidence

- **WHEN** a train advance attempt exits non-zero
- **AND** no loop events and no structured block/stop evidence are available for that attempt
- **THEN** the human-visible train error / blocker SHALL include the exit code or engine failure message
- **AND** it SHALL NOT invent a stop class name such as `supervisor_no_progress` or `dependency_deadlock`

#### Scenario: failure remains non-zero

- **WHEN** a train advance attempt fails under any of the scenarios above
- **THEN** the train process SHALL still exit non-zero or report incomplete status with a blocker
- **AND** it SHALL NOT treat the attempt as successful solely because structured diagnostic text was attached

#### Scenario: enrichment is regression-tested with injected deps

- **WHEN** the automated train tests for this requirement run under `npm run ci`
- **THEN** at least one fixture SHALL fail if `supervisor_no_progress` (or equivalent stop reason under test) is present in injected loop evidence but absent from the train blocker / item error
- **AND** at least one fixture SHALL pass with exit-code-only text when evidence is empty without inventing a class
- **AND** the tests SHALL inject deps (no real network, git, or subprocess for this logic)

### Requirement: Recovered loop item block SHALL NOT STOP a later ready-to-deploy train item

The pipeline SHALL classify a train advance-wave item as ok with terminal `ready-to-deploy` when live GitHub labels include `pipeline:ready-to-deploy` and do not include `blocked`, and that item’s last terminal for the wave is a successful ready terminal (`ready_to_deploy` or wave `all_done` / `loop_run_complete` with no later `loop_run_stopped` for the run). An earlier `loop_item_blocked` for the same item, including class `implementation-ci` or any other recovered class, SHALL NOT by itself make the outcome non-ok and SHALL NOT become the train STOP / per-item `error` reason.

The last **terminal** event for that item SHALL win. A later successful terminal SHALL supersede earlier item-block evidence for that item. A later `loop_run_stopped` for the attempt, a non-zero engine failure, or an engine failure message SHALL still make the outcome non-ok even when live labels include `pipeline:ready-to-deploy` (existing #1074 law). A live `blocked` label SHALL remain a park, not a merge candidate.

When `--merge` is provided and that item classifies ok at `ready-to-deploy`, the train SHALL invoke the existing issue-PR merge surface for its linked open PR instead of STOPping with a recovered block class. Production train SHALL continue to use multi-item loop advance waves and SHALL NOT merge inside advance/loop.

#### Scenario: Recovered implementation-ci then ready-to-deploy classifies ok

- **WHEN** a train advance wave’s events include `loop_item_blocked` with class `implementation-ci` for issue N
- **AND** a later event for that same item is `ready_to_deploy` or the wave ends `all_done` / `loop_run_complete` with no later `loop_run_stopped`
- **AND** live labels for issue N include `pipeline:ready-to-deploy` and do not include `blocked`
- **THEN** train advance classification for issue N SHALL be ok with terminal `ready-to-deploy`
- **AND** the outcome SHALL NOT be non-ok solely because of the earlier `loop_item_blocked`

#### Scenario: Historical loop_item_blocked does not remain current after a later successful terminal

- **WHEN** the shared train advance evidence extractor scans a run whose events list `loop_item_blocked` for issue N and then a later successful terminal for issue N (`ready_to_deploy` or wave `all_done` / `loop_run_complete` with no later `loop_run_stopped`)
- **THEN** the extracted current evidence for issue N SHALL NOT report that blocked class as the current terminal
- **AND** a later consumer of that evidence SHALL NOT treat the recovered block as the wave’s current failure for issue N

#### Scenario: #1074 live R2D plus current loop_run_stopped remains non-ok

- **WHEN** live labels for issue N include `pipeline:ready-to-deploy`
- **AND** the attempt’s current evidence includes `loop_run_stopped` (or a non-zero engine failure / engine failure message)
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** the human-visible error SHALL quote the stop reason or engine failure per existing structured-evidence law
- **AND** it SHALL NOT treat the attempt as successful solely because an earlier label said ready-to-deploy

#### Scenario: Live blocked label is not a recovered success

- **WHEN** live labels for issue N include `blocked`
- **AND** events include `loop_item_blocked` for issue N
- **THEN** train SHALL NOT classify that item as a ready-to-deploy success
- **AND** merge-mode SHALL NOT merge that item on the recovered-block path

#### Scenario: Merge-mode train merges the recovered R2D item

- **WHEN** `pipeline train --merge` finishes an advance wave that matches the recovered-block-then-ready-to-deploy scenario for issue N
- **AND** issue N has a linked open PR that passes the existing merge gates
- **THEN** the train SHALL invoke the existing merge surface for that PR
- **AND** it SHALL NOT STOP with a reason whose sole current class is the recovered `loop_item_blocked` class (for example `implementation-ci on #N`)

#### Scenario: Current loop_item_blocked plus R2D label flicker remains non-ok

- **WHEN** a train advance wave’s current evidence for issue N still has `loop_item_blocked` as that item’s last terminal (no later `ready_to_deploy` / `all_done` / `loop_run_complete`)
- **AND** live labels for issue N include `pipeline:ready-to-deploy` and do not include `blocked`
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** it SHALL NOT treat the attempt as successful solely because a ready-to-deploy label is present

#### Scenario: Reasonless loop_run_stopped remains non-ok on live R2D

- **WHEN** live labels for issue N include `pipeline:ready-to-deploy`
- **AND** the attempt’s events include `loop_run_stopped` with a missing or empty reason
- **THEN** train advance classification for issue N SHALL be ok false
- **AND** the extracted evidence SHALL record a current stop marker independently of the optional reason
- **AND** the human-visible error SHALL quote a stable fallback diagnostic when no reason is available

#### Scenario: Multi-item recovered blocks then all_done do not remain current

- **WHEN** the shared extractor scans `loop_item_blocked` for two or more items
- **AND** a later wave terminal is `all_done` / `loop_run_complete` with no later `loop_run_stopped`
- **THEN** the extracted current evidence SHALL NOT report any of those blocked classes as the current terminal

#### Scenario: Recovered-block classification is regression-tested with injected deps

- **WHEN** the automated train tests for this requirement run under `npm run ci`
- **THEN** at least one fixture SHALL fail if `loop_item_blocked` then later `ready_to_deploy` / `all_done` plus live `pipeline:ready-to-deploy` is classified non-ok
- **AND** at least one fixture SHALL fail if live `pipeline:ready-to-deploy` plus current `loop_run_stopped` or non-zero engine failure is classified ok
- **AND** at least one merge-mode fixture SHALL fail if that recovered R2D item is STOPped instead of offered to the merge surface
- **AND** the tests SHALL inject deps (no real network, git, or subprocess for this logic)

### Requirement: Train merge-first SHALL be regression-tested as the first mutation

The test suite SHALL include a hermetic merge-mode fixture whose work list is ready-to-deploy #A with an open MERGEABLE PR plus ready #B. The fixture SHALL fail if any plan, implement, or other non-merge mutation for #B is recorded before the merge surface is invoked for #A. Tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Merge-first fixture bites an advance-then-merge implementation

- **WHEN** the automated merge-first fixture runs against an implementation that advances or implements #B before merging #A
- **THEN** the fixture SHALL fail
- **AND** it SHALL pass when the first mutation is merge of #A

### Requirement: Train advance-wave ready SHALL emit the live loop_run_handoff events path on stderr

Train SHALL emit a machine-readable JSON line on stderr whose `kind` is `loop_run_handoff` and whose `events` field is the absolute `events.jsonl` path from that live handoff when `pipeline train` attaches a successful advance-wave loop (lock held, run ready, before first item dispatch of that wave). Train SHALL flush that line so a supervisor reading the train stderr capture can parse it while train is still running. Train SHALL NOT write that handoff object to `train --json` stdout. Nested `single` / loop handoff, status, and terminal JSON objects SHALL still NOT appear on that stdout stream. Human diagnostics MAY remain on stderr in addition to the JSON line.

#### Scenario: Advance-wave ready includes absolute events on stderr

- **WHEN** a JSON train starts an advance-wave loop that becomes ready
- **THEN** train stderr SHALL contain one JSON line with `kind` equal to `loop_run_handoff`
- **AND** that object SHALL include an absolute `events` path for that run
- **AND** a consumer SHALL be able to parse that path without scraping prose

#### Scenario: Train JSON stdout stays one train_status

- **WHEN** a JSON train emits the advance-wave `loop_run_handoff` on stderr
- **THEN** `train --json` stdout SHALL still be exactly one unfenced JSON object whose `kind` is `train_status`
- **AND** that stdout SHALL NOT contain a `loop_run_handoff` object

#### Scenario: Handoff is available before train completes

- **WHEN** the advance-wave loop is ready and train is still dispatching items
- **THEN** the stderr `loop_run_handoff` line SHALL already have been flushed
- **AND** a concurrent supervisor SHALL be able to read `events` without waiting for the final `train_status`

### Requirement: Ship train freeze SHALL admit already-integrated milestone items

In-engine `pipeline ship --milestone <m>` train freeze SHALL build the ship plan from freeze-eligible issues in that milestone: open non-backlog pipeline issues, plus closed issues labeled `pipeline:ready-to-deploy`. Freeze-eligible membership SHALL be train membership only. It SHALL NOT be proof that the milestone has no remaining open GitHub issues. It SHALL NOT authorize Factory Reliability Gate (FRG) pack, release, or promotion.

When every freeze-eligible issue is closed at `pipeline:ready-to-deploy` with its linked pull request merged and the merge-result contained in the fetched base, freeze SHALL include those issues in the ordered plan and SHALL proceed to train merge-mode (which records `already-integrated`). Freeze SHALL NOT stop with `no open issues to freeze` or an equivalent open-only empty-list error solely because the open-issue subset is empty. Freeze SHALL still fail closed when the milestone has no freeze-eligible issues. Freeze SHALL NOT invent a second already-integrated classifier; train merge-mode SHALL remain the authority for `already-integrated` vs containment / no-linked-PR blockers.

After train merge-mode completes, ship SHALL proceed to the FRG / release phase only when the ship-end remaining-open check proves zero open GitHub issues on that milestone. A leftover open issue on that milestone, including an issue labeled `pipeline:backlog`, SHALL fail closed before FRG, release, and promote. This requirement SHALL NOT change which issues train advances.

#### Scenario: All-integrated milestone proceeds past freeze

- **WHEN** `pipeline ship --milestone v1.39.13` freezes a milestone whose freeze-eligible issues are all closed, labeled `pipeline:ready-to-deploy`, and have linked PRs merged and contained in the fetched base
- **THEN** freeze SHALL return an ordered plan that includes those issues
- **AND** it SHALL NOT throw `no open issues to freeze`
- **AND** train merge-mode SHALL record each item `already-integrated`
- **AND** freeze-eligible integration alone SHALL NOT start FRG, release, or promote

#### Scenario: Empty freeze-eligible set still fails

- **WHEN** `pipeline ship --milestone <m>` freezes a milestone that has no open non-backlog pipeline issues and no closed `pipeline:ready-to-deploy` issues
- **THEN** freeze SHALL fail closed
- **AND** the error SHALL name that the milestone has no freeze-eligible issues
- **AND** the ship run SHALL NOT proceed to release as if the milestone were integrated

#### Scenario: Closed ready-to-deploy without merged contained PR is not skipped at freeze

- **WHEN** freeze admits a closed issue labeled `pipeline:ready-to-deploy` whose linked PR is missing or whose merge-result is not contained in the fetched base
- **THEN** train merge-mode SHALL apply existing already-integrated / no-open-PR / containment fail-closed law
- **AND** freeze SHALL NOT classify that item as integrated on its own

#### Scenario: Leftover open backlog does not ride freeze-eligible integration into FRG

- **WHEN** freeze-eligible items on milestone `v1.40.1` are integrated
- **AND** GitHub still has open issue #1344 on that milestone labeled `pipeline:backlog`
- **THEN** train freeze-eligible membership SHALL NOT include #1344
- **AND** ship SHALL fail closed before FRG pack, release, and `engine-promote`
- **AND** the fail-closed path SHALL be the remaining-open check, not a change to which issues train advances

### Requirement: Mixed open and already-integrated milestone items SHALL complete in one run

When a ship or merge-mode train work list contains both (a) open `pipeline:ready-to-deploy` items with a linked open mergeable PR and (b) already-integrated items (closed or open ready-to-deploy with a merged contained PR), the same run SHALL merge the open mergeable items under existing merge-wave law and SHALL record the already-integrated items as `already-integrated` without a second merge mutation. The run SHALL NOT drop the already-integrated set from the plan solely because freeze listed only open issues.

#### Scenario: Mixed milestone merges open items and skips integrated items

- **WHEN** `pipeline ship --milestone <m>` (or `pipeline train --milestone <m> --merge`) runs on a milestone with open ready-to-deploy issue A (open mergeable PR) and closed ready-to-deploy issue B (merged PR contained in the fetched base)
- **THEN** the freeze / milestone listing SHALL include both A and B
- **AND** the run SHALL invoke the existing merge surface for A's PR
- **AND** the run SHALL record B as `already-integrated` without a merge mutation for B
- **AND** a successful path SHALL complete that work list in one run

### Requirement: All-integrated freeze regressions SHALL be guarded by automated tests

The test suite SHALL fail if ship freeze or `pipeline train --milestone` rejects a milestone whose freeze-eligible issues are all closed at `pipeline:ready-to-deploy` with merged contained PRs, instead of classifying those items as already integrated. The suite SHALL also fail if a mixed open + already-integrated fixture omits the already-integrated items from the plan or skips merging the open mergeable item. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: All-closed merged freeze rejection fails CI

- **WHEN** a hermetic fixture models a milestone of closed `pipeline:ready-to-deploy` issues with merged contained PRs
- **AND** freeze or train milestone listing throws `no open issues to freeze` or `has no open issues` (or equivalent open-only empty-list error)
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Mixed-plan omission fails CI

- **WHEN** a hermetic fixture models one open mergeable ready-to-deploy item and one already-integrated item
- **AND** the system under test omits the already-integrated item from the plan or does not offer the open item to the merge surface
- **THEN** the test SHALL fail

### Requirement: Train merge-wave linked PR SHALL include non-closing pipeline mentions

Train merge-mode reconciliation SHALL treat a ready-to-deploy item as already integrated when any-state resolution links a same-repo merged pull request via `ConnectedEvent`, closing `willCloseTarget`, head `pipeline/<N>-*`, or title parenthetical `(#N)`, and the merge commit OID is contained in the fetched configured base. It SHALL NOT STOP with `ready-to-deploy but has no linked open PR` for that item. It SHALL NOT require an open pull request and SHALL NOT invoke a merge mutation for that item.

#### Scenario: Merged (#N) pipeline PR is already-integrated

- **WHEN** `pipeline train --merge` processes an issue labeled `pipeline:ready-to-deploy`
- **AND** the issue has no open pull request
- **AND** the issue timeline has a `CrossReferencedEvent` with `willCloseTarget: false` to a merged same-repo pull request whose head is `pipeline/<N>-*` or whose title contains `(#N)`
- **AND** that merge commit OID is contained in the fetched base
- **THEN** the train SHALL record the item as already integrated
- **AND** it SHALL NOT stop with `ready-to-deploy but has no linked open PR`
- **AND** it SHALL NOT invoke a merge mutation for that item

#### Scenario: Resume after ship train merge does not re-STOP

- **WHEN** a ship resume re-enters `train --merge` for planned issues whose squash merges already landed on `origin/<base>` as `(#N)` mentions
- **THEN** the train SHALL classify those items already-integrated
- **AND** it SHALL NOT STOP with `ready-to-deploy but has no linked open PR`

### Requirement: Integrated train SHALL accept --dry-run without executing the live train

The `pipeline train` command SHALL accept `--dry-run` as a supported flag in both default and `--merge` modes. When `--dry-run` is present, the command SHALL produce the read-only plan defined by the `train-dry-run` capability and SHALL NOT advance work-list items or invoke the merge surface. When `--dry-run` is absent, existing live-train law SHALL remain unchanged.

#### Scenario: Dry-run does not advance

- **WHEN** an operator runs `pipeline train --issues 10,11 --dry-run`
- **THEN** no advance wave SHALL run
- **AND** each issue SHALL remain at its pre-invocation stage

#### Scenario: Dry-run plus merge does not merge

- **WHEN** an operator runs `pipeline train --issues 10 --merge --dry-run`
- **THEN** the linked pull request SHALL remain unmerged
- **AND** the live merge surface SHALL NOT be invoked

#### Scenario: Live train without the flag still executes

- **WHEN** an operator runs `pipeline train --issues 10,11 --json` without `--dry-run`
- **THEN** the command SHALL run the live train
- **AND** stdout SHALL still be exactly one `train_status` object when the run finishes

### Requirement: Train merge SHALL park-release through the shared bound-proof gate

After `train --merge` proves a merge-result OID is contained in the fetched configured base for issue N and PR P, the train SHALL invoke the same park-release bound-proof gate used by `/pipeline` / `pipeline single`. The train SHALL pass that bound identity (issue N, PR P, that base, that proven OID, and the worktree HEAD observed at merge/proof time) into the gate. When the managed worktree is clean and the current HEAD still matches, the train SHALL NOT keep it solely because the remote head was deleted and pre-merge commits are not reachable from the base. The train SHALL NOT emit `commit verification failed (git/network/auth error)` or tell the operator to check connectivity or retry on that proven-merge path. A dirty worktree, a worktree whose HEAD moved after merge, or a filesystem cleanup failure SHALL retain the tree, report that actual cause, and SHALL NOT change ready-to-deploy or integrated state.

The train SHALL NOT implement a train-only worktree-delete mole, a second recoverer inside `train.ts`, or merge-inside-advance. The next identical post-squash-merge case SHALL take this shared gate without a new issue.

#### Scenario: Train merge releases a clean worktree after proven squash merge

- **WHEN** `pipeline train --merge` squash-merges PR P for issue N
- **AND** the train proves merge-result OID R is contained in `origin/<base>`
- **AND** the managed worktree for issue N is clean
- **THEN** park-release SHALL remove that worktree from `worktree_root`
- **AND** train/pipeline logs SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** the logs SHALL NOT tell the operator to check connectivity or retry

#### Scenario: Train merge retains a dirty worktree without rolling back integration

- **WHEN** `pipeline train --merge` has proven merge-result OID R in `origin/<base>` for issue N and PR P
- **AND** the managed worktree is dirty
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name the dirty condition, not git/network/auth
- **AND** the item SHALL remain integrated / `pipeline:ready-to-deploy`

#### Scenario: Train merge retains a post-merge local commit without rolling back integration

- **WHEN** `pipeline train --merge` has proven merge-result OID R in `origin/<base>` for issue N and PR P
- **AND** the managed worktree HEAD differs from the HEAD bound at merge/proof time
- **THEN** the worktree SHALL remain on disk
- **AND** the item SHALL remain integrated / `pipeline:ready-to-deploy`

#### Scenario: Train merge does not invent a path-local remover

- **WHEN** park-release after a proven train merge is implemented
- **THEN** it SHALL call the shared bound-proof park-release gate
- **AND** it SHALL NOT add a train-only `git worktree remove` path that bypasses dirty checks or bound-proof identity

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

A remaining selected item SHALL count as **independent** of the held set when it has no
direct or transitive admitted declared-dependency path to any held item. Direct and
transitive dependents of a held item SHALL themselves be held with terminal
`dependency-skipped`. They SHALL NOT enter an advance wave and SHALL NOT be merged while
that ancestor remains held.

Independence SHALL be computed from the **admitted** shared discovery graph resolved at
train start for the frozen selected set: lexical body/title declarations, GitHub-native
`blockedBy` edges, and enabled roadmap-declared edges after hard-wait admission. A lexical
`Depends on: #N` phrase is one source of that graph, not the only source. A missing or
unknown admitted edge SHALL fail closed as a code dependency, as today. A remaining item
that a held item depends on (a prerequisite of the held item) SHALL NOT be skipped solely
because of that reverse edge. Closed, merged, and out-of-selector references that hard-wait
admission ignores SHALL NOT create a skip or a deadlock.

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

#### Scenario: Direct native dependent of a held item is dependency-skipped

- **WHEN** merge-mode train holds item 1322
- **AND** GitHub-native discovery fully observes that 1323 is blocked by 1322
- **AND** 1323 has no lexical `Depends on` phrase naming 1322
- **THEN** the train SHALL record 1323 as `dependency-skipped`
- **AND** SHALL NOT advance or merge 1323 while 1322 remains held

#### Scenario: Transitive mixed-source dependent is dependency-skipped

- **WHEN** merge-mode train holds item A
- **AND** native discovery fully observes that B is blocked by A
- **AND** issue C lexically declares `Depends on: #B`
- **THEN** the train SHALL record B and C as `dependency-skipped`
- **AND** SHALL NOT advance or merge B or C while A remains held

#### Scenario: Off-selector native blocker does not skip the depender

- **WHEN** native discovery fully observes that selected issue A is blocked by issue Z
- **AND** Z is not on the frozen selected work-list
- **AND** hard-wait admission ignores Z as `not_on_selector`
- **THEN** A SHALL NOT be recorded `dependency-skipped` solely because of Z
- **AND** A SHALL remain eligible subject to other non-dependency gates

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

### Requirement: Train SHALL NOT STOP solely for nested mechanical or recovery exhaustion

Train SHALL keep a nested item in Cooling, an external-condition wait, or a valid typed request when that item records mechanical failure, strategy-cursor exhaustion, or `recovery_exhausted` evidence. Train SHALL NOT STOP the wave solely because a nested loop recorded that exhaustion. Train MAY still quote `recovery_exhausted` or the blocked class in diagnostic text. Independent siblings SHALL continue. Genuine human-authority holds and missing merge authority SHALL remain waits. This requirement SHALL NOT restore N×`single` STOP shells and SHALL NOT authorize merge inside train without operator merge authority.

#### Scenario: Nested recovery exhaustion does not STOP the train

- **WHEN** a train advance wave has a nested loop item that records `recovery_exhausted` or mechanical strategy exhaustion
- **AND** that item has no genuine human-authority predicate
- **THEN** train SHALL keep that item in Cooling or an external-condition wait
- **AND** train SHALL NOT STOP the wave solely for that exhaustion
- **AND** diagnostic text MAY still contain `recovery_exhausted`

#### Scenario: Independent sibling continues

- **WHEN** item P records mechanical exhaustion
- **AND** item Q is proven independent and already ready-to-deploy
- **THEN** train SHALL NOT abort Q solely because P is cooling

### Requirement: Train SHALL report park and merge observations to RecoverySupervisor

When `pipeline train` (including ship/Tugboat composition that invokes train) observes an item at `pipeline:needs-human`, leftover `pipeline:blocked`, merge conflict, check drift, head drift, unknown mergeability, timeout, or uncertain merge response, train SHALL report a typed operation observation to RecoverySupervisor. Train SHALL NOT invoke the `recover-parked` command or its shared entrypoint. Train SHALL NOT implement a second finding classifier, SHALL NOT call `pipeline override` directly for this reflow, SHALL NOT drop `blocked`/`needs-human` without an audited RecoverySupervisor disposition, and SHALL NOT call `repair_pipeline_item` as a train-local recoverer. Recovery inside an advance wave SHALL remain the loop's job.

#### Scenario: Parked item does not invoke recover-parked

- **WHEN** a train item reaches `pipeline:needs-human` or residual leftover `blocked` after deterministic resume inside the advance wave
- **THEN** train SHALL NOT invoke `recover-parked`
- **AND** RecoverySupervisor SHALL retain ownership of that item
- **AND** train SHALL NOT invent an override disposition

#### Scenario: Successful supervisor recover continues same-issue advance

- **WHEN** RecoverySupervisor clears or re-enters advance for the parked issue
- **THEN** train/loop SHALL continue that same issue toward ready-to-deploy on the current work list
- **AND** SHALL NOT remove and re-select the issue from backlog solely because recovery ran

#### Scenario: Train still does not merge from recover-parked

- **WHEN** an operator or RecoverySupervisor recipe invokes `recover-parked` during a non-merge or merge train
- **THEN** recover-parked SHALL NOT grant merge authority
- **AND** train merge behavior SHALL remain governed only by existing `--merge` / merge-wave rules

---

### Requirement: Train SHALL treat waiting or cooling as a contained hold for independent siblings

When `--merge` is provided and one selected item reaches a contained wait or Cooling state — including merge conflict, check drift, unknown mergeability, timeout, or uncertain merge response — the train SHALL hold that item and SHALL continue the remaining selected set of proven-independent items. Direct and transitive dependents SHALL remain excluded until the held item's merge-result is contained in the fetched base. The train SHALL NOT whole-train STOP solely because that item is waiting or cooling.

#### Scenario: Cooling item does not abandon independents

- **WHEN** merge-mode train holds issue P in Cooling after uncertain merge response
- **AND** independent issues S1 and S2 remain on the frozen work list
- **THEN** the train SHALL continue S1 and S2
- **AND** it SHALL NOT STOP with `will not implement another sibling` or an equivalent abandonment

#### Scenario: Transitive dependent stays excluded while the prerequisite cools

- **WHEN** merge-mode train holds issue A in Cooling
- **AND** issue B depends transitively on A
- **THEN** train SHALL NOT advance or merge B while A remains unintegrated

### Requirement: Train SHALL consume a single reconciled pipeline stage and SHALL NOT throw on multiple stage labels

When freeze, eligibility, or item classification reads GitHub labels, train SHALL consume the single observed stage derived from all `pipeline:*` labels whose suffix is a member of `STAGES`, using the greatest `STAGES` index when more than one is present. Train SHALL NOT throw because two or more such labels are present. Train SHALL NOT STOP the work list solely for that observation. The item SHALL remain RecoverySupervisor-owned. Train SHALL NOT write GitHub labels during that derivation.

#### Scenario: Contradictory stage labels do not STOP the train

- **WHEN** a freeze-eligible issue carries `pipeline:pre-merge` and `pipeline:design-gate`
- **THEN** train SHALL treat the observed stage as `pre-merge`
- **AND** SHALL NOT throw `ambiguous pipeline stage labels`
- **AND** SHALL NOT STOP the train solely for those labels
- **AND** independent siblings SHALL remain schedulable

#### Scenario: Train derivation matches loop derivation

- **WHEN** loop reconciliation and train freeze classify the same label list
- **THEN** both SHALL return the same observed stage
- **AND** neither SHALL throw

### Requirement: Train SHALL resolve one shared discovery graph before order, plan, frontier, or independence decisions

Train SHALL obtain declared dependencies for the frozen selected work-list from the same
authoritative discovery contract used by durable loop work-list compile. That contract
SHALL union lexical body/title declarations, GitHub-native same-repo `blockedBy` edges, and
enabled roadmap-declared edges, then apply hard-wait admission. Train SHALL use that one
admitted graph for issue order, dry-run planning, base-eligible frontier computation, merge
eligibility, and independent-sibling continuation. Train SHALL NOT maintain a second
lexical-only declared-dependency graph and SHALL NOT invent a train-local parser or GitHub
query shape for those sources. A missing or unknown admitted edge SHALL fail closed as a
code dependency. List order and bare related-work references SHALL NOT become dependencies.

#### Scenario: Native blockedBy enters the train graph

- **WHEN** a train selects issues `1322` and `1323`
- **AND** GitHub-native discovery fully observes that `1323` is blocked by `1322`
- **AND** neither issue body declares a lexical `Depends on` edge
- **THEN** the train graph SHALL include `1323` depends on `1322`
- **AND** `1323` SHALL NOT be treated as independent of `1322`

#### Scenario: Lexical, native, and enabled roadmap edges are unioned

- **WHEN** issue `B` lexically declares `Depends on: #A`
- **AND** native `blockedBy` fully observes that `B` is blocked by `C`
- **AND** an enabled roadmap source fully observes `B` depends on `D`
- **AND** `A`, `C`, and `D` are open members of the selected work-list
- **THEN** the admitted train graph for `B` SHALL include `A`, `C`, and `D`
- **AND** train SHALL NOT drop any of those sources because another source omitted them

#### Scenario: Train does not use a private lexical-only graph

- **WHEN** train orders issues, computes a frontier, or tests independence of held items
- **THEN** those decisions SHALL consume the shared discovery result
- **AND** they SHALL NOT re-parse title and body as the sole declared-dependency source

---

### Requirement: A fresh multi-item train SHALL refuse incomplete discovery before run-store init or advance

Train SHALL refuse a **fresh** multi-item invocation with a typed, actionable result that
names the incomplete source and enough scope to act (issue id and/or list-level source)
when any **enabled** authoritative discovery source observation is `unavailable` or
`incomplete`. Train SHALL NOT create a train run store, SHALL NOT emit `train_run_handoff`,
SHALL NOT invoke an advance wave, and SHALL NOT invoke the merge surface for that refused
attempt. Successfully observed edges from other sources SHALL NOT override the refuse.
Fully observed empty sources SHALL still admit independent items rather than inventing
edges. A single-item non-factory train SHALL follow the same incomplete-source observation
rules as a single-item non-factory loop compile (observations recorded; no hard refuse
unless factory-owned or otherwise forced).

#### Scenario: Incomplete native source blocks multi-item train before store init

- **WHEN** `pipeline train --issues 1322,1323` is a fresh multi-item invocation
- **AND** native `blockedBy` discovery is `unavailable` or `incomplete` for either issue
- **THEN** the command SHALL exit non-zero with a typed result naming that native source
- **AND** it SHALL NOT create `.agent-pipeline/runs/train-*/`
- **AND** it SHALL NOT invoke an advance wave or the merge surface

#### Scenario: Fully observed empty native source still admits independents

- **WHEN** a fresh multi-item train fully observes native `blockedBy` as empty for every
  selected issue
- **AND** lexical and enabled roadmap sources are also fully observed
- **THEN** admission MAY proceed
- **AND** items with no admitted edge SHALL remain independent rather than inventing edges

---
