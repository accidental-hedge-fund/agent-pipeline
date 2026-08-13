## ADDED Requirements

### Requirement: Outcome ingest SHALL use a versioned source-adapter contract

The engine SHALL define a source-adapter contract for production-outcome ingestion. Each adapter SHALL expose a stable `id` string and SHALL produce normalized `production_outcome` records (schema from `production-outcome-records`) from external or local signals. The contract SHALL support:

- discovery or fetch of raw signals through injectable I/O deps
- normalization into zero or more outcome records with stable `outcome_id` values
- linkage population via `outcome-linkage` helpers
- non-fatal failure: a single bad signal SHALL NOT abort the entire ingest batch

Adapters SHALL NOT mutate GitHub labels, pipeline stage labels, worktrees, or merge state as a side effect of ingest. Ingest is append/upsert to the outcome store only.

#### Scenario: adapter id is stable and required

- **WHEN** a registered outcome source adapter is listed
- **THEN** it SHALL expose a non-empty stable `id`
- **AND** normalized records SHALL carry that id under `source.adapter_id` (or equivalent documented field)

#### Scenario: ingest does not mutate pipeline GitHub state

- **WHEN** outcome ingest runs against a repository fixture
- **THEN** no GitHub-mutating operation (label add/remove, comment create, merge) SHALL be invoked by the adapter path
- **AND** only the outcome store (and optional diagnostics logs) SHALL be written

#### Scenario: bad signal is non-fatal

- **WHEN** one raw signal in a batch fails normalization or validation
- **THEN** remaining signals SHALL still be processed
- **AND** the failed signal SHALL appear as a diagnostic with a stable reason code

---

### Requirement: outcome_id SHALL make ingest idempotent

The engine SHALL derive `outcome_id` as a pure function of adapter id and stable signal identity fields (for example adapter id + provider event id, or adapter id + PR number + kind + SHA). Re-ingesting the same signal SHALL upsert or dedupe to the same `outcome_id` so consumers do not double-count identical outcomes. Distinct signals SHALL produce distinct `outcome_id` values.

#### Scenario: re-ingest collapses to one record

- **WHEN** the same GitHub revert signal is ingested twice
- **THEN** both operations SHALL resolve to the same `outcome_id`
- **AND** the outcome store SHALL not retain two full duplicate facts for that signal under default dedupe rules

#### Scenario: distinct signals stay distinct

- **WHEN** two revert PRs target different original merge SHAs
- **THEN** their `outcome_id` values SHALL differ

---

### Requirement: A GitHub-native adapter SHALL demonstrate end-to-end ingest and linkage

The engine SHALL ship at least one built-in GitHub-native outcome source adapter that can, from fixture or injectable `gh` deps:

1. observe merge-related signals for pipeline-linked PRs (merged state / merge commit SHA when available)
2. observe reversion signals (revert PRs or revert commits referencing an original PR or SHA)
3. observe deployment-class signals when present in the fixture shape (GitHub Deployments or environment status); when absent, emit `not_observed` / `unknown` rather than success
4. normalize those signals into `production_outcome` records with `attribution` entries populated or explicitly unresolved

Unit tests SHALL exercise a fixture end-to-end: raw signal → normalized record → store → readable linkage fields, without live network.

#### Scenario: merge signal produces delivery observation without claiming deploy success

- **WHEN** the GitHub adapter ingests a merged PR fixture with a merge commit SHA and a resolvable `Pipeline-Run` trailer
- **THEN** it SHALL write a `delivery` (or update an existing delivery) with `merge_status: "merged"` and `merged_sha` set
- **AND** if no deployment signal is in the fixture, `deploy_status` SHALL be `not_observed` or `unknown`

#### Scenario: merge then deploy share one delivery outcome_id

- **WHEN** the GitHub adapter ingests a merge signal for candidate SHA S (or PR N when SHA is absent)
- **AND** later ingests a deployment signal for the same candidate SHA S (or same PR N)
- **THEN** both normalizations SHALL resolve to the same `outcome_id` (stable delivery identity; environment is not part of the id)
- **AND** upsert SHALL update the existing delivery record so merge and deploy fields coexist on one chain
- **AND** the store SHALL NOT retain two separate full `delivery` facts for that candidate under default dedupe rules

#### Scenario: revert signal produces reversion outcome

- **WHEN** the GitHub adapter ingests a revert PR fixture that references original PR N
- **THEN** it SHALL write an outcome with `outcome_kind: "reversion"`
- **AND** attribution SHALL include the original PR when resolvable
- **AND** run attribution SHALL be `observed` when trailers/run store resolve, else omitted/inferred per linkage rules

#### Scenario: missing deployment API data is not success

- **WHEN** the fixture has no deployment or environment status for the candidate
- **THEN** the adapter SHALL NOT set `deploy_status: "succeeded"`
- **AND** diagnostics MAY include `deployment_signal_absent`

#### Scenario: end-to-end fixture is offline

- **WHEN** the GitHub adapter unit tests run
- **THEN** they SHALL inject fake `gh`/fs deps or static fixtures
- **AND** SHALL NOT require network access to pass

---

### Requirement: Ingest CLI or library entrypoint SHALL be read-mostly and diagnosable

The engine SHALL expose an operator entrypoint (CLI subcommand such as `pipeline outcomes ingest` and/or a library function used by scoreboard refresh) that runs registered adapters, writes the outcome store, and prints or returns counts plus diagnostics. The entrypoint SHALL support a dry-run or JSON summary mode suitable for tests. Missing outcome store directory SHALL be created on first successful write or reported empty without crashing reads.

#### Scenario: empty store reads cleanly

- **WHEN** a consumer lists outcomes before any ingest
- **THEN** it SHALL return zero outcomes without throwing
- **AND** MAY emit a diagnostic that the store is empty

#### Scenario: ingest summary reports written and skipped counts

- **WHEN** ingest processes three signals, one invalid and two valid
- **THEN** the summary SHALL report two written (or upserted) outcomes and at least one diagnostic for the invalid signal
