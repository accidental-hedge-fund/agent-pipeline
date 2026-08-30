# doctor-harness-smoke Specification

## Purpose
TBD - created by archiving change doctor-role-aware-harness-smoke. Update Purpose after archive.

## Requirements

### Requirement: The pipeline SHALL expose opt-in doctor harness smoke for every unique configured treatment

The pipeline CLI SHALL accept `pipeline doctor --harness-smoke` as an opt-in mode of the existing
`doctor` subcommand. When the flag is set, doctor SHALL build a smoke plan of every unique
configured local-CLI treatment coordinate `{adapter, role, model, effort}` drawn from the active
configuration and the runtime adapter registry (built-in and externally registered adapters
included when assigned). Unassigned registered adapters MAY be omitted. The smoke path SHALL be
runnable standalone without starting an advance loop and is intended for use as step 1 of a harness
promotion gate.

The smoke SHALL perform real subprocess I/O by design. Unit tests of the smoke orchestrator SHALL
use an injected deps seam and SHALL NOT perform real network, git, or subprocess calls.

#### Scenario: Standalone smoke invocation

- **WHEN** an operator runs `pipeline doctor --harness-smoke` with a valid configuration
- **THEN** the pipeline SHALL run the harness-smoke plan without requiring an issue number or
  advance loop
- **AND** SHALL exit 0 only when every planned treatment smoke passes and any co-run static doctor
  checks also pass

#### Scenario: Unique configured treatments are exercised

- **WHEN** configuration assigns implementer adapter `A` with model `M1` and effort `E1` and
  reviewer adapter `B` with model `M2` and effort `E2`
- **AND** `pipeline doctor --harness-smoke` runs
- **THEN** the smoke plan SHALL include distinct treatments for `(A, implementer, M1, E1)` and
  `(B, reviewer, M2, E2)`
- **AND** SHALL NOT skip `B` solely because it is not a historical built-in name

#### Scenario: Duplicate coordinates are not double-billed

- **WHEN** two configured stages resolve to the same `{adapter, role, model, effort}` coordinate
- **AND** `pipeline doctor --harness-smoke` runs
- **THEN** the smoke plan SHALL include that coordinate at most once

#### Scenario: Unassigned registered adapters need not be smoked

- **WHEN** an adapter is registered but not assigned as implementer or reviewer in the active
  configuration
- **AND** `pipeline doctor --harness-smoke` runs
- **THEN** the smoke plan MAY omit that adapter
- **AND** omitting it solely because it is unassigned SHALL NOT by itself fail doctor

#### Scenario: Orchestration unit tests inject deps

- **WHEN** unit tests cover harness-smoke planning, short-circuit, role assertions, or exit
  aggregation
- **THEN** they SHALL inject fake deps through the smoke deps seam
- **AND** SHALL perform no real network, git, or subprocess I/O

---

### Requirement: Implementer treatment smoke SHALL prove mutation, trailers, output contract, and optional telemetry

For each implementer-role treatment in the smoke plan, the pipeline SHALL run a cheap canned
implementer prompt against a throwaway scratch repository (not the operator worktree and not a
managed pipeline worktree). The treatment SHALL pass only when all of the following hold:

1. the harness process spawns and exits 0,
2. the scratch repository gains a new commit whose message includes the required pipeline trailers
   (`Issue:` and `Pipeline-Run:` in git trailer form, or the smoke’s documented trailer values for
   the throwaway context),
3. the product output passes the central stage-output-contract validator for the smoke’s
   implementer-facing contract id,
4. when the adapter declares telemetry support, captured output is parseable by the adapter’s
   `parseTelemetry` without throwing and without inventing a resolved model or cost the CLI did not
   report. Provenance is per-field: a non-null `resolvedModel` or `costUsd` SHALL be rejected unless
   the corresponding value is present in the raw CLI capture’s JSON telemetry envelope (empty or
   nonempty product-only output without those fields is not sufficient justification).

A failure of any of (1)–(4) SHALL mark that treatment as failed with remediation naming the
adapter, role, and (when set) model and effort.

#### Scenario: Implementer smoke passes full contract

- **WHEN** an implementer treatment is smoked and the CLI exits 0, creates a trailer-bearing
  commit in the scratch repo, produces contract-valid output, and (if telemetry is declared) yields
  parseable telemetry
- **THEN** that treatment’s smoke result SHALL be pass

#### Scenario: Telemetry inventing model or cost from nonempty non-telemetry output fails

- **WHEN** an adapter declares telemetry support
- **AND** smoke captured output is nonempty ordinary product output or JSONL that does not report
  model or cost fields
- **AND** `parseTelemetry` returns a non-null `resolvedModel` or `costUsd` not present in that
  capture’s JSON envelope
- **THEN** that treatment’s smoke result SHALL be fail
- **AND** remediation SHALL state that the adapter must not invent those values

#### Scenario: Implementer missing commit fails

- **WHEN** an implementer treatment exits 0 but the scratch repo has no new trailer-bearing commit
- **THEN** that treatment’s smoke result SHALL be fail
- **AND** remediation SHALL name the adapter and the missing commit/trailer expectation

