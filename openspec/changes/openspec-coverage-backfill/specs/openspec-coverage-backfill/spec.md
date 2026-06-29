## ADDED Requirements

### Requirement: The `backfill` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `backfill` as a positional sub-command keyword that requires no issue number and that does not read or advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `backfill` (case-sensitive). The command SHALL accept an optional `--apply` flag (default off → preview), an optional `--capability <name>` flag to scope a slice, and an optional `--repo <owner/repo>` flag (default: the current repo). When `--apply` is supplied but no applicable slice can be resolved, the command SHALL exit non-zero with a usage error rather than silently doing nothing.

#### Scenario: Invoked with no flags runs a preview

- **WHEN** the user runs `pipeline backfill`
- **THEN** the CLI SHALL dispatch the backfill handler without resolving or advancing any issue stage label
- **AND** SHALL run in preview mode

#### Scenario: Apply is opt-in

- **WHEN** the user runs `pipeline backfill --apply`
- **THEN** the handler SHALL run the mutating apply path (subject to the spec-only and validation guarantees in this capability) rather than the preview

#### Scenario: Apply with no resolvable slice errors

- **WHEN** the user runs `pipeline backfill --apply` and no `missing-coverage` candidate is eligible (e.g. everything is already covered, conflicting, or uncertain)
- **THEN** the command SHALL exit non-zero with a usage error explaining that there is no slice to apply

---

### Requirement: Backfill preview SHALL be non-mutating and SHALL state that nothing changed

In preview mode (the default, when `--apply` is absent), the handler SHALL NOT write any spec file, create or edit any GitHub issue, create any branch, or open any PR. The preview output SHALL include an explicit statement that no specs, issues, branches, or PRs were changed.

#### Scenario: Preview writes nothing

- **WHEN** the user runs `pipeline backfill` without `--apply`
- **THEN** the handler SHALL make no write to the filesystem, no GitHub issue create/edit, no branch creation, and no PR creation
- **AND** the output SHALL include an explicit "no specs, issues, branches, or PRs were changed" statement

---

### Requirement: Backfill SHALL operate on absent, empty, and partially-populated OpenSpec workspaces

The handler SHALL run a coverage preview against a repository whose OpenSpec workspace is absent, present-but-empty, or partially populated. Coverage SHALL be computed from the *content* of living specs (the requirement inventory under `openspec/specs/`), and the handler SHALL NOT treat a repository as fully covered merely because an `openspec/` directory exists.

#### Scenario: Absent workspace

- **WHEN** backfill previews a repository that has no `openspec/` directory
- **THEN** the handler SHALL run and report candidate legacy behavior (every eligible behavior is a candidate because there are zero living requirements)

#### Scenario: Empty workspace

- **WHEN** backfill previews a repository whose `openspec/` workspace contains no living requirements
- **THEN** the handler SHALL run and report candidate legacy behavior rather than reporting the repository as covered

#### Scenario: Partial adoption is not reported as complete

- **WHEN** backfill previews a repository whose living specs cover only some of its accepted behavior
- **THEN** the handler SHALL still surface the accepted behaviors that no living requirement describes as missing coverage
- **AND** SHALL NOT report the repository as fully covered merely because an `openspec/` workspace exists

---

### Requirement: Backfill SHALL classify candidate legacy behavior into evidence-graded coverage groups

The preview SHALL report existing OpenSpec coverage and candidate legacy behavior in at least four groups: **already-covered** (behavior mapped to an existing living requirement), **missing-coverage** (accepted behavior with sufficient, non-conflicting evidence and no existing requirement), **conflicting-evidence** (behavior that contradicts a living requirement or whose evidence sources disagree), and **uncertain-evidence** (behavior whose evidence is too weak to justify codifying). Only `missing-coverage` candidates SHALL be eligible to be proposed for the living specs.

#### Scenario: Report contains the four groups

- **WHEN** backfill previews a repository with a mix of covered, uncovered, conflicting, and weakly-evidenced behavior
- **THEN** the report SHALL present at least the four groups already-covered, missing-coverage, conflicting-evidence, and uncertain-evidence
- **AND** each candidate SHALL appear in exactly one group

#### Scenario: Only missing-coverage is eligible to be proposed

- **WHEN** backfill assembles the set of candidates eligible for the living specs
- **THEN** only candidates in the `missing-coverage` group SHALL be eligible
- **AND** candidates in `already-covered`, `conflicting-evidence`, and `uncertain-evidence` SHALL NOT be proposed for the living specs

