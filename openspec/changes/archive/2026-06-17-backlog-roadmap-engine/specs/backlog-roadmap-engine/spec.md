## ADDED Requirements

### Requirement: The `roadmap` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `roadmap` as a positional sub-command keyword that requires no issue number and that does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `roadmap` (case-sensitive). A `--apply` flag gates all GitHub write-back; omitting it SHALL run in dry-run mode. A `--next <N>` option SHALL emit the top-N dependency-safe issues from an existing `plan.json` without re-running the engine. The sub-command SHALL be listed in the CLI help text alongside peer no-issue-number sub-commands.

#### Scenario: Invoked with no flags (dry-run)

- **WHEN** the user runs `pipeline roadmap`
- **THEN** the command SHALL dispatch the roadmap handler, run all 7 phases, write `plan.json` and `roadmap.md` to the output directory, and print the intended GitHub mutations without applying any of them

#### Scenario: Invoked with `--apply`

- **WHEN** the user runs `pipeline roadmap --apply`
- **THEN** the command SHALL run all 7 phases and apply all GitHub write-back actions (label/milestone/comment/issue mutations, PR creation)

#### Scenario: Invoked with `--next N`

- **WHEN** the user runs `pipeline roadmap --next 5`
- **THEN** the command SHALL read the existing `plan.json` and emit the top-5 dependency-safe issues in order, without re-running the engine phases

#### Scenario: `--next` warns on stale plan

- **WHEN** the user runs `pipeline roadmap --next 3` and the existing `plan.json` has `generated_at` older than the configured threshold (default 7 days)
- **THEN** the command SHALL emit a staleness warning before printing the issue list
- **AND** SHALL NOT refuse to emit the list

---

### Requirement: The engine SHALL always run all 7 phases in order

The roadmap engine SHALL execute the following phases in order regardless of backlog size: (1) comprehend, (2) inventory, (3) depgraph, (4) score, (5) roadmap, (6) hygiene, (7) adversarial critique. No phase SHALL be skipped or short-circuited. The comprehend and adversarial-critique phases are mandatory even for backlogs with a single issue.

#### Scenario: Phases execute in order

- **WHEN** `runRoadmap` is called
- **THEN** phase 1 (comprehend) SHALL complete before phase 2 (inventory) begins
- **AND** phase 7 (critique) SHALL be the final phase, running after the roadmap tier list is produced

#### Scenario: Small backlog does not skip comprehend

- **WHEN** the repo has exactly one open issue
- **THEN** the comprehend and adversarial-critique phases SHALL still both execute

---

### Requirement: The engine SHALL build a source-verified dependency graph

For each candidate dependency edge between two issues, the engine SHALL read the relevant source file(s) and confirm the coupling before promoting the edge to `must_precede` or `should_precede` in `plan.json`. An edge SHALL NOT be promoted based solely on issue text. Candidate edges that cannot be source-verified SHALL be placed in `plan.json.dependency_graph.open_questions[]` with a rationale. Cycles in `must_precede` edges SHALL be detected and recorded in `plan.json.dependency_graph.cycle_reports[]`; the engine SHALL NOT silently break a cycle.

#### Scenario: Source-verified edge is promoted

- **WHEN** issue A imports a type from a file that issue B creates or modifies, and the engine reads the file and confirms the import
- **THEN** the edge A→B SHALL appear in `plan.json.dependency_graph.must_precede` with a `file:line` citation

#### Scenario: Unverified candidate stays in open_questions

- **WHEN** issue text says "depends on #42" but no source file confirms the coupling
- **THEN** the edge SHALL NOT appear in `must_precede` or `should_precede`
- **AND** the dependency candidate SHALL appear in `plan.json.dependency_graph.open_questions[]` with rationale "edge not source-verified"

#### Scenario: Cycle is detected and reported

- **WHEN** issue A must precede B and B must precede A (cycle)
- **THEN** `plan.json.dependency_graph.cycle_reports[]` SHALL contain an entry describing the cycle
- **AND** the topological sort SHALL surface both issues with a conflict marker rather than choosing an arbitrary order silently

---

### Requirement: The engine SHALL score issues using a reproducible formula

Each issue SHALL receive a numeric priority score computed as `Priority = (Impact × Confidence × Ease) + RiskReduction + DepLeverage`, where all sub-factors are integers 1–5 and `Ease = 5 − Effort` (effort 1 = XS → Ease 4; effort 5 = XL → Ease 0). Optional weight overrides in `config.roadmap.score_weights` SHALL multiply the corresponding sub-factor. Every scored item in `plan.json.scored[]` SHALL include the sub-factor breakdown so the score is reproducible from the formula given the same inputs.

#### Scenario: Score is reproducible from breakdown

- **WHEN** `plan.json.scored[]` is inspected for any issue
- **THEN** the `priority` field SHALL equal `(impact × confidence × ease) + risk_reduction + dep_leverage` computed from the `score_breakdown` fields

#### Scenario: Weight override applies

- **WHEN** `config.roadmap.score_weights.impact = 2` is set
- **THEN** the impact sub-factor SHALL be multiplied by 2 in the priority formula for all scored issues

