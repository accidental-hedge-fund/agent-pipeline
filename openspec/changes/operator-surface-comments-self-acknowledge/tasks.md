# Tasks — operator-surface comments are self-acknowledging (#484)

## 1. Registry

- [ ] 1.1 Add an `operatorSurface: true` marker to `PIPELINE_COMMENT_KINDS`
      (`core/scripts/gh.ts`) for `unblocked`, `finding-override`, `scope-override`, and flip
      those three entries from `verify: "exempt"` to `verify: "pipeline-attest"`.
- [ ] 1.2 Delete the now-false `reason` text on `finding-override` / `scope-override`
      ("not constructed/posted anywhere in core/scripts/"); keep `pre-planning-context`
      exempt and rewrite its reason to state the third-party-authorship distinction.
- [ ] 1.3 Export a helper that answers "is this body a verified operator-surface comment?"
      from the attestation payload's `kind` (no heading-literal matching).

## 2. Render the three bodies through the attesting helper

- [ ] 2.1 `runUnblock` (`core/scripts/pipeline.ts`): wrap the `## Pipeline: Unblocked` body
      in `attestPipelineComment("unblocked", …)`.
- [ ] 2.2 `overrideComment` / `scopedOverrideComment` (`core/scripts/review-policy.ts`):
      attest as `finding-override` / `scope-override`. Verify the scoped-override sentinel
      that `extractScopedOverrides` reads back still parses with the marker appended.

## 3. Gate

- [ ] 3.1 `findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`): treat a
      trusted-actor, verified operator-surface comment as an acknowledgement anchor.
- [ ] 3.2 Replace the hard-coded `SCOPE_OVERRIDE_HEADING` anchor branch with the new rule
      (do not stack both); keep the trusted-actor plain-ack branch and the fail-closed
      empty-`trustedComments` behaviour intact.
- [ ] 3.3 Update the module doc-comment on `findUnacknowledgedComments` to describe the
      operator-surface rule alongside the #390/#471 history.

## 4. Tests (`core/test/`)

- [ ] 4.1 Regression (issue-context-snapshot.test.ts): plan anchor → trusted-actor attested
      `## Pipeline: Unblocked` whose answer contains "instead"/"don't" → zero unacknowledged.
      Confirm it fails before the fix.
- [ ] 4.2 Same for attested `## Pipeline: Finding override` and `## Pipeline: Scope override`
      with change-request wording in `### Reason`.
- [ ] 4.3 Third-party human comment posted after the unblock comment → still counted.
- [ ] 4.4 Operator-surface heading from a non-trusted author → still counted.
- [ ] 4.5 Attested operator-surface body with text appended after the marker → verification
      fails → still counted.
- [ ] 4.6 Earlier unacknowledged human comment + later attested unblock comment → anchor
      advances → zero unacknowledged (no manual scope override needed).
- [ ] 4.7 Stage-level regression (fix.test.ts or review-routing.test.ts): resuming a fix
      round after `unblock` posts no `## Pipeline: New human input detected` and does not
      set `pipeline:blocked`.
- [ ] 4.8 Extend the `PIPELINE_COMMENT_KINDS` drift guards
      (`pipeline-comment-attestation.test.ts`): the three kinds render + verify, and the
      `operatorSurface` set is exactly those three.

## 5. Docs & gate

- [ ] 5.1 Update the `unblock` / `override` command docs (`hosts/**/SKILL.md`, blocked-recovery
      recipe text) if they instruct the operator to hand-post a scope override after unblock.
- [ ] 5.2 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the same change.
- [ ] 5.3 `npm run ci` green from the repo root.