---

### Requirement: Backfill SHALL preserve existing living specs as the current contract

The handler SHALL treat the requirements already present under `openspec/specs/` as the current contract. It SHALL NOT overwrite, rename, reorder away, or weaken any existing living requirement. The apply path SHALL only *add* requirements for `missing-coverage` behavior.

#### Scenario: Existing requirements are untouched by apply

- **WHEN** backfill applies a slice to a repository with existing living specs
- **THEN** no existing living requirement SHALL be removed, renamed, or have its `SHALL`/`MUST` text weakened
- **AND** the change SHALL contain only additive (`## ADDED Requirements`) deltas

#### Scenario: A behavior already covered is not re-added

- **WHEN** a candidate behavior already maps to an existing living requirement
- **THEN** the handler SHALL classify it as already-covered
- **AND** SHALL NOT propose a duplicate or competing requirement for it

---

### Requirement: Candidate backfill requirements SHALL identify the user-visible behavior and carry provenance

Every candidate requirement the handler produces SHALL name the user-visible behavior it describes and SHALL carry provenance: at least one concrete evidence reference (a test, a documentation/README section, a code path, or merged history) that demonstrates the behavior is accepted rather than accidental. A candidate that has no concrete provenance SHALL be classified as `uncertain-evidence` and SHALL NOT be eligible for the living specs.

#### Scenario: Candidate names behavior and cites evidence

- **WHEN** backfill drafts a candidate requirement
- **THEN** the candidate SHALL state the user-visible behavior it describes
- **AND** SHALL include at least one concrete provenance reference

#### Scenario: No provenance demotes a candidate

- **WHEN** a drafted candidate has no concrete provenance reference
- **THEN** it SHALL be classified as `uncertain-evidence`
- **AND** SHALL NOT appear in the `missing-coverage` (proposable) group

---

### Requirement: Conflicting- and uncertain-evidence candidates SHALL be withheld from living specs and surfaced for human decision

The handler SHALL NOT codify candidates classified as `conflicting-evidence` or `uncertain-evidence` into living specs or into an apply slice. It SHALL instead surface them in the report for human decision, with the reason (the conflicting requirement, the disagreement, or the missing evidence) shown.

#### Scenario: Conflicts are reported, not codified

- **WHEN** a candidate contradicts an existing living requirement
- **THEN** it SHALL be placed in `conflicting-evidence` and listed for human decision with the conflicting requirement named
- **AND** SHALL NOT be included in any apply slice

#### Scenario: Weak evidence is reported, not codified

- **WHEN** a candidate's evidence is too weak to justify codifying it
- **THEN** it SHALL be placed in `uncertain-evidence` and listed for human decision
- **AND** SHALL NOT be included in any apply slice

---

### Requirement: Applying a backfill slice SHALL open a reviewable, spec-only PR and SHALL NOT change application behavior

Under `--apply`, the handler SHALL author an OpenSpec change containing additive requirement deltas for the selected slice, commit it on a new branch, and open a PR targeting the default branch. It SHALL NOT commit directly to the default branch and SHALL NOT merge the PR. The change's diff SHALL touch only files under `openspec/`; if any non-`openspec/` path would change, the handler SHALL abort before opening the PR.

#### Scenario: Apply opens a PR, never commits to default

- **WHEN** backfill applies a slice
- **THEN** a new branch SHALL be created with the additive change
- **AND** a PR SHALL be opened targeting the default branch
- **AND** no commit SHALL be made directly to the default or main branch
- **AND** the PR SHALL NOT be merged by the handler

#### Scenario: The applied diff is spec-only

- **WHEN** backfill applies a slice
- **THEN** every path in the change's diff SHALL be under `openspec/`
- **AND** no application source, test, or config file outside `openspec/` SHALL be modified

#### Scenario: A non-spec change aborts before the PR

- **WHEN** authoring the slice would modify a path outside `openspec/`
- **THEN** the handler SHALL abort with a non-zero exit before opening any PR
- **AND** SHALL NOT open a PR or commit to any branch

---

### Requirement: Backfilled requirements SHALL distinguish accepted existing behavior from new intended behavior

Each requirement authored by the apply path SHALL be annotated to record that it codifies pre-existing *accepted* behavior (carrying its provenance), so a reader can distinguish it from new *intended* behavior added by the normal per-change flow. The annotation SHALL survive archival into the living specs.

#### Scenario: Backfilled requirement is marked as accepted-existing

