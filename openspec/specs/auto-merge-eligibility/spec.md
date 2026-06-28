# auto-merge-eligibility Specification

## Purpose
TBD - created by archiving change auto-merge-eligibility-gate. Update Purpose after archive.
## Requirements
### Requirement: Deterministic policy envelope hard-denies high-risk PRs before LLM judge
The auto-merge eligibility gate SHALL evaluate a fixed set of deterministic policy checks before invoking the LLM risk judge. If any hard-deny condition is met, the gate SHALL immediately classify the PR as `needs-human`, record all triggered denial reasons in the eligibility artifact, and SHALL NOT invoke the LLM judge.

Hard-deny conditions SHALL include: any changed file matching a built-in deny pattern (migrations, auth, billing, security, infra/deployment config, secrets/env files, dependency manifests, cron/scheduler config, public API surface files, release config, production config); diff line count exceeding `max_diff_lines`; file count exceeding `max_files`; any changed file matching a user-configured `deny_paths` pattern; changed files not fully covered by `allow_paths` when `allow_paths` is non-empty; absence of a passing CI run; presence of unresolved review comments; an unclean pipeline review verdict; a missing or incomplete evidence bundle; behavioral code changes with no accompanying tests and no explicit no-test rationale; or the PR not being linked to exactly one pipeline run artifact.

The built-in deny path patterns SHALL be a compile-time constant and SHALL NOT be overridable by repo config.

#### Scenario: migration file triggers hard deny
- **WHEN** the PR diff includes a file matching `**/migrations/**` or `**/*.migration.*`
- **THEN** the gate SHALL set `eligibility: "needs-human"` in the artifact
- **AND** SHALL record `"touches: migrations"` in `denial_reasons`
- **AND** SHALL NOT invoke the LLM judge

#### Scenario: diff line threshold exceeded
- **WHEN** the PR total diff line count exceeds `config.auto_merge_eligibility.max_diff_lines`
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"diff_lines: <N> exceeds max <M>"` in `denial_reasons`
- **AND** SHALL NOT invoke the LLM judge

#### Scenario: deny_paths config pattern matches
- **WHEN** a changed file matches any pattern in `config.auto_merge_eligibility.deny_paths`
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record the matched pattern in `denial_reasons`

#### Scenario: missing CI success hard-denies
- **WHEN** no passing CI run exists for the PR head SHA at gate evaluation time
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"ci: no passing run"` in `denial_reasons`

#### Scenario: unresolved review comments hard-denies
- **WHEN** the PR has one or more unresolved review comment threads
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"unresolved_review_comments: <N>"` in `denial_reasons`

#### Scenario: behavioral change without tests hard-denies
- **WHEN** the diff includes changes to non-test source files
- **AND** no test files are modified
- **AND** the evidence bundle contains no explicit `no_test_rationale` field
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"missing_tests: behavioral change without tests or rationale"` in `denial_reasons`

---

### Requirement: LLM judge classifies risk within the deterministic envelope
When all deterministic policy checks pass, the gate SHALL invoke the LLM risk judge using the `reviewMode: prompt-harness` invocation pattern. The judge SHALL be provided with: the PR diff summary, file list, review verdict summary, CI status, evidence bundle metadata, linked issue/spec IDs, and the issue scope statement.

The judge prompt SHALL instruct the judge to return a JSON object matching the `EligibilityJudgeOutput` schema. The schema SHALL be single-sourced and drift-guarded by a test, following the same pattern as `review-schema.ts`.

The judge output SHALL be validated against the schema before use. If validation fails, the gate SHALL classify as `needs-human` and record `"judge: schema validation failed"` as a denial reason.

#### Scenario: judge invoked after all deterministic checks pass
- **WHEN** no hard-deny condition is met
- **THEN** the gate SHALL invoke the LLM judge with the PR context payload
- **AND** SHALL validate the judge's JSON output against `EligibilityJudgeOutput` schema

#### Scenario: judge returns well-formed output with high confidence and no denials
- **WHEN** the judge output has `confidence >= min_confidence` and `denial_reasons: []`
- **AND** `blast_radius: "low"` and `semantic_risk: "mechanical"` or `"localized_behavior"`
- **THEN** the gate SHALL set `eligibility: "auto-merge-eligible"` in the artifact

#### Scenario: judge returns invalid JSON
- **WHEN** the judge harness returns output that fails `EligibilityJudgeOutput` schema validation
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"judge: schema validation failed"` in `denial_reasons`

#### Scenario: judge confidence below threshold
- **WHEN** the judge output has `confidence < config.auto_merge_eligibility.min_confidence`
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"judge: confidence <score> below min_confidence <threshold>"` in `denial_reasons`

#### Scenario: judge emits explicit denial reasons
- **WHEN** the judge output has one or more entries in `denial_reasons`
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL propagate all judge denial reasons into the artifact's `denial_reasons`

#### Scenario: judge invocation timeout or harness error
- **WHEN** the judge harness call times out or returns a non-zero exit code
- **THEN** the gate SHALL set `eligibility: "needs-human"`
- **AND** SHALL record `"judge: harness error or timeout"` in `denial_reasons`

---

### Requirement: LLM judge output conforms to the EligibilityJudgeOutput schema
The `EligibilityJudgeOutput` schema SHALL define the following fields:

- `scope_size`: one of `"tiny" | "small" | "medium" | "large"` — estimated change size
- `blast_radius`: one of `"low" | "medium" | "high"` — impact envelope if the change regresses
- `semantic_risk`: one of `"mechanical" | "localized_behavior" | "cross_cutting_behavior"` — nature of behavioral change
- `reversibility`: one of `"trivial" | "normal" | "painful"` — ease of rollback
- `confidence`: a number in `[0, 1]` — judge's confidence in the classification
- `reasons`: a non-empty array of strings — supporting evidence for the classification
- `denial_reasons`: an array of strings (may be empty) — explicit reasons the judge recommends `needs-human`

