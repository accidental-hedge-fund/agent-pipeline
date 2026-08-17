## Why

`auto-tag-release.yml` no longer requires
`.agent-pipeline/frg/<ver>/latest.json` (#962 / #964). That unblocked
v1.34 tagging after Factory Reliability Gate (FRG) could not produce a
pack. Tugboat now writes that file as a normal ship output (#1039).
Tagging a release merge without a release-eligible FRG pass is a hole.

## What Changes

- **Auto-tag fail-closes on missing or failed FRG.** On a detected
  release merge whose version tag does not already exist, the workflow
  SHALL require a release-eligible FRG pass artifact for the version
  being tagged (`pass: true`, matching version, same eligibility rules
  already used by `--validate-tag`). Missing, unparsable, `pass: false`,
  or otherwise ineligible evidence SHALL exit non-zero and SHALL NOT
  create or push the tag.
- **Passing `latest.json` allows the tag.** A present, parseable,
  release-eligible `pass: true` artifact for that version SHALL let
  auto-tag proceed to notes resolution and annotated tag push under
  existing `RELEASE_TAG_TOKEN` rules.
- **Failure names path and remediation.** The fail-closed message SHALL
  name `.agent-pipeline/frg/<X.Y.Z>/latest.json` and SHALL name
  `factory-release prepare` / the Tugboat FRG pack phase as the
  remediation. It SHALL NOT tell the operator that FRG is optional or
  advisory.
- **#962 inverted test flips.** The workflow test that currently asserts
  the FRG step is absent SHALL instead assert that the step exists
  before tag create/push, and that missing or failed evidence blocks
  the tag.
- **Reuse the shared validator.** Restore the existing
  `factory-reliability-gate.ts --validate-tag` / `validateFrgEvidenceFileForTag`
  path. Do not invent a second tag validator.

**BREAKING** for a release merge that has no release-eligible FRG
`latest.json` for that version. Auto-tag will fail closed instead of
tagging. That is the intended restore after #1039. Do not land this
check on a base that still lacks the Tugboat FRG pack phase.

## Acceptance Criteria

- [ ] On a detected release merge for `X.Y.Z` whose tag `vX.Y.Z` does
      not exist, missing `.agent-pipeline/frg/X.Y.Z/latest.json` causes
      the auto-tag job to exit non-zero and create or push no tag.
- [ ] The same merge with `latest.json` present but `pass: false` (or
      otherwise not release-eligible) also exits non-zero and creates
      or pushes no tag.
- [ ] The same merge with a release-eligible `latest.json` (`pass:
      true`, matching version) allows tag create/push to proceed under
      existing notes and `RELEASE_TAG_TOKEN` rules.
- [ ] The fail-closed message names `.agent-pipeline/frg/<X.Y.Z>/latest.json`
      and names `factory-release prepare` or the Tugboat FRG pack phase
      as the remediation.
- [ ] A non-release default-branch push still exits as a successful
      no-op and does not require FRG evidence.
- [ ] Workflow / unit tests fail if the FRG verify step is removed,
      if missing or failed FRG still allows tag create/push, or if a
      passing `latest.json` is treated as a hard block. Tests inject
      I/O or inspect the workflow and validator; they do not push
      real tags.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same
      change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This restores and tightens existing auto-tag and FRG law. -->

### Modified Capabilities

- `release-auto-tag-on-merge`: Auto-tag SHALL verify a release-eligible
  FRG `latest.json` for the detected version before tag create/push.
  Missing or failed evidence SHALL fail closed. A passing artifact
  SHALL allow the tag. The fail-closed message SHALL name the missing
  path and the `factory-release prepare` / Tugboat FRG-pack remediation.
  The #962 inverted “FRG must be absent” test SHALL flip.
- `factory-reliability-gate`: The shared `--validate-tag` /
  `validateFrgEvidenceFileForTag` fail-closed message SHALL name the
  `latest.json` path and the same remediation. Skip-frg restore law
  SHALL stop calling auto-tag a later child; this change is that child.
  Eligibility rules (HMAC, provenance, matching version) stay shared.

## Impact

- **Workflow:** `.github/workflows/auto-tag-release.yml` — restore the
  “Verify Factory Reliability Gate evidence” step before notes / tag
  push. Remove the #962 “FRG is optional/advisory” comment.
- **Shared validator:** `core/scripts/factory-reliability-gate.ts`
  (`validateFrgEvidenceFileForTag`, `--validate-tag`). Tighten the
  missing/fail message to name the path and remediation. Do not add a
  second validator.
- **Tests:** `core/test/auto-tag-release-workflow.test.ts` (flip the
  #962 inverted assertion; add missing/fail/pass cases). Existing
  `validateFrgEvidenceFileForTag` tests in
  `core/test/factory-reliability-gate.test.ts` cover eligibility;
  extend them only for the remediating message.
- **Docs:** `docs/factory-reliability-gate-runbook.md` auto-tag section
  already describes the guard. Align any leftover thin-ship “optional
  FRG on auto-tag” wording.
- **Mirror / gate:** regenerate `plugin/` after any `core/` edit.
  `npm run ci` must pass.
- **Depends on:** #1039 (Tugboat FRG pack writes `latest.json` as
  normal ship output). That parent is on the integration base. Landing
  this check before #1039 would recreate the 1.34 “merged release PR,
  cannot tag” failure.
- **Does not:** implement the pack generator; change Tugboat (parent);
  merge or publish a GitHub Release; add `auto_merge` or a merge stage;
  weaken HMAC / release-eligibility; add a second tag validator.
