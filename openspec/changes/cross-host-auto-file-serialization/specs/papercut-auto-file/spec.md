## ADDED Requirements

### Requirement: Auto-file dedup SHALL converge to a single open issue per cluster across distinct hosts

Auto-filing SHALL guarantee that a qualifying papercut cluster results in at most one open
auto-filed issue **across pipeline processes running on different hosts**, not only within a single
host's `withLock` critical section. Because the host-local `/tmp` lock provides no cross-host mutual
exclusion, the engine SHALL treat GitHub-authored issue state as the shared source of truth: after
creating an auto-filed issue, the engine SHALL re-read the improve-issue list, and when the created
title maps to more than one open issue, SHALL keep the lowest-numbered open issue and close the
remaining duplicates with a comment that references the surviving issue. The lowest-numbered-survivor
rule SHALL be deterministic so that two hosts reconciling the same duplicate select the same survivor.
This reconciliation SHALL be best-effort and total: any failure SHALL be caught, logged as a
non-fatal warning, and SHALL NOT fail a run, stage, or batch.

#### Scenario: Two hosts filing the same cluster converge to one open issue

- **WHEN** two pipeline processes on distinct hosts each pass the pre-create dedup check for the same
  qualifying cluster and both create an issue with the same title
- **THEN** after read-back reconciliation exactly one issue for that title SHALL remain open
- **AND** the surviving issue SHALL be the lowest-numbered of the duplicates
- **AND** the closed duplicate SHALL carry a comment referencing the surviving issue

#### Scenario: Single-host run performs no reconciliation

- **WHEN** only one host auto-files and no duplicate title exists after a create
- **THEN** the engine SHALL close no issue
- **AND** the run's output and artifacts SHALL be identical to the behaviour before cross-host
  reconciliation existed

#### Scenario: Reconciliation failure is non-fatal

- **WHEN** the read-back list or the duplicate-close call throws during reconciliation
- **THEN** the engine SHALL log a non-fatal warning and leave the duplicate for a later trigger to
  reconcile
- **AND** the run or batch SHALL complete with the same exit status it would have had with
  auto-filing disabled

---

### Requirement: Auto-file rate cap SHALL be enforced against GitHub-authored issue state to bound cross-host overshoot

The per-window rate cap SHALL be enforced so that the total number of open auto-filed issues within
the trailing `auto_file_window_hours` window does not exceed `auto_file_max_per_window` **across
hosts**, not merely per host. The engine SHALL derive the in-window auto-filed count from
GitHub-authored issue state at or immediately before each create — rather than solely from a single
up-front host-local snapshot decremented in memory — so that an issue already created by another host
is counted before this host files. Any residual overshoot from a simultaneous cross-host create SHALL
be corrected by the duplicate reconciliation above, since a closed duplicate no longer counts as an
open auto-filed issue.

#### Scenario: Concurrent hosts near the cap do not overshoot

- **WHEN** two pipeline processes on distinct hosts auto-file concurrently while the in-window count
  is at or near `auto_file_max_per_window`
- **THEN** after reconciliation the number of open auto-filed issues in the window SHALL NOT exceed
  `auto_file_max_per_window`

#### Scenario: An issue filed by another host counts toward the cap

- **WHEN** host B computes its remaining cap after host A has already created an in-window auto-filed
  issue for a different cluster
- **THEN** host B's cap count SHALL include host A's issue as read from GitHub
- **AND** host B SHALL stop filing once the GitHub-authored in-window count reaches the cap
