## ADDED Requirements

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
