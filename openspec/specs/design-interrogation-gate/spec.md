# design-interrogation-gate Specification

## Purpose
TBD - created by archiving change design-interrogation-gate. Update Purpose after archive.
## Requirements
### Requirement: The design_gate config block SHALL be opt-in and strictly validated

`PartialConfigSchema` SHALL accept an optional strict `design_gate` object with the keys
`enabled` (boolean, default `false`), `triggers` (array of built-in trigger class names, default the
full built-in set), `extra_triggers` (optional map of trigger class name → additional path globs),
`max_rounds` (integer ≥ 1, default `2`), `block_threshold` (`critical | high | medium | low`,
default `medium`), `min_confidence` (number 0..1, default `0.6`), and `limits`
(`{ max_decisions: number, max_field_chars: number, max_artifact_bytes: number }`). Unknown keys
inside `design_gate` SHALL be rejected at config-parse time. When `design_gate` is absent,
`cfg.design_gate.enabled` SHALL be `false` and no gate behavior SHALL run.

#### Scenario: design_gate absent — gate disabled by default
- **WHEN** `.github/pipeline.yml` contains no `design_gate` block
- **THEN** `resolveConfig()` SHALL set `cfg.design_gate.enabled` to `false`
- **AND** the remaining `design_gate` fields SHALL take their documented defaults

#### Scenario: design_gate enabled with a trigger subset
- **WHEN** `.github/pipeline.yml` sets `design_gate: { enabled: true, triggers: ["storage", "auth"] }`
- **THEN** `cfg.design_gate.enabled` SHALL be `true`
- **AND** `cfg.design_gate.triggers` SHALL be exactly `["storage", "auth"]`

#### Scenario: unknown key inside design_gate is rejected
- **WHEN** `.github/pipeline.yml` sets `design_gate: { enabled: true, always: true }`
- **THEN** `resolveConfig()` SHALL throw a strict-schema parse error identifying `always` as an unknown key
- **AND** the pipeline SHALL NOT run

---

### Requirement: Trigger evaluation SHALL be deterministic, pure, and recorded

The pipeline SHALL expose `evaluateDesignGateTrigger(inputs)` returning
`{ triggered: boolean, matched: TriggerMatch[], reason: string }`, where `inputs` are the changed
file paths produced by `implementing`, the issue's labels, and the diff size. The function SHALL
perform no network, git, or subprocess calls and SHALL return identical output for identical input.
Built-in trigger classes SHALL be `concurrency`, `storage`, `auth`, `migration`, `infrastructure`,
`public-api`, and `architecture`. Each `TriggerMatch` SHALL name the trigger class and the concrete
evidence that matched (the matching path(s), label, or size threshold). When the gate does not fire,
`reason` SHALL be one of `gate-disabled` or `no-trigger-matched`. The result SHALL be recorded on the
`design-gate` stage record on every run, whether or not the gate fires.

#### Scenario: gate disabled — recorded skip, no harness call
- **WHEN** the `design-gate` stage runs with `cfg.design_gate.enabled` set to `false`
- **THEN** the stage SHALL advance to `review-1` without invoking any harness
- **AND** the stage record SHALL carry `triggered: false` with reason `gate-disabled`

#### Scenario: enabled but no trigger matches — recorded skip
- **WHEN** the gate is enabled and no changed path, label, or size threshold matches an enabled trigger class
- **THEN** the stage SHALL advance to `review-1` without invoking any harness
- **AND** the stage record SHALL carry `triggered: false` with reason `no-trigger-matched`

#### Scenario: a trigger matches — evidence recorded
- **WHEN** the gate is enabled with the `storage` class and the changed set includes a path matching that class's globs
- **THEN** `evaluateDesignGateTrigger` SHALL return `triggered: true`
- **AND** `matched` SHALL contain a `storage` entry naming the matching path

#### Scenario: evaluation is pure and repeatable
- **WHEN** `evaluateDesignGateTrigger` is called twice with identical inputs
- **THEN** it SHALL return deeply equal results
- **AND** it SHALL make no network, git, or subprocess call

---

### Requirement: The gate SHALL use the configured independent reviewer and disclose fallback

When the gate fires, the interrogation round SHALL be invoked through `cfg.harnesses.reviewer` with
its configured model and effort (see `configurable-review-harness`). The run SHALL record a
`reviewerIdentity` (harness, model, effort) and a `reviewerIndependence` value of `independent` when
the reviewer harness differs from the implementer harness, or `same-harness-fallback` when it does
not. Under `same-harness-fallback` the round SHALL still execute, and the disclosure SHALL appear in
both the posted gate comment and the evidence bundle.

#### Scenario: independent reviewer
- **WHEN** the implementer harness is `claude` and `cfg.harnesses.reviewer` is `codex`
- **THEN** the interrogation SHALL be invoked with `codex`
- **AND** `reviewerIndependence` SHALL be `independent`

