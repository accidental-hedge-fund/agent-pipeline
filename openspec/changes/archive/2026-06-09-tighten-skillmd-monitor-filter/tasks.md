## 1. Audit current filter usage

- [x] 1.1 Confirm that every `[pipeline] #N:` transition line in `pipeline.ts` (and stage handlers) carries the `[pipeline] #N: ` prefix — i.e., no real failure or terminal line is emitted without that prefix
- [x] 1.2 Confirm that process exit / crash is signalled by background task completion independent of log content (no need to grep for exit markers)

## 2. Update plugin SKILL.md

- [x] 2.1 In `plugin/pipeline/skills/pipeline/SKILL.md` section 4c, replace the broad grep alternation with `^\[pipeline\] #<N>: ` (issue-number-anchored)
- [x] 2.2 Update the explanatory prose: remove the "we deliberately broaden the filter" rationale; add the test-gate fixture / Monitor auto-stop explanation
- [x] 2.3 Show a concrete example with `<N>` substituted (e.g., `^\[pipeline\] #64: `)
- [x] 2.4 Confirm no real signal is lost by adding a note that every transition — including `done`, `blocked: …`, `→ ready-to-deploy` — begins with `[pipeline] #N:`

## 3. Update hosts/claude SKILL.md

- [x] 3.1 In `hosts/claude/SKILL.md` section 4c, apply the same tight filter and updated prose as task 2 (identical change)

## 4. Update hosts/codex SKILL.md

- [x] 4.1 In `hosts/codex/SKILL.md` section 4c, apply the same tight filter and updated prose as task 2 (identical change)

## 5. Validate and commit

- [x] 5.1 Run `openspec validate tighten-skillmd-monitor-filter` and fix any structural errors
- [x] 5.2 Commit all OpenSpec change artifacts (`openspec/changes/tighten-skillmd-monitor-filter/`) with a message referencing #64
- [x] 5.3 Commit the three SKILL.md edits referencing #64
