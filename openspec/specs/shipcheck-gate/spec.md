# shipcheck-gate Specification

## Purpose
TBD - created by archiving change private-eval-shipcheck-gate. Update Purpose after archive.
## Requirements
### Requirement: Repo opts in via shipcheck_gate config block
A repo opts in to the shipcheck gate by declaring a `shipcheck_gate` block in `.github/pipeline.yml` with `enabled: true`. The gate SHALL be disabled by default when the block is absent or when `enabled` is `false`.

#### Scenario: shipcheck_gate block present with enabled true
- **WHEN** `.github/pipeline.yml` contains `shipcheck_gate.enabled: true`
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL be `true`

#### Scenario: shipcheck_gate block absent
- **WHEN** `.github/pipeline.yml` has no `shipcheck_gate` block
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL default to `false`

#### Scenario: shipcheck_gate.enabled false
- **WHEN** `.github/pipeline.yml` contains `shipcheck_gate.enabled: false`
- **THEN** `PipelineConfig.shipcheck_gate.enabled` SHALL be `false`

---

### Requirement: shipcheck-gate is a distinct pipeline stage between eval-gate and ready-to-deploy
The constant `STAGES` SHALL include `"shipcheck-gate"` positioned after `"eval-gate"` and before `"ready-to-deploy"`. The orchestrator dispatch table SHALL route `"shipcheck-gate"` to the shipcheck stage handler.

#### Scenario: STAGES ordering
- **WHEN** the `STAGES` constant is inspected
- **THEN** `"shipcheck-gate"` SHALL appear at an index greater than the index of `"eval-gate"`
- **AND** `"shipcheck-gate"` SHALL appear at an index less than the index of `"ready-to-deploy"`

#### Scenario: dispatch routes shipcheck-gate
- **WHEN** the current stage label is `pipeline:shipcheck-gate`
- **THEN** the orchestrator SHALL call the shipcheck stage handler

---

### Requirement: shipcheck-gate stage is skipped when shipcheck_gate is not enabled
When `shipcheck_gate.enabled` is false (or the config block is absent), the `shipcheck-gate` stage SHALL transition immediately to `ready-to-deploy` with a "step disabled" log line, without invoking any harness and without posting any comment.

#### Scenario: shipcheck_gate disabled — stage is skipped
- **WHEN** the current stage is `shipcheck-gate`
- **AND** `cfg.shipcheck_gate.enabled` is `false`
- **THEN** the stage SHALL call `transition(cfg, issueNumber, "shipcheck-gate", "ready-to-deploy", "shipcheck-gate step disabled; skipping.")`
- **AND** SHALL NOT invoke the reviewer harness
- **AND** SHALL NOT post any comment

---

### Requirement: Reviewer harness evaluates the rubric; implementing harness is excluded
The `shipcheck-gate` stage SHALL invoke `cfg.harnesses.reviewer` (the reviewer role harness) with the shipcheck prompt. The implementing harness (`cfg.harnesses.implementer`) SHALL NOT be invoked during shipcheck evaluation. This separation ensures the builder does not self-certify.

#### Scenario: reviewer harness is invoked
- **WHEN** the current stage is `shipcheck-gate`
- **AND** `cfg.shipcheck_gate.enabled` is `true`
- **THEN** the stage SHALL invoke `cfg.harnesses.reviewer` with the assembled shipcheck prompt
- **AND** SHALL NOT invoke `cfg.harnesses.implementer`

---

### Requirement: Rubric is loaded from the repo-local rubric_path
The stage SHALL load the rubric text from the file at `cfg.shipcheck_gate.rubric_path` (default `.github/shipcheck-rubric.md`) relative to the repo root. If the file does not exist, the stage SHALL use the issue's acceptance criteria as the rubric (falling back to the issue body when ACs are absent) and SHALL log a warning identifying the missing file.

#### Scenario: rubric file present
- **WHEN** `cfg.shipcheck_gate.rubric_path` resolves to an existing file
- **THEN** the stage SHALL read and embed that file's contents in the shipcheck prompt as the rubric

#### Scenario: rubric file absent — fallback to issue ACs
- **WHEN** the file at `rubric_path` does not exist
- **THEN** the stage SHALL log a warning identifying the missing file
- **AND** SHALL use the issue body's acceptance-criteria section (or full issue body) as the rubric in the prompt

---

### Requirement: Shipcheck prompt includes issue body, plan, changed files, eval summary, and OpenSpec deltas
The shipcheck prompt sent to the reviewer harness SHALL include: (1) the rubric text, (2) the issue body, (3) the plan and acceptance criteria from the planning stage output (if available), (4) a summary of changed files (file names and line-count deltas), (5) the eval summary from the evidence bundle when available, and (6) OpenSpec change deltas when the issue references an OpenSpec change.

