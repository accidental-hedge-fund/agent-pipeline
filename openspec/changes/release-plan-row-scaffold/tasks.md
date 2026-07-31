## 1. Pure ensure helper (bite-first tests)

- [ ] 1.1 Add regression tests in `core/test/release.test.ts` that fail on current behavior: missing unshipped `| **v{version}** |` row causes `release-plan-row` abort from `patchReleasePlanRow` / `scaffoldRoadmap` without insert.
- [ ] 1.2 Implement pure `ensureReleasePlanRow` (name as fits local style) that: returns unchanged when unshipped row exists; returns unchanged when only shipped row exists (no duplicate); inserts via existing `insertReleasePlanRow` shape when missing; throws structured remediation when insert sentinel/table missing (copy-paste row, `ROADMAP.md`, insert location).
- [ ] 1.3 Unit-test shipped-row non-overwrite, unshipped non-duplicate, successful insert, and remediation error content.
- [ ] 1.4 Prove bite: missing-row regression fails without ensure wired; passes with ensure.

## 2. Wire ensure into release scaffold path

- [ ] 2.1 Call ensure at the start of `scaffoldRoadmap` (before intro / ship-mark / shipped block / per-issue stamp) so pre-validate, dry-run, and live paths all share it.
- [ ] 2.2 Confirm pre-validate still aborts before package writes when other anchors are missing or plan-row insert is impossible.
- [ ] 2.3 Confirm dry-run ROADMAP diff includes a newly scaffolded plan row without writing files.

## 3. Theme / issues / CLI sourcing

- [ ] 3.1 Accept optional `--theme` on `pipeline release` and pass it into plan-row scaffolding context.
- [ ] 3.2 Resolve theme: `--theme` → matching milestone title when available → documented placeholder.
- [ ] 3.3 Resolve Issues column from milestone membership and/or existing shipped-PR / git-log issue discovery; never invent issue numbers; use placeholder when empty.
- [ ] 3.4 Derive Bump from existing version bump typing; set Why to a short release-scaffolded note.
- [ ] 3.5 Unit-test theme precedence and no-invented-issue-numbers behavior with fake deps (no real network/git).

## 4. Documentation

- [ ] 4.1 Document required unshipped plan-row shape and auto-scaffold / remediation behavior in release help usage text.
- [ ] 4.2 Mirror the same shape and behavior note in host SKILL release sections (`hosts/claude`, `hosts/codex` as applicable).
- [ ] 4.3 After host/core edits that affect the mirror, run `node scripts/build.mjs` and include regenerated `plugin/` in the same implementation commit(s).

## 5. Verification

- [ ] 5.1 Run `cd core && npm test` (or targeted release tests) — all green; missing-row path covered.
- [ ] 5.2 Run `npm run ci` from repo root — green (mirror check, openspec validate, docs check if present).
- [ ] 5.3 Self-check acceptance criteria in `proposal.md` against implemented behavior; note any deferred follow-up (e.g. version-aware `release --check` only mode) explicitly if not landed.
