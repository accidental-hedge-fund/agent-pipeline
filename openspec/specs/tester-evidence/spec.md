# tester-evidence Specification

## Purpose
TBD - created by archiving change sha-pinned-tester-evidence. Update Purpose after archive.

## Requirements

### Requirement: Versioned Tester evidence schema SHALL pin suite results to a candidate SHA

The pipeline SHALL represent authoritative suite execution as a versioned
`TesterEvidence` record with `schema_version` (integer, starting at `1`) and
`kind: "tester_evidence"`. The record SHALL include at minimum:

- `candidate_sha` — full 40-character commit SHA of the worktree HEAD at
  production time
- run and issue identity (`run_id`, `issue`, and `pr` when known)
- `config_digest` — digest of the effective test/format gate configuration and
  resolved command identity used for the run
- worktree identity suitable for audit without requiring a full host path dump
- a bounded, privacy-safe `toolchain_fingerprint` (allowlisted keys such as
  runtime/OS version strings only — not a full environment dump)
- `started_at`, `ended_at`, and `duration_ms`
- `overall_status` and, when not a clean pass, an explicit `overall_reason`
- `commands` — normalized per-command results (identity, exit code or null,
  duration, status, bounded redacted `output_excerpt`)
- optional `tests` — normalized per-test results only when a supported
  extractor produces them
- `output_excerpt` — bounded, secret-redacted combined summary excerpt
- `producer` identifying the deterministic component that created the record

