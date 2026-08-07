## ADDED Requirements

### Requirement: Plan-revision acknowledgement validation SHALL use complete product text not a telemetry-tail fragment

Verification of the plan-revision acknowledgement contract (`plan-revision.ack@1` or successor) SHALL run on the **complete reconstructed assistant product text** for that harness invocation — the same plain product content freeform consumers receive after envelope normalization — and SHALL NOT treat a telemetry-tail-truncated fragment as authoritative product stdout when that fragment omits leading content that was successfully streamed and forwarded during the same invocation.

When the complete product text contains a valid `## Feedback Incorporated` section with at least one line-start `[ADDRESSED]` or `[DEFERRED]` item (subject to existing mid-line, fence, and multi-header tolerances), the step SHALL accept the acknowledgement and SHALL NOT report `"Plan revision output is missing required ## Feedback Incorporated section"` solely because raw telemetry capture dropped early envelope lines.

Shared format-repair SHALL run only when the complete product text still lacks a valid acknowledgement after existing normalisation. Format-repair MUST NOT be triggered solely by capture/reconstruction loss of a section already present in the complete product text for that invocation.

Existing true-negative behavior is preserved: after normalisation and exhaustion of the shared format-repair budget, absence of a valid section or presence of a header with no tagged items still blocks with the existing reasons and terminal `harness-contract` diagnostic.

#### Scenario: Leading Feedback Incorporated on a large Grok plan-revision passes

- **WHEN** the plan-revision harness (Grok or any streaming-json + tail-capture adapter) exits 0
- **AND** the complete product text begins with a valid `## Feedback Incorporated` section and tagged items, followed by a large revised plan whose raw envelope exceeded the telemetry capture cap
- **THEN** `plan-revision.ack@1` validation SHALL succeed
- **AND** the step SHALL post the revised plan as an issue comment and proceed
- **AND** the step SHALL NOT report `"Plan revision output is missing required ## Feedback Incorporated section"`

#### Scenario: Format-repair is not false-triggered by capture-only loss

- **WHEN** the complete product text for a plan-revision invocation already contains a valid acknowledgement section
- **AND** a tail-truncated raw telemetry buffer alone would omit that section
- **THEN** the step SHALL NOT treat the invocation as an output-contract failure
- **AND** SHALL NOT spend the shared format-repair budget for that false miss

#### Scenario: True absence still format-repairs then terminal harness-contract

- **WHEN** the plan-revision harness exits 0
- **AND** the complete product text lacks a valid `## Feedback Incorporated` section with at least one tagged item after normalisation
- **AND** the shared format-repair budget has not been exhausted
- **THEN** the step SHALL re-invoke through the shared format-repair policy
- **AND** after budget exhaustion without a compliant section, the step SHALL block with reason `"Plan revision output is missing required ## Feedback Incorporated section"` and terminal diagnostic reason `harness-contract`

#### Scenario: Offline transcript agreement with complete product text

- **WHEN** an operator extracts a `## Feedback Incorporated` chunk from the human-forwarded plan-revision transcript for the same invocation
- **AND** `verifyPlanRevisionOutput` returns ok on that chunk
- **THEN** the stage’s contract input derived from complete product text SHALL also satisfy `plan-revision.ack@1` for that invocation (no transcript-vs-stage disagreement caused by telemetry tail truncation)
