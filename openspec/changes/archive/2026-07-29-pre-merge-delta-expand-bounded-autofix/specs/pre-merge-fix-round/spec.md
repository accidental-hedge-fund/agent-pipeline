## MODIFIED Requirements

### Requirement: Pre-merge SHALL gate the auto-fix on a fixed finding-category allowlist

The pipeline SHALL attempt a bounded auto-fix of a blocking pre-merge delta review only when **every** blocking finding has a `category` in the allowlist `{ correctness, missing-dep, concurrency }` (case-insensitive, trimmed). If **any** blocking finding has a category outside the allowlist — including `security`, `scope`, `product-judgment-required`, `spec-divergence`, `data-loss`, `observability`, an unrecognized token, or an absent/empty category — the pipeline SHALL skip the auto-fix and escalate directly to `needs-human`. Eligibility additionally requires that at least one blocking finding exists and that an implementer harness is configured. When all blocking findings are allowlisted and no prior auto-fix commit is present for the entry, the pipeline SHALL attempt the auto-fix (it SHALL NOT first-hop to `needs-human` for an allowlisted-only set). The living allowlist rationale is the category matrix requirement below; expansions require an OpenSpec change and tests, not an undocumented string add.

#### Scenario: all blocking findings are correctness — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `correctness`, `missing-dep`, or `concurrency`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt (see the bounded-attempt
  requirement) rather than escalating to `needs-human`

#### Scenario: all blocking findings are concurrency — auto-fix eligible

- **WHEN** the pre-merge delta review returns `needs-attention` with one or more blocking findings
- **AND** every blocking finding's `category` is `concurrency`
- **AND** no auto-fix has been attempted for the current pre-merge entry
- **THEN** the pipeline SHALL perform exactly one bounded auto-fix attempt rather than escalating
  to `needs-human` on the first hop

#### Scenario: mixed allowlisted categories remain eligible

- **WHEN** the blocking findings include only categories from
  `{ correctness, missing-dep, concurrency }` (any non-empty combination)
- **AND** no prior auto-fix commit exists for the entry
- **THEN** the pipeline SHALL treat the set as auto-fixable and attempt one auto-fix

#### Scenario: a security finding is present — escalate without auto-fix

- **WHEN** the blocking findings include at least one finding with `category` `security`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately

#### Scenario: a product-judgment or scope finding is present — escalate without auto-fix

- **WHEN** the blocking findings include at least one finding with `category`
  `product-judgment-required` or `scope`
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL set `blocked`/`needs-human` immediately

#### Scenario: an absent or unrecognized category fails closed

- **WHEN** at least one blocking finding has an absent, empty, or unrecognized `category` (any value
  outside `{ correctness, missing-dep, concurrency }`)
- **THEN** the pipeline SHALL treat the entry as not auto-fixable
- **AND** SHALL set `blocked`/`needs-human` without invoking the auto-fix harness

### Requirement: The pre-merge auto-fix behavior SHALL be covered by regression tests

The test suite SHALL cover the pre-merge auto-fix path using the existing dependency-injection seams (no real harness, git, or network). The tests SHALL cover: a blocking all-`correctness` review that is auto-fixed and then advances; a blocking all-`concurrency` review that is auto-fixable (eligible → auto-fix path); a blocking `product-judgment-required` (or `security`) review that escalates without an auto-fix; the one-attempt bound after a prior auto-fix commit; the developer classification of the auto-fix commit; and — driving the fix-then-re-review path — that the second (post-fix) review invocation receives a diff **distinct** from the first review invocation and that the re-review is anchored to the post-fix head (recorded `reviewed-sha` equals the auto-fix commit SHA, not the pre-fix SHA). Each test SHALL fail (bite) if the corresponding behavior is removed.

#### Scenario: auto-fix regression tests bite

- **WHEN** the eligibility-and-attempt branch is removed so the delta-review block path
  escalates directly to `needs-human`
- **THEN** at least the all-`correctness`-advances test, the all-`concurrency`-eligible test, and
  the one-attempt-bound test SHALL fail

#### Scenario: concurrency allowlist expansion test bites

- **WHEN** `isAutoFixableFinding` / `allBlockingAutoFixable` are reverted so `concurrency` is
  treated as non-allowlisted