Identity field names SHALL remain forward-compatible with the planned shared
`evidence_subject` contract (#692): the implementation SHALL NOT introduce a
Tester-only identity vocabulary that renames or conflicts with candidate SHA,
run id, issue/PR, config digest, or engine fingerprint concepts. An optional
nested `evidence_subject` object MAY be absent in v1; readers SHALL ignore
unknown fields.

#### Scenario: passed run produces a complete schema_version 1 record

- **WHEN** the deterministic tester producer completes a trusted suite run that
  exits 0 on the required command set for candidate SHA `S`
- **THEN** the resulting `TesterEvidence` SHALL have `schema_version: 1`
- **AND** `candidate_sha` SHALL equal the full 40-character value of `S`
- **AND** `overall_status` SHALL be `"passed"`
- **AND** `commands` SHALL contain one row per required command with
  `status: "passed"`
- **AND** `run_id` and `issue` SHALL be set from the active pipeline run

#### Scenario: identity fields do not invent a competing subject vocabulary

- **WHEN** a `TesterEvidence` record is serialized
- **THEN** candidate and run identity SHALL be carried under the standard
  fields (`candidate_sha`, `run_id`, `issue`, `pr`, `config_digest`)
- **AND** the record SHALL NOT require a Tester-only subject id that would
  conflict with a later shared `evidence_subject` shape

---

### Requirement: overall_status taxonomy SHALL distinguish outcome classes

`overall_status` SHALL be one of: `passed`, `failed`, `timeout`,
`tooling_failure`, `partial`, `disabled`, `not_run`, `unavailable`, `stale`.
These classes SHALL remain distinguishable in persisted artifacts and review
acquisition results. A timeout SHALL NOT be recorded only as `failed` when the
runner classified a timeout. A disabled gate SHALL NOT be recorded as `passed`.
An absent trustworthy result SHALL use `unavailable` or `not_run` with reason,
never an implied pass.

#### Scenario: timeout is classified as timeout

- **WHEN** a required command is killed for exceeding the configured gate
  timeout
- **THEN** the command row status SHALL be `"timeout"`
- **AND** `overall_status` SHALL be `"timeout"` (or `"partial"` when other
  commands completed under a multi-command producer — with the timed-out
  command still marked `"timeout"`)

#### Scenario: disabled gate is not a pass

- **WHEN** `test_gate.enabled` is false and the producer emits evidence
- **THEN** `overall_status` SHALL be `"disabled"`
- **AND** the record SHALL NOT claim `"passed"`

#### Scenario: no command detected is not_run or disabled path, not passed

- **WHEN** the gate is enabled but no test/build command is configured or
  detected and the gate skips without running
- **THEN** `overall_status` SHALL be `"not_run"` or an equivalent explicit
  non-pass classification with reason
- **AND** SHALL NOT be `"passed"`

#### Scenario: runner/spawn failure is tooling_failure when classifiable

- **WHEN** the deterministic runner fails to spawn or complete for tooling
  reasons distinct from a product test assertion failure
- **THEN** `overall_status` or the affected command status SHALL be
  `"tooling_failure"` when the engine can classify it
- **AND** the reason SHALL be retained in bounded redacted form

#### Scenario: multi-command partial completion remains distinguishable

- **WHEN** a multi-command producer completes some required commands and does
  not complete others
- **THEN** `commands` SHALL retain per-command statuses
- **AND** `overall_status` SHALL be `"partial"` or another non-pass status that
  does not imply full suite success

---

### Requirement: Deterministic producer SHALL create Tester evidence without trusting the writer model

`TesterEvidence` SHALL be produced only by deterministic engine runner code on
the existing test/build (and related deterministic gate) path. The pipeline
SHALL NOT accept writer-authored claims, harness prose, or model-written
“tests passed” statements as the authoritative suite outcome. When the run
store / state directory is available, a production path that executed or
explicitly skipped the gate SHALL emit or update the artifact for the current
candidate HEAD.

#### Scenario: successful gate run writes engine-produced evidence

- **WHEN** `runTestGate` (or the combined deterministic producer) finishes a
  trusted run for issue N with `stateDir` / run directory available
- **THEN** a `TesterEvidence` record SHALL be written for the worktree HEAD SHA
- **AND** the producer identity SHALL name the engine component, not a model
  harness role

#### Scenario: writer prose cannot supply the authoritative record

- **WHEN** an implementer or fix harness output claims that tests passed
- **THEN** the pipeline SHALL NOT treat that claim as `TesterEvidence`
- **AND** authoritative status SHALL come only from the deterministic producer

---

### Requirement: SHA match and staleness checks SHALL reject reuse across candidates

Acquisition SHALL compare `artifact.candidate_sha` to the candidate HEAD SHA
under review before treating Tester evidence as current. On mismatch, the
evidence SHALL be classified `stale` (or acquisition SHALL return an explicit
stale/unavailable result). Stale evidence SHALL NEVER be presented as a suite
pass for the new candidate. After any candidate-changing commit (review fix,
test-fix, salvage, or other product HEAD movement), prior evidence for the old
SHA SHALL be considered invalid for the new HEAD until the deterministic
producer regenerates evidence for the new SHA.

Pipeline-internal commits that do not change the product candidate, as
classified by the same internal-commit rules used by review-SHA gating, SHALL
NOT alone force a false “suite pass” reuse story: acquisition SHALL still
require SHA match or an explicit internal-commit policy consistent with
`review-sha-gating`, and SHALL NOT treat a mismatched product SHA as current.

#### Scenario: matching SHA is current

- **WHEN** review acquisition loads Tester evidence whose `candidate_sha`
  equals the full HEAD SHA under review
- **AND** the record is well-formed
- **THEN** acquisition SHALL treat the evidence as current for that candidate

#### Scenario: mismatched SHA is stale and not a pass

- **WHEN** review acquisition loads Tester evidence for SHA `A`
- **AND** the candidate under review is SHA `B` where `A ≠ B`
- **THEN** acquisition SHALL classify the evidence as stale (or refuse it as
  non-current)
- **AND** SHALL NOT report overall suite status as `"passed"` for SHA `B` from
  that artifact

#### Scenario: fix commit requires regeneration before current evidence

- **WHEN** a fix stage lands a candidate-changing commit moving HEAD from `A`
  to `B`
- **AND** only Tester evidence for `A` exists
- **THEN** review for `B` SHALL NOT treat the `A` artifact as current
- **AND** the deterministic producer SHALL regenerate evidence for `B` before
  suite evidence is considered current for `B`

#### Scenario: mid-pipeline re-entry regenerates before fail_closed park

- **WHEN** a new advance run directory is created after implementing (for
  example at design-gate or review-1 re-entry) with no `tester-evidence.json`
  for the current candidate HEAD
- **AND** `on_missing` is `fail_closed`
- **THEN** the code-review path SHALL attempt one deterministic producer run
  for the current HEAD before treating the absence as a terminal withhold
- **AND** acquisition after that attempt SHALL remain load-only (no invented
  pass): only a successfully written SHA-matched artifact yields current
  evidence

---

### Requirement: Missing or malformed evidence disposition SHALL be deterministic and never imply pass

Configuration SHALL define a deterministic disposition when trustworthy
SHA-matched Tester evidence is missing or malformed at review acquisition
(e.g. `on_missing: fail_closed | fail_open`). Under both dispositions the
pipeline SHALL present an explicit unavailable/malformed classification and
SHALL NOT imply that tests passed. Fail-closed MAY hard-block or withhold
suite-backed approval semantics; fail-open MAY allow the review to proceed
with the unavailable classification visible in the prompt and artifacts.

#### Scenario: fail_closed missing evidence does not imply pass

- **WHEN** `on_missing` is `fail_closed`
- **AND** no trustworthy SHA-matched Tester evidence exists at review
  acquisition
- **THEN** acquisition SHALL yield an explicit missing/unavailable result
- **AND** the review path SHALL NOT claim or summarize suite status as passed

#### Scenario: fail_open missing evidence still does not imply pass

- **WHEN** `on_missing` is `fail_open`
- **AND** no trustworthy SHA-matched Tester evidence exists at review
  acquisition
- **THEN** the review prompt SHALL include an explicit unavailable
  classification
- **AND** SHALL NOT claim that tests passed

#### Scenario: malformed artifact is not treated as passed

- **WHEN** the stored Tester evidence payload is present but fails schema
  validation or required field checks
- **THEN** acquisition SHALL treat it as malformed/unavailable
- **AND** SHALL NOT use any partial pass flag as authoritative suite success

---

### Requirement: Optional per-test extraction SHALL NOT corrupt command-level authority

The producer SHALL populate optional `tests` rows only when a supported
repository-provided or engine-allowlisted extractor exists and parses
successfully. When no extractor exists, `tests` SHALL be omitted or empty.
When extractor output is malformed, the producer SHALL preserve command-level
results as the authority, SHALL NOT invent per-test rows from garbage input,
and SHALL NOT flip a command-level pass into overall failure solely because
optional extraction failed.

#### Scenario: no extractor yields command-only evidence

- **WHEN** a suite command exits 0 and no extractor is configured
- **THEN** `overall_status` SHALL be `"passed"` when other trust rules are met
- **AND** `tests` SHALL be omitted or an empty array

#### Scenario: malformed extractor output preserves command results

- **WHEN** a suite command exits 0
- **AND** the configured extractor returns malformed output
- **THEN** command rows SHALL still reflect the exit status
- **AND** the producer SHALL NOT write fabricated per-test pass rows from the
  malformed payload

---

### Requirement: Bounded secret-redacted output SHALL apply to all persisted Tester strings

The pipeline SHALL pass all string fields on `TesterEvidence`, including
command and test excerpts and reasons, through the existing secret-redaction
and injection-denylist process before persistence or prompt injection. Output
excerpts SHALL be truncated to a configured maximum character budget. The
pipeline SHALL NOT persist a full environment dump, unbounded test log, or raw
secret values in the Tester artifact, evidence bundle, or public comments.

#### Scenario: long output is truncated

- **WHEN** command output exceeds the configured maximum excerpt length
- **THEN** `output_excerpt` (and per-command excerpts) SHALL be truncated to
  that budget
- **AND** truncation SHALL be marked rather than silently implying completeness

#### Scenario: secrets are redacted

- **WHEN** command output contains a token or secret matching redaction rules
- **THEN** persisted and injected Tester evidence strings SHALL contain the
  redacted placeholder instead of the raw secret

#### Scenario: no full environment dump

- **WHEN** the toolchain fingerprint is recorded
- **THEN** it SHALL include only allowlisted fingerprint fields
- **AND** SHALL NOT serialize the full process environment

---

### Requirement: Supplemental targeted-check records SHALL NOT replace authoritative Tester evidence

The pipeline SHALL allow reviewers to run a targeted check to answer a specific
question and MAY record such a result as a supplemental record (distinct kind
from `tester_evidence`). Supplemental records SHALL NOT mutate, overwrite, or
replace the authoritative `TesterEvidence` `overall_status` or command rows.
Review prompts SHALL label suite evidence as authoritative and targeted checks
as supplemental.

#### Scenario: targeted check cannot flip suite failure to pass

- **WHEN** authoritative Tester evidence has `overall_status: "failed"` for
  candidate SHA `S`
- **AND** a reviewer runs a targeted check that exits 0
- **THEN** the authoritative artifact for `S` SHALL remain `"failed"`
- **AND** the targeted check SHALL be stored or presented only as supplemental

#### Scenario: prompt distinguishes authority levels

- **WHEN** a review prompt includes Tester evidence and any supplemental
  targeted-check material
- **THEN** the prompt SHALL clearly label the engine suite record as
  authoritative
- **AND** SHALL label reviewer targeted checks as supplemental

---

### Requirement: Human summary SHALL not replace the full structured Tester record

The pipeline SHALL, when posting a human-readable comment about Tester results,
summarize status, short SHA, command count, and duration (or equivalent compact
fields) without embedding the full unbounded log. The full structured
`TesterEvidence` record SHALL remain in the run evidence surfaces (run
directory / evidence bundle / events as specified by `evidence-bundle`).

#### Scenario: comment is summary-only

- **WHEN** the pipeline posts a human-visible Tester summary for a run
- **THEN** the comment body SHALL NOT include the full unbounded test log
- **AND** the full structured record SHALL still be available under the run
  evidence path

---

### Requirement: Scoreboard-readable Tester metrics SHALL be structured

The pipeline SHALL make Tester duration, command count, overall status class,
per-command pass/fail/timeout/tooling tallies, and supplemental targeted-check
counts available from structured artifact or event fields so scoreboard and
accounting consumers can report them without parsing human prose.

#### Scenario: metrics without prose parsing

- **WHEN** a completed run has a well-formed `TesterEvidence` record
- **THEN** a scoreboard or accounting consumer SHALL be able to read
  `duration_ms`, command count, and `overall_status` from structured fields
- **AND** SHALL NOT need to regex a human summary comment to obtain those
  values

### Requirement: Pre-merge consumers SHALL refuse fail authority from SHA-mismatched Tester evidence

When pre-merge (or any pre-merge sub-gate) loads `TesterEvidence` to decide suite pass/fail or exhaustion, acquisition SHALL compare `artifact.candidate_sha` to the live open PR head pin for that evaluation. On mismatch, the evidence SHALL be classified stale (or non-current) exactly as for review acquisition. Stale evidence with a non-pass `overall_status` SHALL NEVER supply fail authority for the live head: the pipeline SHALL NOT treat that artifact as proving the live head suite failed, and SHALL NOT escalate to `test-gate-exhausted` / suite-fail `needs-human` solely from it. Stale evidence SHALL also NEVER be presented as a suite pass for the live head (existing non-pass-on-mismatch rule is preserved).

#### Scenario: Mismatched fail evidence is stale and not live-head fail

- **WHEN** pre-merge loads Tester evidence whose `candidate_sha` is `H_fail`
- **AND** the live open PR head pin is `H_green` where `H_fail ≠ H_green`
- **AND** the record’s `overall_status` is a non-pass class (e.g. `failed`)
- **THEN** acquisition SHALL classify the evidence as stale or non-current for `H_green`
- **AND** pre-merge SHALL NOT treat the live head suite as failed solely from that artifact

#### Scenario: Matching fail evidence remains authoritative for that head

- **WHEN** pre-merge loads well-formed Tester evidence whose `candidate_sha` equals the live head pin H
- **AND** `overall_status` is `failed` (or another non-pass class that blocks under policy)
- **THEN** acquisition SHALL treat the evidence as current for H
- **AND** pre-merge MAY apply existing suite-fail / recovery / block dispositions for H

#### Scenario: Matching pass evidence remains current

- **WHEN** pre-merge loads well-formed Tester evidence whose `candidate_sha` equals the live head pin H
- **AND** `overall_status` is `passed`
- **THEN** acquisition SHALL treat the evidence as current for H
- **AND** SHALL NOT invent a fail from older mismatched records when this record is current

### Requirement: Tester evidence producers SHALL emit a nested evidence_subject from runtime state

When the deterministic Tester producer writes a `TesterEvidence` record for a suite run, it SHALL populate a nested `evidence_subject` object conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`). Subject fields SHALL be derived from authoritative runtime state available to the producer (candidate HEAD SHA, run id, issue, PR, domain, effective test/gate config material folded into policy or config digests as documented, engine identity, verifier/toolchain surface, required-evidence-set revision). Top-level `candidate_sha`, `run_id`, `issue`, and `pr` SHALL remain and SHALL equal the corresponding subject fields when both are present. The producer SHALL NOT leave `evidence_subject` absent on newly produced schema-current records, and SHALL NOT accept model or harness prose as subject input.

#### Scenario: successful suite production includes evidence_subject

- **WHEN** the deterministic tester producer completes a trusted suite run for candidate SHA S on run R for issue N
- **THEN** the written `TesterEvidence` record SHALL include `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal top-level `candidate_sha` and the full 40-character value of S
- **AND** `evidence_subject.run_id` SHALL equal the active run id R
- **AND** `evidence_subject.issue` SHALL equal N

#### Scenario: top-level identity stays consistent with subject

- **WHEN** a `TesterEvidence` record is serialized with both top-level identity fields and `evidence_subject`
- **THEN** `candidate_sha`, `run_id`, `issue`, and `pr` SHALL equal the corresponding subject fields
- **AND** the record SHALL NOT introduce a Tester-only subject type that renames those concepts

---

### Requirement: Tester acquisition SHALL validate evidence_subject currency before treating suite evidence as current

Acquisition and pre-merge consumers of `TesterEvidence` SHALL compare the artifact’s `evidence_subject` to the evaluation pin subject (or, when building a pin, at least the live candidate SHA and other dimensions required for suite currency) using the shared comparison semantics. On subject `mismatch` for candidate (or other dimensions that govern suite currency), the evidence SHALL be classified stale/non-current. On `malformed`, the evidence SHALL be quarantined and SHALL NOT supply pass or fail authority. On `legacy_unbound` (historical records without a subject), acquisition MAY fall back to existing `candidate_sha` match rules but MUST label the result legacy unbound and MUST NOT claim full multi-dimension subject match. A subject match does not invent a suite pass: family-local `overall_status` rules still apply.

#### Scenario: subject candidate mismatch is stale

- **WHEN** acquisition loads Tester evidence whose `evidence_subject.candidate_sha` is A
- **AND** the evaluation pin candidate SHA is B where A ≠ B
- **THEN** acquisition SHALL classify the evidence as non-current for B
- **AND** SHALL NOT present it as a suite pass for B

#### Scenario: exact subject match allows family-local status rules

- **WHEN** acquisition loads well-formed Tester evidence whose `evidence_subject` matches the evaluation pin
- **AND** `overall_status` is `"passed"`
- **THEN** acquisition MAY treat the suite result as current for that pin under existing pass rules
- **AND** SHALL NOT ignore a non-pass `overall_status` solely because the subject matches

#### Scenario: legacy artifact without subject uses candidate_sha fallback with legacy label

- **WHEN** acquisition loads a historical `TesterEvidence` record that has no `evidence_subject`
- **AND** top-level `candidate_sha` equals the evaluation pin candidate SHA
- **THEN** acquisition MAY treat candidate identity as matching under the legacy path
- **AND** diagnostics SHALL mark the evidence `legacy_unbound`
- **AND** SHALL NOT report a full subject `match`

#### Scenario: post-fix regeneration required after candidate change

- **WHEN** Tester evidence exists for candidate A and a fix advances the product candidate to B
- **THEN** the A-bound evidence SHALL be non-current for B under subject comparison
- **AND** the deterministic producer MUST regenerate evidence for B before suite pass authority applies to B

### Requirement: Successful producer SHALL persist SHA-matched Tester evidence or fail_closed SHALL name the persist/acquire cause

The pipeline SHALL write a SHA-matched `tester-evidence.json` for the candidate HEAD into the current run directory, **or** withhold review with a named persist/acquire reason, when the code-review path invokes the deterministic Tester producer because `on_missing` is `fail_closed` and trustworthy SHA-matched evidence is missing, stale, or malformed, and that producer records a required test-gate command exit 0. Whether the producer recorded that exit 0 SHALL be a typed result from `runTestGate` (or the equivalent regenerate observation), not an inference from `summary.json` or free-form logs. The artifact `candidate_sha` SHALL be the worktree HEAD passed to the gate, validated as a full 40-character hex SHA, and SHALL NOT be the trusted-surface decision `candidate_sha` (including an all-zero sentinel). SHA-matched Tester evidence that omits `evidence_subject` SHALL still be current suite evidence for review acquisition (`legacy_unbound` SHA fallback) and SHALL remain unusable as a readiness-pass subject. The named reason SHALL be a closed persist/acquire code stored on the acquisition result and in durable run/comment evidence, and SHALL NOT be the generic missing-file string (`No Tester suite evidence file for this run (missing tester-evidence.json)`). A present trusted-surface decision with `outcome: blocked`, `repo_policy` `failure_reason: missing_base_sha`, and/or all-zero `candidate_sha` SHALL NOT be the sole cause of both (a) no suite artifact and (b) that generic missing-file withhold. An atomic write failure after recorded exit 0 SHALL produce the named persist-write-failed code, SHALL preserve the original error in bounded redacted form, and SHALL NOT manufacture a passed artifact. Acquisition after the producer attempt SHALL remain load-only and SHALL NOT invent a suite pass. Readiness `evidence_subject` emission MAY stay fail-closed when trusted-surface is blocked; omitting the subject SHALL NOT omit the suite artifact after a recorded exit 0.

#### Scenario: successful producer persists SHA-matched artifact

- **WHEN** review re-entry finds no trustworthy SHA-matched `tester-evidence.json` under `fail_closed`
- **AND** the deterministic producer runs once and records a required test-gate command exit 0
- **AND** the candidate HEAD is a full 40-character SHA
- **AND** a run directory is available
- **THEN** the run directory SHALL contain a SHA-matched `tester-evidence.json` for that HEAD
- **AND** acquisition SHALL treat that artifact as current (subject to existing SHA-match rules)
- **AND** review SHALL NOT withhold the model invoke solely because the file was missing before the producer ran

#### Scenario: persist failure after exit 0 uses a named withhold

- **WHEN** the deterministic producer records a required test-gate command exit 0 as a typed observation
- **AND** re-acquisition is still not current (`missing`, `stale`, or `malformed`)
- **THEN** `fail_closed` SHALL withhold with a named persist/acquire code other than the generic missing-file string
- **AND** that code SHALL be stored on the acquisition result and in durable run or comment evidence
- **AND** the re-acquired classification SHALL be preserved in the rendered reason and section
- **AND** acquisition SHALL NOT invent a suite pass

#### Scenario: remaining stale or malformed after exit 0 uses named persist/acquire

- **WHEN** the deterministic producer records a required test-gate command exit 0 as a typed observation
- **AND** an old SHA-pinned or unreadable `tester-evidence.json` remains so re-acquisition is `stale` or `malformed`
- **THEN** `fail_closed` SHALL withhold with a named persist/acquire code other than the generic missing-file string
- **AND** the acquisition classification SHALL remain `stale` or `malformed` as re-acquired
- **AND** the rendered reason and section SHALL preserve that classification
- **AND** recover-parked SHALL be able to read the durable persist/acquire marker
- **AND** acquisition SHALL NOT invent a suite pass

#### Scenario: atomic write failure after exit 0 is named and does not invent a pass

- **WHEN** the deterministic producer records a required test-gate command exit 0
- **AND** the atomic Tester evidence write fails
- **THEN** the persist observation SHALL report write failure with the original error in bounded redacted form
- **AND** the run directory SHALL NOT contain a manufactured `overall_status: "passed"` artifact from that failed write
- **AND** review SHALL withhold with persist-write-failed (or an equivalent named persist/acquire code)

#### Scenario: SHA-matched evidence without evidence_subject is current for review

- **WHEN** a SHA-matched `tester-evidence.json` exists for the candidate HEAD
- **AND** the record omits `evidence_subject`
- **THEN** review acquisition SHALL classify the artifact as current suite evidence under existing SHA-match / `legacy_unbound` rules
- **AND** SHALL NOT withhold the review model invoke solely because the subject is absent
- **AND** readiness consumers SHALL still treat the omitted subject as unusable for a readiness pass

#### Scenario: trusted-surface missing_base_sha is not generic missing

- **WHEN** the run directory contains `trusted-surface.json` with `outcome: blocked`
- **AND** `repo_policy` `failure_reason` is `missing_base_sha`
- **AND** trusted-surface `candidate_sha` is all zeros
- **AND** the producer recorded a required test-gate command exit 0
- **THEN** review SHALL NOT withhold using only the generic missing-file string
- **AND** either SHA-matched Tester evidence SHALL be present for the real candidate HEAD or the withhold reason SHALL name the trusted-surface / persist cause

#### Scenario: producer that did not record exit 0 may still withhold as missing

- **WHEN** the optional producer is not invoked, throws before recording a command result, or records a non-zero test-gate exit
- **AND** no trustworthy SHA-matched artifact exists
- **AND** `on_missing` is `fail_closed`
- **THEN** acquisition MAY still withhold
- **AND** SHALL NOT claim that tests passed

### Requirement: Persist-or-named-fail regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a producer callback resolves after recording test-gate exit 0 and review still withholds solely because `tester-evidence.json` is missing, or still stale/malformed without a named persist/acquire code; (2) a `trusted-surface.json` `repo_policy` `missing_base_sha` with all-zero `candidate_sha` is collapsed into the generic missing-file withhold string with no distinct diagnostic.

#### Scenario: missing-file withhold after recorded exit 0 fails the suite

- **WHEN** a unit test drives review Tester acquisition with a producer that records test-gate exit 0 and does not leave a SHA-matched artifact under the generic missing classification
- **THEN** the test SHALL fail unless withhold is false because a SHA-matched artifact was written, or withhold is true with a named persist/acquire reason other than the generic missing-file string

#### Scenario: stale or malformed withhold after recorded exit 0 fails the suite

- **WHEN** a unit test drives review Tester acquisition with a producer that records test-gate exit 0 and leaves a stale or malformed artifact
- **THEN** the test SHALL fail unless withhold is true with a named persist/acquire reason and the re-acquired classification remains stale or malformed

#### Scenario: missing_base_sha collapse fails the suite

- **WHEN** a unit test supplies `trusted-surface.json` with `outcome: blocked`, `repo_policy` `missing_base_sha`, and all-zero `candidate_sha` after a producer that recorded test-gate exit 0
- **THEN** the test SHALL fail if the withhold reason is only the generic missing-file string

### Requirement: Pipeline SHALL bind or reproduce current-SHA Tester evidence after PR-backed trusted-surface resolution

After an implementation commit is pushed and a linked pull request makes the candidate and trusted-surface identity observable, the pipeline SHALL bind or reproduce SHA-matched Tester evidence for the final pushed PR head with the required implementation role and a well-formed readiness `evidence_subject` before the first consumer delivery-stage evidence observer runs. Ordinary advance, nested advance, `single`, `loop`, and FRG SHALL share this path. The bound or reproduced `candidate_sha` SHALL equal the final pushed PR head as a full 40-character hex SHA. The pipeline SHALL NOT treat pre-push SHA, a different candidate SHA, or blocked trusted-surface evidence as current implementation-role Tester evidence for that consumer stage.

When SHA-matched Tester evidence already exists for that final PR head and records a suite pass, and trusted-surface for that SHA is `passthrough` or `rebound` with a trustworthy verifier pin, the pipeline SHALL bind the subject and implementation role onto that record. The pipeline SHALL NOT require a second suite command solely to emit the subject. When no SHA-matched record exists for that head, or the record is stale or malformed for that head, the pipeline SHALL reproduce evidence through the existing deterministic producer and persist the subject and implementation role.

#### Scenario: subject-less Tester after test-gate-before-PR is rebound before design-gate observer

- **WHEN** implementing runs the test gate before a pull request exists
- **AND** Tester evidence is written for candidate SHA S without a readiness `evidence_subject` because trusted-surface was not yet candidate-observable
- **AND** implementing then pushes S and opens a linked pull request whose head is S
- **AND** trusted-surface for S then resolves `passthrough` or `rebound`
- **THEN** the pipeline SHALL bind or reproduce SHA-matched Tester evidence for S with implementation role and a well-formed `evidence_subject`
- **AND** that bind or reproduce SHALL complete before the first consumer delivery-stage evidence observer runs
- **AND** the next delivery stage SHALL NOT refuse with `required implementation evidence role, observed missing` solely because the pre-PR record omitted the subject

#### Scenario: bind uses the final pushed PR head and does not re-run a matching suite

- **WHEN** SHA-matched Tester evidence for PR head S already records a suite pass
- **AND** trusted-surface for S is `passthrough` or `rebound` with a trustworthy verifier pin
- **THEN** the pipeline SHALL bind `evidence_subject` and implementation role onto that record for S
- **AND** SHALL NOT require a second suite command solely because the earlier write omitted the subject
- **AND** `candidate_sha` SHALL equal S

#### Scenario: reproduce when the final PR head has no current Tester record

- **WHEN** the final pushed PR head is S
- **AND** no SHA-matched current Tester record exists for S (missing, stale, or malformed)
- **AND** trusted-surface for S is `passthrough` or `rebound`
- **THEN** the pipeline SHALL run the existing deterministic Tester producer for S
- **AND** SHALL persist SHA-matched Tester evidence for S with implementation role and a well-formed `evidence_subject`

#### Scenario: pre-push or stale SHA is not blessed

- **WHEN** Tester evidence exists only for SHA A
- **AND** the final pushed PR head is SHA B where A ≠ B
- **THEN** the pipeline SHALL NOT present the A record as current implementation-role evidence for B
- **AND** SHALL bind or reproduce evidence for B before a consumer delivery-stage observer runs
- **OR** SHALL fail closed with a typed actionable blocker if B cannot be observed

#### Scenario: blocked trusted-surface is not rebound as a readiness pass

- **WHEN** trusted-surface for the final PR head remains `blocked` or has no trustworthy verifier pin
- **THEN** the pipeline SHALL NOT emit a fabricated readiness `evidence_subject`
- **AND** SHALL NOT treat the subject-less record as consumer-stage implementation-role proof
- **AND** SHALL fail closed with a typed actionable blocker rather than invent passthrough

#### Scenario: ordinary advance, nested advance, single, loop, and FRG share the path

- **WHEN** any of ordinary advance, nested advance, `single`, `loop`, or FRG reaches a consumer delivery stage after implementing has pushed a linked PR
- **THEN** that invocation SHALL use the same bind-or-reproduce path
- **AND** SHALL NOT skip the bind because the caller is FRG or nested

#### Scenario: disabled test gate does not strand exact product-path implementation proof

- **WHEN** `test_gate.enabled` is false
- **AND** no SHA-matched passed Tester record exists for the final PR head
- **AND** exact product-path implementation proof exists for the observed candidate
- **THEN** the pipeline SHALL NOT fail closed solely because Tester rebind cannot record a suite pass
- **AND** the consumer observer SHALL still accept that exact product-path implementation proof

#### Scenario: successor dispatch reuses SHA-matched rebound Tester evidence from a prior run

- **WHEN** recovery or a prior advance bound SHA-matched passed Tester evidence for PR head S in a prior run directory
- **AND** the next loop dispatch mints a new run directory
- **THEN** the pipeline SHALL bind or adopt that SHA-matched record into the successor run by exact candidate identity
- **AND** SHALL NOT require a second suite command solely to recreate the already-passed record

#### Scenario: PR head movement after bind is not authorized as the observed candidate

- **WHEN** the pipeline binds or reproduces Tester evidence for observed PR head S1
- **AND** a subsequent read of the linked PR head observes S2 where S1 ≠ S2 before the consumer observer runs
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **OR** SHALL rebind or reproduce for S2 before the observer runs
- **AND** SHALL NOT present S1 Tester evidence as current implementation-role proof for S2

#### Scenario: enabled test gate later-stage resume without worktree fails closed

- **WHEN** `test_gate.enabled` is true
- **AND** a later consumer implementation stage resumes with no managed worktree
- **AND** no SHA-matched passed Tester record exists for the final PR head
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT dispatch the consumer delivery-stage observer
- **AND** SHALL NOT return helper action `not-applicable`

#### Scenario: PR head movement after confirmation is detected at the observer

- **WHEN** bind and a confirmation read observed PR head S1
- **AND** a managed worktree HEAD remains S1
- **AND** the consumer observer's live PR read observes S2 where S1 ≠ S2
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **OR** SHALL rebind or reproduce for S2 before treating the observation as proven

#### Scenario: Linked PR identity changes while the head SHA stays equal

- **WHEN** Tester evidence is bound to linked PR P1 at head S
- **AND** a confirmation or delivery-stage observer resolves linked PR P2 at the same head S where P1 differs from P2
- **THEN** the pipeline SHALL treat the `{PR number, head SHA}` binding as changed
- **AND** SHALL rebind and reconfirm Tester evidence for P2/S before dispatch
- **AND** implementation-role acquisition SHALL require both the evidence and its subject to name P2
- **AND** SHALL NOT present S1 worktree HEAD or S1 Tester evidence as implementation-role proof for S2

#### Scenario: PR head movement after execution is a typed mismatch, not a generic wait

- **WHEN** bind and the pre-attempt observer observed PR head S1
- **AND** the consumer stage executes
- **AND** the post-attempt observer's live PR read observes S2 where S1 ≠ S2
- **AND** the S1→S2 movement is not a stage-owned push from that consumer's managed worktree
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **AND** SHALL NOT leave the outcome as generic Candidate-binding-changed waiting
- **AND** SHALL restore the consumer stage label, or persist typed blocker `tester_rebind_stage_label_unrestored` if that restoration cannot be confirmed
- **AND** SHALL NOT record `stage_complete` as `advanced` for that consumer stage
- **AND** recovery SHALL NOT treat `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` as eligible for that diagnostic

#### Scenario: stage-owned PR head mutation is rebound, not foreign drift

- **WHEN** bind and the pre-attempt observer observed PR head S1
- **AND** the consumer stage is `fix-1`, `fix-2`, or `pre-merge`
- **AND** that stage pushes a new PR head S2 from the managed worktree
- **AND** the post-attempt observer's live PR read observes S2 where S1 ≠ S2
- **AND** the managed worktree HEAD equals S2
- **THEN** the pipeline SHALL re-resolve trusted-surface and bind or reproduce Tester evidence for S2
- **AND** SHALL NOT fail closed with `tester_rebind_pr_head_mismatch` solely because the stage produced S2
- **AND** SHALL NOT restore the consumer stage label
- **AND** SHALL allow the handler outcome to stand when S2 binding succeeds
- **AND** the post-attempt observer SHALL report candidate SHA S2 as the completion proof
- **AND** SHALL NOT report S1 Tester evidence or S1 Candidate identity as that post-attempt proof

#### Scenario: failed restoration of the consumer stage label is a typed reconciliation blocker

- **WHEN** post-attempt unowned PR-head movement requires restoring the consumer stage label
- **AND** the compensating transition does not confirm the original consumer stage label
- **THEN** the pipeline SHALL persist typed blocker `tester_rebind_stage_label_unrestored`
- **AND** SHALL NOT silently discard the restoration failure
- **AND** SHALL NOT record `stage_complete` as `advanced` for that consumer stage

#### Scenario: missing pipeline stage label is not a restored consumer stage

- **WHEN** post-attempt unowned PR-head movement requires restoring the consumer stage label
- **AND** the live issue has no `pipeline:*` stage label after the compensating transition
- **THEN** the pipeline SHALL persist typed blocker `tester_rebind_stage_label_unrestored`
- **AND** SHALL NOT treat a missing stage label as confirmation of the original consumer stage

#### Scenario: disabled-gate exact-proof still fail-closes when PR head moved

- **WHEN** `test_gate.enabled` is false
- **AND** the helper reports `ok: true` with action `not-applicable`
- **AND** bind observed PR head S1
- **AND** a subsequent read of the linked PR head observes S2 where S1 ≠ S2 before the consumer observer treats the observation as proven
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **AND** SHALL NOT treat worktree S1 changed paths as exact implementation proof for S2

### Requirement: Pipeline SHALL fail closed when PR head or trusted-surface identity cannot be observed after push

If, after the implementation commit is pushed, the linked PR head is missing, is not a full 40-character hex SHA, or disagrees with the pushed head, or trusted-surface identity cannot be resolved, the pipeline SHALL fail closed with a typed actionable blocker. The pipeline SHALL NOT run a consumer delivery-stage observer against missing implementation-role evidence as if the post-PR bind had succeeded. This fail-closed rule SHALL apply at every consumer implementation stage, including `design-gate`, `review-1`, `fix-1`, and `pre-merge`. The blocker code SHALL be machine-readable on the observation or run evidence and SHALL NOT be only the generic `required implementation evidence role, observed missing` string.

#### Scenario: missing PR head after push is a typed blocker

- **WHEN** implementing reports a successful push
- **AND** no linked pull request head SHA can be observed as a full 40-character hex value
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT enter the next consumer delivery stage as verified
- **AND** SHALL NOT invent a candidate SHA or `evidence_subject`

#### Scenario: unobservable trusted-surface after push is a typed blocker

- **WHEN** a linked PR head S is observable
- **AND** trusted-surface for S cannot be resolved to `passthrough` or `rebound` with a trustworthy verifier pin
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT bind a fabricated subject onto Tester evidence for S

#### Scenario: later consumer stages fail closed on typed rebind failure

- **WHEN** the shared bind-or-reproduce path returns a typed failure at `review-1`, `fix-1`, or `pre-merge`
- **THEN** the pipeline SHALL fail closed with that typed actionable blocker
- **AND** SHALL NOT dispatch the consumer delivery-stage observer
- **AND** SHALL NOT replace the typed blocker with generic `required implementation evidence role, observed missing`

### Requirement: Post-PR Tester rebind regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a fixture where the test gate passes before PR creation, Tester omits `evidence_subject`, then the same SHA resolves trusted-surface `passthrough` or `rebound` still lets the next consumer delivery stage refuse `required implementation evidence role, observed missing`; (2) rebound or reproduced Tester evidence uses a pre-push SHA, a stale SHA, or a blocked trusted-surface fabricated subject; (3) a missing PR head or unresolvable trusted-surface after push does not produce a typed actionable blocker.

#### Scenario: design-gate missing-role refuse after same-SHA passthrough fails the suite

- **WHEN** a unit test drives implementing test-gate-before-PR (subject omitted), then PR creation, then same-SHA trusted-surface `passthrough` or `rebound`, then the next consumer delivery-stage observer
- **THEN** the test SHALL fail unless that observer receives implementation-role Tester evidence for the final PR head
- **AND** the test SHALL inject I/O and SHALL NOT perform live network, git, or subprocess calls

#### Scenario: stale or blocked rebound fails the suite

- **WHEN** a unit test supplies Tester evidence for SHA A or a blocked trusted-surface decision and asks the rebind path to satisfy consumer evidence for SHA B or a blocked surface
- **THEN** the test SHALL fail if the path reports current implementation-role evidence
