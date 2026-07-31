## ADDED Requirements

### Requirement: Release-eligible FRG pass SHALL auto-close synthetic pack PRs and issues without merging

The FRG driver SHALL, when it successfully writes release-eligible evidence with `pass: true`
(non-empty durable `loop_run_id`, validated fixed-pack `pack_id` matching the versioned pack
manifest, and scenario criteria met as required for release-eligible pass), perform post-pass pack
disposition: close without merging each open pull request associated with a scored pack item that
is `ready_clean: true` on `scoreboard.per_item[]` and still has an open PR, and close the linked
GitHub issue for those items when the issue is still open. Close comments SHALL be deterministic
and auditable, include the FRG target version and evidence `run_id`, and state that the synthetic
factory-gate pack item was scored ready-to-deploy and is being closed without merge. The driver
SHALL NOT merge any pull request, enable auto-merge, or enqueue a merge-queue entry as part of
this disposition.

#### Scenario: Release-eligible pass closes ready_clean pack PR and issue

- **WHEN** `pipeline factory-gate` writes release-eligible evidence with `pass: true` for version
  `X.Y.Z` and `run_id` `R`
- **AND** `scoreboard.per_item[]` contains an item with `ready_clean: true` that has an open PR
  and an open linked issue carrying the pack selector label
- **THEN** the driver SHALL close that PR without merging
- **AND** SHALL close that issue
- **AND** SHALL attach a deterministic comment on each closed resource that cites version `X.Y.Z`
  and `run_id` `R` and states closing without merge

#### Scenario: Multiple open PRs for one ready_clean item are all closed

- **WHEN** release-eligible evidence with `pass: true` is written
- **AND** a scored `ready_clean` pack item has more than one open associated PR (for example a
  replacement PR and an abandoned draft still linked to the same issue)
- **THEN** the driver SHALL close each of those open associated PRs without merging
- **AND** SHALL close the linked open issue when it still carries the pack selector label
- **AND** a close failure on one PR SHALL NOT prevent remaining PR closes for that item
  (fail-soft per PR)

#### Scenario: Non-pass does not close pack artifacts

- **WHEN** the FRG driver produces evidence with `pass: false`
- **THEN** the driver SHALL NOT close pack PRs or issues as a side effect of that scoring run

#### Scenario: Non-release-eligible score does not close pack artifacts

- **WHEN** FRG scoring is not release-eligible (for example missing non-empty `loop_run_id` or
  validated fixed-pack `pack_id`) even if scenario outcomes would otherwise look successful
- **THEN** the driver SHALL NOT close pack PRs or issues as post-pass disposition

#### Scenario: Passing FRG still never merges

- **WHEN** post-pass pack disposition runs after a release-eligible `pass: true`
- **THEN** the driver SHALL NOT call merge on any pull request
- **AND** SHALL NOT enable auto-merge or enqueue merge-queue as a side effect of the FRG run

---

### Requirement: FRG pack auto-close SHALL hard-limit scope to scored pack items

Post-pass pack disposition SHALL close only resources that satisfy **all** of the following:
(1) the item appears on the scored run’s work-list / `scoreboard.per_item[]` for that FRG evidence
run, (2) the linked issue carries the pack selector label used for the fixed pack (the
`factory-gate` label or the documented pack selector validated for that run), and (3) the resource
is still open at close time. The driver SHALL NOT perform a repo-wide close of all
`factory-gate`-labeled issues or PRs, and SHALL NOT close product-milestone or other non-pack
items solely because they ran on the same host or in a different loop.

#### Scenario: Non-pack labeled item is never closed

- **WHEN** post-pass disposition considers an issue that does not carry the pack selector label
  for the scored run
- **THEN** the driver SHALL NOT close that issue
- **AND** SHALL NOT close any PR solely because it was associated with that non-pack issue

#### Scenario: Item absent from scored scoreboard is never closed

- **WHEN** an open issue carries the `factory-gate` label but is not present on the scored run’s
  work-list / `scoreboard.per_item[]` for the evidence being written
