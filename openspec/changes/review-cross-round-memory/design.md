## Context

Review rounds are stateless with respect to one another. `buildReviewAdversarialPrompt` accepts a `review1Summary` ("already addressed — find NEW problems") and a `priorReview2Findings` block (only when review-2 is re-running after a fix), and `buildDeltaReviewPrompt` passes neither. None of these carry *dispositions*: they say what was raised, never what was decided, accepted, or overridden. A reviewer therefore cannot distinguish "nobody has considered this" from "round 2 asked for exactly the opposite and the fix was accepted".

The durable substrate already exists and is used by other convergence machinery:

- `formatReviewComment` embeds `pipeline-blocking-keys`, `pipeline-blocking-surfaces` (`findingKey → surfaceKey`), `reviewed-sha`, and a base64 `ReviewArtifact` block, all last-occurrence-wins and injection-hardened.
- `findingKey` (`review-policy.ts`) is the single source of finding identity; `surfaceKey` = `normalize(file) | category` is the existing cross-round clustering axis (`review-surface-recurrence`).
- `--override` dispositions live in `pipeline-override` sentinel comments, recovered by `extractOverrides` / `extractScopedOverrides`, and are trusted only from the pipeline actor or `trusted_override_actors` (`buildTrustedOverrideComments`).

So the work is derivation + injection, not new persistence.

## Goals / Non-Goals

**Goals:**
- Give round N ≥ 2 a compact, durable record of prior rounds' blocking findings, their resolutions, and override dispositions.
- Make an unacknowledged reversal of a settled trade-off structurally impossible to land as a blocker.
- Keep round 1 and no-history paths byte-identical to today.

**Non-Goals:**
- Auto-resolving a trade-off, auto-approving a round, or changing `review_policy` thresholds.
- Cross-issue memory.
- Changing when the review-SHA gate triggers a re-review, or the ceiling / recurrence / early-park guards.
- Feeding the digest to the `eval` stage (see Decision 5).

## Decisions

### 1. Source of truth: trusted PR review comments, not run-local state