#### Scenario: Implementer contract failure fails the treatment

- **WHEN** an implementer treatment exits 0 but stage-output-contract validation fails
- **THEN** that treatment’s smoke result SHALL be fail
- **AND** remediation SHALL name the contract validation failure

#### Scenario: Implementer smoke does not mutate the operator worktree

- **WHEN** implementer smoke runs
- **THEN** commits and file mutations for the smoke SHALL occur only inside the throwaway scratch
  repository
- **AND** the operator’s calling worktree SHALL NOT receive smoke-created commits as a required
  side effect

---

### Requirement: Reviewer treatment smoke SHALL prove a structured read-only verdict without requiring commits

For each reviewer-role treatment in the smoke plan, the pipeline SHALL run a cheap canned reviewer
prompt against a throwaway scratch repository. The treatment SHALL pass only when all of the
following hold:

1. the harness process spawns and exits 0,
2. the product output passes the central review verdict contract (`review.verdict@1` or the same
   schema-backed validator production review uses),
3. the scratch repository has **no** new commits and no required file mutations attributable to the
   smoke turn (read-only),
4. when the adapter declares telemetry support, telemetry parsing succeeds under the same rules as
   implementer smoke.

The pipeline SHALL NOT require reviewer-only adapters to create commits. A smoke that forces or
expects a reviewer commit as a pass condition is non-conformant.

#### Scenario: Reviewer smoke passes with verdict and no mutation

- **WHEN** a reviewer treatment is smoked and the CLI exits 0, emits a contract-valid structured
  verdict, leaves the scratch repo without new commits, and (if telemetry is declared) yields
  parseable telemetry
- **THEN** that treatment’s smoke result SHALL be pass

#### Scenario: Reviewer mutation fails the treatment

- **WHEN** a reviewer treatment produces a new commit or other required repository mutation in the
  scratch repo
- **THEN** that treatment’s smoke result SHALL be fail
- **AND** remediation SHALL state that reviewer smoke must remain read-only

#### Scenario: Reviewer-only adapter is not required to commit

- **WHEN** configuration assigns a reviewer-only adapter (implementer role not declared)
- **AND** that adapter’s reviewer treatment is smoked
- **THEN** the smoke SHALL NOT fail solely because no commit was created
- **AND** SHALL still require a contract-valid structured verdict and exit 0

#### Scenario: Unparseable reviewer verdict fails

- **WHEN** reviewer smoke output fails `review.verdict@1` (or the shared schema-backed validator)
- **THEN** that treatment’s smoke result SHALL be fail
- **AND** the failure SHALL be classified as an output-contract (or equivalent harness-contract)
  failure rather than a successful empty-findings verdict

---

### Requirement: Harness smoke SHALL consume adapter-declared readiness hooks before the model call

For each planned treatment, the smoke orchestrator SHALL first invoke the adapter’s declared
readiness path (`runtimeSmoke` and/or treatment-aware preflight from the public adapter contract).
When readiness fails, the orchestrator SHALL mark the treatment as failed with the readiness
failure’s remediation, SHALL NOT spawn the canned model prompt for that treatment when the failure
is detectable without a model call, and SHALL continue or stop according to doctor fail-fast policy.

When readiness succeeds, the orchestrator SHALL proceed to the role-aware canned prompt using the
exact treatment’s adapter, role, model, and effort (when set), without falling back to a different
adapter or ambient model default.

#### Scenario: Readiness failure short-circuits model call

- **WHEN** a treatment’s declared `runtimeSmoke` (or preflight) returns not-ok for missing CLI or
  unauthenticated state
- **THEN** that treatment’s smoke result SHALL be fail with remediation naming the adapter
- **AND** the canned model prompt for that treatment SHALL NOT be spawned

#### Scenario: Readiness success proceeds to canned prompt

- **WHEN** readiness for a treatment succeeds
- **THEN** the orchestrator SHALL spawn the role-aware canned prompt for that exact treatment
  coordinate

#### Scenario: No silent adapter or model fallback

- **WHEN** a treatment fails readiness or the canned prompt
- **THEN** the orchestrator SHALL NOT retry the same plan step with a different adapter or
  invented default model
- **AND** SHALL report failure for the exact configured coordinate

---

### Requirement: Harness smoke results SHALL compose with doctor exit codes, summary, and JSON

When `--harness-smoke` is set, each treatment result SHALL appear in the doctor human-readable
summary and, when `--json` is set, in the doctor JSON envelope as one or more check records (or an
equivalent stable nested structure) that include at least: treatment identity (adapter, role, and
model/effort when set), status (`pass`/`fail`/`skip`), reason, and remediation `fix` on failure.
Overall doctor status and process exit code SHALL treat any failed smoke treatment as a failing
check (exit non-zero), consistent with existing doctor pass/fail rules. Help text for
`--harness-smoke` SHALL document expected spend: approximately one cheap model call per unique
configured treatment per invocation.

#### Scenario: Any smoke failure fails doctor

- **WHEN** `pipeline doctor --harness-smoke` runs and at least one treatment smoke fails
- **THEN** the command SHALL exit non-zero
- **AND** the summary SHALL include remediation for the failing treatment

