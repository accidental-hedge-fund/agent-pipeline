## ADDED Requirements

### Requirement: Suite runs locally with fake deps and no real I/O
The benchmark and reliability suite SHALL exercise all covered scenarios using injectable fake deps (the same `deps`/`Deps` seam pattern used by existing unit tests). The suite SHALL NOT make real network calls, real git operations, or real subprocess spawns.

#### Scenario: Suite passes with no network access
- **WHEN** `npm test` is executed from `core/` with no outbound network access
- **THEN** all benchmark and reliability tests SHALL pass or skip, and none SHALL fail due to a network timeout or DNS error

#### Scenario: Fake gh dep is injected for all covered stages
- **WHEN** a benchmark or reliability test exercises a pipeline stage
- **THEN** the test SHALL supply a fake `gh` dep satisfying the stage's dep interface
- **AND** no real `gh` binary invocation SHALL occur

---

### Requirement: Benchmark scenarios emit structured BenchmarkResult objects
Each benchmark scenario SHALL produce a `BenchmarkResult` containing at minimum: `scenario` (string), `p50_ms` (number ≥ 0), `p95_ms` (number ≥ 0), `gh_call_count` (integer ≥ 0), and `stage_duration_ms` (number ≥ 0). The test SHALL assert all fields are present and satisfy their type constraints.

#### Scenario: Status latency result has all required fields
- **WHEN** the status-latency benchmark runs with any worktree count
- **THEN** the returned `BenchmarkResult` SHALL have `p50_ms >= 0`, `p95_ms >= 0`, `gh_call_count >= 0`, and `stage_duration_ms >= 0`

#### Scenario: Stage-loop result carries gh call count
- **WHEN** the stage-loop gh call count benchmark runs
- **THEN** `BenchmarkResult.gh_call_count` SHALL equal the number of times the fake `gh` dep was invoked during the scenario

---

### Requirement: Status latency benchmark covers worktree-count scaling
The suite SHALL include status-latency benchmark scenarios for 1, 10, and 50 synthetic worktrees. Each scenario SHALL run the status lookup path through its injected deps and record a `BenchmarkResult`.

#### Scenario: 1-worktree status benchmark
- **WHEN** the status benchmark runs with a 1-element fake worktree list
- **THEN** a `BenchmarkResult` with `scenario: "status-latency-1"` SHALL be produced and the test SHALL pass

#### Scenario: 10-worktree status benchmark
- **WHEN** the status benchmark runs with a 10-element fake worktree list
- **THEN** a `BenchmarkResult` with `scenario: "status-latency-10"` SHALL be produced and the test SHALL pass

#### Scenario: 50-worktree status benchmark
- **WHEN** the status benchmark runs with a 50-element fake worktree list
- **THEN** a `BenchmarkResult` with `scenario: "status-latency-50"` SHALL be produced and the test SHALL pass

#### Scenario: gh call count does not grow super-linearly with worktree count
- **WHEN** comparing `gh_call_count` at 1 vs 50 worktrees
- **THEN** `gh_call_count(50) SHALL be less than gh_call_count(1) * 100`

---

### Requirement: Stage-loop gh call count is asserted within a documented budget
The suite SHALL run one full review-stage iteration with a fake `AdvanceReviewDeps`-shaped dep set and assert that the `gh` call count per iteration does not exceed a documented budget. The budget SHALL be recorded as a constant in the test with a comment stating it is observational (not a hard CI gate on absolute timing).

#### Scenario: Review stage gh calls within budget
- **WHEN** one review-stage iteration runs with a minimal fake context
- **THEN** the `gh_call_count` SHALL be ≤ the budget constant defined in the test
- **AND** the actual count SHALL be emitted as `BenchmarkResult.gh_call_count` for observability

---

### Requirement: Pre-merge polling call count is exact
The suite SHALL run the pre-merge CI-polling path with a fake that returns "pending" for K iterations then "success" and assert that `gh_call_count` equals exactly K + 1.

#### Scenario: Polling loop call count is K + 1
- **WHEN** the fake CI-status dep returns "pending" K times then "success"
- **THEN** `BenchmarkResult.gh_call_count` SHALL equal K + 1
- **AND** the stage SHALL exit cleanly without throwing

---

### Requirement: Harness timeout triggers blocked outcome
The suite SHALL include a reliability test asserting that when the harness fake returns `timed_out: true`, the stage transitions to `blocked` rather than advancing or throwing uncaught.

#### Scenario: Stage blocks on harness timeout
- **WHEN** the fake harness `invoke` dep returns `{ timed_out: true, stdout: "", stderr: "", exit_code: null }`
- **THEN** the stage outcome SHALL be `blocked`
- **AND** no uncaught exception SHALL propagate from the stage

---

### Requirement: Partial GitHub transition failure surfaces blocked outcome
The suite SHALL include a reliability test asserting that when `gh label add` throws during a stage transition (while comment creation succeeds), the stage outcome is `blocked` with a `blocked_reason` referencing the label failure, rather than silently advancing.

#### Scenario: Label-add failure causes blocked outcome
- **WHEN** the fake `gh` dep throws on `label add` but succeeds for all other calls
- **THEN** the stage outcome SHALL be `blocked`
- **AND** `blocked_reason` SHALL contain the string "label"
- **AND** the stage SHALL NOT advance to the next pipeline label

---

### Requirement: Artifact corruption surfaces a clear error state
The suite SHALL include reliability tests for two artifact-corruption modes: missing `summary.json` (fake returns `null`) and malformed `summary.json` (fake returns non-JSON string). In both cases the stage SHALL surface a clear, catchable error state rather than throwing uncaught or silently no-op-ing.

#### Scenario: Missing summary.json yields clear error state
- **WHEN** the artifact reader fake returns `null` for `summary.json`
- **THEN** the stage SHALL surface an explicit error state (not an uncaught exception propagated to the test runner)
- **AND** the pipeline state SHALL NOT advance

#### Scenario: Malformed summary.json yields clear error state
- **WHEN** the artifact reader fake returns a non-JSON string for `summary.json`
- **THEN** the stage SHALL surface an explicit error state (not an uncaught exception propagated to the test runner)
- **AND** the pipeline state SHALL NOT advance
