## Context

See `proposal.md` for why. Current law and code:

- Living `trusted-surface-rebind` requires a structured decision with `candidate_sha` as the product candidate under evaluation. It does not say the SHA must come from a managed worktree, but `ensureTrustedSurfaceDecision` in `core/scripts/pipeline-run.ts` fails `worktree_unavailable` when `getOnDiskForIssue` returns null, before any SHA is known.
- That check runs at the start of every advance-loop iteration, including `pre-merge` re-entry. Pre-merge can still advance (it talks to GitHub). `deploy_ready.finalize` then reads the blocked decision and refuses the PR tag. The issue label can already be `pipeline:ready-to-deploy` from the prior transition.
- Living `parked-item-worktree-release` says re-advance SHALL recreate via `createWorktree`. Re-entry at `pre-merge` skips planning/implementing, so that create never runs. This change does not rematerialize a tree only to satisfy the check.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is #1236 / PR #1242 after park at `pre-merge`. The class is: trusted-surface / readiness subject candidate SHA must resolve without a live managed worktree when a later-stage re-entry already has an authoritative PR head or override. An R2D-only skip of `worktree_unavailable` for issue #1236 is a mole.
2. **Shared surfaces.** Candidate SHA resolution lives in `ensureTrustedSurfaceDecision` (shared gate). Ready-to-deploy tagging lives in `deploy_ready.finalize` (already refuses on blocked decision). Park-release is unchanged. No new blocker kind, no second recoverer, no merge inside advance/loop.
3. **Next identical fault.** The next issue parked at `pre-merge` whose worktree was released uses the same resolver. Unit tests fail if matching PR head still yields `worktree_unavailable` / untagged PR, or if a mismatched PR head is accepted.

## Goals / Non-Goals

**Goals:**

- Resolve trusted-surface `candidate_sha` without a managed worktree when a later-stage pin exists.
- Tag the linked PR `pipeline:ready-to-deploy` on that path.
- Keep fail-closed named outcomes when no matching SHA source exists.
- Keep worktree HEAD as the source when a managed worktree is present.
- Bite with injected unit tests on the #1236 shape and on a bogus PR head.

**Non-Goals:**