#### Scenario: JSON includes smoke treatment records

- **WHEN** `pipeline doctor --harness-smoke --json` runs
- **THEN** stdout SHALL remain a single unfenced JSON object
- **AND** each smoked treatment SHALL be represented with identity and status fields
- **AND** `JSON.parse(stdout)` SHALL succeed whether treatments pass or fail

#### Scenario: Help documents spend

- **WHEN** an operator inspects doctor help for `--harness-smoke`
- **THEN** the help text SHALL state that the mode performs about one cheap model call per
  unique configured treatment per invocation

---

### Requirement: Throwaway scratch repositories SHALL be isolated and cleaned up

Harness smoke SHALL create a dedicated throwaway scratch repository (or equivalent isolated git
working tree) per treatment or per smoke run, set the harness cwd to that root, and attempt
cleanup after assertions complete. Smoke SHALL NOT require or rely on mutating the operator’s
current worktree, a pipeline managed worktree under `.worktrees/`, or a protected branch as the
mutation target.

#### Scenario: Scratch isolation

- **WHEN** implementer or reviewer smoke runs
- **THEN** the harness cwd for the canned prompt SHALL be the throwaway scratch root
- **AND** SHALL NOT be the operator’s primary worktree path as the required mutation target

#### Scenario: Best-effort cleanup

- **WHEN** a treatment smoke completes (pass or fail)
- **THEN** the orchestrator SHALL attempt to remove the throwaway scratch directory
- **AND** a cleanup failure SHALL NOT by itself convert a passing treatment into a silent success
  if product assertions failed; cleanup issues MAY be reported as warnings

### Requirement: Implementer harness smoke SHALL NOT use the tool-disabling lean invoke mode

Implementer-role `--harness-smoke` treatments SHALL invoke the adapter with tools enabled so the canned turn can create a trailer-bearing commit. The orchestrator SHALL NOT pass lean / tool-disabling invoke options for the implementer role. Reviewer-role treatments MAY still use lean because they MUST remain read-only. A smoke that disables implementer tools and then fails for missing trailers is non-conformant.

#### Scenario: Implementer invoke is not lean

- **WHEN** an implementer treatment reaches the canned-prompt spawn
- **THEN** the invoke options SHALL NOT set lean or an equivalent tool-disabling flag
- **AND** a unit test that inspects the injected invoke seam SHALL fail if implementer lean is true

#### Scenario: Tool-disabled implementer is not the production contract

- **WHEN** a fake implementer can create the required trailer-bearing commit only when lean is absent
- **AND** that treatment is smoked through the injected deps seam
- **THEN** the treatment SHALL pass
- **AND** the same fake SHALL fail the treatment if the orchestrator still passes lean

#### Scenario: Reviewer smoke may remain lean and read-only

- **WHEN** a reviewer treatment is smoked
- **THEN** the orchestrator MAY pass lean
- **AND** the treatment SHALL still fail if the scratch repository gains a new commit or required mutation

---

### Requirement: Harness-smoke assertion failures SHALL persist a typed evidence artifact before scratch cleanup

On every harness-smoke assertion failure after a scratch repository exists, the orchestrator SHALL write one bounded, sanitized, typed per-treatment artifact before it attempts scratch cleanup. The artifact SHALL include stdout, stderr, before and after porcelain, HEAD and log excerpt, and exit, timeout, and preflight fields. The same secret-redaction and injection-denylist pass used for run artifacts SHALL apply. Human-readable doctor output and `pipeline doctor --harness-smoke --json` SHALL include the artifact location and a content digest. A write failure SHALL be reported and SHALL NOT convert the original assertion failure into a pass. Cleanup SHALL still be attempted after the write.

#### Scenario: Trailer-miss captures evidence before delete

- **WHEN** an implementer treatment exits 0 but the scratch repo has no new trailer-bearing commit
- **THEN** the orchestrator SHALL write the typed artifact before deleting the scratch directory
- **AND** the stored doctor result, human summary, and JSON record SHALL include the artifact path and digest
- **AND** the treatment SHALL remain fail

#### Scenario: Spawn, contract, mutation, and telemetry failures also capture evidence

- **WHEN** a treatment fails spawn, stage-output-contract validation, reviewer mutation, or declared-telemetry provenance
- **AND** a scratch repository was created for that treatment
- **THEN** the orchestrator SHALL write the same shaped artifact before cleanup
- **AND** the artifact SHALL carry stdout, stderr, before and after porcelain, HEAD/log, and exit, timeout, and preflight fields

#### Scenario: Artifact is sanitized and bounded

- **WHEN** captured stdout or stderr contains a secret-shaped token
- **THEN** the persisted artifact SHALL redact that token
- **AND** the artifact SHALL apply deterministic head/tail bounds rather than storing unbounded CLI output

#### Scenario: Artifact write failure does not green the check

- **WHEN** writing the failure artifact raises an error
- **THEN** the treatment SHALL still be fail with the original assertion reason
- **AND** the summary SHALL mention that evidence capture failed
- **AND** the treatment SHALL NOT be recorded as pass
