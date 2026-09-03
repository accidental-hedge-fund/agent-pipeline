# train-dry-run Specification

## Purpose
Gives `pipeline train --dry-run` a structured, point-in-time, read-only plan so an operator can preview order, stages, dependency eligibility, linked PRs, and intended merge behavior before a live or `--merge` train.

## Requirements

### Requirement: Train dry-run SHALL be an opt-in read-only plan in normal and merge modes

`pipeline train` SHALL accept `--dry-run` when a valid work selector is present, both without `--merge` and with `--merge`. Dry-run SHALL be opt-in: omitting `--dry-run` SHALL keep today's live train (advance, and merge when `--merge` is set). A successful dry-run SHALL exit 0 after printing the plan. Dry-run SHALL NOT become the default the way `merge-queue` defaults to plan-only.

#### Scenario: Explicit issues dry-run is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11 --dry-run`
- **THEN** the command SHALL exit 0 after printing a plan
- **AND** it SHALL NOT print that `--dry-run` is not supported

#### Scenario: Milestone dry-run is accepted

- **WHEN** an operator runs `pipeline train --milestone v1.39.13 --dry-run`
- **THEN** the command SHALL exit 0 after printing a plan for that milestone's freeze-eligible issues
- **AND** it SHALL NOT print that `--dry-run` is not supported

#### Scenario: Merge-mode dry-run is accepted

- **WHEN** an operator runs `pipeline train --issues 10,11 --merge --dry-run`
- **THEN** the command SHALL exit 0 after printing a merge-mode plan
- **AND** it SHALL NOT merge any pull request

#### Scenario: Omitting dry-run stays live

- **WHEN** an operator runs `pipeline train --issues 10,11` without `--dry-run`
- **THEN** the command SHALL run the live train
- **AND** it SHALL NOT stop after printing a plan

#### Scenario: Missing selector still fails before a plan

- **WHEN** an operator runs `pipeline train --dry-run` with neither `--issues` nor `--milestone`
- **THEN** the command SHALL exit non-zero with the existing selector usage error
- **AND** it SHALL NOT print a successful empty plan

---

### Requirement: Train dry-run SHALL perform no engine, git-write, GitHub-write, or run-store mutations

A dry-run invocation SHALL be allowed to read repository configuration and GitHub issue, label, milestone, dependency, and pull-request state. It SHALL NOT invoke a planning or implementation engine, create a worktree, post a comment, add or remove labels, push, force-push, merge, or write a train run directory / `events.jsonl`. It SHALL NOT call the live merge surface or an advance wave.

#### Scenario: Merge surface is not invoked

- **WHEN** a unit test runs `pipeline train --issues 10 --merge --dry-run` against a fixture whose issue 10 is `pipeline:ready-to-deploy` with an open pull request
- **THEN** the recorded merge-surface call count SHALL be 0
- **AND** the recorded advance-wave call count SHALL be 0

#### Scenario: No train run store is created

- **WHEN** a dry-run train resolves a non-empty work list
- **THEN** it SHALL NOT create `.agent-pipeline/runs/train-*/`
- **AND** it SHALL NOT write `events.jsonl`
- **AND** it SHALL NOT emit `kind: "train_run_handoff"`

#### Scenario: GitHub writes are absent

- **WHEN** a dry-run train completes successfully
- **THEN** it SHALL NOT post a comment, change labels, push, or merge
- **AND** a second dry-run against the same fixture SHALL report the same ordered issues and intended actions

---

### Requirement: Train dry-run SHALL print a structured point-in-time plan

The dry-run plan SHALL use the same resolved issue order as a live train would use at that moment (explicit `--issues` order after dependency validation, or milestone freeze-eligible issues in declared-dependency order, with `--merge` still placing current ready-to-deploy items first). For each ordered issue the plan SHALL include:

- current pipeline stage (from labels)
- whether the issue is on the current snapshot frontier (in-list code prerequisites look already integrated from GitHub merged-PR state, or have no in-list code prerequisite)
- linked pull-request number when GitHub state shows one (open or merged)
- intended next train action from this closed set: `would-advance`, `waiting-on-deps`, `would-merge`, `already-integrated`, `would-block`, `held`

In `--merge` mode the plan SHALL also name the merge-first set: current ready-to-deploy items with an open linked PR. `already-integrated` SHALL mean GitHub shows a merged linked PR for a ready-to-deploy item; dry-run SHALL NOT prove merge-result containment in the fetched base. Human output SHALL include the existing `[train] ordered issues: #A → #B` line (plus merge-mode / merge-first annotation when `--merge` is set) and SHALL state that no mutations were performed. The plan is a snapshot; a later live run MAY see different stages or PRs.

#### Scenario: Human output names order, stage, PR, and action

- **WHEN** dry-run resolves issues 279 then 269, issue 279 is `pipeline:ready-to-deploy` with open PR 50, and issue 269 is `pipeline:ready` with no PR and depends on 279
- **AND** `--merge` is set
- **THEN** human output SHALL include `ordered issues: #279 → #269`
- **AND** SHALL list 279 as `would-merge` with PR 50 and in the merge-first set
- **AND** SHALL list 269 as `waiting-on-deps` or not frontier-eligible until 279 is integrated
- **AND** SHALL state that no merges were performed

#### Scenario: Non-merge dry-run does not advertise merges

- **WHEN** dry-run runs without `--merge` for two non-ready-to-deploy frontier issues
- **THEN** each item's intended action SHALL be `would-advance` or `waiting-on-deps`
- **AND** no item SHALL have intended action `would-merge`

