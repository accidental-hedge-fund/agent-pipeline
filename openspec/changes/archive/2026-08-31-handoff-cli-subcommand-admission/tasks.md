## 1. CLI-parser regression (prove the guard still bites)

- [x] 1.1 Add CLI-parser tests that run `list`, `show`, `answer`, `reject`, and `supersede` through `buildCmd().parse` and assert `cmd.args.length <= maxPositionalsFor(cmd.args[0], cmd.args)`. Confirm the tests fail on the unfixed default cap of 1.
- [x] 1.2 Assert `--issue` and `--json` stay options (not positionals) for `pipeline handoff list --issue N --json`.
- [x] 1.3 Add inverse cases: extra token after `list`; missing ID for `show|answer|reject|supersede`; extra token after `show|answer|reject|supersede <id>`; missing verb; unknown verb. Extra-token cases MUST be over budget before a handler read or mutation.
- [x] 1.4 Optionally spawn `pipeline.ts` only for guard-rejected extras and assert exit 2 with `unexpected argument(s)` (no git/network). Do not spawn a valid `handoff list` in CI.

## 2. Shared positional gate

- [x] 2.1 Extend `maxPositionalsFor` with optional `args`. For `handoff`: `list` → 2; `show|answer|reject|supersede` → 3; missing/unknown verb → 2; no `args` → 3. Verify 1.1–1.3 pass.
- [x] 2.2 Pass `cmd.args` at the extra-positionals call site in `main`. Leave the existing `numArg === "handoff"` dispatch block, handler auth, flags, locks, materialization, and audit unchanged.
- [x] 2.3 Confirm nearby `maxPositionalsFor` caps for non-`handoff` commands still match `core/test/loop-command.test.ts`.

## 3. Docs surface

- [x] 3.1 Replace the collapsed `handoff` usage string in `command-docs.ts` with spaced-pipe alternatives for `list`, `show`, `answer`, `reject`, and `supersede`. Use `--filter-status`, not `--status`. Do not document module invocation.
- [x] 3.2 Regenerate `docs/cli.md` (`node scripts/generate-docs.mjs`) and confirm each verb appears as a complete `pipeline handoff …` alternative.
- [x] 3.3 Run `node scripts/build.mjs` after the `core/` edit and confirm host SKILL `--check` is fresh.

## 4. Full gate

- [x] 4.1 Run `npm run ci` from the repo root and confirm it passes (core tests, SKILL freshness, install smoke, OpenSpec, docs check, scripts).
