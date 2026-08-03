## MODIFIED Requirements

### Requirement: Auto-filing SHALL enforce a per-window rate cap

The engine SHALL file at most `papercuts.auto_file_max_per_window` open papercut-auto-filed
issues within the trailing `papercuts.auto_file_window_hours` window, counted across all runs
and batches in the repository rather than per process. An issue SHALL count toward this cap
only when it is open, carries the `pipeline:backlog` label, was created inside the trailing
window, and its body includes the papercut auto-file provenance marker. Issues auto-filed by
other categories (correction, durable-run-blocker), human-managed backlog issues, and
`pipeline improve --apply` issues SHALL NOT count toward the papercut cap. Once the cap is
reached, remaining qualifying papercut clusters SHALL be reported as deferred and SHALL NOT be
filed until the window has advanced enough for the papercut-scoped count to fall below the cap.

#### Scenario: Filing stops at the papercut cap

- **WHEN** `papercuts.auto_file_max_per_window` open papercut-auto-filed issues already exist
  inside the current papercut window and further qualifying papercut clusters exist
- **THEN** no additional papercut issue SHALL be created for that window
- **AND** the remaining qualifying papercut clusters SHALL appear in the output marked as deferred

#### Scenario: Filing resumes once the window advances

- **WHEN** the trailing papercut window has advanced so that the in-window open
  papercut-auto-filed count is below the cap
- **THEN** a still-qualifying deferred papercut cluster SHALL become eligible for auto-filing again

#### Scenario: Cap holds across concurrent runs for the papercut category

- **WHEN** several runs of one queue batch complete concurrently with qualifying papercut clusters
- **THEN** the total number of open papercut-auto-filed issues within the papercut window SHALL
  NOT exceed `papercuts.auto_file_max_per_window`

#### Scenario: Other categories do not consume the papercut cap

- **WHEN** open in-window correction-auto-filed or durable-run-blocker-auto-filed issues exist
  and the open in-window papercut-auto-filed count is still below
  `papercuts.auto_file_max_per_window`
- **THEN** a qualifying papercut cluster SHALL still be eligible for auto-filing

#### Scenario: Unmarked backlog issues do not consume the papercut cap

- **WHEN** open in-window `pipeline:backlog` issues exist without the papercut auto-file
  provenance marker (including human-filed or `improve --apply` issues)
- **THEN** those issues SHALL NOT count toward `papercuts.auto_file_max_per_window`

### Requirement: Auto-file rate cap SHALL be enforced against GitHub-authored issue state to bound cross-host overshoot

The papercut per-window rate cap SHALL be enforced so that the total number of open
**papercut-auto-filed** issues within the trailing `papercuts.auto_file_window_hours` window does
not exceed `papercuts.auto_file_max_per_window` **across hosts**, not merely per host. The engine
SHALL derive the in-window papercut-auto-filed count from GitHub-authored issue state at or
immediately before each create — rather than solely from a single up-front host-local snapshot
decremented in memory — so that a papercut issue already created by another host is counted
before this host files. Membership in that count SHALL use the same predicate as post-create
rate-cap reconciliation: open, `pipeline:backlog`, papercut provenance marker, created inside
the window. Because two hosts can both pass this pre-create check before either create lands —
including for **different** papercut cluster titles, which the duplicate-title reconciliation
above cannot detect — the post-create reconciliation SHALL also recompute the in-window open
papercut-auto-filed set from a fresh read-back and close every papercut-auto-filed issue past the
lowest-numbered `papercuts.auto_file_max_per_window` survivors, ordered by issue number ascending.
Rate-cap reconciliation SHALL NOT close open issues that lack the papercut provenance marker
(including other auto-file categories). This rate-cap reconciliation SHALL use the same
deterministic lowest-numbered-survivor rule as the duplicate-title reconciliation so that two
hosts reconciling independently — even against snapshots taken at different times — converge on
the same surviving papercut set once every involved host's post-create reconciliation has run.

#### Scenario: Concurrent hosts near the papercut cap do not overshoot

- **WHEN** two pipeline processes on distinct hosts auto-file papercut clusters concurrently
  while the in-window open papercut-auto-filed count is at or near
  `papercuts.auto_file_max_per_window`
- **THEN** after reconciliation the number of open papercut-auto-filed issues in the window
  SHALL NOT exceed `papercuts.auto_file_max_per_window`

#### Scenario: An issue filed by another host counts toward the papercut cap

- **WHEN** host B computes its remaining papercut cap after host A has already created an
  in-window open papercut-auto-filed issue for a different papercut cluster
- **THEN** host B's papercut cap count SHALL include host A's papercut issue as read from GitHub
- **AND** host B SHALL stop filing papercut issues once the GitHub-authored in-window
  papercut-auto-filed count reaches the papercut cap

#### Scenario: Concurrent hosts filing different papercut titles past the cap converge after reconciliation

- **WHEN** two pipeline processes on distinct hosts each pass the pre-create papercut cap check
  against the same stale, pre-create snapshot — because neither host's create is visible to the
  other's check yet — and each creates a papercut issue for a **different** cluster title,
  together exceeding `papercuts.auto_file_max_per_window`
- **THEN** each host's post-create reconciliation SHALL recompute the in-window open
  papercut-auto-filed set and close every papercut-auto-filed issue past the lowest-numbered
  `papercuts.auto_file_max_per_window` survivors
- **AND** once every involved host's reconciliation has run, the number of open
  papercut-auto-filed issues in the window SHALL NOT exceed `papercuts.auto_file_max_per_window`
- **AND** open auto-filed issues of other categories SHALL remain open solely because of this
  papercut rate-cap reconciliation

## ADDED Requirements

### Requirement: Pre-create and post-create papercut rate-cap predicates SHALL be identical

The papercut rate-cap membership rule SHALL be identical for pre-create counting and for
post-create rate-cap overflow selection. An issue counts under both sites only when it is open,
carries `pipeline:backlog`, includes the papercut provenance marker, and was created inside the
window. The engine SHALL NOT use an unlabeled backlog count for pre-create while using a
marker-filtered set for reconcile, or any other split of open/closed, marker, or window rules
between the two sites.

#### Scenario: Pre-create and reconcile agree on membership

- **WHEN** the same GitHub-authored issue list is evaluated for papercut pre-create cap counting
  and for papercut post-create rate-cap reconciliation
- **THEN** both evaluations SHALL include exactly the same set of issues under the open,
  backlog-label, papercut-marker, and in-window created-at rules
