## ADDED Requirements

### Requirement: Prompt single-turn text SHALL NOT be treated as lifecycle proof

The existing single-turn prompt discipline in `implementing.md`, `fix.md`, `test_fix.md`,
`eval_fix.md`, and `visual_fix.md` SHALL remain. The pipeline SHALL still permit a
lifecycle-tracked background job on an adapter that declares `background_job_lifecycle`
supported. The pipeline SHALL NOT treat prompt wording, a missing foreground instruction, or
generic inactivity as proof of a background wait, as a protocol violation, or as
`harness-background-wait`. Detection and termination of a missed delivery or join remain the
typed lifecycle rules in `harness-background-job-lifecycle`.

#### Scenario: A lifecycle-tracked background job is not a prompt-discipline failure

- **WHEN** a supporting adapter starts a background job during implement or a gate-fix and later
  emits typed complete, delivery, and foreground-join inside the effective grace
- **THEN** the pipeline SHALL accept that job as a valid background execution
- **AND** SHALL NOT fail the invocation solely because the prompt told the harness to run in the
  foreground

#### Scenario: Prompt waiting prose is not a hang classifier

- **WHEN** a prompt-loader assertion still requires the single-turn discipline text
- **AND** a harness transcript contains waiting-for-notification wording without typed
  complete-or-fail-without-join evidence
- **THEN** the prompt assertion SHALL still pass when the discipline text is present
- **AND** the pipeline SHALL NOT emit `harness-background-wait` from that wording
