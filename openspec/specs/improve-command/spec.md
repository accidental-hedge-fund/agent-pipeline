# improve-command Specification

## Purpose
TBD - created by archiving change pipeline-improve-analyzer. Update Purpose after archive.
## Requirements
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

The analyzer SHALL group run evidence into six named categories: `review-finding` (same normalized
finding title across runs), `blocker` (same normalized blocker reason across runs), `flaky-gate`
(same stage name with repeated `outcome: "error"` events), `token-waste` (stages with anomalously
high duration or token cost when data is available), `papercut` (same normalized `message` across
`papercut` events recorded by agents during runs), and `correction` (recurring `correction_event`
records clustered by their deterministic `correction_key`). Each cluster SHALL record: category,
normalized signal string, occurrence count, affected run IDs, and at least one evidence excerpt
(truncated to ≤ 200 characters). The `correction` category SHALL key its clusters on the event
contract's `correction_key` rather than on `normalizeSignal`, and its per-cluster fields are
specified by the `correction-compiler` capability.

#### Scenario: Repeated review finding titles cluster together

- **WHEN** three runs each record a `review_verdict` finding whose title normalizes to the same string
- **THEN** those findings SHALL be grouped into a single `review-finding` cluster
- **AND** the cluster SHALL list all affected run IDs and an evidence excerpt from the finding body

#### Scenario: Repeated blocker reasons cluster together

- **WHEN** multiple runs record `blocker_set` events whose reason normalizes to the same string
- **THEN** those events SHALL be grouped into a single `blocker` cluster
- **AND** the cluster SHALL list all affected run IDs

#### Scenario: Repeated stage errors cluster as a flaky gate

- **WHEN** the same stage name records `stage_complete` with `outcome: "error"` across multiple runs
- **THEN** those events SHALL be grouped into a single `flaky-gate` cluster
- **AND** the cluster SHALL record the stage name and affected run IDs

#### Scenario: High-duration stages cluster as token waste

- **WHEN** run summaries report the same stage exceeding the high-duration threshold in multiple runs
- **THEN** those runs SHALL be grouped into a single `token-waste` cluster keyed by stage name
- **AND** the cluster SHALL list all affected run IDs

#### Scenario: Token-waste data absent

- **WHEN** no analyzed run summary contains token-count or duration data
- **THEN** the `token-waste` category SHALL be silently omitted from the report
- **AND** the report SHALL note that token-waste analysis was skipped due to absent data

#### Scenario: Repeated papercut messages cluster together

- **WHEN** `papercut` events across two or more runs carry messages that normalize to the same string
- **THEN** those events SHALL be grouped into a single `papercut` cluster
- **AND** the cluster SHALL record the normalized message as its signal, the occurrence count, every
  affected run ID, and an evidence excerpt drawn from the papercut message

#### Scenario: Repeated corrections cluster by correction_key

- **WHEN** `correction_event` records across two or more runs share the same `correction_key`
- **THEN** those records SHALL be grouped into a single `correction` cluster keyed on that
  `correction_key`
- **AND** the cluster's identity SHALL NOT depend on the free-text `correction` prose or any model
  output

#### Scenario: No correction events yields no correction clusters

- **WHEN** the analyzed runs contain no `correction_event` records
- **THEN** the report SHALL contain no `correction` cluster
- **AND** the command SHALL exit 0 with the other categories reported as before

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

When invoked with `--apply`, the analyzer SHALL create GitHub issues for the top-N clusters (default
N=5, overridable with `--top <N>`) whose occurrence count meets or exceeds `--min-occurrences`
(default 3). Each created issue SHALL include: the cluster category, normalized signal string,
occurrence count, all affected run IDs, and at least one evidence excerpt. The command SHALL NOT
create issues in dry-run mode and SHALL require explicit `--apply` to write anything. `papercut`
clusters SHALL be eligible for issue creation on the same terms as every other category.

#### Scenario: Apply creates issues for qualifying clusters

- **WHEN** `pipeline improve --apply` is run and three clusters meet the occurrence threshold
- **THEN** the command SHALL call `gh issue create` for each qualifying cluster up to the top-N limit
- **AND** each issue body SHALL include affected run IDs and an evidence excerpt
- **AND** the command SHALL print the URL of each created issue

#### Scenario: Clusters below the threshold are skipped

- **WHEN** `pipeline improve --apply --min-occurrences 5` is run
- **THEN** clusters with fewer than 5 occurrences SHALL NOT result in issue creation

