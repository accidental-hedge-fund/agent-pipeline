## ADDED Requirements

### Requirement: pipeline improve command is a read-only batch analyzer by default
The `pipeline improve` subcommand SHALL read existing run artifacts under `.agent-pipeline/runs/` and produce a dry-run report of clustered recurring failure patterns. In dry-run mode (no flags), the command SHALL NOT create issues, modify labels, push commits, touch worktrees, or write any file. The command SHALL exit 0 after printing the report.

#### Scenario: dry-run produces report without side effects
- **WHEN** `pipeline improve` is invoked without `--apply`
- **THEN** the command SHALL print a cluster report to stdout
- **AND** SHALL NOT create any GitHub issues
- **AND** SHALL NOT modify any pipeline labels, branches, PRs, worktrees, or repo files
- **AND** SHALL exit 0

#### Scenario: no run artifacts present
- **WHEN** `.agent-pipeline/runs/` is absent or empty
- **THEN** the command SHALL print a message indicating no run data was found
- **AND** SHALL exit 0 without error

### Requirement: improve command clusters recurring patterns by category
The analyzer SHALL group run evidence into four named categories: `review-finding` (same normalized finding title across runs), `blocker` (same normalized blocker reason across runs), `flaky-gate` (same stage name with repeated `outcome: "error"` events), and `token-waste` (stages with anomalously high duration or token cost when data is available). Each cluster SHALL record: category, normalized signal string, occurrence count, affected run IDs, and at least one evidence excerpt (truncated to ≤ 200 characters).

#### Scenario: review finding recurring across runs is clustered
- **WHEN** `review_verdict` events across multiple runs contain findings with the same normalized title
- **THEN** those findings SHALL be grouped into a single `review-finding` cluster
- **AND** the cluster SHALL list all affected run IDs and an evidence excerpt from the finding body

#### Scenario: blocker recurring across runs is clustered
- **WHEN** `blocker_set` events across multiple runs contain the same normalized reason string
- **THEN** those events SHALL be grouped into a single `blocker` cluster
- **AND** the cluster SHALL list all affected run IDs

#### Scenario: repeated stage error is clustered as flaky-gate
- **WHEN** `stage_complete` events across multiple runs show the same stage name with `outcome: "error"`
- **THEN** those events SHALL be grouped into a single `flaky-gate` cluster
- **AND** the cluster SHALL record the stage name and affected run IDs

#### Scenario: token-waste category skipped when data absent
- **WHEN** run summaries do not contain token-count or duration fields
- **THEN** the `token-waste` category SHALL be silently omitted from the report
- **AND** the report SHALL note that token-waste analysis was skipped due to absent data

### Requirement: improve command normalizes signals before clustering
Before grouping, the analyzer SHALL normalize finding titles and blocker reason strings by: converting to lowercase, removing issue/PR/SHA/line-number tokens (patterns matching `#\d+`, `[0-9a-f]{7,40}`, `:\d+`), and collapsing whitespace. Two records whose normalized strings are equal SHALL be treated as the same cluster.

#### Scenario: findings differing only by line number are merged
- **WHEN** two `review_verdict` findings have titles "Null check missing at line 42" and "Null check missing at line 107"
- **THEN** both SHALL normalize to the same string
- **AND** SHALL be counted as one cluster with occurrence count 2

#### Scenario: findings with different normalized titles are not merged
- **WHEN** two findings have titles that differ after normalization
- **THEN** they SHALL be treated as distinct clusters

### Requirement: improve command supports --since date windowing
The `pipeline improve --since <ISO-date>` flag SHALL restrict analysis to run directories whose `run.json` `started_at` value is on or after the given date. Runs without a readable `run.json` SHALL still be included (the flag cannot exclude data-less runs).

#### Scenario: runs before --since cutoff are excluded
- **WHEN** `pipeline improve --since 2026-06-01` is invoked
- **THEN** run directories with `run.json` `started_at` before 2026-06-01 SHALL NOT contribute events to any cluster

#### Scenario: run without run.json is not excluded by --since
- **WHEN** a run directory has no readable `run.json`
- **THEN** that run's `events.jsonl` SHALL still be read regardless of `--since`

### Requirement: improve command --apply flag creates GitHub issues for top clusters
When invoked with `--apply`, the analyzer SHALL create GitHub issues for the top-N clusters (default N=5, overridable with `--top <N>`) whose occurrence count meets or exceeds `--min-occurrences` (default 3). Each created issue SHALL include: the cluster category, normalized signal string, occurrence count, all affected run IDs, and at least one evidence excerpt. The command SHALL NOT create issues in dry-run mode and SHALL require explicit `--apply` to write anything.

#### Scenario: --apply creates issues for qualifying clusters
- **WHEN** `pipeline improve --apply` is invoked and clusters exist with occurrence count ≥ 3
- **THEN** the command SHALL call `gh issue create` for each qualifying cluster up to the top-N limit
- **AND** each issue body SHALL include affected run IDs and an evidence excerpt
- **AND** the command SHALL print the URL of each created issue

#### Scenario: --apply respects --min-occurrences threshold
- **WHEN** `pipeline improve --apply --min-occurrences 5` is invoked
- **THEN** clusters with fewer than 5 occurrences SHALL NOT result in issue creation

#### Scenario: --apply without gh authentication exits with error
- **WHEN** `pipeline improve --apply` is invoked and `gh` is not authenticated
- **THEN** the command SHALL exit with a non-zero code and a descriptive error message
- **AND** SHALL NOT partially create issues

### Requirement: improve command --apply never mutates pipeline state
Regardless of flags, the `pipeline improve` command SHALL NOT modify pipeline labels, branches, PRs, worktrees, or repo files. The only permitted write operation is `gh issue create` when `--apply` is set.

#### Scenario: --apply does not add labels or modify existing issues
- **WHEN** `pipeline improve --apply` is invoked
- **THEN** no existing GitHub issue, label, branch, PR, or file SHALL be modified
- **AND** no pipeline label SHALL be applied to any issue or PR

### Requirement: improve command supports --json output for machine consumers
When invoked with `--json`, the analyzer SHALL emit a JSON array of cluster objects to stdout instead of the human-readable Markdown report. Each cluster object SHALL contain: `category`, `signal` (normalized string), `count` (occurrence count), `runIds` (array of run ID strings), and `excerpt` (string, ≤ 200 characters).

#### Scenario: --json output is a valid JSON array
- **WHEN** `pipeline improve --json` is invoked
- **THEN** stdout SHALL be a valid JSON array
- **AND** each element SHALL contain `category`, `signal`, `count`, `runIds`, and `excerpt` fields

#### Scenario: --json and --apply can be combined
- **WHEN** `pipeline improve --apply --json` is invoked
- **THEN** the command SHALL emit the JSON cluster array AND create issues for qualifying clusters
- **AND** each JSON cluster object SHALL include the URL of any created issue in an `issueUrl` field (or `null` if not created)

### Requirement: improve command streams events.jsonl without loading all lines into memory
The analyzer SHALL read each `events.jsonl` line-by-line and accumulate only normalized keys and their occurrence counts in memory. The analyzer SHALL NOT buffer full event records from all runs simultaneously.

#### Scenario: large run corpus does not cause OOM
- **WHEN** `.agent-pipeline/runs/` contains hundreds of run directories
- **THEN** peak memory usage SHALL scale with the number of distinct cluster keys, not with the total number of events across all runs
