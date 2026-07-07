# Tasks

## 1. Recognize the missing pipeline structural markers (`gh.ts`)
- [x] 1.1 Add `## Pre-merge Delta Review` to the recognized pipeline markers and generalize `## Review 1`/`## Review 2` to `## Review <N>` for any positive integer N (regex or numeric-suffix check), keeping the existing `## Review 1`/`## Review 2` cases green.
- [x] 1.2 Recognize the pipeline machine-sentinel HTML markers (`<!-- pipeline-audit:`, `<!-- pipeline-override`, `<!-- pipeline-override-scope`, `<!-- pipeline-blocking-keys`, `<!-- pipeline-blocking-surfaces`, `<!-- reviewed-sha`) as structural pipeline markers in `classifyComment`.
- [x] 1.3 Keep `classifyComment` a pure body-classification (no signature change); confirm `isPipelineComment` and other consumers stay consistent.

## 2. Author-gate the exclusion and add the plain-acknowledgement anchor (`issue-context-snapshot.ts`)
- [x] 2.1 In `findUnacknowledgedComments`, exclude a `classifyComment === 'pipeline'` comment only when its author is a trusted actor (present in the already-passed trusted-actor comment set); count pipeline-styled comments from non-trusted authors as human input.
- [x] 2.2 Extend the anchor-selection loop so a trusted-actor comment posted after the plan anchor that contains no scope-changing / change-request language (`NEGATION_PATTERNS`) advances the anchor, in addition to the existing trusted `## Pipeline: Scope override` anchor.
- [x] 2.3 Ensure a plain-acknowledgement anchor comment is not itself counted on the next resume (it sits at the anchor, so post-anchor scanning excludes it).
- [x] 2.4 Update the docstring/param name to reflect that the passed set is "trusted-actor comments" (not only scope-overrides), preserving the fail-closed default when the actor is null.

## 3. Wire trusted-actor context at call sites (`review-routing.ts`, `fix.ts`)
- [x] 3.1 Confirm both gate call sites already pass `buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors)`; adjust argument passing if the function needs the actor identity as well as the trusted-comment set.

## 4. Regression tests (`issue-context-snapshot.test.ts`, `gh` classification tests)
- [x] 4.1 `classifyComment` returns `'pipeline'` for `## Pre-merge Delta Review …`, `## Review 3`, and a body containing a `<!-- pipeline-audit: … -->` sentinel; returns `'human'` for an unmarked body.
- [x] 4.2 castrecall #45: delta-review needs-attention + follow-up approve, both under the actor's login → zero unacknowledged.
- [x] 4.3 Forged pipeline-styled body from a non-trusted author → counted as human input.
- [x] 4.4 Plain trusted-actor acknowledgement dismisses a prior unacknowledged human comment and is not re-counted on resume.
- [x] 4.5 Trusted-actor comment with scope-changing language still counts.
- [x] 4.6 Prove each test bites: it fails against the pre-change behavior.

## 5. Mirror + full gate
- [x] 5.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 5.2 `npm run ci` green (core tests, mirror check, install smoke, `openspec validate --all`).
