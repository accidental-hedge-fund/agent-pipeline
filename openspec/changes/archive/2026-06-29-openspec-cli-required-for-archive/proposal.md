## Why

At pre-merge, `maybeArchiveOpenspec` treats a missing `openspec` CLI as a *non-blocking
skip* — even when the PR branch introduced active OpenSpec change directories that still
need archiving. It logs `openspec CLI unavailable; skipping archive (non-blocking)` and
returns `null`, so pre-merge advances the issue to `ready-to-deploy` with the change never
archived. The active `openspec/changes/<id>/` directory then ships to `main`, and the next
issue that runs OpenSpec planning sees two active changes and is blocked by the "expected
exactly one change" planning guard.

This already happened in production: issue #275 (PR #300) merged 2026-06-24 without
archiving `merge-no-required-checks-fallback`; the orphaned change blocked planning for
issue #289 across three attempts and required a manual cleanup PR (#307).

The behavior is also a documented policy mismatch. `doctor` already treats active OpenSpec
as *requiring* the `openspec` CLI (`openspec-cli` check), and planning blocks with an
install hint when the CLI is missing — yet the README and `maybeArchiveOpenspec` say the
pre-merge archive is skipped non-blocking. A missing CLI is not a safe reason to skip an
archive that has active candidates: skipping silently corrupts `main`'s OpenSpec state.

## What Changes

- **Archive gate becomes blocking when there is work to do.** When `openspec.archive`
  reports the CLI is `unavailable` and the branch diff contains one or more active change
  directories (`candidates.length > 0`), `maybeArchiveOpenspec` SHALL block the issue via
  `setBlocked(..., "pre-merge", "openspec-invalid")` with a message naming the missing CLI
  and the change id(s), and return `{ advanced: false, status: "blocked" }` — the same
  outcome class as an archive failure. It SHALL no longer return `null`.
- **No regression when there is nothing to archive.** When there are no active candidates
  (`candidates.length === 0`), the function returns `null` *before* invoking the CLI, exactly
  as today — repos with no active change to finalize are unaffected.
- **Docs aligned to the policy.** The README's OpenSpec section is updated so "active
  OpenSpec means the `openspec` CLI is required" reads consistently across `doctor`,
  planning, and the pre-merge archive: a missing CLI blocks (`openspec-invalid`) when there
  is an active change to archive, rather than being skipped non-blocking.

Out of scope (the downstream `openspec validate --all` gate at pre-merge keeps its current
non-blocking skip): the archive gate runs first and returns before validation, so whenever
active candidates exist with the CLI missing, the archive gate already blocks. The
validation gate is only reached when there are *no* active candidates — flipping it to
block there would regress the "no candidates ⇒ continue unaffected" guarantee. See
`design.md`. The repo-CI `openspec validate --all` gap is tracked separately in #315.

## Capabilities

### Modified Capabilities

- `openspec-integration`: the pre-merge archive step's requirement is extended so a missing
  `openspec` CLI blocks (`openspec-invalid`) when active change candidates exist, instead of
  skipping non-blocking; the no-candidates path stays a non-blocking continue.

## Impact

- `core/scripts/stages/pre_merge.ts` — `maybeArchiveOpenspec`, the `if (res.unavailable)`
  branch inside the candidate loop (currently returns `null`).
- `core/test/pre-merge-convergence.test.ts` (or a new co-located test) — regression test for
  the unavailable-with-candidates → blocked path, plus the unavailable-with-no-candidates →
  null path.
- `README.md` — OpenSpec section CLI-availability wording (around the "the `openspec` CLI
  must be on PATH" sentence).
- `plugin/` mirror — regenerated via `node scripts/build.mjs` after the `core/` change.

## Acceptance Criteria

- [ ] When `openspec.archive` returns `{ unavailable: true }` and the branch diff has one or
  more active change candidates, `maybeArchiveOpenspec` calls `setBlocked` with stage
  `"pre-merge"`, type `"openspec-invalid"`, and a message naming the missing `openspec` CLI
  and the change id, then returns `{ advanced: false, status: "blocked" }`. It does NOT
  return `null`.
- [ ] When the `openspec` CLI is unavailable but there are no active candidates
  (`candidates.length === 0`), `maybeArchiveOpenspec` returns `null` without calling the CLI
  or `setBlocked` — repos with nothing to archive are unaffected (no regression).
- [ ] When the `openspec` CLI is available, archive proceeds exactly as before (success →
  commit/push/`waiting`; failure → block `openspec-invalid`) — no behavior change on the
  CLI-present paths.
- [ ] A regression test drives `maybeArchiveOpenspec` with an `openspecArchive` dep returning
  `{ unavailable: true }` and exactly one active candidate, and asserts the outcome is
  `{ status: "blocked" }` and that `setBlocked` was called with type `"openspec-invalid"`.
  The test bites: it fails against the pre-fix `return null` and passes after the fix.
- [ ] The README no longer states the pre-merge archive is skipped non-blocking when the CLI
  is missing; it states the CLI is required (blocks `openspec-invalid`) when there is an
  active change to archive, consistent with `doctor` and planning.
- [ ] `npm run ci` passes end-to-end (core tests + `build.mjs --check` mirror sync + install
  smoke).
