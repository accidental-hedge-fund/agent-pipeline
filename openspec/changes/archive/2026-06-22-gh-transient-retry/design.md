## Context

`ghRun` (lines 198–230, `core/scripts/gh.ts`) is the single gateway through which every `gh` subprocess in the pipeline flows. It already implements a three-attempt retry loop, but the retry condition (`stderr.toLowerCase().includes("rate limit")`) only covers GitHub's explicit rate-limit message. Every other failure class — including transient 401 blips on the GraphQL endpoint, 5xx server errors, and network-level ETIMEDOUT/ECONNRESET — exits the loop on the first attempt with an immediate throw.

The live incident (#255 run): `gh issue comment 255 failed: HTTP 401: Bad credentials (https://api.github.com/graphql)` crashed the run mid-planning. The token was valid; `gh auth status` and a REST `gh api user` both succeeded seconds later. The failure was a momentary GraphQL blip, not an auth problem — but `ghRun`'s narrow retry guard treated it as a hard error.

The existing `GhRunOptions.retries` field controls the attempt budget; `GhRunOptions.collector` provides metric injection. There is no `sleep` or `isTransient` injectable, so testing the retry path today requires either a real subprocess or monkey-patching `setTimeout`.

## Goals / Non-Goals

**Goals:**
- Expand the retry guard in `ghRun` to cover HTTP 401/403, 5xx, and network/timeout error classes.
- Export a pure `isTransientGhError(stderr: string): boolean` function so the classification logic is independently testable.
- Add `sleep` and `isTransient` optionals to `GhRunOptions` so unit tests control delay and classification without spawning subprocesses.
- Preserve the existing bounded retry budget (`retries`, default 3) — no infinite loops.

**Non-Goals:**
- Distinguishing a "truly transient" 401 from a "persistently invalid token" 401 by semantic heuristics beyond what stderr content provides — retrying all 401s within the budget is simpler and safe.
- Per-call retry counts beyond what `GhRunOptions.retries` already provides — callers needing fewer retries can pass `retries: 1`.
- Recovering from irreversible partial writes mid-stage (the companion issue #271 tracks that separately).
- Adding circuit-breaker state across multiple `ghRun` calls in a single run.

## Decisions

**Decision: export `isTransientGhError` as a pure function rather than inlining the predicate.** Inlining keeps the change minimal but makes the classification rule untestable without invoking `ghRun`. An exported pure function can be unit-tested exhaustively against sample stderr strings, and the production `ghRun` uses it as its default — identical behavior, much better test coverage.

**Decision: treat all HTTP 401 bodies as transient within the retry budget.** A genuine credential failure will still fail — after `retries` attempts rather than immediately. This is a small latency cost (~4 seconds total backoff with 3 retries at 1s/2s base) in exchange for self-healing on the common case (momentary API blip). Trying to distinguish "real" 401s from "transient" 401s by body content is fragile; the GitHub GraphQL error body for both cases is identical.

**Decision: include ETIMEDOUT and ECONNRESET in the transient class.** Network interruptions (DNS hiccup, TCP reset) leave `stderr` empty but `err.message` or `err.code` carries the POSIX error string. `isTransientGhError` receives the combined `stderr || message` string so these are classified correctly.

**Decision: keep `sleep` injectable via `GhRunOptions` (not module-level patching).** `retryComment` already sets the precedent (injectable `sleep`). Following the same pattern avoids any global state concerns and lets tests verify backoff timing without `sinon`-style patching.

**Decision: do NOT change the default backoff formula (`2 ** attempt * 1_000` ms).** The current 1s/2s/4s progression is appropriate for transient network/API blips. Changing it risks slowing down the common non-retry path or introducing a new constant to debate.

## Risks / Trade-offs

- *All 401s are retried, slightly delaying a genuinely bad-token failure.* Mitigation: the budget is bounded (≤3 attempts, ≤7 s total backoff); the final error surface is unchanged — the run still fails with the original stderr.
- *A 5xx retry could duplicate a write operation if the server processed the request before returning 5xx.* Mitigation: GitHub's API guarantees idempotency for comment-post and label-add operations via its own deduplication; the existing `reconcileAuditComment` sentinel provides an additional layer. This risk existed before this change for rate-limit retries.
- *Missing a transient error subclass not enumerated in `isTransientGhError`.* Mitigation: the function can be extended without touching `ghRun`; adding new patterns to the predicate is a one-line change with a co-located unit test.
