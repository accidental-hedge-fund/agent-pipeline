## 1. Audit current false claims

- [x] 1.1 Grep high-traffic surfaces for absolute "pipeline never merges", "no merge command anywhere", and merge-queue "never merges" claims that ignore `--apply` (`CLAUDE.md`, `AGENTS.md`, `README.md`, `hosts/*/SKILL.md`, `openspec/project.md`, `openspec/specs/pipeline-state-machine/spec.md`, `openspec/specs/merge-queue-command/spec.md`)
- [x] 1.2 Classify each hit using design D6 (keep advance-isolation truths and subcommand-local "this path never merges" claims; fix product-level falsehoods)
- [x] 1.3 Confirm existing isolation tests in `core/test/merge.test.ts` (and any merge-queue isolation tests) still assert `mergePr` / merge-queue unreachable from advance

## 2. Align living-spec intent in source files (implementation of deltas)

- [x] 2.1 Update `openspec/specs/pipeline-state-machine/spec.md` "Never auto-merge (structural guarantee)" body and scenarios to match this change's MODIFIED delta (no merge stage; no merge from advance; name `pipeline merge` and `merge-queue --apply`; keep `auto_merge` rejection scenario)
- [x] 2.2 Update `openspec/specs/merge-queue-command/spec.md` authority requirement to drop "future drive" language and name operator `--apply` with dry-run default
- [x] 2.3 Add living `openspec/specs/merge-authority-boundary/spec.md` when archiving (or leave until pre-merge archive if the project only materializes new capabilities at archive — follow repo archive convention; keep the change delta as source of truth until then)

## 3. Reword golden rules and project context

- [x] 3.1 Reword CLAUDE.md golden rule 4 to no-autonomous-merge + operator carve-out (`pipeline merge`, `merge-queue --apply`, no `auto_merge`, unattended remains #662)
- [x] 3.2 Reword AGENTS.md golden rule 4 to match CLAUDE.md (no contradictory twin)
- [x] 3.3 Align `openspec/project.md` Out of scope auto-merge bullet with the same boundary if it over-claims

## 4. Align README and host skills

- [x] 4.1 Update README front-door and human-merge sections: autonomous through R2D; explicit operator merge surfaces exist; no unattended auto-merge; not end-to-end autonomous SDLC/ADLC
- [x] 4.2 Fix README absolute "pipeline never merges" product claims that deny operator merge commands (leave true subcommand-local "this PR is for human review" phrasing)
- [x] 4.3 Update `hosts/claude/SKILL.md` entry summary and "What this skill never does" to name per-PR merge and merge-queue `--apply` as operator-only; dry-run default; advance never merges
- [x] 4.4 Update `hosts/codex/SKILL.md` with the same policy phrasing
- [x] 4.5 Run `node scripts/build.mjs` and include regenerated `plugin/` if Claude packaging is mirrored from `hosts/claude`

## 5. Preserve and tighten structural drift-guards

- [x] 5.1 Keep loop-isolation tests: advance stage handlers do not import merge for merging; `dispatch()` does not call `mergePr`
- [x] 5.2 Confirm merge-queue remains excluded from the autonomous stage-handler import scan as a human-gated CLI surface (not an advance stage)
- [x] 5.3 Add or extend a minimal regression assertion if any gap is found (e.g. advance path referencing merge-queue apply symbols)
- [x] 5.4 Optionally add a narrow docs presence/absence check only if it is stable (do not fail legitimate "advance loop never merges" sentences)

## 6. Verification

- [x] 6.1 Run `openspec validate no-autonomous-merge-policy` and fix any structural issues
- [x] 6.2 Run `node scripts/build.mjs --check` after host skill / mirror updates
- [x] 6.3 Run `npm run ci` from the repo root and fix failures
- [x] 6.4 Re-run the audit grep and check every acceptance criterion in `proposal.md` as falsifiable done
- [x] 6.5 Confirm zero intentional runtime behavior change (diff limited to docs, specs, comments, tests/guards)
