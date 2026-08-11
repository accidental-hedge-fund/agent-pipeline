## Purpose

Operator-invoked `pipeline decompose` turns one epic issue into a bounded set of small, dependency-linked child issues and a human-reviewable ROADMAP PR, with dry-run default and no merge authority.

## ADDED Requirements

### Requirement: The `decompose` sub-command SHALL run without an issue-number positional and SHALL default to dry-run

The pipeline CLI SHALL accept `decompose` as a positional sub-command keyword that requires no issue-number positional argument and that does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `decompose` (case-sensitive). Without `--apply`, the command SHALL run in preview (dry-run) mode: it SHALL print the proposed child graph and SHALL NOT create GitHub issues, open branches or PRs, write labels, or mutate the operator primary checkout. With `--apply`, the command MAY perform the documented GitHub and branch/PR writes. The sub-command SHALL appear in CLI help text alongside peer no-issue-number authoring commands (`intake`, `sweep`, `roadmap`).

#### Scenario: Invoked without `--apply` (dry-run)

- **WHEN** the user runs `pipeline decompose --epic 123`
- **THEN** the command SHALL dispatch the decompose handler
- **AND** SHALL print proposed children (title, summary, AC outline, deps, effort)
- **AND** SHALL NOT create any GitHub issue
- **AND** SHALL NOT open any branch or PR
- **AND** SHALL NOT mutate the primary checkout working tree for ROADMAP delivery

#### Scenario: Invoked with `--apply`

- **WHEN** the user runs `pipeline decompose --epic 123 --apply`
- **THEN** the command SHALL create child issues (when the plan is valid) and open a ROADMAP.md PR
- **AND** SHALL NOT merge that PR or any other PR

#### Scenario: Preview notice when `--apply` is absent

- **WHEN** the user runs `pipeline decompose --epic 123` without `--apply`
- **THEN** the command SHALL print a notice that no writes will occur and that `--apply` is required to create children and open the ROADMAP PR

#### Scenario: Help lists decompose

- **WHEN** the user runs `pipeline --help`
- **THEN** the output SHALL include `decompose` among recognized sub-command keywords

### Requirement: The `decompose` sub-command SHALL require an epic seed and MAY accept a description seed

The handler SHALL require a positive integer epic issue number via `--epic <N>`. An optional `--description "<text>"` flag MAY supply additional free-text context that enriches the decomposition harness input. Omitting `--epic` SHALL exit non-zero with a usage error. The epic issue body and title SHALL be loaded as primary input context before decomposition.

#### Scenario: Epic flag is required

- **WHEN** the user runs `pipeline decompose` with neither `--epic` nor a valid epic seed
- **THEN** the command SHALL exit non-zero with a usage error naming `--epic`

#### Scenario: Description seed is optional

- **WHEN** the user runs `pipeline decompose --epic 123 --description "prefer vertical slices by API surface"`
- **THEN** the description text SHALL be included in the decomposition harness input alongside the epic title and body

#### Scenario: Missing epic issue fails visibly

- **WHEN** `--epic 99999` refers to an issue that does not exist or is inaccessible
- **THEN** the command SHALL exit non-zero before any child creation
- **AND** SHALL NOT open a ROADMAP PR

### Requirement: Decomposition SHALL produce a bounded child graph with WHAT-not-HOW bodies and machine-usable dependencies

Given a valid epic seed, the handler SHALL produce a proposed set of child work items. Each child SHALL include: a concise title; a WHAT-not-HOW outline with Summary, User story, Acceptance criteria (checkable observable outcomes), and Out of scope; an effort band of `S` or `M` by default; and zero or more prerequisite references among the proposed siblings (and, when needed, existing issue numbers). Dependency declarations written into child bodies under `--apply` SHALL use forms recognized by the shared `declared-dependency-grammar` (phrase forms and/or a Dependencies section) so work-list population can compile `depends_on` without a second grammar. Decomposition MAY use one model harness call for the graph; issue creation, label writes, cycle checks, sizing enforcement, and ROADMAP PR steps SHALL be deterministic given the accepted plan.

#### Scenario: Proposed child shape in dry-run

- **WHEN** dry-run decomposition of a multi-capability epic succeeds
- **THEN** each printed child SHALL include title, summary, AC outline, deps, and effort
- **AND** acceptance criteria SHALL be observable outcomes, not implementation steps

#### Scenario: Applied child body is machine-usable for depends_on

- **WHEN** `--apply` creates a child that depends on sibling `#A`
- **THEN** the child body SHALL declare that dependency using a form accepted by the shared declared-dependency grammar
- **AND** a later work-list compile that fully observes lexical sources SHALL include `#A` in that child's declared dependencies