#### Scenario: same-harness fallback is executed and disclosed
- **WHEN** `cfg.harnesses.reviewer` resolves to the same harness and model as the implementer
- **THEN** the interrogation round SHALL still run
- **AND** `reviewerIndependence` SHALL be `same-harness-fallback`
- **AND** the posted gate comment SHALL contain an explicit same-harness fallback disclosure

#### Scenario: reviewer harness unavailable — gate blocks
- **WHEN** the reviewer harness CLI cannot be invoked
- **THEN** the gate SHALL NOT advance to `review-1`
- **AND** the issue SHALL be blocked with a harness-failure blocker naming the unavailable reviewer

---

### Requirement: The interrogation verdict SHALL be a validated structured document

The reviewer SHALL return a verdict of `approve` (zero challenges) or `needs-attention` carrying
between 3 and 7 challenges. Each challenge SHALL carry `decision_id`, `title`, `severity`
(`critical | high | medium | low`), `confidence` (0..1), `falsifier`, `evidence_request`, and
`required_action` (`defend | revise | accept-uncertainty`). The verdict schema SHALL be single-sourced
as a shared constant substituted into the interrogation prompt's `{{schema_block}}` placeholder, and a
test SHALL guard prompt/schema drift. Parsing SHALL fail conservatively: output that cannot be parsed
into a valid verdict SHALL NOT be treated as an approval.

#### Scenario: clean approval
- **WHEN** the reviewer returns `approve` with zero challenges
- **THEN** the gate SHALL advance to `review-1`
- **AND** the approval SHALL be recorded in the evidence bundle with the reviewer identity

#### Scenario: malformed reviewer output — one bounded re-ask, then block
- **WHEN** the reviewer output cannot be parsed into a valid verdict
- **THEN** the verdict SHALL default to `needs-attention` with the raw output attached
- **AND** the gate SHALL re-ask the reviewer exactly once
- **AND** if the second response is also unparseable the gate SHALL block rather than advance

#### Scenario: schema block substituted in the interrogation prompt
- **WHEN** the interrogation prompt is assembled
- **THEN** the `{{schema_block}}` placeholder SHALL be replaced with the shared challenge-schema constant before the prompt is sent

#### Scenario: challenge count outside the 3–7 band
- **WHEN** a `needs-attention` verdict carries fewer than 3 or more than 7 challenges
- **THEN** the verdict SHALL be treated as malformed and follow the bounded re-ask path

---

### Requirement: Challenge identity SHALL be stable across rounds

The pipeline SHALL derive a challenge's stable key as
`sha1(severity | decision_id | normalize(title))` truncated to 8 hexadecimal characters, where
`normalize(title)` applies the same normalization used by `findingKey` (lowercase, strip markdown
emphasis, strip leading/trailing ellipsis and punctuation, collapse whitespace, trim). The key SHALL be
identical for two emissions that share severity, `decision_id`, and normalized title, and SHALL differ
when any of the three changes.

#### Scenario: reworded title at the same decision and severity — same key
- **WHEN** a challenge is re-emitted in a later round with a reworded title but the same `decision_id` and `severity`
- **THEN** `challengeKey` SHALL return the same 8-character hex string for both emissions

#### Scenario: different decision or severity — different key
- **WHEN** two challenges share a normalized title but differ in `decision_id` or `severity`
- **THEN** `challengeKey` SHALL return different 8-character hex strings

---

### Requirement: Blocking SHALL be policy-driven and SHALL prevent advancement

A challenge SHALL block when its `severity` meets `design_gate.block_threshold` **and** its
`confidence` is at least `design_gate.min_confidence`; otherwise it SHALL be advisory. Advisory
challenges SHALL be recorded in the evidence bundle and SHALL NOT block. While at least one blocking
challenge is unresolved, the gate SHALL NOT transition to `review-1` and SHALL NOT invoke any diff
review.

#### Scenario: blocking challenge holds the gate
- **WHEN** the verdict carries a challenge at or above `block_threshold` with confidence at or above `min_confidence`
- **THEN** the issue SHALL NOT transition to `review-1`
- **AND** no diff-review harness call SHALL be made

#### Scenario: advisory-only verdict advances with a record
- **WHEN** every challenge is below the severity threshold or below the confidence floor
- **THEN** the gate SHALL advance to `review-1`
- **AND** each advisory challenge SHALL be recorded in the evidence bundle

---

### Requirement: The response round SHALL resolve challenges by defense, revision, or accepted uncertainty

For each blocking challenge, the implementer SHALL produce exactly one disposition: `defended` (with
supporting repository or runtime evidence), `revised` (the decision record is updated and re-emitted),
or `uncertainty-accepted` (the uncertainty is stated explicitly in the decision record). A challenge
carrying a recorded disposition SHALL retain that disposition across re-review and SHALL NOT be
re-litigated from scratch. A disposition without the required evidence or record update SHALL be
rejected and the challenge SHALL remain unresolved.

