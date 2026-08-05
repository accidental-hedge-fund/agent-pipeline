## Why

Review stages receive issue context, plan/spec material, conventions, and the candidate diff, but they do not share a first-class, structured **test record pinned to the exact candidate SHA** they are judging. That leaves two avoidable holes: reviewers cannot deterministically map claimed behavior to independent suite evidence, and review ensembles may re-run overlapping suites or reason from incomplete prose instead of one authoritative result. The writer’s own test report is not sufficient evidence, and a pass recorded for an earlier SHA must never support approval of a later candidate. This lands in v1.31 as factory/harness honesty that directly supports the parallel review ensemble (#645).

## What Changes

- **Versioned Tester evidence artifact.** Deterministic runner code (not the writer model) produces a structured, versioned record from the existing test/build (and related deterministic) gate machinery: candidate SHA, run/issue identity, command identity + effective configuration digest, worktree identity + bounded privacy-safe toolchain fingerprint, timing, exit status, timeout/tooling classification, normalized per-command results, optional normalized per-test results when a supported extractor exists, bounded redacted output, and explicit `unavailable` / `not_run` / `stale` states with reasons.
- **Reuse existing surfaces.** Production reuses `test-build-gate` / format-gate execution, run-store, evidence-bundle, and stage accounting — no new stage label and no second workflow state machine solely for Tester execution.
- **Shared review input.** `review-1`, `review-2`, delta re-review, and every agent in an enabled review ensemble receive the **same** SHA-matched Tester artifact for that candidate. Prompts clearly distinguish authoritative suite evidence from reviewer-run targeted checks.
- **Strict SHA binding.** Acquisition rejects or explicitly classifies candidate/artifact SHA mismatch. Stale evidence never supports approval. Any candidate-changing fix invalidates the prior artifact; regeneration is required before a new review verdict may rely on Tester evidence.
- **Deterministic fail-open / fail-closed.** Missing, malformed, disabled, timeout, tooling-failure, and partial-completion states are distinguishable. Configured disposition when trustworthy evidence is absent is deterministic and documented; no path may imply tests passed without evidence.
- **Supplemental targeted checks.** Reviewers may run a targeted check to answer a specific question; that result is supplemental only and MUST NOT overwrite the authoritative Tester record.
- **Bounded, redacted persistence.** Full structured record lives in the run evidence bundle; human-readable comments summarize. No full environment dump or unbounded test log. Scoreboard/accounting can report Tester duration, command count, pass/fail/tooling outcomes, and redundant targeted-check cost without parsing prose.
- **Forward-compatible identity.** Candidate/run identity fields SHALL reuse a shape that can become or embed #692’s shared `evidence_subject` without a Tester-only vocabulary that later needs a hard rename. This issue does **not** implement the full multi-family subject contract.

**Non-goals (explicit):**

- Universal test framework or requiring per-test extraction for every repository.
- Making model reviewers deterministic.
- Letting a reviewer rewrite the authoritative test outcome.
- A new stage label solely for Tester execution.
- Replacing CI, eval-gate, visual-gate, or shipcheck evidence.
- Full #692 `evidence_subject` unification across all assurance families (compose later; stay compatible now).
- #575 behavior-to-test human attestation (compose when that lands; not a blocker).

## Capabilities

### New Capabilities

- `tester-evidence`: Versioned SHA-pinned Tester execution artifact produced by deterministic gate runners; unavailable/stale/not_run classification; shared injection into all review paths (including ensemble agents); supplemental targeted-check records that cannot replace the authority; redaction/bounds; scoreboard-readable metrics fields.

### Modified Capabilities

- `test-build-gate`: After deterministic gate execution (or explicit skip/disable paths), emit or update the Tester evidence artifact for the candidate HEAD SHA rather than only free-form command records.
- `evidence-bundle`: Persist the full structured Tester record (and optional supplemental targeted-check records) in the run evidence surfaces (`events.jsonl` / `summary.json` / run directory) with secret redaction.
- `review-layer`: Review prompt assembly and acquisition for review-1, review-2, and delta re-review SHALL load the SHA-matched Tester artifact, distinguish authoritative vs supplemental evidence, and apply deterministic missing/stale disposition.
- `review-ensemble`: When ensemble is enabled, every agent in the fan-out SHALL receive the same SHA-matched Tester artifact (identical authoritative suite evidence; no per-agent rewrite of the Tester record).
- `factory-scoreboard`: Scoreboard/accounting SHALL be able to report Tester duration, command count, pass/fail/tooling outcomes, and redundant targeted-check cost from structured fields without parsing prose.

## Impact

- `core/scripts/testgate.ts` (and format-gate call sites) — produce Tester evidence after deterministic runs
- New pure types/module for Tester schema, SHA match, stale classification, redaction bounds (e.g. `tester-evidence.ts`)
- `core/scripts/evidence-bundle.ts` / `run-store.ts` — persist artifact + events
- Review prompt builders / `self-review.ts` / `stages/review-routing.ts` / planning plan-review path / pre-merge SHA-gate re-review — inject shared artifact
- `core/scripts/stages/format-gate.ts` when format commands contribute to the normalized command set (only if already part of deterministic pre-review gates; do not invent a second gate)
- Config schema for fail-open/fail-closed disposition and optional extractor allowlist
- `scoreboard.ts` / stage accounting consumers
- Unit tests under `core/test/` with injected gate/run-store fakes (no real network/git/subprocess)
- Regenerate `plugin/` after any `core/` edit; `npm run ci` green
- No autonomous merge path; no new stage label; no weakening of review rigor

## Acceptance criteria

Observable, falsifiable outcomes that make #646 done:

- [ ] A versioned schema (with `schema_version`) represents Tester execution including candidate SHA, run/issue identity, effective configuration digest, worktree identity + bounded toolchain fingerprint, command results, optional per-test results, bounded redacted output, timing, and explicit unavailable / not_run / stale states with reasons.
- [ ] The artifact is produced by deterministic runner code on the existing test/build (and related) gate path — never by trusting writer-authored claims or model-written “tests passed” prose.
- [ ] Every review path that evaluates a candidate (`review-1`, `review-2`, delta re-review) receives the same SHA-matched Tester artifact; when review ensemble is enabled, every ensemble agent for that round receives that same artifact.
- [ ] Review acquisition rejects or explicitly classifies a candidate/artifact SHA mismatch; stale evidence never supports an approval disposition that claims suite success.
- [ ] A candidate-changing fix invalidates prior Tester evidence; the next review-supporting path regenerates the artifact for the new HEAD before treating Tester evidence as current.
- [ ] Disabled gates, missing extractors, runner failures, timeouts, malformed extractor output, and multi-command partial completion remain distinguishable states (not collapsed into a single opaque “failed” or “passed”).
- [ ] Reviewers may attach targeted-check evidence without mutating or replacing the authoritative Tester record; prompts label suite evidence as authoritative and targeted checks as supplemental.
- [ ] Persisted and posted output is bounded and secret-redacted; no full environment dump or unbounded test log is written to the evidence bundle or GitHub comments.
- [ ] Human-readable comments (when posted) summarize the Tester result while the full structured record remains in the run evidence bundle.
- [ ] Scoreboard/accounting can report Tester duration, command count, pass/fail/tooling outcomes, and redundant targeted-check cost from structured fields without parsing prose.
- [ ] Unit tests cover pass, test failure, tooling failure, timeout, disabled/unavailable, malformed extractor output, multi-command partial completion, stale SHA, post-fix regeneration, ensemble fan-out shared injection, and redaction — with injected I/O seams only.
- [ ] `npm run ci` is green; any `core/` change regenerates and commits the `plugin/` mirror.
- [ ] Identity fields are forward-compatible with #692 `evidence_subject` (no Tester-only identity vocabulary that conflicts with the planned shared subject).
