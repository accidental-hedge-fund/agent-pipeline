## 1. Confirm event shape and CLI surface

- [x] 1.1 Confirm advance completion event field/value (`type: "run_complete"`) from `run-store` writers — do not invent field names
- [x] 1.2 Inventory current `pipeline logs` follow implementation and loop until-terminal helper for reuse (`followEventsWithTerminalExit` or equivalent)
- [x] 1.3 Design flag surface: `--until-terminal` / `--no-until-terminal` on advance logs when `--events --follow`; default until-terminal **on** for that path only

## 2. Host skill orchestration (§4)

- [x] 2.1 Update `hosts/claude/SKILL.md` §4 with same-turn re-attach after cancelled/interrupted/timed-out/lost follow before terminal (liveness → re-arm → continue → summary)
- [x] 2.2 State explicitly that cancelled wait is **not** a terminal pipeline outcome and must not end supervision alone
- [x] 2.3 Document the operator re-attach path: `pipeline status <N>` + `pipeline logs <run-id> --events --follow` + `pipeline summary <run-id>` (run-store ids only)
- [x] 2.4 Keep/strengthen final summary + same-turn stop follows after `run_complete` / sentinel
- [x] 2.5 Mirror the same guidance in `hosts/codex/SKILL.md`
- [x] 2.6 Update command one-liners / tables that restate advance follow so they document until-terminal default (when CLI ships) and re-attach recovery

## 3. Advance logs until-terminal (engine)

- [x] 3.1 Add until-terminal option parsing/allowlist for `pipeline logs … --events --follow` without breaking dump/list or read-only classification
- [x] 3.2 Implement line-aware events follow that prints lines and exits 0 on `run_complete` under default until-terminal
- [x] 3.3 Support `--no-until-terminal` interrupt-only path; leave non-`--events` `terminal.log` follow interrupt-only
- [x] 3.4 Handle historical `run_complete` already in file (exit 0, no hang); buffer incomplete trailing lines; ignore non-matching lines for terminal detection
- [x] 3.5 Update help strings so `--events --follow` does not claim unconditional interrupt-only as the only stop condition
- [x] 3.6 Document supervise-until-terminal composition (`logs … --events --follow && summary <run-id>`) in skill and/or help; add thin CLI alias only if packaging needs it

## 4. Tests and drift guards

- [x] 4.1 Unit regression: default `--events --follow` exits 0 when a `run_complete` line is delivered (fails without the implementation)
- [x] 4.2 Unit: historical `run_complete` ends follow without hang
- [x] 4.3 Unit: `--no-until-terminal` does not exit solely on `run_complete`
- [x] 4.4 CLI parse/allowlist tests for new flags; existing dump/list/read-only tests remain green
- [x] 4.5 Drift-guard: fail if Claude/Codex skill §4 drops re-attach, cancelled-wait-not-terminal, or run-store re-attach command path language
- [x] 4.6 All new tests use injected seams only (no real network, git, or live advance process)

## 5. Mirror, validate, and CI

- [x] 5.1 Run `node scripts/build.mjs` and include regenerated `plugin/` when host/core packaging sources change
- [x] 5.2 `openspec validate advance-follow-reattach-until-terminal` (and `--all` via ci) remains green
- [x] 5.3 Run `npm run ci` from repo root; treat red as not-done
- [x] 5.4 Confirm out-of-scope: no advance stage-semantic, review-policy, or auto-merge changes