#### Scenario: full context assembled
- **WHEN** planning output, changed files, and an evidence bundle with eval results are all available
- **THEN** the assembled prompt SHALL contain sections for rubric, issue body, plan/ACs, changed-files summary, and eval summary

#### Scenario: eval results absent
- **WHEN** no evidence bundle eval entry is available (e.g. eval-gate disabled)
- **THEN** the prompt SHALL note "eval results: not available" rather than omitting the section entirely

---

### Requirement: Reviewer returns a structured shipcheck verdict
The reviewer harness SHALL return a JSON object conforming to the `ShipcheckVerdict` schema: `{ verdict: "pass" | "partial" | "fail", summary: string, criteria: Array<{ criterion: string, result: "pass" | "fail" | "na", note: string }> }`. The schema SHALL be single-sourced in `review-schema.ts` alongside the review verdict schema and drift-guarded by the existing schema constant test.

#### Scenario: valid verdict returned
- **WHEN** the reviewer returns valid JSON matching `ShipcheckVerdict`
- **THEN** the stage SHALL parse the verdict without fallback
- **AND** `criteria` SHALL list one entry per rubric criterion evaluated

#### Scenario: unparseable reviewer output — conservative fallback
- **WHEN** the reviewer output contains no JSON matching `ShipcheckVerdict`
- **THEN** the verdict SHALL default to `"fail"` with `summary` set to the raw output (truncated)
- **AND** a warning SHALL be logged

---

### Requirement: Advisory mode records findings without blocking; gate mode blocks on fail
`cfg.shipcheck_gate.mode` SHALL control blocking behavior. In `advisory` mode (default) the stage SHALL post the verdict comment and transition to `ready-to-deploy` regardless of the verdict. In `gate` mode the stage SHALL block `ready-to-deploy` on a `fail` verdict (and optionally on `partial` when `block_on_partial` is `true`, default `false`).

#### Scenario: advisory mode — fail verdict still advances
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"` (or absent/default)
- **AND** the reviewer returns `verdict: "fail"`
- **THEN** the stage SHALL post the verdict comment
- **AND** SHALL transition to `ready-to-deploy`

#### Scenario: gate mode — fail verdict blocks
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer returns `verdict: "fail"`
- **THEN** the stage SHALL call `setBlocked` and SHALL NOT advance to `ready-to-deploy`

#### Scenario: gate mode — pass verdict advances
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer returns `verdict: "pass"`
- **THEN** the stage SHALL transition to `ready-to-deploy`

#### Scenario: gate mode — partial verdict respects block_on_partial
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** `cfg.shipcheck_gate.block_on_partial` is `false` (default)
- **AND** the reviewer returns `verdict: "partial"`
- **THEN** the stage SHALL post the verdict comment and transition to `ready-to-deploy`

---

### Requirement: Result is posted to the issue/PR with per-criterion detail
The stage SHALL post a comment to the issue (and PR when one exists) that includes: the overall verdict (`pass`/`partial`/`fail`), the summary, and a per-criterion breakdown table. In advisory mode the comment SHALL be labeled "Shipcheck (advisory)". In gate mode the comment SHALL be labeled "Shipcheck" with a clear block or pass outcome.

#### Scenario: advisory mode comment label
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"`
- **THEN** the posted comment header SHALL include the text "advisory"

#### Scenario: per-criterion table present
- **WHEN** the reviewer returns a verdict with non-empty `criteria`
- **THEN** the comment SHALL include a table or list with one row per criterion showing `result` and `note`

---

### Requirement: Gate is bounded by max_rounds; timeout surfaces as needs-human or advisory warning
`cfg.shipcheck_gate.max_rounds` (default 1) limits the number of reviewer invocations. If the verdict is not parseable after all rounds, the stage SHALL: in gate mode, call `setBlocked` with a `needs-human` blocker kind; in advisory mode, log a warning and advance to `ready-to-deploy`. The gate SHALL NOT silently pass on parse failure or timeout in either mode.

#### Scenario: parse failure in gate mode after max_rounds
- **WHEN** `cfg.shipcheck_gate.mode` is `"gate"`
- **AND** the reviewer output is unparseable after `max_rounds` attempts
- **THEN** the stage SHALL call `setBlocked` with blocker kind `needs-human`
- **AND** SHALL NOT advance to `ready-to-deploy`

#### Scenario: parse failure in advisory mode after max_rounds
- **WHEN** `cfg.shipcheck_gate.mode` is `"advisory"`
- **AND** the reviewer output is unparseable after `max_rounds` attempts
- **THEN** the stage SHALL log a warning
- **AND** SHALL transition to `ready-to-deploy`