#### Scenario: Plan may depend on existing issue numbers

- **WHEN** a proposed child declares a prerequisite on an existing issue via `depends_on_issue_numbers` (for example `[42]`) in addition to or instead of sibling keys
- **THEN** plan parse SHALL accept those positive issue numbers
- **AND** under `--apply` the created child body SHALL include those issue numbers using the shared declared-dependency grammar forms

#### Scenario: Harness is the only model-invoking step for the graph

- **WHEN** decompose runs to successful completion under `--apply`
- **THEN** graph generation is the only model-invoking step required for the breakdown
- **AND** create-issue, label, cycle check, and ROADMAP PR steps do not require additional model calls

### Requirement: Sizing and cardinality bounds SHALL be enforced

The handler SHALL prefer children sized `S` or `M`. It SHALL refuse a plan that includes an `XL` (or larger-than-configured) child unless an explicit operator override flag is supplied. It SHALL refuse a plan whose child count exceeds the configured maximum (default bound documented in config and overridable via `--max-children`). Config keys under an optional `decompose` block in `.github/pipeline.yml` (for example `max_children`, `max_effort`) SHALL supply defaults when present; CLI flags override config for that invocation. Bound violations SHALL exit non-zero in both dry-run and apply modes and SHALL NOT create partial child sets under `--apply`.

#### Scenario: Max children exceeded fails before writes

- **WHEN** the proposed graph has 20 children and `--max-children 12` is in effect
- **THEN** the command SHALL exit non-zero with an error naming the bound
- **AND** under `--apply` SHALL NOT create any child issue

#### Scenario: XL without override fails

- **WHEN** the proposed graph includes a child with effort `XL` and no XL override is supplied
- **THEN** the command SHALL exit non-zero
- **AND** SHALL NOT create that child or any sibling under the same apply attempt

#### Scenario: Override permits max-effort exception

- **WHEN** the operator supplies the documented max-effort override together with an otherwise valid plan
- **THEN** the command MAY accept the plan subject to all other checks (cycles, max children, idempotency)

### Requirement: Dependency cycle detection SHALL fail the run visibly

Before printing a successful dry-run summary and before any `--apply` child creation, the handler SHALL validate the proposed dependency graph among the new children (and any referenced existing issue edges in the plan). If a cycle exists, the command SHALL exit non-zero with an error that identifies the cycle membership and SHALL NOT create issues or open a ROADMAP PR.

#### Scenario: Cycle fails dry-run

- **WHEN** the proposed children form a cycle A→B→A
- **THEN** dry-run SHALL exit non-zero and name the cycle
- **AND** SHALL NOT imply a successful plan

#### Scenario: Cycle fails apply before creates

- **WHEN** the same cyclic plan is run with `--apply`
- **THEN** the command SHALL exit non-zero before creating any child issue
- **AND** SHALL NOT open a ROADMAP PR

### Requirement: `--apply` SHALL create child issues with parent linkage and pipeline triage labels

Under `--apply`, after a valid acyclic in-bounds plan, the handler SHALL create each child issue in the target repository. Each child body SHALL reference the parent epic by number. The parent issue SHALL remain open as an umbrella and SHALL receive the `pipeline:epic` label (create-only label ensure: create if absent; never clobber existing label color/description). Children SHALL receive either `pipeline:ready` when the child body is decision-complete (no blocking open questions) or `pipeline:backlog` when open questions remain. Optional `--release vX.Y.Z` SHALL attach the corresponding `release:vX.Y.Z` label to children when provided; when omitted, release labeling follows the same documented slot proposal rules as intake or remains unlabeled only if the design documents that choice consistently. Label ensure for pipeline and release labels SHALL be create-only.

#### Scenario: Children reference parent and receive triage labels

- **WHEN** `--apply` succeeds for epic `#123` with three decision-complete children
- **THEN** three child issues exist
- **AND** each child body references `#123`
- **AND** each child carries `pipeline:ready`
- **AND** the parent carries `pipeline:epic`

#### Scenario: Incomplete child is labeled backlog

- **WHEN** a proposed child still has unresolved open questions in its body
- **THEN** under `--apply` that child SHALL receive `pipeline:backlog` rather than `pipeline:ready`

#### Scenario: Parent is not closed and is not default-implementable as a unit of the graph

- **WHEN** `--apply` completes
- **THEN** the parent epic remains open
- **AND** the parent is not treated as one of the newly created implementable children

### Requirement: Parent epics labeled `pipeline:epic` SHALL be excluded from default milestone and label loop selectors

