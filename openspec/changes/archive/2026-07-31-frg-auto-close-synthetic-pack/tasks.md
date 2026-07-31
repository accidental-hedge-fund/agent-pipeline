## 1. Specs and docs alignment

- [x] 1.1 Keep OpenSpec change `frg-auto-close-synthetic-pack` valid (`openspec validate frg-auto-close-synthetic-pack`) after any artifact edits during implement
- [x] 1.2 Update `docs/factory-reliability-gate-runbook.md`: release-eligible pass ⇒ auto-close synthetic pack PRs/issues without merge; never merge; opt-out flag name + when to use; product milestones out of scope
- [x] 1.3 If docs generation / freshness gate applies, regenerate or satisfy `docs:check` for the runbook change

## 2. Close helper and candidate resolution

- [x] 2.1 Confirm real `gh` close/comment shapes (`gh pr close` / `gh issue close` help or live dry inspection) before coding against flags
- [x] 2.2 Add or extend deps-injected close helpers (prefer `gh.ts` wrappers or FRG-local deps) that post the deterministic FRG close comment and close PR/issue without merge
- [x] 2.3 Implement pure candidate selection: from release-eligible evidence + loop/scoreboard resolution → open PRs/issues for `ready_clean` scored items filtered by pack selector label; skip already-closed; never repo-wide label sweep

## 3. FRG driver integration

- [x] 3.1 Invoke post-pass pack disposition only after successful evidence write when `pass: true` and release-eligible
- [x] 3.2 Add CLI opt-out flag (`--no-close-pack` or `--keep-pack-open` — one name, wire through help and runbook)
- [x] 3.3 Fail-soft: report close errors on stderr/summary; do not flip `pass`, delete evidence, or fail exit solely due to close errors; continue best-effort on remaining candidates
- [x] 3.4 Ensure merge / merge-queue APIs are never called on this path

## 4. Tests

- [x] 4.1 Unit tests with injected `gh`/resolution fakes: release-eligible pass closes the right PR+issue set with the standard comment
- [x] 4.2 Non-pass and non-release-eligible paths perform zero closes
- [x] 4.3 Non-pack / missing scoreboard items are never closed
- [x] 4.4 Opt-out skips all closes while still allowing `pass: true` evidence
- [x] 4.5 Close errors are reported and leave `pass: true` / evidence intact (regression for fail-soft)
- [x] 4.6 Prove at least one test fails without the production hook (bite check) during development

## 5. Packaging and verification

- [x] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 5.2 Run `npm run ci` from repo root and fix failures until green
