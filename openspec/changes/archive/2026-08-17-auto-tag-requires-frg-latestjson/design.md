## Context

See `proposal.md` for why. Current law and code:

- Living `release-auto-tag-on-merge` already requires a release-eligible
  FRG artifact before tag create/push. Implementation does not match.
  #964 removed the workflow step so v1.34 could tag after FRG could not
  produce a pack. `core/test/auto-tag-release-workflow.test.ts` now
  asserts that step is **absent**.
- The shared validator still exists:
  `factory-reliability-gate.ts --validate-tag <X.Y.Z>` and
  `validateFrgEvidenceFileForTag`. Missing-file error names the path
  and points at the FRG runbook. It does **not** name
  `factory-release prepare` or the Tugboat FRG pack phase.
- #1039 is on the integration base. Tugboat default ship now runs an
  FRG pack phase and writes
  `.agent-pipeline/frg/<X.Y.Z>/latest.json` before `pipeline release`.
  Restoring the auto-tag gate no longer recreates the 1.34 hole **when
  the default ship path ran**.

**Class vs site (engine-dogfood bar):** the site is “this workflow YAML
is missing one step.” The class is: after Tugboat writes `latest.json`
as a normal ship output, a release-merge tag without a release-eligible
FRG pass is a hole. Shared surfaces: auto-tag workflow, shared
`--validate-tag` / `validateFrgEvidenceFileForTag`, and the workflow
drift-guard that currently inverts the gate. The next identical “tag
without FRG” fault SHALL fail that shared gate and SHALL NOT need a new
mole issue.

## Goals / Non-Goals

**Goals:**

- Restore fail-closed auto-tag on missing or failed FRG for the version
  being tagged.
- Name the missing path and the pack remediation in the fail message.
- Flip the #962 inverted test so removing the step fails CI again.
- Reuse the shared tag validator. Do not invent a second one.

**Non-Goals:**

- Implementing the pack generator.
- Changing Tugboat (parent #1039).
- Weakening HMAC / release-eligibility.
- Adding an auto-tag `--skip-frg` escape.
- Merging, publishing a GitHub Release, or adding `auto_merge`.

## Decisions

### 1. Restore the removed workflow step; reuse `--validate-tag`

**Choice:** Put back the step `#964` deleted, immediately after the
existing-tag check and **before** notes resolution and tag create/push.
Keep the historical step name `Verify Factory Reliability Gate evidence`
so the drift-guard can find it. The step runs only when a release merge
is detected, the package version matches, and `vX.Y.Z` does not already
exist. It invokes the existing shared CLI:

`node --experimental-strip-types core/scripts/factory-reliability-gate.ts --validate-tag <X.Y.Z>`

It still requires `PIPELINE_FRG_ATTESTATION_KEY` for HMAC verification
(living eligibility law). On non-zero exit the job fails and creates
no tag.

**Why:** Living spec already names this validator. A second bash
existence check would miss `pass: false`, HMAC, and provenance.

**Alternatives considered:**

- Workflow-only `test -f latest.json` → rejected; not release-eligible.
- New tag-only validator → rejected; second brain.
- Soft-warn and still tag → rejected; the hole this issue closes.

### 2. Put remediating text on the shared validator, not only YAML

**Choice:** `validateFrgEvidenceFileForTag` (and therefore
`--validate-tag`) SHALL name
`.agent-pipeline/frg/<X.Y.Z>/latest.json` and SHALL name
`factory-release prepare` / the Tugboat FRG pack phase on fail-closed.
The workflow MAY wrap that with `::error::`. It SHALL NOT be the only
place that names the remediation.

**Why:** Class-over-site. Any later tag path that calls the shared
validator gets the same message. A YAML-only string is a mole.

**Alternatives considered:**

- YAML echo only → rejected; site-local mole.
- Keep “see the runbook” only → rejected; issue names the remediations.

### 3. Flip the #962 inverted test; add missing / fail / pass cases

**Choice:** Replace
`auto-tag-release workflow does not hard-gate tag create on FRG evidence`
with a guard that fails if the verify step is missing, runs after the
exists-check, or is skipped when `exists=false`. Add hermetic cases:
missing file blocks, `pass: false` blocks, release-eligible `pass:
true` proceeds (subject to notes / token). Inject I/O. Do not push
real tags.

**Why:** Leaving the inverted test in place would fail the restore.
Adding a second test that fights it would flake.

**Alternatives considered:**

- Keep the inverted test as history → rejected; it encodes the hole.

### 4. No auto-tag skip; Tugboat `--skip-frg` then fails at tag

**Choice:** Auto-tag has no `--skip-frg`. If an operator skipped FRG on
Tugboat / `pipeline release`, the merge can land without `latest.json`,
and auto-tag SHALL fail closed. Manual tag or a later honest pack is
the escape. That is the intended hole-close.

**Why:** Issue acceptance is fail-closed. A second skip on the tag path
would restore the hole.

**Alternatives considered:**

- Honor Tugboat skip at tag time → rejected; no durable skip signal on
  the merge commit, and it reopens the hole.
- Land this before #1039 → rejected; recreates the 1.34 failure.

## Risks / Trade-offs

- **[Risk] Operator skip-frg release then cannot auto-tag.** →
  Mitigation: intended. Message names `factory-release prepare` /
  Tugboat FRG pack. Manual annotated tag remains possible.
- **[Risk] `PIPELINE_FRG_ATTESTATION_KEY` missing fails a real pass.** →
  Mitigation: living eligibility law. Same secret the old step used.
  Do not weaken HMAC.
- **[Risk] Implementer adds a file-exists check and skips the shared
  validator.** → Mitigation: spec and workflow tests require
  `--validate-tag` (or the shared file-for-tag validator) before tag
  create/push.
- **[Trade-off] Fail-closed after merge is louder than fail-closed
  before release.** → Acceptable. Release already fail-closes without
  FRG on the default path. Auto-tag is the last shared gate if a skip
  or a stale PR bypassed prepare.

## Migration Plan

1. Land only on a base that already contains #1039 (true on `main`).
2. Restore the workflow step, tighten the shared fail message, flip
   the inverted test, regenerate `plugin/` if `core/` changed.
3. Next default-path release merge tags only when
   `.agent-pipeline/frg/<ver>/latest.json` is release-eligible.

Rollback: revert the workflow step and the test flip. The shared
validator can keep the remediating message; that is backward compatible.

## Open Questions

None that block specs or tasks.