All fields SHALL be required. The schema SHALL be single-sourced in `auto-merge-eligibility-schema.ts` and referenced in both the judge prompt template and the gate stage handler.

#### Scenario: valid judge output accepted
- **WHEN** the judge returns JSON with all required fields and valid enum values
- **THEN** schema validation SHALL pass and the gate SHALL proceed to the eligibility decision

#### Scenario: missing required field causes schema failure
- **WHEN** the judge output omits `blast_radius`
- **THEN** schema validation SHALL fail
- **AND** the gate SHALL classify as `needs-human` with reason `"judge: schema validation failed"`

#### Scenario: out-of-range confidence value causes schema failure
- **WHEN** the judge output has `confidence: 1.5`
- **THEN** schema validation SHALL fail

---

### Requirement: Eligibility gate is a no-op when disabled
When `config.auto_merge_eligibility.enabled` is `false` (the default), the gate SHALL perform no deterministic checks, invoke no LLM judge, and write no `auto_merge_eligibility` artifact to the evidence bundle. The `shipcheck-gate` handler SHALL proceed as if the gate code were absent.

#### Scenario: gate disabled by default
- **WHEN** `.github/pipeline.yml` has no `auto_merge_eligibility` block
- **THEN** the gate SHALL NOT be invoked
- **AND** no `auto_merge_eligibility` artifact SHALL appear in the evidence bundle

#### Scenario: gate enabled by config
- **WHEN** `.github/pipeline.yml` sets `auto_merge_eligibility.enabled: true`
- **THEN** the gate SHALL run deterministic checks and invoke the LLM judge if all checks pass

---

### Requirement: Deterministic check results must not be overridable by the LLM judge
The gate SHALL evaluate deterministic policy checks independently of and before the LLM judge. The judge output SHALL NOT be able to override a hard denial. If a hard-deny condition fires, `eligibility` SHALL be `"needs-human"` regardless of what the judge would have returned.

#### Scenario: judge cannot override hard denial
- **WHEN** a hard-deny condition fires (e.g. migration file changed)
- **AND** the LLM judge (if it were invoked) would classify as `auto-merge-eligible`
- **THEN** the gate SHALL NOT invoke the judge
- **AND** SHALL return `eligibility: "needs-human"` with the deterministic denial reason

---

### Requirement: Eligibility gate persists a durable decision artifact
After reaching an eligibility verdict, the gate SHALL write an `auto_merge_eligibility` artifact to the run evidence bundle via the evidence bundle's standard record API. The artifact SHALL be written before run finalization so that `summary.json` contains it.

The artifact SHALL include:
- `eligibility`: `"auto-merge-eligible"` or `"needs-human"`
- `evaluated_at`: ISO 8601 timestamp of gate evaluation
- `deterministic_checks`: array of `{ check: string; passed: boolean; reason?: string }` for every check evaluated
- `denial_reasons`: consolidated array of all denial reasons (deterministic + judge)
- `judge_output`: the raw validated `EligibilityJudgeOutput` object, or `null` if the judge was not invoked
- `ci_status_snapshot`: `{ sha: string; conclusion: string; checked_at: string }`
- `review_verdict_snapshot`: `{ verdict: string; finding_count: number; recorded_at: string }`
- `linked_run_id`: the pipeline run ID
- `linked_issue`: the GitHub issue number
- `linked_pr`: the GitHub PR number
- `revert_note`: a human-readable string describing how to revert the change (e.g. `"git revert <sha>"` or `"gh pr close <N>"`)

#### Scenario: eligible artifact written before finalization
- **WHEN** the gate classifies a PR as `auto-merge-eligible`
- **THEN** the evidence bundle SHALL contain an `auto_merge_eligibility` artifact before `summary.json` is written
- **AND** the artifact SHALL have `eligibility: "auto-merge-eligible"`

#### Scenario: needs-human artifact contains all denial reasons
- **WHEN** the gate classifies a PR as `needs-human` with two hard-deny conditions and one judge denial
- **THEN** `denial_reasons` SHALL contain all three denial reason strings

#### Scenario: artifact includes ci_status_snapshot
- **WHEN** the gate evaluates a PR
- **THEN** the artifact SHALL include `ci_status_snapshot.sha` matching the PR head SHA at evaluation time

#### Scenario: artifact includes revert_note
- **WHEN** the artifact is written
- **THEN** `revert_note` SHALL be a non-empty string containing at minimum the merge commit SHA or `gh pr revert` instruction

---

### Requirement: Eligibility result is surfaced in CLI output at run end
When the eligibility gate has run (i.e., `auto_merge_eligibility.enabled: true`), the pipeline run summary output SHALL include the eligibility verdict and, if `needs-human`, the top-level denial reasons. The output SHALL appear in the run summary that is posted as a GitHub comment and printed to stdout.

#### Scenario: eligible result shown in summary
- **WHEN** the gate classifies a PR as `auto-merge-eligible`
- **THEN** the run summary SHALL include a line such as `Auto-merge eligibility: ELIGIBLE`

#### Scenario: needs-human result with reasons shown in summary
- **WHEN** the gate classifies a PR as `needs-human`
- **THEN** the run summary SHALL include `Auto-merge eligibility: NEEDS HUMAN` and the denial reasons

#### Scenario: gate disabled — no eligibility line in summary
- **WHEN** `auto_merge_eligibility.enabled: false`
- **THEN** the run summary SHALL NOT include any `Auto-merge eligibility` line