- **THEN** the driver SHALL NOT close that issue or its PRs as part of that FRG pass disposition

#### Scenario: Already-closed resources are skipped without failure

- **WHEN** a candidate pack PR or issue is already closed at disposition time
- **THEN** the driver SHALL skip that resource without treating the overall FRG pass as failed

---

### Requirement: FRG pack auto-close failures SHALL be fail-soft

A GitHub close or comment failure during post-pass pack disposition SHALL be reported to the
operator (stderr and/or structured run messaging) and MAY be summarized in CLI output or an
auditable note that does not rewrite `pass`. Such a failure SHALL NOT flip a recorded FRG
`pass: true` to fail, SHALL NOT delete or invalidate already-written evidence artifacts, and
SHALL NOT alone force a non-zero process exit when the scored evidence is `pass: true`. FRG
scoring remains authoritative; close is post-pass hygiene.

#### Scenario: Close error leaves pass and evidence intact

- **WHEN** release-eligible evidence with `pass: true` has been written
- **AND** closing one eligible pack PR or issue fails with a GitHub/API error
- **THEN** the driver SHALL report the failure
- **AND** the evidence artifact SHALL remain with `pass: true`
- **AND** the driver SHALL NOT delete the written evidence paths for that run
- **AND** remaining eligible closes MAY still be attempted (best-effort)

---

### Requirement: FRG driver SHALL offer opt-out of pack auto-close

The FRG driver CLI SHALL provide a flag (for example `--no-close-pack` or `--keep-pack-open`) that
skips post-pass pack disposition entirely for that invocation. When the flag is set, a
release-eligible `pass: true` run SHALL still write evidence and exit according to scoring rules
but SHALL NOT close pack PRs or issues. Default behavior without the flag SHALL perform auto-close
on release-eligible pass as specified by the post-pass disposition requirements.

#### Scenario: Opt-out skips closes on pass

- **WHEN** an operator runs the FRG driver with the pack auto-close opt-out flag
- **AND** the run writes release-eligible evidence with `pass: true`
- **THEN** the driver SHALL NOT close pack PRs or issues for that invocation
- **AND** evidence `pass: true` SHALL still be written according to scoring rules

---

### Requirement: FRG runbook SHALL document post-pass pack auto-close

The checked-in FRG runbook SHALL document that a release-eligible FRG pass auto-closes synthetic
pack open PRs and linked open issues without merging; that merge is never part of FRG; when
operators should use the opt-out flag (debugging, intentional provenance land); and that product
milestones / non-pack work are out of scope for this disposition.

#### Scenario: Runbook states close-without-merge on pass

- **WHEN** an operator reads the FRG runbook
- **THEN** it SHALL state that release-eligible pass auto-closes synthetic pack PRs/issues
  without merge
- **AND** SHALL name or describe the opt-out flag
- **AND** SHALL state that product-milestone items are not closed by FRG disposition

## MODIFIED Requirements

### Requirement: FRG SHALL NOT introduce auto-merge

The Factory Reliability Gate SHALL NOT merge pull requests, enable auto-merge, or create a release
tag as a side effect of a passing FRG. Human ownership of merge and tag paths remains as specified
by existing release and golden-rule constraints. FRG observes factory outcomes and records
pass/fail; after a release-eligible pass it MAY close synthetic pack pull requests and issues
without merging as post-pass hygiene, subject to the pack auto-close scope and fail-soft
requirements. Close-without-merge SHALL NOT be treated as merge authority.

#### Scenario: Passing FRG does not merge

- **WHEN** a live FRG run reaches `pass: true`
- **THEN** the driver SHALL NOT merge any pull request
- **AND** SHALL NOT create a git tag for the version as a side effect of the FRG run itself

#### Scenario: Close-without-merge is allowed as pack hygiene

- **WHEN** a live FRG run reaches release-eligible `pass: true`
- **AND** post-pass pack disposition closes a synthetic pack PR without merging
- **THEN** that close SHALL be permitted as hygiene
- **AND** SHALL NOT be treated as introducing auto-merge or human merge authority
