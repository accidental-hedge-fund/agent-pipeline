# Tasks — operator-surface comments are self-acknowledging (#484)

## 1. Registry

- [x] 1.1 Add an `operatorSurface: true` marker to `PIPELINE_COMMENT_KINDS`
      (`core/scripts/gh.ts`) for `unblocked`, `finding-override`, `scope-override`, and flip
      those three entries from `verify: "exempt"` to `verify: "pipeline-attest"`.
- [x] 1.2 Delete the now-false `reason` text on `finding-override` / `scope-override`
      ("not constructed/posted anywhere in core/scripts/"); keep `pre-planning-context`
      exempt and rewrite its reason to state the third-party-authorship distinction.
- [x] 1.3 Export a helper that answers "is this body a verified operator-surface comment?"
      from the attestation payload's `kind` (no heading-literal matching).

## 2. Render the three bodies through the attesting helper

- [x] 2.1 `runUnblock` (`core/scripts/pipeline.ts`): wrap the `## Pipeline: Unblocked` body
      in `attestPipelineComment("unblocked", …)`.
- [x] 2.2 `overrideComment` / `scopedOverrideComment` (`core/scripts/review-policy.ts`):
      attest as `finding-override` / `scope-override`. Verify the scoped-override sentinel
      that `extractScopedOverrides` reads back still parses with the marker appended.

## 3. Gate

- [x] 3.1 `findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`): treat a
      trusted-actor, verified operator-surface comment as an acknowledgement anchor.
- [x] 3.2 Replace the hard-coded `SCOPE_OVERRIDE_HEADING` anchor branch with the new rule
      (do not stack both); keep the trusted-actor plain-ack branch and the fail-closed
      empty-`trustedComments` behaviour intact.
- [x] 3.3 Update the module doc-comment on `findUnacknowledgedComments` to describe the
      operator-surface rule alongside the #390/#471 history.

## 4. Tests (`core/test/`)

- [x] 4.1 Regression (issue-context-snapshot.test.ts): plan anchor → trusted-actor attested
      `## Pipeline: Unblocked` whose answer contains "instead"/"don't" → zero unacknowledged.
      Confirm it fails before the fix.
- [x] 4.2 Same for attested `## Pipeline: Finding override` and `## Pipeline: Scope override`
      with change-request wording in `### Reason`.
- [x] 4.3 Third-party human comment posted after the unblock comment → still counted.
- [x] 4.4 Operator-surface heading from a non-trusted author → still counted.
- [x] 4.5 Attested operator-surface body with text appended after the marker → verification
      fails → still counted.
- [x] 4.6 Earlier unacknowledged human comment + later attested unblock comment → anchor
      advances → zero unacknowledged (no manual scope override needed).
- [x] 4.7 Stage-level regression (fix.test.ts or review-routing.test.ts): resuming a fix
      round after `unblock` posts no `## Pipeline: New human input detected` and does not
      set `pipeline:blocked`.
- [x] 4.8 Extend the `PIPELINE_COMMENT_KINDS` drift guards
      (`pipeline-comment-attestation.test.ts`): the three kinds render + verify, and the
      `operatorSurface` set is exactly those three.

## 5. Docs & gate

- [x] 5.1 Update the `unblock` / `override` command docs (`hosts/**/SKILL.md`, blocked-recovery
      recipe text) if they instruct the operator to hand-post a scope override after unblock.
      (No such instructions were found — no doc changes needed.)
- [x] 5.2 `node scripts/build.mjs` to regenerate `plugin/`; commit the mirror in the same change.
- [x] 5.3 `npm run ci` green from the repo root.