#### Scenario: Dependent ordering preserved after scoring

- **WHEN** issue B scores higher than issue A but B `must_precede`-depends on A
- **THEN** issue A SHALL appear before issue B in the final `plan.json.roadmap[]` order

---

### Requirement: The engine SHALL produce a tiered roadmap in `plan.json.roadmap[]`

The roadmap SHALL organize scored issues into five tiers in order: (1) enablers, (2) dependency-unlock, (3) high-value/low-risk, (4) larger bets, (5) cleanup. Within each tier, issues are ordered by dependency-adjusted priority score descending. Each roadmap entry SHALL include: rank, score breakdown, dependency rationale (which issues it unblocks or is blocked by), touched files list, effort estimate (XS/S/M/L/XL), and identified risks.

#### Scenario: Enabler tier appears first

- **WHEN** issue A is a hard prerequisite for three other high-scoring issues and has no prerequisites of its own
- **THEN** issue A SHALL appear in tier 1 (enablers) at a rank above the issues it unblocks

#### Scenario: Cleanup tier appears last

- **WHEN** issue Z is a refactor with no blockers and no issues depending on it
- **THEN** issue Z SHALL appear in tier 5 (cleanup) regardless of its raw score

---

### Requirement: The engine SHALL propose hygiene actions for backlog health

The engine SHALL identify and propose one or more hygiene dispositions for each candidate: close (obsolete), merge (duplicate), rewrite (vague title/body), split (scope bundle), spike (research needed), postpone (blocked by external). Each proposal SHALL include exact comment text and `file:line` evidence. No hygiene action SHALL be applied to GitHub without `--apply`. Under `--apply`, each action SHALL be idempotent: a comment with a `<!-- roadmap-run:<hash> -->` sentinel SHALL NOT be posted twice; a close action SHALL NOT be issued if the issue is already closed.

#### Scenario: Hygiene proposal is dry-run by default

- **WHEN** `pipeline roadmap` is run without `--apply`
- **THEN** `plan.json.hygiene[]` SHALL contain all proposed actions with comment text and evidence
- **AND** no GitHub issue, comment, label, or milestone SHALL be mutated

#### Scenario: Idempotent comment sentinel

- **WHEN** `pipeline roadmap --apply` is run twice on the same backlog
- **THEN** the second run SHALL NOT post a duplicate comment on any issue that already has the `<!-- roadmap-run:<hash> -->` sentinel from the first run

#### Scenario: Close action is skipped for already-closed issue

- **WHEN** a hygiene action proposes closing issue #42 and issue #42 is already closed
- **THEN** the close action SHALL be skipped with a log message and SHALL NOT produce an error

---

### Requirement: The engine SHALL run an adversarial critique phase and apply corrections

After the roadmap tier list is produced, the engine SHALL invoke an adversarial critique using the `review-schema.ts` verdict schema (single-sourced via `{{schema_block}}` injection). The critique SHALL attack for: dependency-order violations, non-reproducible scores, missed duplicates, and mislabeled "ready" issues. Critique findings classified as `must_precede` violations SHALL trigger re-application of the violated edge and a re-run of the topological sort. This correction loop SHALL execute at most 2 times; after 2 correction rounds, unresolved findings SHALL be promoted to `plan.json.open_questions[]`. The final `plan.json` and `roadmap.md` SHALL reflect corrections before they are written.

#### Scenario: Dep-order violation finding triggers re-sort

- **WHEN** the critique identifies that issue B appears before issue A in the roadmap but A `must_precede` B
- **THEN** the engine SHALL add A→B to `must_precede`, re-run the topological sort, and re-produce the roadmap tier list

#### Scenario: Correction loop cap promotes to open_questions

- **WHEN** the critique finds the same dep-order violation after 2 correction rounds
- **THEN** the finding SHALL be placed in `plan.json.open_questions[]` with the critique text
- **AND** the engine SHALL finalize the plan rather than looping indefinitely

#### Scenario: Non-blocking critique findings are advisory

- **WHEN** the critique emits a finding below the `block_threshold` in `review_policy`
- **THEN** the finding SHALL appear in `plan.json.critique[]` as advisory
- **AND** it SHALL NOT trigger a correction round or block plan finalization

---

### Requirement: `plan.json` SHALL be the machine source of truth for all downstream derivations

`plan.json` under `.agent-pipeline/roadmap/<repo>/` SHALL be the authoritative output of the engine. It SHALL contain: `dependency_graph` (with sub-keys `must_precede[]`, `should_precede[]`, `parallel_safe[]`, `blocked_pending_decision[]`, `duplicate_merge[]`, `conflict_pairs[]`, `cycle_reports[]`, `open_questions[]`), `scored[]`, `roadmap[]`, `hygiene[]`, `milestones[]`, `new_issue_drafts[]`, `critique[]`, and `open_questions[]`. "Next N to pipeline" lists, Pipeline Desk graph renderings, and re-runs SHALL be derived from `plan.json` without re-invoking the LLM engine. `plan.json` SHALL include `generated_at` (ISO timestamp) and `backlog_sha` (hash of open issue numbers + updated_at timestamps at inventory time) for staleness detection.

