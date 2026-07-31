## 1. Convention golden rules

- [x] 1.1 Rewrite CLAUDE.md golden rule 4 to **no autonomous merges**: advance stops at `pipeline:ready-to-deploy`; merge only via explicit operator invocation (`pipeline merge` / `/pipeline:merge`, `merge-queue --apply` with dry-run default); session-bound operator authority; no `auto_merge` config key; unattended merge deferred to #662
- [x] 1.2 Mirror the same rule phrasing in AGENTS.md golden rule 4 (keep CLAUDE.md / AGENTS.md in sync)

## 2. Living-spec-aligned docs surfaces

- [x] 2.1 Update README purpose summary and any "owns the merge button / never auto-merge" product-boundary lines to the precise autonomy boundary (through ready-to-deploy; operator-authorized merge; no autonomous deployment / end-to-end SDLC claim)
- [x] 2.2 Update `hosts/claude/SKILL.md` lead, merge-next-step notes, and "What this skill never does" so merge-queue `--apply` is recognized as an operator merge surface and autonomous/unattended merge remains forbidden
- [x] 2.3 Update `hosts/codex/SKILL.md` with the same policy phrasing as the Claude host skill
- [x] 2.4 Spot-check other live operator-facing docs that still assert absolute "pipeline never merges" as current policy (e.g. high-traffic host packaging text) and align only those that define current product rules — leave archived OpenSpec history alone

## 3. Structural guards (no behavior change)

- [x] 3.1 Confirm existing tests still encode: stage handlers do not import merge-queue drive symbols; stage handlers do not import `merge.ts` / call `mergePr`; `auto_merge` rejected at config parse
- [x] 3.2 Keep or add a drift-guard that `mergePr` is unreachable from the advance loop dispatch path; if adding, use a static/read unit test with no network/git/subprocess and prove it would fail if advance imported/called merge
- [x] 3.3 Do not change merge, merge-queue, or advance runtime behavior

## 4. Mirror, validate, CI

- [x] 4.1 If host skill content is mirrored into `plugin/`, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [x] 4.2 Run `openspec validate policy-no-autonomous-merge` (and `openspec validate --all` if required by local workflow) until green
- [x] 4.3 Run `npm run ci` from repo root and fix any docs-freshness / mirror / test failures introduced by the wording change only
