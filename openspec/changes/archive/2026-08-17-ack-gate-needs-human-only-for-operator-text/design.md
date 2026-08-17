## Context

See `proposal.md` for motivation.

After #1098, a Review-2 body verifies when the engine binds `bodyHash` after banners. `findUnacknowledgedComments` still treats three residuals as unacknowledged human input and the fix/review call sites still `setBlocked(..., "needs-human")`:

1. Trusted-actor review/delta heading + present `review-artifact` whose `bodyHash` does not match (`NEGATION_PATTERNS` hit).
2. Grill / ship-halt / “don’t comment” notes with no `## Pipeline:` heading. `classifyComment` = `human`.
3. Any other trusted-author body that fails verify and matches `NEGATION_PATTERNS`.

#1098 living law still says: no heading-only exemption; unverified review-shaped trusted bodies still count. This change **replaces that residual**. It does not reopen the hash-after-banner bind.

Constraints:

- Class over site: one shared classifier. Not a Review-2 mole and not a grill-string mole.
- Same `gh` actor is the pipeline poster. Author-login is not operator identity.
- Forge resistance stays: an untrusted author with a copied heading or artifact still counts.
- `NEGATION_PATTERNS` stay. Do not delete `\binstead\b`.
- `fix.ts` and `review-routing.ts` share the predicate. No host janitor.
- Unit tests inject deps. No real network, git, or subprocess.

## Goals / Non-Goals

**Goals:**

- `needs-human` on this gate fires only for operator-authored product/scope-change text.
- Trusted heading + terminal matching artifact blob never parks as human, even when the hash fails.
- Closed operational-note shapes never `setBlocked` with kind `needs-human`.
- Residual ambiguity recovers in-engine (re-plan), not `needs-human` STOP.
- Real “please also change X” from a non-pipeline author still blocks. `pipeline unblock` still clears it.

**Non-Goals:**

