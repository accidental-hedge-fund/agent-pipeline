## MODIFIED Requirements

### Requirement: The engine SHALL build a source-verified dependency graph

For each candidate dependency edge between two issues, the engine SHALL read the relevant source file(s) and confirm the coupling before promoting the edge to `must_precede` or `should_precede` in `plan.json`. An edge SHALL NOT be promoted based solely on issue text. Candidate edges that cannot be source-verified SHALL be placed in `plan.json.dependency_graph.open_questions[]` with a rationale. Cycles in `must_precede` edges SHALL be detected and recorded in `plan.json.dependency_graph.cycle_reports[]`; the engine SHALL NOT silently break a cycle.

Before source-verification, all candidate edges SHALL be deduplicated and ranked in the following order: (1) textual candidates (issue body explicitly references a dependency by issue number), (2) shared-file candidates (both issues touch at least one common file), (3) cross-file candidates (only inferred from file-level import analysis). Within each group, candidates with more overlapping touched-files SHALL be ranked higher. Candidates ranked beyond `roadmap.depgraph_verify_cap` (default 20) SHALL be recorded in `plan.json.dependency_graph.open_questions[]` with rationale "candidate ranked beyond verify cap" and SHALL NOT be source-verified. Verification of the remaining candidates SHALL proceed with at most `roadmap.depgraph_concurrency` (default 4) concurrent harness calls.

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

#### Scenario: Candidates are ranked before verification

- **WHEN** the engine builds dependency candidates from textual, shared-file, and cross-file sources
- **THEN** textual candidates SHALL be ranked before shared-file candidates
- **AND** shared-file candidates SHALL be ranked before cross-file candidates
- **AND** verification calls SHALL process candidates in ranked order

#### Scenario: Verification cap triggers open_questions recording

- **WHEN** the total deduplicated candidate count exceeds `roadmap.depgraph_verify_cap`
- **THEN** candidates beyond the cap SHALL appear in `plan.json.dependency_graph.open_questions[]` with rationale "candidate ranked beyond verify cap"
- **AND** no verification harness call SHALL be made for those candidates

#### Scenario: Verification calls run with bounded concurrency

- **WHEN** multiple independent candidates require source-verification
- **THEN** at most `roadmap.depgraph_concurrency` (default 4) verification harness calls SHALL be in flight concurrently at any point

---

### Requirement: The engine SHALL build a source-verified inventory using deterministic extraction first

The inventory phase SHALL attempt to identify touched files for each issue using deterministic regex extraction (`extractCandidateFiles`) before calling the harness. When the regex extraction produces at least one file path, the harness call SHALL be skipped for that issue and the regex results SHALL be used as `touched_files`. When the regex extraction returns zero results, the harness SHALL be called as the fallback. When multiple issues require harness calls, those calls SHALL run with at most `roadmap.inventory_concurrency` (default 4) concurrent calls. The number of harness calls made and skipped SHALL be recorded in `plan.json.run_stats`.

#### Scenario: Regex extraction eliminates harness call for well-specified issues

- **WHEN** an issue body contains one or more backtick-wrapped file paths (e.g. `` `core/scripts/roadmap/index.ts` ``)
- **THEN** `buildInventory` SHALL NOT call `deps.runHarness` for that issue
- **AND** the file paths from the regex match SHALL appear in `inventory_item.touched_files`

#### Scenario: Harness is called for ambiguous issue bodies

- **WHEN** an issue body contains no detectable file path patterns
- **THEN** `buildInventory` SHALL call `deps.runHarness` for that issue as the fallback

#### Scenario: Concurrent harness calls are bounded

- **WHEN** multiple issues require harness calls in the inventory phase
- **THEN** at most `roadmap.inventory_concurrency` (default 4) calls SHALL be in-flight concurrently
- **AND** all results SHALL be collected before the inventory phase returns

#### Scenario: All 7 phases still execute in order

- **WHEN** `runRoadmap` is called with these optimizations active
- **THEN** phase 1 (comprehend) SHALL still complete before phase 2 (inventory) begins
- **AND** phase 7 (critique) SHALL still be the final phase, running after the roadmap tier list is produced
- **AND** no phase SHALL be skipped regardless of backlog size
