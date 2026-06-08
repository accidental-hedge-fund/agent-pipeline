## 1. Fallback Logging in parseStructuredVerdict

- [x] 1.1 Add `console.warn("[pipeline] warning: verdict fallback — no structured JSON found in reviewer output; raw attached")` in the fallback branch of `parseStructuredVerdict` (`review.ts`)
- [x] 1.2 Confirm `_raw` is always set on the fallback return (already present at line 377; verify it is never omitted)

## 2. Normalization Gate in advanceReview

- [x] 2.1 Add optional `retryCount?: number` parameter (default 0) to `advanceReview` signature
- [x] 2.2 After parsing the verdict and before routing to fix, add gate: if `verdict.verdict === "needs-attention"` and `verdict.findings.length === 0` and `retryCount === 0`, invoke `advanceReview` recursively with `retryCount: 1` and return its result
- [x] 2.3 If `verdict.verdict === "needs-attention"` and `verdict.findings.length === 0` and `retryCount >= 1`, call `setBlocked` with a message that includes the raw output (`verdict._raw`) and return `{ advanced: false, status: "blocked", reason: "needs-attention with 0 findings on re-review" }`
- [x] 2.4 Log `[pipeline] #N: needs-attention+0-findings — triggering re-review (attempt retryCount+1)` before the re-review call

## 3. Regression Tests

- [x] 3.1 In `review.test.ts`: add test — `parseStructuredVerdict` with prose-only input sets `_raw`, returns `needs-attention`
- [x] 3.2 In `review.test.ts`: add test — `parseStructuredVerdict` with valid fenced JSON `verdict: "approve"` does NOT set `_raw`
- [x] 3.3 In `review.test.ts`: add test — `advanceReview` with mocked harness returning `needs-attention`+`findings:[]` on first call does NOT call fix-stage transition (`transition` to `fix-1`/`fix-2`)
- [x] 3.4 In `review.test.ts`: add test — `advanceReview` with `retryCount: 1` and mocked harness returning `needs-attention`+`findings:[]` calls `setBlocked`, does NOT transition to fix stage

## 4. Verification

- [x] 4.1 Run `pnpm test` and confirm all existing tests still pass alongside new regression tests
- [x] 4.2 Confirm the fix-stage is unreachable from a 0-findings `needs-attention` in both round-1 and round-2 by tracing call paths manually or with a targeted test
