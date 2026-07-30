## Context

The merge-queue cluster (#673–#676) adds a human-gated walker over
`pipeline:ready-to-deploy` PRs. Drive (#674) merges via the existing
`/pipeline:merge` surface; hold/repair (#675) records held items. After a clean
drive, operators still run `pipeline release` manually.

`pipeline release` already **prepares** a release PR only (version bump, mirror
regen, CI gate, ROADMAP scaffold, open PR). It does not tag, merge, or publish —
post-merge tag/publish stays on existing GitHub Actions after a human merges the
release PR. `runRelease` is injectable via `ReleaseDeps` and supports `dryRun` and
`noEdit`.

This change wires an **opt-in** post-drive hook into that existing prepare path.
It does not introduce `auto_merge` or advance-loop merge authority.

Sibling capabilities (#673–#675) may land first; this design assumes a merge-queue
drive surface that can report: candidate set remaining, held items, dry-run vs
apply, and a completion evaluation after the drive pass. Implementation of #676
MAY land after #674’s completion definition exists, or against a shared
completion helper introduced by this change and used by the drive.

## Goals / Non-Goals

**Goals:**

- Opt-in only: default drive never prepares a release.
- Deterministic **queue-complete** definition for release-when-complete.
- Reuse `runRelease` (or the same library it is) so release policy stays single-sourced.
- Isolate release failure from merge success.
- Dry-run discloses intent without side effects.
- Prove invariants with unit tests (injected deps).

**Non-Goals:**

- Auto-tag, npm publish, or auto-merge of the release PR from merge-queue.
- Closing the milestone via API.
- Changing semver resolution, ROADMAP four-site scaffold, or release CI gate.
- Background daemon merge or any `auto_merge` config key.
- Requiring the milestone to have zero open non-R2D issues before prepare
  (reported as warning only).

## Decisions

### 1. Completeness definition (queue-complete)

**Decision:** Release-when-complete evaluates **queue-complete** as both:

1. **No remaining open R2D candidates** for the same selector used by the drive
   (at least milestone): open issues in the selector that still have an open PR
   linked under `pipeline:ready-to-deploy` (and whatever other eligibility the
   queue uses for candidates) count as incomplete.
2. **No held items** for this drive (conflict / checks-failed / budget exhaust
   holds from #675, or equivalent hold records if only #674 is present).

**Open non-R2D issues** on the milestone (planning, implementing, blocked, etc.)
do **not** block release prepare. The command SHALL emit a warning listing their
count (and optionally numbers) so the operator sees residual work.

**Rationale:** Operators often cut a release for what shipped while leftover
backlog remains on the same milestone title. Blocking on all open issues would
force either premature milestone hygiene or manual release anyway. The issue’s
“optionally when the milestone has no remaining open issues” is treated as
**optional future strictness**, not v1.

**Alternatives considered:**

- *Strict: zero open milestone issues* — cleaner “milestone done” story, but
  blocks the common “ship what is R2D, leave backlog” workflow.
- *Only “drive processed all initial candidates”* — misses PRs that became R2D
  mid-drive or were skipped/held; re-query is safer.

### 2. Opt-in surface

**Decision:**

- CLI: `--release-when-complete` on the merge-queue command (exact parent flag
  spelling matches the merge-queue CLI once #673/#674 land).
- Config (optional): e.g. `merge_queue.release_when_complete: false` (default
  false). CLI flag ORs with config (either true enables).
- Version argument: when release-when-complete is enabled, require an explicit
  version intent: `--release-version <major|minor|patch|X.Y.Z>` (or a single
  adjacent flag accepted by design at implement time). If enabled without a
  version, exit non-zero **before** prepare with a usage error (and before any
  release mutation). Dry-run with flag but missing version still reports the
  validation error path without preparing.

**Rationale:** Silent default version (e.g. always `minor`) is too easy to get
wrong on patch hotfix trains. Explicit version mirrors `pipeline release`’s
required version argument.

**Alternatives considered:**

- *Default `minor`* — less typing, higher surprise risk.
- *Infer from ROADMAP release-plan row* — clever but fragile and out of scope.

### 3. Invoke existing prepare path, non-interactively

**Decision:** Call `runRelease(versionArg, { dryRun, noEdit: true }, cfg, deps)`
(or a thin shared wrapper used by both CLI `pipeline release` and merge-queue)
from the merge-queue completion hook. Always pass `noEdit: true` on this path so
the drive does not hang on `$EDITOR`. Dry-run merge-queue passes `dryRun: true`
into release so no PR is opened and no release-managed files are written.

**Rationale:** Single source of release policy; avoids forking ROADMAP/scaffold
logic. `noEdit` already exists on the release path.

**Alternatives considered:**

- *Shell out to `pipeline release` subprocess* — harder to inject deps in tests;
  messier exit codes. Prefer in-process shared function.
- *Duplicate a slim prepare* — rejects rigor / single-source rule.

### 4. When to evaluate complete

**Decision:** Evaluate after the drive pass finishes processing (including any
holds). Re-query remaining R2D candidates for the selector rather than trusting
only the initial candidate list, so mid-drive label/PR changes are reflected.

For **dry-run**, evaluate projected completeness from the dry-run plan (no merges
performed): if the planned drive would leave zero remaining R2D candidates and
zero holds under current state, report “would prepare release”; if current state
already has remaining candidates or holds, report would-not with reason. Dry-run
MUST NOT assume merges that have not happened make the queue complete unless the
plan shows every current candidate would be merged and none would hold — prefer
**current-state** completeness for “would prepare” honesty:

- Dry-run **would prepare** only if **current** state is already queue-complete
  (nothing left to merge/hold) AND the flag is set. A dry-run over a non-empty
  queue reports would-not prepare because release would run only after a live
  drive empties it.

**Rationale:** Avoid promising a release PR from a dry-run that still lists
merges. Operators re-run dry-run after apply, or run apply with the flag.

### 5. Failure isolation

**Decision:** Structure the drive result as:

1. Perform merges / holds (existing drive).
2. If opt-in and queue-complete → call release prepare.
3. If prepare throws or exits non-zero → record release failure on the result,
   print a clear error (`[merge-queue] release prepare failed: …`), exit non-zero
   for the overall command **only after** merge outcomes are already reported as
   done. Do not unmerge, re-drive, or delete held state.

Unit tests assert prepare is invoked after merge phase and that a failing prepare
dep does not call merge again or reverse merge results.

### 6. No tag / publish / merge of release

**Decision:** Spec-level invariant: this path MUST NOT call tag creation, `gh
release create`, npm publish, or `gh pr merge` on the release PR. Rely on
`runRelease`’s existing stop-at-open-PR behavior; tests on the hook mock assert
no tag/merge/publish deps are invoked (even if release deps gain such methods
later, the hook must not wire them).

### 7. Config and golden rules

**Decision:** No `auto_merge` key. Release-when-complete is prepare-only and
opt-in. Document single-operator / single-host assumption inherited from
merge-queue drive.

## Risks / Trade-offs

- **[Risk] Sibling merge-queue not landed** → Implementation tasks depend on
  #673/#674 surfaces; this OpenSpec change still freezes intent and can land
  first. Wire into a completion hook once drive exists.
- **[Risk] Preparing release with residual non-R2D work confuses operators** →
  Warning lists open non-R2D issues; human reviews the release PR before merge.
- **[Risk] Dirty tree / CI failure during prepare after merges** → Expected;
  error surfaces; merges stay done; operator fixes tree and runs `pipeline
  release` manually. Same failure modes as standalone release.
- **[Risk] Version wrong for the train** → Mitigated by required
  `--release-version`; no silent default.
- **[Risk] Double prepare if re-run after complete** → Second live run with flag
  may attempt another release; `runRelease` clean-tree / existing release branch
  behavior applies. Document that re-running after a successful prepare is
  operator-owned (idempotency of release is not this change’s job beyond not
  looping forever).

## Migration Plan

1. Land OpenSpec change; implement against merge-queue drive when available.
2. Default remains off — no behavior change for operators who never pass the flag.
3. Rollback: remove flag handling or leave flag unused; no data migration.

## Open Questions

- Exact merge-queue CLI parent command name (`merge-queue` vs bikeshed) — owned
  by #673; this change attaches flags to whatever lands.
- Whether config key lives under `merge_queue.*` vs a flatter key — implementer
  matches #673/#674 config shape when present; otherwise CLI-only is acceptable
  for v1 if config surface is not yet defined.
- Optional future: `--require-milestone-empty` strict completeness — out of
  scope for v1 unless product asks.
