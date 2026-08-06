## 1. Reproduce and pin the false-negative

- [ ] 1.1 Confirm the production path: Grok `streaming-json` + `captureMode: "tail"` + `MAX_OUTPUT` + `makeGrokForwardTransform` + `parseGrokTelemetry` → `HarnessResult.stdout` used by `plan-revision.ack@1` in `planning.ts`.
- [ ] 1.2 Build a synthetic streaming-json fixture whose plain product text starts with a valid `## Feedback Incorporated` section and tagged items, then a large plan body such that raw JSONL length exceeds production `MAX_OUTPUT`.
- [ ] 1.3 Write a failing regression test that runs capture/reconstruction under production Grok settings and asserts the product stdout used for contracts currently **drops** the leading ack (test bites pre-fix) — then will flip to expect pass after the fix.
- [ ] 1.4 Assert `verifyPlanRevisionOutput` / `plan-revision.ack@1` on the **forwarded** plain text is ok while the pre-fix reconstructed stdout is not (documents transcript-vs-stage disagreement).

## 2. Product-text capture seam

- [ ] 2.1 Implement a product-text accumulation path in `runCapped` / `invoke` that records complete plain assistant text from `transformForward` (or equivalent) independently of the raw telemetry buffer’s tail bound.
- [ ] 2.2 Ensure freeform consumers receive that complete product text as `HarnessResult.stdout` (or an explicit product field stages already read) after telemetry parse, without inventing text that was never streamed.
- [ ] 2.3 Keep telemetry cost/usage recovery from the tail-capped (or dual-buffered) raw envelope; add/adjust a test that terminal `type:end` cost still parses under the large-stream fixture.
- [ ] 2.4 Choose and document product-text bounding: head-preserving / separate plain-text cap; never silently tail-drop leading product sections used by freeform contracts. Fail visibly if a hard product bound is exceeded.
- [ ] 2.5 Prefer a general seam for any adapter with forward transform + tail raw capture; avoid Grok-only special cases in stage code. Confirm Claude/Codex telemetry and verdict paths do not regress.

## 3. Contract and planning path

- [ ] 3.1 Confirm `plan-revision.ack@1` validation input is the complete product text (no `terminal.log` scrape; pure validators remain pure).
- [ ] 3.2 Confirm format-repair runs only on true product-text misses; large-stream leading-ack case does **not** enter format-repair or report missing section.
- [ ] 3.3 Confirm true absence still format-repairs once then terminal `harness-contract` with existing reason strings.
- [ ] 3.4 Existing mid-line (#658), fenced-section, multi-header, and no-items cases remain green.

## 4. Grok fixtures and version pin

- [ ] 4.1 Re-check Grok streaming-json fixtures / `verified-against` against current CLI if available; update pin and fixtures only if envelope shape actually changed (0.2.118 drift is secondary, not the root fix).
- [ ] 4.2 Extend Grok fixtures only as needed for the large-stream product-text regression; keep non-throwing parse on truncated raw capture.

## 5. Tests, mirror, and gate

- [ ] 5.1 Unit tests: product completeness under tail raw capture; cost recovery still works; true-missing ack still fails; no invented section.
- [ ] 5.2 Integration or planning-path test: `plan-revision.ack@1` passes for large leading-ack stream under production Grok capture settings.
- [ ] 5.3 Prove the primary regression failed before the product-text fix and passes after.
- [ ] 5.4 Run `node scripts/build.mjs` and commit regenerated `plugin/` with any `core/` change.
- [ ] 5.5 Run `npm run ci` (or at minimum `ci:core` + `build.mjs --check` + `openspec validate --all`) and fix failures.

## 6. Optional stretch (not ship-blocking)

- [ ] 6.1 Durable recovery: when evidence shows capture/reconstruction loss rather than true omission, prefer re-invoke plan-revision or re-parse product artifact over full replan — only if low-risk and scoped.
- [ ] 6.2 Operator-facing diagnostic hint when product text and raw capture diverge in length (debug aid).
