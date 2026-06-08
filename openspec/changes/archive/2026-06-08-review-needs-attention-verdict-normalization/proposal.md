## Why

When `parseStructuredVerdict` cannot find a valid JSON verdict in the reviewer's output, it falls back to `parseTextVerdict`, which defaults to `needs-attention` with `findings: []`. The routing logic in `advanceReview` then sends that 0-finding verdict directly to a fix stage, burning a full harness invocation on nothing concrete and producing semantically misleading "fixes pushed" pipeline comments. This was observed live in the #34 run (PR #44).

## What Changes

- **Normalization gate in `advanceReview`**: before routing `needs-attention` to a fix stage, check `findings.length`. If 0, trigger a re-review instead of a fix round.
- **Re-review-once policy**: if the re-review still yields `needs-attention`+0 findings (or still can't be parsed into a real structured verdict), transition to `blocked` and surface the raw companion output in the PR comment — do **not** auto-approve.
- **Fallback logging**: emit a `[pipeline] warning: verdict fallback — no structured JSON found; raw output attached` log line (and set `_raw`) whenever `parseStructuredVerdict` takes the text-based path, so silent degradation becomes visible.
- **Regression tests**: unit tests that assert `needs-attention`+0 findings never invokes the fix harness, and that native-review prose vs schema JSON both parse to correct verdicts.

## Capabilities

### New Capabilities

- `verdict-normalization`: Normalization policy applied to review verdicts before pipeline routing — specifically, the rule that a `needs-attention` verdict with zero enumerated findings triggers a re-review rather than a fix stage, and blocks with raw output if re-review still cannot yield a structured verdict.

### Modified Capabilities

(none — no existing spec-level requirements change; `parseStructuredVerdict` behavior and routing logic are implementation-level changes captured here for the first time)

## Impact

- `core/scripts/stages/review.ts` — `advanceReview` routing logic, `parseStructuredVerdict` fallback logging
- `core/scripts/stages/review.test.ts` — regression tests for the normalization gate and parse paths
- Pipeline PR comments — blocked state now surfaces raw reviewer output when re-review also fails to parse