#### Scenario: `plan.json` contains all required top-level keys

- **WHEN** `pipeline roadmap` completes successfully
- **THEN** `plan.json` SHALL contain all of: `dependency_graph`, `scored`, `roadmap`, `hygiene`, `milestones`, `new_issue_drafts`, `critique`, `open_questions`, `generated_at`, `backlog_sha`

#### Scenario: `--next` reads plan.json without re-running the engine

- **WHEN** `pipeline roadmap --next 3` is run and a valid `plan.json` exists
- **THEN** the top-3 issues are read from `plan.json.roadmap[]` in dependency-safe order
- **AND** no harness call is made

---

### Requirement: `roadmap.md` SHALL be a human living-doc with stable IDs

`roadmap.md` under `.agent-pipeline/roadmap/<repo>/` SHALL contain: a tier-organized issue list with stable per-issue IDs (e.g. `RM-<number>`), score summary per item, dep rationale, effort, risks, and a DONE-tracker section listing items that have been pipeline-completed since the last run. When `config.roadmap.pr_docs` is true (default), `roadmap.md` SHALL also be committed to `docs/roadmaps/<repo>.md` on a new branch with a PR opened targeting the default branch.

#### Scenario: Stable IDs survive re-runs

- **WHEN** the engine is re-run and a previously-ranked issue changes tier
- **THEN** its `RM-<number>` ID SHALL remain the same (keyed by issue number, not rank)

#### Scenario: roadmap.md PR is opened when pr_docs is true

- **WHEN** `pipeline roadmap --apply` completes and `config.roadmap.pr_docs` is true
- **THEN** a PR targeting the default branch SHALL be opened with `docs/roadmaps/<repo>.md` added or updated
- **AND** no direct commit to the default branch SHALL occur

#### Scenario: PR is skipped when pr_docs is false

- **WHEN** `pipeline roadmap --apply` completes and `config.roadmap.pr_docs` is false
- **THEN** no PR is opened and `roadmap.md` exists only under `.agent-pipeline/roadmap/<repo>/`

---

### Requirement: All GitHub write-back SHALL be idempotent across re-runs

Re-running `pipeline roadmap --apply` on the same backlog SHALL NOT create duplicate labels, milestones, comments, or issues. Each write-back action SHALL perform a pre-flight state check before executing. Label creation SHALL be create-only (an already-existing label with the same name is treated as success regardless of color). Milestone creation SHALL check `getMilestones` first and reuse an existing milestone with the same title. Issue creation (new-issue drafts) SHALL be skipped if an issue with the same title already exists and is open.

#### Scenario: Duplicate label creation is a no-op

- **WHEN** `pipeline roadmap --apply` runs twice and both runs attempt to create the same label
- **THEN** the second attempt SHALL NOT produce an error and SHALL NOT modify the label's existing color or description

#### Scenario: Duplicate milestone creation is a no-op

- **WHEN** a milestone with the same title already exists
- **THEN** `createMilestone` SHALL return the existing milestone ID rather than creating a second one

---

### Requirement: The `roadmap:` config block SHALL be accepted in `.github/pipeline.yml`

`PartialConfigSchema` in `config.ts` SHALL accept a `roadmap:` sub-key with fields: `include_labels` (string[], optional), `exclude_labels` (string[], optional), `score_weights` (object with optional numeric overrides for `impact`, `confidence`, `ease`, `risk_reduction`, `dep_leverage`), `hygiene_auto_apply` (boolean, default false), `pr_docs` (boolean, default true). Unknown keys under `roadmap:` SHALL trigger a strict-schema parse error.

#### Scenario: Valid roadmap config is accepted

- **WHEN** `.github/pipeline.yml` contains `roadmap: { pr_docs: false, score_weights: { impact: 2 } }`
- **THEN** config parsing SHALL succeed and `config.roadmap.pr_docs` SHALL be false

#### Scenario: Unknown roadmap config key is rejected

- **WHEN** `.github/pipeline.yml` contains `roadmap: { unknown_key: true }`
- **THEN** config parsing SHALL throw a strict-schema parse error identifying `unknown_key` as unrecognized

---

### Requirement: All roadmap engine logic SHALL be behind injectable `Deps` seams

Every sub-module (`inventory.ts`, `depgraph.ts`, `score.ts`, `writeback.ts`, `roadmap/index.ts`) SHALL accept a `Deps` parameter interface for all external I/O (harness calls, `gh` wrappers, file reads/writes, git operations). Unit tests SHALL supply fakes; production code SHALL supply real implementations. No unit test SHALL make a real network, git, or subprocess call.

#### Scenario: Unit test uses fake deps

- **WHEN** `buildDepgraph` is called in a unit test with a fake `DepgraphDeps` that returns a pre-defined file content
- **THEN** no real file system read or subprocess call SHALL occur
- **AND** the test output SHALL be deterministic from the fake inputs
