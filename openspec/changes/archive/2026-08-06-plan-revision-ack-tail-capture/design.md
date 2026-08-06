## Context

Production Grok plan-revision (and any adapter that mirrors this pattern) uses:

1. `--output-format streaming-json` — JSONL envelopes with `type:text` deltas and a terminal `type:end` carrying cost/usage.
2. `captureMode: "tail"` with `MAX_OUTPUT = 100_000` — so the terminal cost line survives large streams (#778 / #429).
3. `makeGrokForwardTransform()` — strips envelopes and forwards plain assistant text to `terminal.log` **without** the same tail bound on the human-visible stream.
4. After the process exits, `parseGrokTelemetry(result.stdout)` rebuilds `HarnessResult.stdout` from **only** the tail-capped raw capture, then `plan-revision.ack@1` / `verifyPlanRevisionOutput` runs on that reconstructed string.

Plan-revision puts `## Feedback Incorporated` at the **head** of a large revised plan. Raw JSONL is much larger than plain text. Tail truncation therefore drops early `type:text` lines that carry the ack header while:

- the forward path still printed a full plain transcript that verifies `ok: true`, and
- the stage blocks with “missing required ## Feedback Incorporated section” (`headerMatches.length === 0`).

#658 fixed mid-line glue / format-repair; it does **not** fix head-of-response loss under tail capture. Observed live impact: lyric-utils #748 under Grok implementer, repeated advance runs, format-repair exhausted, durable recovery as `workflow-engine-defect` / `harness-contract`, then `run_fatal`.

## Goals / Non-Goals

**Goals:**

- No false `plan-revision.ack@1` failure when the model streamed a valid leading acknowledgement that the forward transform already exposed in the transcript.
- Keep cost/usage recovery for large streaming-json runs (tail or equivalent for the accounting envelope).
- Keep true negatives: truly absent ack still format-repairs once, then terminal `harness-contract`.
- Fixture-backed regression at production Grok capture settings.
- Prefer a **general product-text vs telemetry-capture** seam over a one-off Grok hack if the same head-loss failure mode can hit any streaming+tail adapter.

**Non-Goals:**

- Softening or removing `plan-revision.ack@1`.
- Full unbounded in-memory capture of multi-MB raw JSONL for every stage forever (product text completeness is required; raw envelope retention strategy may remain bounded).
- Changing plan-review, review rigor, or merge authority.
- Requiring durable-loop recovery redesign as a ship gate (optional stretch).
- Fixing unrelated Grok CLI drift beyond re-checking the verified-against pin if envelope shape actually changed.

## Decisions

### Decision 1: Separate **product text** capture from **telemetry envelope** capture (primary)

Keep a dedicated accumulation of **forwarded plain assistant text** (the same bytes `transformForward` already produces for the human stream), independently of the raw JSONL buffer used for `parseTelemetry` cost recovery.

After the harness exits:

- `HarnessResult.stdout` (or an explicit product-text field that stages use for freeform contracts) SHALL be the complete reconstructed plain product text from the forward path (or an equivalent full text reconstruction that does not depend on the tail-capped raw buffer alone).
- Telemetry (`costUsd`, `usage`, `resolvedModel`) continues to come from `parseTelemetry` over the tail-capped (or dual-buffered) raw envelope so the terminal `type:end` still wins.

**Why this over only raising `MAX_OUTPUT`?** Raising the cap reduces but does not eliminate the failure class for very large plans; dual concerns (product completeness vs cost line survival) remain coupled. A side channel matches what the operator already sees in `terminal.log`.

**Why this over validating `terminal.log` post-hoc?** Run-dir logs are observational; stages already consume `HarnessResult.stdout`. Fixing the result shape keeps all freeform contracts (not only plan-revision) consistent and unit-testable without filesystem log parsing.

**Alternatives considered:**

| Approach | Pros | Cons |
|----------|------|------|
| Raise `MAX_OUTPUT` only | Minimal code | Still fails for larger plans; couples cost+product |
| Head+tail raw dual buffer | Keeps early JSONL + end line | Product text still needs join of partial text deltas; mid-stream loss window remains |
| Persist full raw to disk, re-parse | Complete | IO, cleanup, slower; overkill if product side channel exists |
| **Product side channel from forward transform** | Matches transcript; small; general | Must bound product text memory separately (still may need a higher/separate cap) |

**Product-text bound:** implement a separate, documented bound for product plain text (default may equal or exceed raw `MAX_OUTPUT` in **characters of product text**, not raw JSONL). For plan-revision, product text is the plan body; if product text itself exceeds any hard bound, fail visibly rather than silently drop the head. Prefer head-preserving product capture (`captureMode` head for product, or unbounded-with-soft-limit) because contracts care about leading sections.

### Decision 2: Prefer general harness seam; Grok is the first production consumer

Implement the product-text path in `runCapped` / `invoke` so any adapter with `transformForward` + tail raw capture benefits, without special-casing stage names in the adapter. Grok production settings are the regression target; Claude/Codex already use tail for telemetry and reconstruct text via their own parsers — do not regress their cost recovery or verdict parsing.

### Decision 3: Contract layer stays pure; completeness is an input invariant

Do **not** teach `verifyPlanRevisionOutput` to scrape `terminal.log`. Keep validators pure over strings. Spec language: freeform contracts SHALL receive complete product text after envelope normalization; incomplete reconstruction that drops streamed leading product content is a harness defect, not a model shape failure.

Format-repair remains for true product-text misses only.

### Decision 4: Regression fixture shape

Add (or extend) a unit/integration test that:

1. Builds a synthetic streaming-json sequence whose concatenated plain text starts with a valid `## Feedback Incorporated` block and then a multi-tens-of-KB plan body such that **raw JSONL length > production `MAX_OUTPUT`**.
2. Runs capture with production Grok settings (`captureMode: "tail"`, Grok forward transform, Grok `parseTelemetry` path as used by `invoke`).
3. Asserts the product stdout used for contracts still begins with / contains a section that passes `verifyPlanRevisionOutput` / `plan-revision.ack@1`.
4. Asserts cost fields can still be recovered from the terminal `type:end` when present in the tail.

Prove the test bites against pre-fix behavior (fail without product side channel).

### Decision 5: Optional durable recovery (stretch)

If time permits: when diagnostics show harness-contract ack-missing **and** run artifacts already contain a verifiable section (e.g. step terminal excerpt / product artifact), classify as capture defect and prefer re-invoke plan-revision or re-parse artifact rather than full planning restart. **Not required** for the primary ship gate.

### Decision 6: Grok CLI version pin

Re-check fixtures against currently installed Grok (issue observed 0.2.118 vs verified-against 0.2.114). Update `verified-against` only if envelope fields actually changed; version drift alone is not the root cause if text deltas still stream.

## Risks / Trade-offs

- **[Risk] Dual buffers increase memory** → Mitigation: bound product text separately; prefer plain text (much smaller than JSONL); document limits; fail visibly on overflow rather than head-drop.
- **[Risk] Divergent product vs telemetry text fields confuse future callers** → Mitigation: single documented rule: freeform consumers use product stdout; accounting uses telemetry parse; add a short comment + test at the `invoke` seam.
- **[Risk] Over-general change touches Claude/Codex** → Mitigation: keep raw capture behavior for telemetry; only add product accumulation when `transformForward` is present or when captureMode is tail; golden tests for existing adapters.
- **[Risk] Format-repair still burns a retry if product path is wrong** → Mitigation: regression fixture is the primary gate; manual re-run of lyric-utils-shaped stream offline.
- **[Risk] Product text cap still drops mid-plan for enormous plans** → Mitigation: for plan-revision, leading-ack preservation is mandatory; if a cap is required, use head-biased product capture or raise product cap well above realistic plan sizes; never tail-truncate product text used for leading-section contracts.

## Migration Plan

1. Land capture/product-text fix + tests in `core/`; regenerate `plugin/`.
2. No config migration; behavior is default for production Grok telemetry mode.
3. Rollback: revert the change; operators keep workarounds (non-Grok implementer, manual plan post) until re-ship.
4. No label or OpenSpec consumer migration.

## Open Questions

- Exact product-text cap value vs reusing `MAX_OUTPUT` for plain text only (implementation choice; must still pass the “ack in first 20% of large stream” scenario).
- Whether to surface a separate `HarnessResult.product_stdout` field or overwrite `stdout` after telemetry parse (overwrite is current pattern; prefer keeping one consumer-facing stdout if product text is complete).
- Whether durable recovery stretch is in the same PR or a follow-up issue.
