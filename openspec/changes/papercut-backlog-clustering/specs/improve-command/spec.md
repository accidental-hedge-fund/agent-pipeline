## MODIFIED Requirements

### Requirement: improve command clusters recurring patterns by category

The analyzer SHALL group run evidence into five named categories: `review-finding` (same normalized
finding title across runs), `blocker` (same normalized blocker reason across runs), `flaky-gate`
(same stage name with repeated `outcome: "error"` events), `token-waste` (stages with anomalously
high duration or token cost when data is available), and `papercut` (same normalized `message` across
`papercut` events recorded by agents during runs). Each cluster SHALL record: category, normalized
signal string, occurrence count, affected run IDs, and at least one evidence excerpt (truncated to
≤ 200 characters).

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

#### Scenario: Papercut clusters appear in the dry-run report and JSON output

- **WHEN** `pipeline improve` is run over run directories containing `papercut` events
- **THEN** the printed report SHALL include the `papercut` clusters alongside the other categories,
  each showing its normalized signal and occurrence count
- **AND** `pipeline improve --json` over the same data SHALL emit those clusters with
  `category: "papercut"`

#### Scenario: No papercut events yields no papercut clusters

- **WHEN** the analyzed runs contain no `papercut` events
- **THEN** the report SHALL contain no `papercut` cluster
- **AND** the command SHALL exit 0 with the other categories reported as before

---

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

## ADDED Requirements

### Requirement: Improve clusters SHALL be isolated by category and never merged across categories

The analyzer SHALL key every cluster by the pair (category, normalized signal), so that evidence from
different categories SHALL NEVER accumulate into the same cluster. In particular, an agent-reported
`papercut` cluster SHALL remain a distinct cluster from a telemetry-derived `flaky-gate` or
`token-waste` cluster even when both describe the same underlying problem, and the analyzer SHALL NOT
apply any cross-category similarity merging.

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

---

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
