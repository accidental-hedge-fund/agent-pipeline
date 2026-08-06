## ADDED Requirements

### Requirement: Streaming telemetry tail capture SHALL preserve complete product assistant text for freeform consumers

When a harness adapter enables machine-readable streaming output and uses tail-bounded capture of the raw envelope (so a terminal cost/usage record remains recoverable under large streams), the pipeline SHALL still expose **complete reconstructed plain assistant product text** to freeform and markdown stage consumers.

Product text SHALL be accumulated from the same assistant deltas the adapter’s forward transform prints for human observation (or an equivalent reconstruction that does not depend solely on a tail-truncated raw JSONL buffer). Tail truncation of the raw telemetry envelope MUST NOT cause `HarnessResult.stdout` (or the field freeform contracts read) to omit leading product content that was successfully streamed and forwarded.

Telemetry fields (`costUsd`, `usage`, `resolvedModel`, `throttled`) MAY continue to be parsed from a tail-capped or dual-buffered raw capture. Accounting recovery under large streams SHALL remain available when the terminal envelope line is present in the retained raw capture.

If product plain text itself exceeds an implemented bound, the pipeline SHALL fail visibly or preserve a head-biased product buffer that retains leading sections; it SHALL NOT silently tail-truncate product text used by freeform contracts in a way that drops a leading machine-checkable section while keeping only the plan tail.

#### Scenario: Leading product text survives when raw JSONL exceeds the capture cap

- **WHEN** a streaming-json adapter with production tail capture emits a large stream whose raw envelope length exceeds the raw capture cap
- **AND** the plain assistant product text begins with content that appears only in the first portion of the stream
- **THEN** the product text exposed as harness stdout for freeform consumers SHALL still include that leading content
- **AND** the pipeline SHALL NOT report that leading content as absent solely because the raw envelope buffer was tail-truncated

#### Scenario: Terminal cost envelope remains recoverable under large streams

- **WHEN** the same large streaming-json run ends with a complete terminal cost/usage envelope record
- **AND** that record is retained under the adapter’s telemetry capture strategy
- **THEN** `parseTelemetry` SHALL still recover cost and usage fields from that terminal record
- **AND** freeform product text completeness SHALL NOT require abandoning cost recovery

#### Scenario: Grok production settings are covered by regression

- **WHEN** unit or integration tests exercise Grok production capture settings (`--output-format streaming-json`, `captureMode: "tail"`, production raw `MAX_OUTPUT`, Grok forward transform and `parseGrokTelemetry` as used by `invoke`)
- **AND** a synthetic stream places a valid plan-revision acknowledgement only in the first ~20% of the stream with a large trailing plan body
- **THEN** the reconstructed product stdout SHALL contain that acknowledgement for contract validation
- **AND** the regression SHALL fail against the pre-fix tail-only product reconstruction behavior

#### Scenario: Truly missing product text is not invented

- **WHEN** the adapter streams no acknowledgement section in any forwarded product delta
- **THEN** reconstructed product text SHALL NOT fabricate a `## Feedback Incorporated` section
- **AND** freeform contract validation SHALL see the true absence
