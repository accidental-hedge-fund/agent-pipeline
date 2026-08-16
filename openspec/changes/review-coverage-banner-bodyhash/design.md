## Context

See `proposal.md` for motivation.

`formatReviewComment` / `formatDeltaReviewComment` write `ReviewArtifact.bodyHash` over the rendered prefix, then the review post wrapper inserts engine-owned lines after the heading: the #694 coverage banner, optional ensemble identity, and optional self-review warning. `isVerifiedPipelineReviewOutput` hashes the GitHub prefix and compares it to `bodyHash`. A banner in that prefix makes verification false. `findUnacknowledgedComments` then treats a trusted-actor review as human when `NEGATION_PATTERNS` match (Review 2 on #1095 contained `\binstead\b`).

#1095’s merged recovery added a site-local rebind after the coverage insert and a read-side strip of known banner lines. That is not the class law. The next engine-owned insert can skip the rebind and re-park a fix round.

Constraints:

- Class over site: fix the shared post-hash bind and the verification contract. Do not special-case `#694` or Review 2 headings in the ack gate.
- `bodyHash` remains tamper-evidence, not identity. Author checks stay separate.
- Coverage disclosure (#694) stays on the posted body.
- Do not loosen `NEGATION_PATTERNS` or the human-ack gate for real operator comments.
- Unit tests inject deps. No real network, git, or subprocess.

## Goals / Non-Goals

**Goals:**

- Every newly posted review-1 / review-2 / delta body verifies after engine-owned banners.
- Last mutation of the hashed prefix happens before `bodyHash` is written (or `bodyHash` is rebound as that last step).
- Verified pipeline reviews with objection wording do not trip `findUnacknowledgedComments`.
- Real human comments after the plan still do.
- The next engine-owned insert on a review/delta comment inherits the same bind. No new mole issue.

**Non-Goals:**

- Deleting or relocating coverage disclosure off the disposition comment.
- Weakening the ack gate for unverified or non-trusted comments.
- Changing `classifyComment` heading rules.
- Unblocking #1095 as part of this change.
- Changing train leftover-block (#1095) or in-engine ship (#1096).

## Decisions

### D1 — Bind `bodyHash` after the last engine-owned mutation

**Decision:** The production review/delta post path SHALL apply engine-owned inserts first, then bind `bodyHash` to the exact text preceding the last `<!-- review-artifact: … -->` line. After that bind, the engine SHALL NOT mutate the hashed prefix. New posts SHALL verify on that exact prefix (`isVerifiedPipelineReviewOutput` true without needing a strip).

**Rationale:** The living attestation contract already says the hash binds the preceding text. Hash-after-final-mutation keeps one hash over the posted body, including the coverage banner. Operators still see disclosure. Tamper-evidence still covers the banner text.

**Alternatives considered:**

- Thread banners into `formatReviewComment` so the first hash already includes them → rejected as sole fix. More API surface; a later wrapper insert would still break the hash. Last-step bind is the class rule.
- Hash a defined prefix that excludes banners, and attest banners separately → rejected. Two attestation regions for one comment. Same user outcome, more failure modes.
- Skip hashing / treat review headings as always verified → rejected. That weakens tamper-evidence (#390).

### D2 — Class law on the post wrapper, not a coverage-banner mole

**Decision:** The last step before post of any review-1, review-2, or delta body is: apply every engine-owned insert for that comment, then bind `bodyHash`. Coverage, ensemble identity, and self-review banners are instances of that insert set. A future disclosure line uses the same wrapper. Do not add an ack-gate exemption keyed on `**Reviewer coverage (#694):**` or `## Review 2`.

**Rationale:** Engine-dogfood bar. The #1095 park was verification false, not an ack-gate hole. A heading- or banner-string mole would fail on the next insert (or on a banner wording change).

**Alternatives considered:**

- Teach `findUnacknowledgedComments` to ignore trusted-actor `## Review` comments even when unverified → rejected. A trusted actor could paste a review heading plus a real objection and skip the gate.
- Coverage-banner-only rebind in `reviewComment()` with no spec/class law → rejected (that is the #1095 mole).

### D3 — Read-side engine-owned-banner strip is compatibility only

**Decision:** For already-posted comments whose `bodyHash` was computed before the banner insert (v1.39.1 and earlier), verification MAY strip only the documented engine-owned banner lines that sit between the review heading and `**Reviewer**:`, then retry the hash. Human-authored lines in that region SHALL NOT strip. New posts MUST NOT depend on this path.

**Rationale:** In-flight Review 2 comments (the #1095 body) must start verifying after promote without a rewrite of GitHub history. The strip is a closed allowlist of engine-owned lines, not a general prefix-ignore.

**Alternatives considered:**

- No read-side path; only new posts verify → rejected. The observed park is an already-posted comment. Promote would not unstick that class until a re-review rewrite.
- Strip any line before `**Reviewer**:` → rejected. That would accept a human objection in the banner slot.

### D4 — Ack gate stays author + verified-output; tests prove the composition

**Decision:** Do not change `NEGATION_PATTERNS`, trusted-author rules, or the “verified pipeline output is exempt” rule. Add composition tests: wrapper output + `\binstead\b` + pipeline actor → not unacknowledged; free-form human after the revised plan → still unacknowledged; human text in the review prefix → verify false and still counted.

**Rationale:** The gate did its job on an unverified body. The product bug is the broken bind. Changing the gate would hide the next hash miss.

**Alternatives considered:**

- Drop `\binstead\b` from `NEGATION_PATTERNS` because reviews use it → rejected. That is the exact wording the gate exists to catch on real humans.

### D5 — Shared surfaces

**Decision:** Implement in the shared review render/post bind and the shared review-artifact verifier. `findUnacknowledgedComments` stays a consumer of `isVerifiedPipelineOutput`. Production review-1, review-2, and delta post paths inherit the class. If `core/` changes, regenerate `plugin/` in the same commit.

**Rationale:** Same class, all three comment kinds. A delta-only or review-2-only fix is a mole.

## Risks / Trade-offs

- **[Risk] Rebind after a human-edited body would mint a new hash over an objection** → **Mitigation:** Rebind runs only on freshly rendered engine output, before post. It is a no-op when trailing content follows the artifact. Posted-body verification still fails on a later human append.
- **[Risk] Compatibility strip is too wide and accepts a human line that looks like a banner** → **Mitigation:** Allowlist exact engine-owned prefixes (`**Reviewer coverage (#694):**`, ensemble identity, self-review warning). Tests prove a `Do not merge … instead` line between heading and `**Reviewer**:` still fails.
- **[Risk] A later insert is added outside the shared wrapper** → **Mitigation:** Spec and a wrapper-level test that the production assembly (not a hand-built string) verifies. Drift-guard the insert site if one already exists for comment kinds.
- **[Risk] Operators expect #1095 to unblock when this lands** → **Mitigation:** Out of scope. Resume of #1095 is a separate operator action.

## Migration Plan

- Land as an ordinary PR under #1098. No config flag.
- After promote to v1.39.2, new review/delta posts verify with banners. Already-posted bannered reviews verify via the compatibility strip, so a later fix-round ack scan does not re-park them as human.
- Rollback: revert the bind / verifier / tests. Bannered reviews fail verify again; `#instead` parks the next fix round.

## Open Questions

None that block specs or tasks. Whether banners are passed into the renderer or rebound after insert is an implement detail as long as D1 holds for every new post.