The digest is derived from `detail.comments` filtered to the pipeline actor (plus `trusted_override_actors` for override comments) — the same trust boundary `pre_merge.ts` already applies before honoring a prior verdict. GitHub comments are the only evidence that survives a crashed run, a fresh clone, a new worktree, and a different machine. `.agent-pipeline/history/issue-<N>.jsonl` and `summary.json` finding records are *not* used as a source: they are gitignored engine artifacts (#452) and are absent on a fresh checkout, which would make the digest silently vary by machine.

_Alternative rejected_: read finding records from the run directory (richer, already structured) — fails the durability criterion and introduces machine-dependent prompts.

### 2. Structured extension over markdown scraping

`ReviewArtifact` gains an optional `blockingFindings?: Array<{ key, surface, severity, title }>` (title truncated at render time). `review-artifact-record` already licenses optional extension fields, and readers ignoring unknown fields are unaffected. `extractReviewArtifact` keeps last-occurrence-wins semantics, so the digest inherits its injection resistance for free.

Comments predating this change have no `blockingFindings`. Fallback ladder, per comment, each step independent:
1. `artifact.blockingFindings` → full entries.
2. `pipeline-blocking-surfaces` marker → key + surface, severity/title unknown.
3. `pipeline-blocking-keys` marker (or `artifact.blockingKeys`) → key only.
4. Nothing → the round contributes no entries (it is not invented from prose).

A degraded entry renders with `(title unavailable)` rather than being dropped, so the reviewer still sees that a decision happened there.

### 3. Resolution status is derived, not stored

For a blocking finding with key `k` and surface `s` first seen in round `i`:
- **`overridden`** if a trusted override comment matches `k` (or a scoped override matching its `category`/`file`) — reason and recording round are carried through.
- **`resolved-by-fix`** if `s` does not appear in the blocking surfaces of any round after `i`. The change advanced past that round without the surface re-blocking, which is exactly "the fix was accepted".
- **`still-open`** otherwise.

A surface whose latest resolution is `overridden` or `resolved-by-fix` is marked **settled**. Deriving rather than storing means the digest is correct for issues whose earlier rounds ran before this change shipped.

_Alternative rejected_: an explicit per-round "accepted trade-off" record written at fix time. More precise, but it only works for rounds recorded after the change lands, and it adds a write path where a pure read suffices.

### 4. Reversal guard: deterministic surface match + reviewer-authored acknowledgment

Detection is deterministic (surface identity), the judgment is the reviewer's — the reverse split would either require the model to self-report reversal honestly (unenforceable) or require the engine to decide whether two findings are semantically opposite (not knowable from a verdict).

`ReviewFinding` gains optional `prior_round_acknowledgment?: string`. The schema block, the `FINDING_FIELD_GUARD` record, and `REVIEW_SCHEMA_FIELDS` are updated together — the existing drift guard test fails otherwise, which is the intended forcing function.

In `partitionFindings`, a finding that (a) is otherwise blocking, (b) has a surface marked settled in the digest, and (c) has no non-empty `prior_round_acknowledgment`, is moved to the advisory partition with reason `reversal-unacknowledged`. It is rendered in the review comment with a `REVERSAL-UNACKNOWLEDGED` tag naming the prior round, and an event is emitted.

Demote-and-surface is chosen over hard-failing the verdict or re-prompting the reviewer: it converges in one pass, costs no extra harness invocation, and — critically for the "rigor over latency" rule — loses no information. The finding is still recorded, still shown to the human, and a reviewer who genuinely believes the prior trade-off was wrong simply writes one sentence and keeps the block.

_Alternative rejected_: reject the verdict and re-ask once. Adds a full harness round to every reversal, and a second omission still needs a terminal policy — so the terminal policy may as well be the only policy.

### 5. Scope of injection: review rounds ≥ 2 and the pre-merge delta review

`review_adversarial.md` gains a `{{prior_rounds_digest}}` slot, which serves `buildReviewAdversarialPrompt` (round 2 and its re-reviews) and `buildDeltaReviewPrompt` (pre-merge delta) — these are exactly the rounds that can see history. `review_standard.md` (round 1) is left untouched: round 1 is by definition the first round of a run, and its re-runs re-review the full diff from scratch. The `eval` stage is excluded — it gates tests/acceptance, not code-review trade-offs, and no oscillation was observed there. If eval oscillation is later observed, the digest builder is stage-agnostic and can be wired in without spec change.

This resolves the issue's first open question; Decision 4 resolves the second.

### 6. Compactness and untrusted-content handling

Caps: 12 findings per round, 8 rounds, 4 000 characters total, titles truncated to 120 characters. Overflow emits `[… N earlier entries truncated]`. The digest never contains diff hunks, transcripts, or prompt text — only key, surface, severity, title, resolution, and override reason.

Titles and override reasons are reviewer/operator-authored, so the rendered section is passed through the existing `sanitizeBriefForPrompt` redactor and wrapped in `<untrusted-external-evidence>` with the no-instructions directive, mirroring `carry-forward-injection-boundary`.

## Risks / Trade-offs

- **Reviewer writes a token acknowledgment to keep blocking** → Acceptable and by design: the goal is forced engagement with the prior decision, not veto. The acknowledgment text is rendered in the review comment, so a hollow one is visible to the human at the ceiling.
- **`resolved-by-fix` is inferred from surface absence and can be wrong** (e.g. a later round did not reach that file) → The consequence is a demotion-to-advisory of a blocking finding, not a silent drop; the finding is tagged and surfaced. Surface granularity `(file|category)` is the same axis the recurrence guard already trusts.
- **Legacy comments yield a thin digest** → Explicit `(title unavailable)` degradation; the settled/reversal machinery still works off key + surface.
- **Prompt growth on long-running issues** → Hard character cap with a visible truncation marker; oldest rounds truncated first.
- **Injection via a reviewer-authored title** → `<untrusted-external-evidence>` fence + `sanitizeBriefForPrompt`; markers are read last-occurrence-wins from base64 artifacts, not from prose.

## Migration Plan

Purely additive and self-healing. New comments carry `blockingFindings`; in-flight issues fall back to the marker ladder. No config key, no state migration, no rollback step beyond reverting the change — a reverted engine simply ignores the extension field.

## Open Questions

None outstanding. The issue's two open questions are answered by Decisions 5 and 4 respectively.