- **WHEN** backfill authors a requirement for a `missing-coverage` behavior
- **THEN** the requirement SHALL carry an annotation marking it as backfilled accepted-existing behavior together with its provenance
- **AND** the annotation SHALL distinguish it from a forward-looking intended-behavior requirement

---

### Requirement: Re-running backfill SHALL be idempotent

A re-run after a slice has landed SHALL recognize behaviors already present in living specs as `already-covered`, and behaviors already proposed in an open backfill change/PR as already-proposed, and SHALL propose neither again. Recognition SHALL key on behavior identity and provenance, not on verbatim requirement prose, so a re-drafted wording of the same behavior is still de-duplicated.

#### Scenario: Previously-applied behavior is recognized as covered

- **WHEN** backfill runs again after a prior slice's requirements have landed in living specs
- **THEN** those behaviors SHALL be reported as already-covered
- **AND** SHALL NOT be proposed again

#### Scenario: Already-proposed behavior is not duplicated

- **WHEN** backfill runs while an open backfill PR already proposes a behavior
- **THEN** that behavior SHALL be reported as already-proposed
- **AND** the new run SHALL NOT author a duplicate requirement for it

---

### Requirement: Backfill SHALL validate the resulting workspace before reporting an applied slice successful

When a slice is applied, the handler SHALL run `openspec validate` on the authored change in the worktree before opening any PR. If validation fails, the handler SHALL surface the failure as a blocker with actionable details (naming the validation error) and SHALL NOT report success or open a PR.

#### Scenario: Validation passes before PR

- **WHEN** backfill applies a slice and the authored change passes `openspec validate`
- **THEN** the handler SHALL proceed to open the PR and report success

#### Scenario: Validation failure blocks with actionable details

- **WHEN** backfill applies a slice and the authored change fails `openspec validate`
- **THEN** the handler SHALL report the failure as a blocker that names the validation error
- **AND** SHALL NOT open a PR
- **AND** SHALL NOT report the slice as successfully applied

---

### Requirement: Backfill SHALL emit a scale-aware summary report

Both preview and apply output SHALL include aggregate counts per group, the items skipped (e.g. already-covered or already-proposed), the conflicts, and a concise "what to review next" summary, so the output is usable at repository scale rather than an undifferentiated dump.

#### Scenario: Report includes counts, skips, conflicts, and next-steps

- **WHEN** backfill produces its report on a repository with many candidates
- **THEN** the output SHALL include per-group aggregate counts
- **AND** SHALL list skipped items and conflicts
- **AND** SHALL include a concise "what to review next" summary

---

### Requirement: The behavior-analysis step SHALL be the only model-invoking part of backfill

The handler SHALL invoke the model only for behavior analysis and candidate drafting (enumerating candidate behaviors, drafting requirement text, grading evidence, and attaching provenance). Coverage comparison against living specs, group assignment, change authoring, the spec-only guard, `openspec validate`, and PR creation SHALL be deterministic given the drafted candidates and SHALL NOT invoke the model.

#### Scenario: Single model boundary

- **WHEN** backfill runs to completion in either preview or apply mode
- **THEN** the only model harness invocation SHALL be the behavior-analysis / candidate-drafting step
- **AND** coverage comparison, file authoring, validation, and PR creation SHALL make no model call

---

### Requirement: The `backfill` handler SHALL use injectable I/O deps for all external calls

All external calls (model harness, living-spec and evidence reads, `openspec validate`, file writes, git branch/PR creation) SHALL be injected via a `BackfillDeps` interface so unit tests can substitute fakes. No real network, git, or subprocess calls SHALL occur in unit tests.

#### Scenario: Unit tests exercise all branches via fakes

- **WHEN** the backfill tests run using a fake `BackfillDeps`
- **THEN** no real `gh` CLI, harness, `openspec`, or filesystem mutation SHALL occur
- **AND** the tests SHALL cover the preview path, the apply path, the spec-only-guard abort, the validation-failure block, and the idempotent re-run

---

### Requirement: Backfill SHALL ship operator documentation

The change SHALL include operator documentation that explains when to use backfill, how to review the provenance attached to candidates, how partial adoption is handled, and why low-confidence (conflicting or uncertain) behavior is not automatically codified.

#### Scenario: Documentation covers the operator-facing topics

- **WHEN** a maintainer reads the backfill operator documentation
- **THEN** it SHALL explain when to use backfill, how to review provenance, how partial adoption is handled, and why low-confidence behavior is not auto-codified
