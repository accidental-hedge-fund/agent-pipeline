## Context

See `proposal.md` for motivation and acceptance criteria.

Today `invokePromptHarnessReview` builds the standard or adversarial review prompt, may append Tester evidence, then invokes the reviewer (ensemble / stage executor / `invokeReviewer`). Shared production preflight (#779) measures UTF-8 **bytes** against adapter `maxPromptBytes`. Codex declares `maxPromptBytes: "unlimited"` because stdin has no OS argv ceiling — so #779 never refuses a multi‑MB Codex review prompt. Codex’s API still rejects inputs above **1,048,576 characters** (`input_too_large`). The failure is classified as `harness-failure`; `isAutoLoopRecoverable` treats that kind as recoverable, so the advance auto-loop can re-drive the same stage and re-send the same payload. The `harness-failure` recipe also tells operators a transient failure can be “unblocked and re-run as-is.”

Constraints:

- Grill-locked milestone A only: preflight, distinct reason, no retry of the same payload.
- Diff truncation (50k) and conventions (8k) already exist; finding the residual 1.29 MB is out of scope.
- Class-over-site (ship-path autonomy): land the shared blocker kind, recipe, recoverability rule, and review-path preflight — not a one-off stderr scrape that still classifies as `harness-failure`.
- Unit tests inject deps; no real network, git, or subprocess.
- Surgical coexistence: do not broaden ordinary product review fix discipline.

## Goals / Non-Goals

**Goals:**

- Refuse oversize assembled review prompts before any reviewer spawn for both rounds.
- Resolve a single effective character ceiling: declared finite reviewer max, else `1048576`.
- Park with typed `review-prompt-too-large` and honest unblock text.
- Make automatic recovery skip re-driving this kind on an unchanged payload.

**Non-Goals:**

- Reducing, chunking, or rewriting prompt content.
- Per-model ceiling tables or new config keys for ceilings (use declared adapter max when finite).
- Changing #779 byte preflight semantics for non-review stages, or flipping Codex’s declaration globally beyond what the review ceiling resolution needs.
- Skipping review and advancing; demoting review rigor.

## Decisions

### D1 — Preflight on the fully assembled review prompt, immediately before spawn

**Decision:** After `buildReviewStandardPrompt` / `buildReviewAdversarialPrompt` and any same-path appendages that are part of the text sent to the reviewer (e.g. Tester evidence section), measure `prompt.length` (JS string character length, matching Codex’s `max_chars` / `actual_chars` reporting). Run the check once per review attempt before any of: stage executor invoke, ensemble fan-out, or single `invokeReviewer`. If over ceiling, `setBlocked(..., "review-prompt-too-large")` and return blocked without calling harness seams.

**Rationale:** Issue requires count after `buildReview*Prompt` and before harness spawn. Tester evidence is part of what is sent; measuring only the bare template would under-count and still crash at spawn.

**Alternatives considered:**

- Rely only on #779 byte preflight → rejected; Codex is unlimited under that capability today.
- Check only the template before Tester evidence → rejected; under-counts real spawn payload.
- Classify post-hoc from stderr `input_too_large` → incomplete; still spends a harness crash and may still auto-retry once.

### D2 — Ceiling = declared finite max, else Codex `1048576` characters

**Decision:** Resolve the effective ceiling as:

1. If the configured reviewer adapter (or structured review harness) exposes a **finite** declared max that is usable as a character/byte upper bound for the prompt payload, use that finite value as the character ceiling for this preflight.
2. Otherwise (missing, unlimited, or unknown) use the constant `1_048_576`.

When comparing a finite `maxPromptBytes` value that is already used for #779, treat it as a numeric ceiling in the same integer domain as the character count for this gate (finite byte caps such as argv limits are strictly tighter than Codex’s char cap for typical ASCII-heavy pipeline prompts; this change does not introduce dual unit tables).

**Rationale:** Matches grill-lock; avoids inventing per-model tables; closes the Codex unlimited gap with the observed API constant.

**Alternatives considered:**

- Always hard-code 1048576 regardless of adapter → weaker for argv-bound reviewers that already declare a lower finite max.
- Change Codex adapter to declare `maxPromptBytes: 1048576` only and rely on #779 → may be a useful follow-up, but #779 is UTF-8 **bytes** and production-preflight remediation is generic `prompt-limit`; this issue requires a distinct **review** blocker kind and recipe. Prefer review-path preflight + typed kind even if Codex’s declaration is later tightened.

### D3 — New closed `BlockerKind`: `review-prompt-too-large`

**Decision:** Extend `BLOCKER_KINDS` and `BLOCKER_RECIPES` with `review-prompt-too-large`. Reason text names measured size and ceiling when available. Recipe directs the operator that the assembled review prompt exceeds the reviewer input ceiling, that re-running without reducing the payload or raising/changing the reviewer ceiling will fail the same way, and that they must change the payload/config (or wait for a follow-up that shrinks assembly) before re-running. Recipe MUST NOT include “unblocked and re-run as-is” or equivalent same-payload retry advice.

**Rationale:** Distinct diagnosis; recipe law already forbids generic unblock-only verbs for most kinds; `harness-failure`’s transient re-run line is exactly wrong here.

**Alternatives considered:**

- Reuse `harness-failure` with special-case recipe text → rejected; recipes are per-kind static maps; recoverability would still treat harness-failure as auto-loop recoverable.
- Use `needs-human` → too coarse; loses machine-readable class for scoreboard / durable projection.

### D4 — Non-recoverable for auto-loop; no same-payload auto-recovery spend

**Decision:** Add `review-prompt-too-large` to the non-recoverable set in `isAutoLoopRecoverable` (alongside `needs-human`, `human-decision-required`, `review-findings`, `worktree-capacity`). Do not introduce an in-stage crash-retry loop for this preflight (unlike fix-stage crash retry). Durable / supervisor recovery MUST NOT re-invoke review solely because of this kind while the assembled prompt and ceiling are unchanged; the typed block stands until the operator or a later scope change alters the inputs.

**Rationale:** Acceptance: recovery does not retry the same payload; auto-recovery must not spend a retry.

**Alternatives considered:**

- Leave recoverable and hope fingerprinting prevents retry → risk of one wasted continuation (the dogfood symptom).
- Auto-switch reviewer harness → out of scope; changes routing policy without grill-lock.

### D5 — Class-over-site placement, pure helper + deps for tests

**Decision:** Implement ceiling resolution + oversize check as a small pure helper (exported for unit tests). Wire it in the shared review invoke path used by both rounds. Tests inject oversized and under-ceiling prompts, assert zero harness invocations and correct `setBlocked` kind/recipe markers; assert auto-loop recoverability false for the kind.

**Rationale:** Repo testing convention; both rounds share one path (`invokePromptHarnessReview`).

### D6 — Coexistence with #779 production preflight

**Decision:** Keep #779 byte preflight as-is for all adapters. This review character preflight is an additional fail-closed gate on the review path. An oversize prompt may be refused by either gate; for the review character gate the outcome kind is always `review-prompt-too-large` when that gate fires first. Do not remove or weaken #779.

**Rationale:** Orthogonal limits (OS/argv vs model input chars); belt-and-braces.

## Risks / Trade-offs

- **[Risk] Character vs UTF-8 byte mismatch** → Codex reports `max_chars` / `actual_chars`; JS `string.length` matches that accounting for the repro. Multi-code-unit characters remain rare in pipeline prompts; if a future limit is strictly bytes, re-align with declared finite byte max only.
- **[Risk] Stage executor / ensemble paths bypass a late check** → Mitigation: place the check on the shared assembled `prompt` before any of those branches (single choke point in `invokePromptHarnessReview`).
- **[Risk] Operators still cannot shrink the 1.29 MB residual in this milestone** → Accepted; grill-lock. Recipe must say re-run-as-is will not help, not pretend this PR shrinks content.
- **[Risk] Finite `maxPromptBytes` used as char ceiling is slightly unit-mixed** → Acceptable for this cut; finite values are lower argv-style caps. Follow-up may declare an explicit char ceiling on adapters without this issue expanding to per-model tables.
- **[Risk] Durable classifier / intervention maps need the new kind** → Mitigation: extend closed maps / exhaustiveness tests with the new `BlockerKind` the same way other kinds are added (recipes snapshot, stage-diagnostic projection). Prefer mapping to a non-retry mechanical class rather than human-authority unless authority evidence is present.

## Migration Plan

- Land under #1054 as ordinary PR; no config flag.
- After promote, oversize review parks with the new kind on first attempt; no install step beyond engine promote.
- Rollback: revert preflight + kind; prior crash-then-`harness-failure` behavior returns.

## Open Questions

None that block specs or tasks. Implement may choose helper file placement (`review-routing.ts` vs small `review-prompt-ceiling.ts`) without changing requirements.
