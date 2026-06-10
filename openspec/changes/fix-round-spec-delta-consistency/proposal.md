## Why

Since OpenSpec authoring was moved into the planning phase (#68), the change's spec deltas are frozen at planning time — but fix rounds only edit code, so a material review finding can cause the implementation to diverge from its own spec and a stale delta is silently archived into the living specs at pre-merge. The primary harm is living-spec corruption; the secondary harm is reviewer-vs-stale-spec churn from the #16 SHA gate re-anchoring on a now-wrong delta.

## What Changes

- `core/scripts/prompts/fix.md`: add an OpenSpec-conditional instruction block that permits and instructs the fix harness to update the active change's `specs/**` deltas (and `tasks.md`) when a finding's fix changes behavior described by them, and to re-run `openspec validate <id>` after doing so.
- `core/scripts/prompts/index.ts` (`specContextSection`): reframe the injected spec section from "This work **must satisfy** these requirement changes" (read-only, frozen-truth framing) to "This work **must stay consistent with** these requirement changes" (consistency framing that permits updates when the spec itself was wrong).
- `core/scripts/stages/pre_merge.ts` (`maybeArchiveOpenspec`): add a consistency guard before calling `openspec archive` — detect "code moved, spec didn't" divergence (developer/fix commits touched implementation files while the change's `specs/**` stayed untouched and a reviewer finding flagged spec divergence) and block with a descriptive reason rather than archiving a stale delta.
- New unit test: given a mock where a fix diverges from the frozen spec delta and the reviewer flagged divergence, `maybeArchiveOpenspec` returns `{ status: "blocked" }` rather than archiving.

## Capabilities

### New Capabilities
- `openspec-fix-round-spec-revision`: Fix rounds are permitted and instructed to revise the active change's spec deltas when a finding implies a behavioral change from the described spec; the revised delta is validated before advancing.

### Modified Capabilities
- `openspec-integration`: The archive step at pre-merge gains a consistency guard — it SHALL detect and block on "code moved, spec didn't" divergence before folding the change into the living specs.

## Impact

- `core/scripts/prompts/fix.md` — instruction added (OpenSpec-conditional).
- `core/scripts/prompts/index.ts` — `specContextSection` wording change only.
- `core/scripts/stages/pre_merge.ts` — `maybeArchiveOpenspec` gains pre-archive consistency check.
- `core/test/pre-merge.test.ts` — regression test added.
- `openspec/specs/openspec-fix-round-spec-revision/spec.md` — new living spec.
- `openspec/specs/openspec-integration/spec.md` — archive requirement modified.
- No changes to the state-machine edges, review prompts, or any other pipeline stage.