#### Scenario: Already-merged ready-to-deploy is already-integrated without containment proof

- **WHEN** `--merge --dry-run` sees an issue labeled `pipeline:ready-to-deploy` whose only linked PR is merged
- **THEN** the plan SHALL classify that item as `already-integrated`
- **AND** it SHALL NOT fetch the base or prove merge-result containment
- **AND** it SHALL NOT call the merge surface

#### Scenario: Ready-to-deploy with no PR is would-block

- **WHEN** `--merge --dry-run` sees an open issue labeled `pipeline:ready-to-deploy` with no linked open PR and no linked merged PR
- **THEN** the plan SHALL classify that item as `would-block`
- **AND** the command SHALL still exit 0 (plan succeeded; the live train would stop)

#### Scenario: Held items are marked held

- **WHEN** a work-list issue currently carries `pipeline:needs-human` or `blocked`
- **THEN** the plan SHALL classify that item as `held`
- **AND** it SHALL still appear in `ordered_issues`

#### Scenario: Cycle still fails closed

- **WHEN** dry-run's work list has a declared-dependency cycle
- **THEN** the command SHALL exit non-zero with a dependency validation error
- **AND** it SHALL NOT print a successful plan

---

### Requirement: Train dry-run JSON SHALL be one train_plan object that shares field names with train status and events

When `--json` is combined with `--dry-run`, stdout SHALL contain exactly one unfenced JSON object. That object SHALL have `schema_version` equal to `1` and `kind` equal to `train_plan`. It SHALL include `ordered_issues` (number array in train order), `merge_mode` (boolean), and an `items` array. Each item SHALL include `issue` (number), current `stage` (pipeline stage string or null), `pr` (number or null), and `intended_action` (one of the closed action strings). Merge mode SHALL include a `merge_first` array of issue numbers. Overlapping facts SHALL use the same field names as `train_status` and `train_work_list_resolved` (`ordered_issues`, `merge_mode`, per-item `issue` / `pr`). Dry-run JSON SHALL NOT have `kind` equal to `train_status`. Dry-run SHALL NOT call the live train event writer to produce this object. Nested child-run JSON SHALL NOT appear on that stdout stream.

#### Scenario: JSON dry-run parses once as train_plan

- **WHEN** `pipeline train --issues 10,11 --dry-run --json` succeeds
- **THEN** one `JSON.parse` of the complete stdout SHALL return an object whose `kind` is `train_plan`
- **AND** `schema_version` SHALL equal `1`
- **AND** `ordered_issues` SHALL equal `[10, 11]` after dependency-preserving order
- **AND** stdout SHALL NOT contain a `train_status` object

#### Scenario: Shared field names match live train vocabulary

- **WHEN** a merge-mode JSON dry-run plans issue 10 with open PR 20
- **THEN** the plan object SHALL set `merge_mode` to true
- **AND** the item SHALL use keys `issue` and `pr` (values 10 and 20)
- **AND** a live `train --json` consumer that keys on `kind: "train_status"` SHALL NOT treat this object as a completed train

#### Scenario: JSON dry-run does not write the event stream

- **WHEN** `--json --dry-run` prints `train_plan`
- **THEN** no `train_work_list_resolved` event SHALL be appended to a run store
- **AND** the dry-run path SHALL NOT initialize a train run directory in order to emit JSON

### Requirement: Train dry-run SHALL use the same shared discovery graph as live train

Dry-run SHALL resolve declared dependencies through the same shared discovery contract
live train uses (lexical, GitHub-native `blockedBy`, and enabled roadmap-declared edges,
after hard-wait admission). Dry-run SHALL classify frontier membership and intended
actions from that graph. A native or mixed-source admitted prerequisite that is not yet
integrated SHALL classify the dependent as `waiting-on-deps` (or not frontier-eligible)
the same way a live train would exclude it from the current frontier. Dry-run SHALL NOT
parse title and body as the sole declared-dependency source.

A fresh multi-item dry-run SHALL refuse with a typed, actionable incomplete-discovery
result when any enabled authoritative source is `unavailable` or `incomplete`. It SHALL
NOT print a successful plan, SHALL NOT create a train run store, and SHALL exit non-zero.
Fully observed empty sources SHALL still produce a plan of independent items rather than
inventing edges.

#### Scenario: Native blockedBy makes the dependent waiting-on-deps

- **WHEN** `pipeline train --issues 1322,1323 --dry-run` fully observes that 1323 is
  natively blocked by 1322
- **AND** 1322 is not already integrated
- **AND** 1323 has no lexical `Depends on` phrase naming 1322
- **THEN** the plan SHALL list 1323 as `waiting-on-deps` or not frontier-eligible
- **AND** it SHALL NOT list 1323 as `would-advance` solely because the body lacked a
  lexical edge

#### Scenario: Dry-run and live train agree on native independence

- **WHEN** the same selected set and the same injected discovery observations are given to
  dry-run and to a live train
- **THEN** both SHALL produce the same ordered issues
- **AND** both SHALL classify the same items as waiting on admitted dependents versus
  independent / frontier-eligible

#### Scenario: Incomplete native source fails dry-run before a plan

- **WHEN** a fresh multi-item dry-run enables native `blockedBy` discovery
- **AND** that source is `unavailable` or `incomplete` for a selected issue
- **THEN** the command SHALL exit non-zero with a typed result naming that source
- **AND** it SHALL NOT print a successful `train_plan`
- **AND** it SHALL NOT create a train run store