- **THEN** the unit test asserting `concurrency` is auto-fixable SHALL fail
- **AND** any gate-path test that expects a concurrency-only blocking set to attempt auto-fix
  SHALL fail

#### Scenario: escalation regression test bites

- **WHEN** the category allowlist is widened to treat `product-judgment-required` as auto-fixable
- **THEN** the escalation test for `product-judgment-required` SHALL fail

#### Scenario: post-fix re-review regression test bites

- **WHEN** the re-review's post-fix head is resolved from the stale GitHub-API PR-head read
  instead of the authoritative local post-fix head (regressing the fix)
- **THEN** the test asserting the second review invocation receives a different diff than the
  first — anchored to the post-fix head — SHALL fail

#### Scenario: final revalidation regression test bites

- **WHEN** the post-approval HEAD revalidation is reverted to block on any mismatch between
  the GitHub-API PR-head read and the auto-fix commit SHA, without tolerating the known
  pre-fix head as staleness
- **THEN** the test asserting a stale GitHub-API read of the pre-fix head does not veto an
  approving post-fix re-review SHALL fail

## ADDED Requirements

### Requirement: Pre-merge auto-fix category matrix SHALL document allowlist membership and rationale

The living `pre-merge-fix-round` capability SHALL document a category matrix that classifies each known finding category as allowlisted or excluded for the pre-merge auto-fix path, with a short rationale. The matrix SHALL include at least: allowlisted `correctness` (mechanical code defect), `missing-dep` (wiring/import omission), and `concurrency` (race/lock/ordering/probe defects fixable surgically without product judgment); and excluded `security` (auth/boundary judgment), `scope` (plan/product boundary), `product-judgment-required` (explicit non-mechanical), `spec-divergence` (separate bounded repair path), `data-loss` (irreversible impact risk), `observability` (often product taste when blocking), and any absent/empty/unrecognized token (fail-closed). The runtime allowlist SHALL match the matrix's allowlisted set. Expanding the allowlist SHALL require updating this matrix, the pure eligibility helpers, and regression tests in the same change.

#### Scenario: matrix matches runtime allowlist

- **WHEN** a reader inspects the living category matrix and the pure eligibility helper
- **THEN** a category marked allowlisted in the matrix SHALL pass `isAutoFixableFinding`
- **AND** a category marked excluded (or absent/unrecognized) SHALL fail `isAutoFixableFinding`

#### Scenario: security remains excluded after concurrency expansion

- **WHEN** the allowlist includes `concurrency`
- **THEN** `security`, `scope`, and `product-judgment-required` SHALL remain excluded
- **AND** a blocking set containing any excluded category SHALL escalate without auto-fix

### Requirement: Allowlisted pre-merge blocking findings SHALL not silent-first-hop to needs-human

The pipeline SHALL invoke the bounded auto-fix path when the pre-merge delta partition yields a non-empty blocking set, every blocking finding is allowlisted under the category matrix, an implementer harness is configured, and no prior auto-fix commit is recognized for the entry. A #668-class concurrency-only (or mixed allowlisted) blocking set SHALL receive one auto-fix attempt and one re-review; on success pre-merge proceeds, and on still-blocking re-review or fix failure the pipeline SHALL escalate to `needs-human` with exhausted-attempt or failure evidence — not a silent first-hop skip of the auto-fix for an allowlisted-only set.

#### Scenario: concurrency-only block attempts auto-fix once

- **WHEN** the delta review blocks only on `concurrency` findings
- **AND** no prior auto-fix commit exists
- **AND** an implementer harness is configured
- **THEN** the pipeline SHALL invoke the auto-fix harness once
- **AND** SHALL re-run the delta review once after a successful fix commit

#### Scenario: exhausted attempt surfaces clear evidence

- **WHEN** a prior pre-merge auto-fix commit is already present among developer commits since the
  reviewed SHA
- **AND** the current delta review still returns blocking findings (allowlisted or not)
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again
- **AND** the block path SHALL remain distinguishable from a first-hop non-allowlisted skip
  (prior auto-fix marker / exhausted attempt, not "category outside allowlist" alone)
