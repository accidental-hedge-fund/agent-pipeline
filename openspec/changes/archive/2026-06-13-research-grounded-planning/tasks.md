## 1. Strengthen `planning.md` with a repo-research instruction and acceptance-criteria section

- [x] 1.1 Prepend a mandatory pre-draft research block to `planning.md`: "Before drafting the plan, read the files most directly in scope for this issue and identify the patterns they establish. Cite at least one concrete pattern from the repo in the Approach section."
- [x] 1.2 Add a `### Acceptance criteria` section to the `planning.md` output format: a checkable list of observable outcomes that make the issue done (not restatements of the approach; must be falsifiable).
- [x] 1.3 Verify the `substitute()` call in `buildPlanningPrompt` (index.ts) still satisfies all `{{placeholders}}`; no new placeholders are introduced (prompt is self-contained text, not a parameterized addition).

## 2. Mirror the acceptance-criteria section in `planning_openspec.md`

- [x] 2.1 Add the same `### Acceptance criteria` section (or equivalent framing) to `planning_openspec.md` so OpenSpec-mode plans also emit explicit criteria.

## 3. Mirror regeneration + CI

- [x] 3.1 Run `node scripts/build.mjs`; confirm `plugin/` is updated.
- [x] 3.2 `npm run ci` passes (core tests + mirror check + install smoke).