#### Scenario: defense accepted
- **WHEN** the implementer defends a blocking challenge with cited evidence and the re-review does not re-emit its `challengeKey`
- **THEN** the challenge SHALL be recorded as `defended`
- **AND** the gate SHALL advance to `review-1` when no other blocking challenge is unresolved

#### Scenario: revision required
- **WHEN** a challenge's `required_action` is `revise`
- **THEN** the implementer SHALL emit an updated decision record for that decision
- **AND** both the original and the revised record SHALL be preserved in the evidence bundle

#### Scenario: uncertainty explicitly preserved
- **WHEN** the implementer disposes a challenge as `uncertainty-accepted` and records the uncertainty and its falsifier in the decision record
- **THEN** the challenge SHALL NOT block advancement
- **AND** the accepted uncertainty SHALL appear in the evidence bundle and the human-readable summary

#### Scenario: disposition preserved across re-review
- **WHEN** a challenge was recorded as `defended` in round 1 and the round 2 verdict does not re-emit its `challengeKey`
- **THEN** the challenge SHALL remain `defended` in the persisted state
- **AND** the implementer SHALL NOT be asked to defend it again

#### Scenario: unsupported disposition is rejected
- **WHEN** the implementer marks a challenge `defended` without citing any evidence
- **THEN** the disposition SHALL be rejected and the challenge SHALL remain unresolved

---

### Requirement: The gate loop SHALL be bounded and recurrence-aware

The interrogation/response loop SHALL run at most `design_gate.max_rounds` rounds. When a blocking
`challengeKey` from the immediately-prior round is re-emitted as blocking after a response round, the
gate SHALL transition to `needs-human` immediately, without consuming further round budget. When
`max_rounds` is exhausted with at least one blocking challenge unresolved, the gate SHALL also
transition to `needs-human`. In both cases the gate SHALL first post a punch-list comment naming each
unresolved challenge, its `challengeKey`, its severity, and its `required_action`, and SHALL NOT
auto-advance to `review-1`.

#### Scenario: recurring blocking challenge parks early
- **WHEN** a blocking `challengeKey` from the prior round is re-emitted as blocking after a response round
- **THEN** the issue SHALL transition to `needs-human`
- **AND** the punch-list comment SHALL be posted before the transition
- **AND** remaining round budget SHALL be irrelevant to the decision

#### Scenario: round budget exhausted with blocking challenges
- **WHEN** `max_rounds` rounds have run and at least one blocking challenge is unresolved
- **THEN** the issue SHALL transition to `needs-human` with the punch-list comment
- **AND** the issue SHALL NOT transition to `review-1`

#### Scenario: all blocking challenges resolved within budget
- **WHEN** every blocking challenge is dispositioned and the re-review re-emits none of their keys as blocking
- **THEN** the gate SHALL advance to `review-1`

---

### Requirement: The gate SHALL be resumable after an interrupted run

The gate SHALL persist its trigger record, decision record, per-round challenges, dispositions, and
round counter so that a re-entry after a crash or interruption rehydrates that state. On re-entry the
gate SHALL resume at the first round that has not completed and SHALL NOT re-invoke a completed
reviewer round or discard recorded dispositions.

#### Scenario: crash after the interrogation round
- **WHEN** the pipeline is interrupted after a reviewer verdict is persisted but before the response round completes
- **AND** the pipeline is re-invoked on the same issue
- **THEN** the gate SHALL rehydrate the persisted verdict and dispositions
- **AND** SHALL NOT re-invoke the reviewer for that round

#### Scenario: crash before any round completes
- **WHEN** the pipeline is interrupted after triggering but before any reviewer verdict is persisted
- **AND** the pipeline is re-invoked on the same issue
- **THEN** the gate SHALL start the interrogation round from the persisted decision record without re-running `implementing`

---

### Requirement: The gate SHALL NOT expand scope or acquire merge authority

The interrogation prompt SHALL scope challenges to the decision record, the issue, and the approved
plan; challenges that propose product scope beyond them SHALL be dispositioned as out-of-scope with a
tracked follow-up rather than expanding the change. The gate SHALL NOT capture private chain-of-thought
or raw hidden model reasoning, SHALL NOT replace plan review or diff review, and SHALL NOT merge or
release anything.

#### Scenario: out-of-scope challenge is deferred
- **WHEN** a challenge proposes behavior outside the issue and the approved plan
- **THEN** it SHALL be dispositioned as out-of-scope with a follow-up reference
- **AND** it SHALL NOT block advancement

#### Scenario: gate never merges
- **WHEN** the `design-gate` stage completes with any outcome
- **THEN** no merge or release operation SHALL be invoked
- **AND** the downstream review stages SHALL still run as configured