- Recreating a managed worktree at `pre-merge` only to satisfy this check.
- Changing park-release safety, retain, or capacity counting.
- Merging inside advance/loop; `auto_merge`; a merge stage.
- Repairing launcher Node bootstrap (#1236), OMP host (#1235), or factory-plane identity (#1237).
- Accepting an arbitrary open PR head that does not match the last-advanced pin.

## Decisions

### 1. Shared SHA resolver in trusted-surface, not an R2D special case (primary)

**Choice:** Extend candidate SHA resolution inside the existing trusted-surface decision path (the function that today returns `worktree_unavailable`). Resolution order: worktree HEAD if present; else explicit candidate-SHA override (full 40-hex); else linked open PR head when it matches the last-advanced pin (or the pin is absent). Persist a real SHA on success. Do not add a ready-to-deploy-only bypass that ignores a blocked decision.

**Why:** `ensureTrustedSurfaceDecision` runs for every stage. An R2D-only ignore of `worktree_unavailable` would still persist a blocked decision at `pre-merge` and leave the next identical late-stage gate broken. Finalize already keys on the durable decision.

**Alternatives considered:**

- Rematerialize a worktree at `pre-merge` so the existing HEAD path works → rejected. Issue out of scope; wastes a capacity slot for a SHA lookup.
- Skip trusted-surface entirely at R2D when the worktree is gone → rejected. Fail-open on the verifier surface.
- R2D-only: if issue label is already `ready-to-deploy`, tag the PR anyway → rejected. Tags without a resolved candidate SHA.

### 2. Last-advanced pin is injected; production reads existing recorded SHA

**Choice:** Tests inject `lastAdvancedCandidateSha` (or equivalent). Production reads the SHA last recorded as this issue's product candidate: review SHA-gate pin, last successful pre-merge candidate, or last non-sentinel trusted-surface `candidate_sha`. When that pin is absent and a linked open PR head is 40-hex, use the PR head. When the pin is present and the PR head differs, fail closed with a named mismatch code. Do not invent a SHA.

**Why:** Park-release already requires remote tip or open PR. The #1236 PR head is the reviewed candidate. A later force-push that moves HEAD off the advanced SHA must not become the readiness subject.

**Alternatives considered:**

- Always trust current PR head with no pin check → rejected by AC (bogus PR head test).
- Fail whenever the pin is absent, even if a PR exists → over-closed; a first re-entry after park may not have a same-run pin because trusted-surface runs before pre-merge records SHA.
- New public `--sha` CLI flag → only if one already exists. Today `candidateSha` is a handoff option, not an advance flag. Expose an injectable override seam for tests and callers; do not add a new public CLI in this change.

### 3. After SHA resolve, compute or reuse the decision; never invent passthrough

**Choice:** Once `candidate_sha` is known, compute the trusted-surface decision via an injectable object-source seam (changed-path set and base blobs), not via a managed worktree. Tests inject canned paths/blobs. Production MAY fetch the candidate SHA into the host checkout (or equivalent object reader) without creating a managed worktree. If a SHA-matched durable decision already exists for this run, reuse it. If neither compute nor reuse is possible, `blocked` with a named reason (`diff_unresolved` or equivalent), not silent `passthrough` and not a fabricated all-zero SHA.

**Why:** Candidate SHA alone does not prove verifier-sensitive paths. Guessing `passthrough` would let a parked `.github/pipeline.yml` change self-judge. Recreating a managed worktree is out of scope; an object-source seam is the class fix.

**Alternatives considered:**

- Reuse a prior *issue* run's `trusted-surface.json` by SHA across run directories as the only path → incomplete when the previous decision used the all-zero sentinel or is missing.
- Skip path classification when there is no worktree → silent passthrough; rejected.

### 4. Named fail-closed codes stay machine-readable

**Choice:** Keep `worktree_unavailable` only when a worktree was required and missing *and* no later-stage SHA source applied. New or existing named codes for: no SHA source (`candidate_sha_unresolved` or equivalent) and pin/PR mismatch (`candidate_sha_mismatch` or equivalent). Exact strings locked by tests. Do not add a new `BlockerKind`; finalize already maps blocked trusted-surface to `needs-human`.

**Why:** Operators and recover paths key on reason codes. Collapsing mismatch into `worktree_unavailable` hides the real fault.

### 5. PR tag is a consequence of a non-blocked decision, not a second write path

**Choice:** Do not add a new labeling helper. Once trusted-surface is not blocked, existing `deploy_ready.finalize` tags the PR. Tests assert that helper is reached (or the tag seam is called) on the matching-PR-head fixture, and is not called on mismatch / missing PR.

**Why:** The live bug is the blocked decision, not a missing `addLabelToPr` call. A second tag path would drift from the single-run log line.

### 6. Park-release spec exception is late-stage only

**Choice:** Modify living `parked-item-worktree-release` so `createWorktree` on resume still applies to stages that need a tree. Add the late-stage exception: at/after `pre-merge`, do not rematerialize solely for SHA resolution. Do not change release safety, dirty/local-only retain, or capacity counting.

**Why:** The existing resume requirement would contradict this change if left as "any re-advance creates a worktree." Early-stage resume still needs a tree.

## Risks / Trade-offs

- **[Risk] Object-source compute is weaker than a full worktree (no dirty tree, no local-only commits).** → Mitigation: park-release already required clean + remote tip or open PR. Late-stage re-entry is SHA-identity work, not harness edit. Dirty local work is a retain case and is out of this path.
- **[Risk] Last-advanced pin missing on first re-entry.** → Mitigation: when pin is absent, linked open PR head is authoritative. Mismatch fail applies only when the pin is present.
- **[Risk] GitHub PR head fetch in production.** → Mitigation: injectable seam; unit tests never call live `gh` or git. Production uses existing `getPrForIssue` / PR view JSON fields already used elsewhere (confirm field names before coding).
- **[Risk] Issue labeled ready-to-deploy while PR stays unlabeled if finalize still refuses.** → Mitigation: tests assert the PR tag seam on the matching-head fixture, not only the issue label.

## Migration Plan

No migration. Existing worktree-present runs keep current HEAD resolution. Parked later-stage issues become re-enterable without operator worktree recreate.

Rollback: revert the resolver fallback; `worktree_unavailable` returns. No stored schema change required unless a new reason code is added to persisted `trusted-surface.json` (additive; old readers already ignore unknown reason details).

## Open Questions

None. Candidate override is an injectable seam, not a new public CLI, unless an advance `--sha` flag already exists at implementation time.