When Pipeline resolves a **milestone** or **label** loop selector into a work list, it SHALL exclude open issues that carry the `pipeline:epic` label. Explicit **work-list** (issue number list) selectors SHALL NOT auto-exclude such issues: if the operator names the epic number explicitly, it remains eligible. Roadmap-slice resolution SHALL exclude `pipeline:epic`-labeled issues that appear only as umbrella parents when the slice extraction would otherwise include them solely by parent membership; child issue numbers listed in the slice remain eligible. Exclusion SHALL be deterministic and tested via injected issue inventory.

#### Scenario: Milestone selector skips epic parents

- **WHEN** a milestone contains child issues `#10`, `#11` and parent epic `#9` labeled `pipeline:epic`
- **AND** the user runs a loop with `--milestone` for that milestone
- **THEN** the resolved work list SHALL include `#10` and `#11`
- **AND** SHALL NOT include `#9`

#### Scenario: Explicit work list may include an epic

- **WHEN** the user supplies an explicit work list containing `#9` only
- **AND** `#9` carries `pipeline:epic`
- **THEN** the resolved work list SHALL still include `#9`

#### Scenario: Label selector for ready does not pull epics

- **WHEN** issues labeled `pipeline:ready` are selected and an open `pipeline:epic` issue also carries another label that would match a broad query only via milestone/label default paths covered by this requirement
- **THEN** any issue that carries `pipeline:epic` SHALL be omitted from milestone and label selector results

### Requirement: `--apply` SHALL open a ROADMAP.md PR and SHALL never merge it

Under `--apply`, after successful child creation (or after determining the idempotent child set), the handler SHALL propose a `ROADMAP.md` update on a new branch and open a PR targeting the default branch. The PR body SHALL summarize the parent epic and the child issue numbers. The handler SHALL NOT commit directly to the default branch. The handler SHALL NOT merge the ROADMAP PR. ROADMAP delivery SHALL avoid mutating the operator primary checkout branch (throwaway worktree or equivalent isolation consistent with existing roadmap/intake isolation patterns).

#### Scenario: ROADMAP PR opened for human review

- **WHEN** `--apply` completes successfully
- **THEN** a branch exists with ROADMAP.md edits placing the children in the delivery plan
- **AND** a PR targets the default branch
- **AND** the PR is not merged by the command

#### Scenario: Default branch is not committed to

- **WHEN** `--apply` runs
- **THEN** the command SHALL NOT create commits on the repository default branch

### Requirement: Re-running decompose for the same epic SHALL be idempotent

A second `pipeline decompose --epic N --apply` for an epic that already has decompose-created children SHALL NOT create duplicate child issues for the same logical breakdown. The handler SHALL recognize prior children via a stable provenance marker (for example a machine-readable parent marker and stable child identity key written into each child body at creation time). When the prior set already matches the accepted plan identity, the command SHALL report existing children and MAY still refresh or open a ROADMAP PR only when the roadmap content would change; it SHALL NOT spam duplicate issues. Dry-run re-runs SHALL show the same logical graph without claiming new creates when identity matches. Under `--apply`, provenance discovery through child creation for a given repository domain and epic SHALL run inside a host-local serialization critical section (recoverable lock released when the section settles) so concurrent same-host applies cannot both observe an empty provenance set and create duplicate children for the same plan keys.

#### Scenario: Second apply does not duplicate children

- **WHEN** `--apply` has already created children for epic `#123`
- **AND** the operator runs `pipeline decompose --epic 123 --apply` again with the same logical plan identity
- **THEN** no additional duplicate child issues are created for those plan slots
- **AND** the command exits successfully or with a documented no-op success path

#### Scenario: Provenance marker enables recognition

- **WHEN** a child issue body contains the decompose provenance marker for parent `#123`
- **THEN** a subsequent decompose of `#123` SHALL treat that issue as an existing child of that epic for idempotency matching

#### Scenario: Concurrent same-host applies serialize provenance discovery and creates

- **WHEN** two `--apply` invocations for the same domain and epic run concurrently on one host
- **THEN** provenance discovery through child creation SHALL be serialized for that epic
- **AND** the second invocation SHALL re-read provenance after acquiring the critical section
- **AND** it SHALL NOT create a second issue for a plan key already created by the first

### Requirement: Decompose I/O SHALL be seam-injected under unit test

Unit tests for decompose SHALL inject fakes for harness invocation, GitHub issue read/create/label, selector inventory, and git/PR operations. Those tests SHALL perform zero real network, git, and subprocess calls for the covered paths.

#### Scenario: Tests use deps injection

- **WHEN** unit tests exercise dry-run, apply, cycle failure, idempotency, and parent exclusion
- **THEN** they SHALL supply fake deps for harness and GitHub/git seams
- **AND** the test process SHALL not require live network access for those assertions
