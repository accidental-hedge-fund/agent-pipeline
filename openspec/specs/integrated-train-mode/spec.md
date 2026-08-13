# integrated-train-mode Specification

## Purpose
TBD - created by archiving change add-integrated-train-mode. Update Purpose after archive.

## Requirements

### Requirement: The CLI SHALL provide an opt-in integrated train command

The Pipeline CLI SHALL expose a loop-isolated `train` command that accepts a work selector of at least one of: an explicit ordered issue list, or a milestone name that resolves to open pipeline issues. The command SHALL NOT be reachable from `pipeline advance` stage dispatch. The command SHALL refuse to run when no work selector is provided.

#### Scenario: Explicit issue list is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11,12`
- **THEN** the train SHALL resolve those issue numbers as the work list in the given order after dependency validation
- **AND** it SHALL NOT invoke advance-stage merge logic

#### Scenario: Milestone selector is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.34.0`
- **THEN** the train SHALL resolve the milestone's issues into a dependency-ordered work list using existing declared-dependency discovery
- **AND** it SHALL refuse a cycle with a validation error

#### Scenario: Missing selector is refused

- **WHEN** an operator runs `pipeline train` with neither issues nor milestone
- **THEN** the command SHALL exit non-zero with an error naming the required selector

---

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
2. Run one advance wave for that frontier via the loop/advance-wave facade (recovery inside the wave).
3. For each frontier item that is at `pipeline:ready-to-deploy` (or equivalent) and not already integrated: reconcile linked PR state across open/closed/merged; if a merge mutation is required, resolve exactly one linked open PR, invoke the existing Pipeline issue-PR merge surface with the same gates as `pipeline merge`, observe the merge-result, fetch the configured base, and prove the merge-result is contained in the fetched base tip ancestry — merges are **serial** within the merge wave.
4. Only after prerequisites are merged and contained may a code-dependent successor enter a later advance wave.
5. Pre-ready-to-deploy items SHALL NOT be short-circuited as integrated from a historical merged PR alone.
6. Concurrent capacity for **merge** under merge mode SHALL be one. Advance concurrency inside a frontier follows loop policy (may be >1 when proven independent).
7. The train SHALL NOT treat "no linked open PR" as a hard stop when reconciliation already established a merged linked PR for a ready-to-deploy item.

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

### Requirement: Train status and events SHALL be machine-readable for supervisors

The train SHALL expose a status read model (CLI status and/or JSON events) that includes train identity, ordered issue list, current issue, current stage or item state, linked PR when known, last merge-result identity when known, next action, and blocker if stopped. Notification failure by an external supervisor SHALL NOT change train or Pipeline state.

#### Scenario: Status names the current item and next action

- **WHEN** an operator or supervisor requests train status during an active train
- **THEN** the status SHALL include the current issue number and the next deterministic action (advance, merge, wait-for-base, complete, or stopped)

#### Scenario: Events do not authorize mutations

- **WHEN** train events are streamed to a notifier
- **THEN** those events SHALL be observational only
- **AND** they SHALL NOT grant merge or advance authority

### Requirement: Train JSON mode SHALL emit one final object on stdout

When `pipeline train` is invoked with `--json`, stdout SHALL contain exactly one
unfenced JSON object whose `kind` is `train_status`. Nested `single` runs SHALL
NOT write handoff, status, or terminal JSON objects to that stdout stream.
Human diagnostics and child progress MAY use stderr or the existing run event
streams.

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

---

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

---