#### Scenario: gh is not authenticated

- **WHEN** `pipeline improve --apply` is run and `gh auth status` fails
- **THEN** the command SHALL exit with a non-zero code and a descriptive error message
- **AND** SHALL NOT partially create issues

#### Scenario: Qualifying papercut cluster becomes an issue

- **WHEN** `pipeline improve --apply` is run and a `papercut` cluster meets `--min-occurrences`
- **THEN** the command SHALL create one GitHub issue for that cluster
- **AND** the issue body SHALL identify the category as `papercut`, and SHALL include the normalized
  signal, the occurrence count, every affected run ID, and a papercut evidence excerpt

#### Scenario: Singleton papercut cluster is reported but never filed

- **WHEN** a `papercut` cluster has exactly one occurrence and `pipeline improve --apply` is run at
  the default `--min-occurrences`
- **THEN** the cluster SHALL still appear in the printed report and in `--json` output
- **AND** no GitHub issue SHALL be created for it

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

### Requirement: Improve clusters SHALL be isolated by category and never merged across categories

The analyzer SHALL key every cluster by the pair (category, cluster key), so that evidence from
different categories SHALL NEVER accumulate into the same cluster. In particular, an agent-reported
`papercut` cluster SHALL remain a distinct cluster from a telemetry-derived `flaky-gate` or
`token-waste` cluster even when both describe the same underlying problem, a `correction` cluster
SHALL remain distinct from every other category even when its signal coincides with theirs, and the
analyzer SHALL NOT apply any cross-category similarity merging.

#### Scenario: Papercut and flaky-gate describing the same problem stay separate

- **WHEN** agents record `papercut` events about a slow, repeatedly-retried test gate and the same
  runs also record `stage_complete` errors for that stage
- **THEN** the report SHALL contain one `papercut` cluster and one `flaky-gate` cluster
- **AND** the two SHALL carry independent occurrence counts and SHALL NOT be combined into a single
  cluster

#### Scenario: Papercut and token-waste describing the same problem stay separate

- **WHEN** a `papercut` cluster and a `token-waste` cluster both concern the same slow stage
- **THEN** each SHALL be reported under its own category as its own cluster
- **AND** `--apply` SHALL treat them as two independent candidates for issue creation

#### Scenario: Identical normalized signals in different categories do not collide

- **WHEN** a `papercut` signal and a `blocker` signal normalize to the identical string
- **THEN** the analyzer SHALL emit two clusters, one per category
- **AND** neither cluster's occurrence count SHALL include the other category's events

#### Scenario: Correction and papercut describing the same problem stay separate

- **WHEN** a `correction` cluster and a `papercut` cluster concern the same underlying failure and
  their signals coincide
- **THEN** the report SHALL contain one `correction` cluster and one `papercut` cluster
- **AND** their occurrence counts SHALL be independent and SHALL NOT be combined

### Requirement: `improve --apply` SHALL NOT create a duplicate issue for a cluster that already has an open issue

Before creating an issue for a cluster, the analyzer SHALL look up the repository's open issues whose
title carries the `[pipeline-improve]` prefix, and SHALL skip issue creation for any cluster whose
proposed title already matches an open issue. The lookup SHALL be performed once per invocation, not
once per cluster. Skipped clusters SHALL still appear in the report and in `--json` output, annotated
as already tracked. Closed issues SHALL NOT suppress creation. This dedup SHALL apply to every
category, including `papercut`.

#### Scenario: Re-running apply files no duplicate

- **WHEN** `pipeline improve --apply` is run twice in succession over unchanged run data
- **THEN** the second invocation SHALL create no issue for any cluster that the first invocation filed
  and whose issue is still open

#### Scenario: Papercut cluster with an existing open issue is skipped

- **WHEN** a qualifying `papercut` cluster's proposed title matches an open `[pipeline-improve]` issue
- **THEN** no new issue SHALL be created for that cluster
- **AND** the cluster SHALL still be reported, annotated with the existing issue

#### Scenario: A closed issue does not suppress a new one

- **WHEN** the only `[pipeline-improve]` issue matching a qualifying cluster's title is closed
- **THEN** `--apply` SHALL create a new issue for that cluster

#### Scenario: Dedup lookup happens once per invocation

- **WHEN** `pipeline improve --apply` processes several qualifying clusters
- **THEN** the analyzer SHALL query the open `[pipeline-improve]` issue list exactly once and reuse
  the result for every cluster

