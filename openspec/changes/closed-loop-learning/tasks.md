## 1. Documentation: conventions-file lessons convention

- [x] 1.1 Add a "Lessons / Gotchas" subsection to `README.md` (and `hosts/*/SKILL.md` if present) explaining: (a) the pipeline reads the conventions file into every stage prompt via `readConventions`, (b) maintainers MAY add a lessons/gotchas section to propagate recurring-mistake context, (c) the pipeline never writes to this file, and (d) no configuration key is required beyond the existing `conventions_md_path` / `CLAUDE.md` default.
- [x] 1.2 Verify that the section is present and accurate in all SKILL.md host variants (`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/_shared/SKILL.md`). If a shared SKILL.md exists, update only that one; otherwise update each variant. (No `_shared` SKILL.md exists — updated both `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`.)

## 2. Regression tests: read path coverage

- [x] 2.1 In `core/test/`, add a test asserting that `buildPlanningPrompt` returns a string containing the content of a non-empty conventions file — confirming `readConventions` reaches the planning prompt builder. Test MUST fail without the `conventions` key in the interpolation map. (Bites two ways: the `{{conventions}}` placeholder is present in `planning.md`, so dropping the key throws "Unfilled prompt placeholder"; and the asserted marker would vanish.)
- [x] 2.2 Add an equivalent test for `buildReviewPrompt` (standard) confirming the conventions content is present in the returned string. (Covers both standard and adversarial review prompts.)
- [x] 2.3 Add a test asserting that when no conventions file exists, `readConventions` returns the stub string and `buildPlanningPrompt` completes without error (existing behavior preserved). (Covers planning + review.)

## 3. Regression tests: no-write guarantee

- [x] 3.1 Add a test that runs each stage prompt builder with a fake `cfg` pointing to a temp conventions file and asserts no builder opens any file for writing. (Snapshots the conventions file's content + mtime and the repo-dir listing before/after building all 9 stage prompts — the observable proof the spec scenario specifies; plus a companion test that no builder creates a conventions file when none exists.)

## 4. Mirror + CI

- [x] 4.1 Run `node scripts/build.mjs` to regenerate `plugin/` if any `core/` source file was touched; confirm output is clean.
- [x] 4.2 Run `npm run ci` from repo root; all checks green before marking done.
