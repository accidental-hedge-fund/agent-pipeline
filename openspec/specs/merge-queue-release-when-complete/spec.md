# merge-queue-release-when-complete Specification

## Purpose
TBD - created by archiving change merge-queue-optional-release-prepare. Update Purpose after archive.
## Requirements
### Requirement: Release-when-complete SHALL be opt-in and default off

The merge-queue command SHALL prepare a release only when release-when-complete
is explicitly enabled for that invocation (CLI flag such as
`--release-when-complete`, and/or a config key whose default is false). When the
flag and config are both unset or false, a completed drive SHALL NOT invoke the
release prepare path and SHALL NOT open a release PR.

#### Scenario: Default drive does not prepare a release

- **WHEN** the operator runs a merge-queue apply/drive without
  `--release-when-complete` and with config default false
- **THEN** the command SHALL NOT call the release prepare path
- **AND** SHALL NOT create a release PR

#### Scenario: Flag enables release-when-complete

- **WHEN** the operator runs a merge-queue apply/drive with
  `--release-when-complete` and a valid `--release-version` and the queue is
  complete after the drive
- **THEN** the command SHALL invoke the existing release prepare path

---

### Requirement: Queue-complete SHALL mean no remaining R2D candidates and no holds

For release-when-complete, the merge-queue SHALL treat the queue as **complete**
only when both of the following hold after the drive pass (re-queried against
current GitHub/issue state for the same selector used by the drive, e.g.
milestone):

1. There are **no remaining open candidates**: no open issue in the selector that
   still has an open pull request eligible as a merge-queue candidate under
   `pipeline:ready-to-deploy` (and the queue’s other candidate eligibility rules).
2. There are **no held merge-queue items** from the drive (including conflict,
   checks-failed, or repair-budget exhaustion holds).

Open issues in the selector that are **not** at `pipeline:ready-to-deploy` (or
that lack an eligible open PR) SHALL **not** block release prepare. The command
SHALL emit a warning that reports the presence (count and/or numbers) of such
open non-candidate issues when prepare runs or would run.

If the queue is not complete, the command SHALL skip release prepare even when
release-when-complete is enabled, and SHALL print a clear skip reason naming
whether remaining R2D candidates and/or held items prevented prepare.

#### Scenario: Empty R2D set and no holds is complete

- **WHEN** release-when-complete is enabled and after the drive there are no open
  selector-scoped R2D candidates and no held items
- **THEN** the queue SHALL be considered complete and release prepare SHALL run
  (live) or be reported as would-prepare (dry-run)

#### Scenario: Remaining R2D candidate blocks prepare

- **WHEN** release-when-complete is enabled and at least one open R2D candidate
  remains for the selector after the drive
- **THEN** the command SHALL skip release prepare
- **AND** SHALL print a skip reason that names remaining candidates

#### Scenario: Held item blocks prepare

- **WHEN** release-when-complete is enabled and at least one item is held after
  the drive
- **THEN** the command SHALL skip release prepare
- **AND** SHALL print a skip reason that names held items

#### Scenario: Open non-R2D issues do not block prepare

- **WHEN** release-when-complete is enabled, the queue is complete by the R2D and
  hold criteria, and the milestone still has open issues that are not
  ready-to-deploy candidates
- **THEN** the command SHALL still run release prepare (live) or report
  would-prepare (dry-run)
- **AND** SHALL emit a warning disclosing those open non-candidate issues

---

### Requirement: Complete + enabled SHALL invoke the existing release prepare path

The merge-queue SHALL, when release-when-complete is enabled and the queue is
complete, invoke the same release prepare implementation used by `pipeline
release` (the shared `runRelease` library or equivalent single-sourced prepare
path). The invocation SHALL supply the operator-provided version argument
(`major`, `minor`, `patch`, or explicit `X.Y.Z`) and SHALL run non-interactively
(no `$EDITOR` wait). Live mode SHALL produce a release PR for human review using
that path’s existing gates (version bump, mirror regen, CI, ROADMAP scaffold,
open PR). When release-when-complete is enabled without a version argument, the
command SHALL exit non-zero with a usage error before any release mutation.

#### Scenario: Live complete drive prepares a release PR

- **WHEN** release-when-complete is enabled with `--release-version minor`, the
  queue is complete, and the command is not in dry-run
- **THEN** the command SHALL call the shared release prepare path with that
  version and non-interactive options
- **AND** a release PR SHALL be opened for human review on success (subject to
  the existing release path’s own success conditions)

#### Scenario: Missing version is a usage error

- **WHEN** the operator enables release-when-complete without providing a release
  version
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** SHALL NOT invoke release prepare mutations

---

### Requirement: Release-when-complete SHALL NOT tag, publish, or merge the release

The release-when-complete path SHALL NOT create or push a git tag, SHALL NOT
create or publish a GitHub Release, SHALL NOT publish to npm, and SHALL NOT merge
the release PR. Authority to merge the release PR remains human; tag/publish
remain the existing post-merge release workflows after a human merges.

#### Scenario: Successful prepare stops at open PR

- **WHEN** release prepare succeeds via release-when-complete
- **THEN** a release PR exists for human review
- **AND** no tag is created or pushed by this path
- **AND** no npm publish is performed by this path
- **AND** the release PR is not merged by this path

---

### Requirement: Release prepare failure SHALL leave merge success intact

The merge-queue command SHALL, if release prepare fails after the drive has
already completed merges, surface a clear error naming the release failure,
SHALL NOT undo merges already performed, SHALL NOT re-merge or force-merge held
items, and SHALL leave previously successful merge outcomes intact. The overall
command MAY exit non-zero to signal the release failure after reporting merge
results.

#### Scenario: Prepare fails after merges

- **WHEN** the drive successfully merged one or more candidates, the queue is
  complete, release-when-complete is enabled, and the release prepare path fails
  (for example CI gate failure or dirty release-managed tree)
- **THEN** the command SHALL print an error identifying the release prepare
  failure
- **AND** SHALL NOT reverse or re-attempt the already-completed merges
- **AND** those merges SHALL remain done

---

### Requirement: Dry-run SHALL disclose release-when-complete intent without side effects

The merge-queue command SHALL, when run in dry-run with release-when-complete
enabled, report whether release prepare **would** run, including the intended
version and either a would-prepare confirmation or a skip reason (incomplete
queue, missing version, or other gate). Dry-run SHALL evaluate completeness
against **current** state (not projected post-merge emptiness of a non-empty
queue): would-prepare only when the current queue is already complete. Dry-run
SHALL NOT open a release PR, SHALL NOT write release-managed files
(`package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, `.claude-plugin/`),
and SHALL NOT tag, publish, or merge.

#### Scenario: Dry-run on an already-complete queue reports would-prepare

- **WHEN** dry-run is used with release-when-complete and a version, and the
  current queue is complete
- **THEN** the output SHALL state that release prepare would run for that version
- **AND** no release PR is created
- **AND** no release-managed paths are mutated

#### Scenario: Dry-run on a non-empty queue reports would-not-prepare

- **WHEN** dry-run is used with release-when-complete and remaining R2D
  candidates exist
- **THEN** the output SHALL state that release prepare would not run
- **AND** SHALL include a skip reason naming remaining candidates
- **AND** no release PR is created

#### Scenario: Dry-run without the flag never mentions preparing a release as an action

- **WHEN** dry-run runs without release-when-complete enabled
- **THEN** the planned actions SHALL NOT include preparing a release PR