- Re-binding `bodyHash` or changing banner insert (#1098).
- Implementing `pipeline ship` (#1096).
- Auto-override of HIGH/CRITICAL review findings.
- Loosening `NEGATION_PATTERNS`.
- Dropping forge resistance for untrusted authors.
- Host-side comment deletion or label surgery.

## Decisions

### D1 — Pick heading + terminal artifact ⇒ never human

**Decision:** A trusted-actor comment whose leading heading is a registered pipeline review/delta heading (`## Review <N>`, `## Pre-merge Delta Review`) and whose body carries a **terminal** `<!-- review-artifact: … -->` line (last occurrence; no non-whitespace after that line) SHALL NOT be unacknowledged human input. `bodyHash` MAY fail. The same rule applies to a trusted-actor registered heading plus a **terminal** `<!-- pipeline-attest: … -->` line.

This is the issue’s preferred pick: heading + artifact blob ⇒ never human. “Terminal” is the exact #1095 shape (banner inserted *before* the artifact). Human text appended *after* the last artifact line is not this shape and still counts when it is a scope change.

**Rationale:** Hash mismatch on an intact pipeline footer is an engine integrity miss. It is not a human-authority class. #1098 makes new posts verify. This rule covers already-posted and future bind misses so the next insert does not need a new mole.

**Alternatives considered:**

- Recover instead of exclude when hash fails → rejected for this shape. Recover would still stop unattended ship for a structurally complete review comment.
- Heading-only exemption with no artifact → rejected. A trusted actor (the operator login) could post `## Review 2` plus a real objection and skip the gate.
- Keep #1098 residual (unverified still counts) → rejected. That is the park this issue exists to stop.

### D2 — One shared three-way classifier

**Decision:** Export one classifier used by `findUnacknowledgedComments` and by both call sites. Every post-plan comment is exactly one of:

| Disposition | Meaning | Gate action |
| --- | --- | --- |
| `pipeline-or-operational` | Verified pipeline output, trusted heading + terminal artifact, or closed operational-note | Exclude. Do not warn. Do not block. |
| `operator-scope-change` | Real operator product/scope text the implementer must ack | Current unacknowledged set. Warning + `setBlocked(..., "needs-human")`. |
| `ambiguous-trusted` | Trusted author, no registered heading/sentinel, negation or lock-like wording, not a closed operational note and not a clear product-scope-change | Do **not** `setBlocked` with kind `needs-human`. Fail **recover**: in-engine re-plan that treats the comment as plan-revision input. |

`findUnacknowledgedComments` continues to return only `operator-scope-change` so a non-empty list still means “human park.” Call sites inspect `ambiguous-trusted` separately. `pipeline single`, `train --merge`, and later `pipeline ship` inherit this because they go through the same stages.

**Rationale:** Today `length > 0` always means `needs-human`. Splitting the return set without a second bucket would either ignore ambiguous notes or keep parking them.

**Alternatives considered:**

- Overload `findUnacknowledgedComments` to drop ambiguous notes and do nothing → rejected. The issue requires recover, not silent drop.
- Keep one list and change only the blocker kind at the call sites → rejected as two policies. The classifier is the class law.

### D3 — Closed operational-note recognizer

**Decision:** An operational note is a trusted-actor body that matches a closed, exported phrase list on a leading line or as the whole trimmed body, and that does **not** also match the product-scope-change recognizer.

Closed phrases (case-insensitive):

- `grill-lock`, `grill locked`, `grill-locked`
- `ship-halt`, `ship halt`
- `don't comment`, `do not comment`, `dont comment`

Product-scope-change for this gate includes existing `NEGATION_PATTERNS` **and** explicit implementer-change phrasing (`please also`, `please add`, `please change`, `please implement`, `please fix`) when the body is not an operational note.

A body that contains both an operational-note phrase and a product-scope-change clause (`grill locked — please also change X`) is `operator-scope-change`.

The phrase list lives next to the classifier and is drift-guarded. Adding a new factory operational note is a list edit plus a test, not a new issue.

**Rationale:** Grill/lock comments have no `## Pipeline:` heading (#1073-class). They classify as `human` and trip `don't` / `do not`. A closed list is deterministic. An open LLM classifier would make the gate non-testable.

**Alternatives considered:**

- Treat every trusted-actor unmarked comment as operational → rejected. Requirement 4: real operator text still blocks.
- Require `## Pipeline:` on future grill posts only → rejected. Already-posted notes would keep parking the current train.

### D4 — Registered heading without a terminal artifact recovers

**Decision:** A trusted-actor registered pipeline heading or sentinel whose body is **not** verified and does **not** carry a terminal matching artifact SHALL NOT be `needs-human`. Disposition is `ambiguous-trusted` (recover / in-engine re-plan), not `operator-scope-change`.

Untrusted authors with the same shape stay `operator-scope-change` (forge resistance).

**Rationale:** The issue allows recover when the engine cannot treat the body as human. A heading without a footer is incomplete pipeline output, not a verified operator decision.

**Alternatives considered:**

- Exclude these too → rejected. That is a heading-only exemption.
- Keep counting them as human → rejected. That is the current false park.

### D5 — Recover means in-engine re-plan, not a new blocker kind

**Decision:** `ambiguous-trusted` at a review or fix boundary SHALL NOT call `setBlocked` with kind `needs-human` and SHALL NOT transition to `pipeline:needs-human` for that comment set. The engine SHALL start the existing plan-revision / re-plan path so the comments become context under a new plan anchor. Until that new plan posts, those comments SHALL NOT be injected into implement, review, or fix prompts.

If the stage cannot start re-plan in-process, it MAY `setBlocked` with a recover-class kind already projected to `workflow-engine-defect` (for example `harness-failure`). It SHALL NOT use `needs-human` or `human-decision-required`.

**Rationale:** The constitution: engine scratch, stale identity, and workflow-engine defects are not janitor / wait-for-human work. Re-plan is the existing acknowledgement mechanism. Only the trigger changes: engine, not operator.

**Alternatives considered:**

- New `BlockerKind` solely for this gate → rejected unless a recover-class kind cannot be reused. Prefer existing projection.
- Host playbook deletes the comment → rejected (no host janitor).

### D6 — Do not change author-trust or `NEGATION_PATTERNS`

**Decision:** Trusted authors remain `getGhActor` plus `trusted_override_actors`. Untrusted forged headings still count. Operator-surface comments (`unblocked` / `finding-override` / `scope-override`) still acknowledge. `NEGATION_PATTERNS` keep `\binstead\b` and `do not`.

**Rationale:** The bug is the disposition, not the word list. Dropping `instead` would hide real operator objections inside review-like prose.

### D7 — Supersede the #1098 residual sentence

**Decision:** Replace the living sentences “The gate SHALL NOT gain a heading-only or banner-string exemption” and “An unverified review-shaped body from a trusted actor that matches `NEGATION_PATTERNS` SHALL still be counted” with D1–D4. Keep the bannered *verified* scenarios. Change the unverified-with-terminal-artifact scenario to “not counted.” Keep “suffix after the last artifact still counts.”

**Rationale:** Archive must not leave two contradictory residual rules.

## Risks / Trade-offs

- **[Risk] A trusted actor pastes `## Review 2` + a terminal artifact + a real objection in the hashed prefix** → **Mitigation:** D1 requires a terminal artifact, which ordinary operator chat does not carry. Untrusted authors still gate. Prefix tamper fails verify but is treated as engine integrity, not human park — accepted for unattended ship.
- **[Risk] Operational-note list is too narrow; a new factory phrase parks again** → **Mitigation:** D2 `ambiguous-trusted` recover is the fallback. Extending the list is the class fix for the next known phrase.
- **[Risk] Operational-note list is too wide and swallows “don’t change X”** → **Mitigation:** Product-scope-change wins when both match. Tests include “please also change X” and “grill locked — please also change X.”
- **[Risk] In-engine re-plan loops on a sticky ambiguous comment** → **Mitigation:** Re-plan posts a new plan anchor, which advances the ack window. If re-plan cannot start, recover-class block + budget applies; still not `needs-human`.
- **[Risk] Implementers re-open the #1098 bind** → **Mitigation:** Tasks forbid hash/banner edits. Tests for invalid-hash + terminal artifact prove the *gate*, not a new bind.

## Migration Plan

- Land as an ordinary PR under #1099 on v1.39.2 with #1098 already on `main`.
- No config flag. No comment rewrite.
- After promote: already-posted invalid-hash Review-2 comments and unmarked grill notes no longer park the next fix/review entry.
- Rollback: revert the classifier and call-site branch. The #1098 residual park returns.

## Open Questions

None. D1 picks heading + terminal artifact. D3 locks the operational-note list. D5 locks recover as in-engine re-plan.
