## 1. Confirm the two flagged ambiguities before coding

- [ ] 1.1 Confirm with @comamitc that `--doctor` (preflight-gate-then-advance) stays a modifier and is NOT deprecated, with `pipeline:doctor` mapping to the standalone `doctor` command.
- [ ] 1.2 Confirm the `pipeline:summary` argument contract: `pipeline:summary <N>` routes to the issue-bundle dump; `pipeline summary <run-id>` stays the exact-run selector.

## 2. CLI keyword promotion (`COMMAND_REGISTRY` + dispatch)

- [ ] 2.1 Add `status`, `unblock`, and `override` entries to `COMMAND_REGISTRY` (`needsIssueNumber: true`; `allowedFlags` = the modifier set each operation consumes; `mutatesGitHub`/`needsConfig`/`needsGhAuth`/`supportsJson` matching the legacy flag's behavior — e.g. `status` is read-only + `supportsJson: true`, `unblock`/`override` mutate GitHub).
- [ ] 2.2 Make `cleanup` an actually-dispatched positional keyword (`pipeline cleanup`) routed to the existing cleanup handler; keep its registry entry consistent with the `--cleanup` flag mode.
- [ ] 2.3 Wire positional dispatch in `pipeline.ts` for `status <N>`, `unblock <N> "<answer>"`, `override <N> "<spec>"`, and `cleanup` to the *same* handlers the legacy flags invoked (parse-and-route only; no behavior change).
- [ ] 2.4 Add `status`, `unblock`, `override`, `cleanup` to the recognized-keyword guard list in `pipeline.ts` so an unrecognized positional still errors cleanly.

## 3. Deprecation shims for legacy mode flags

- [ ] 3.1 For each of `--status`, `--summary`, `--unblock`, `--override`, `--init`, `--cleanup`, emit exactly one deprecation notice to **stderr** naming the `pipeline:<command>` / `pipeline <command>` replacement, then run the existing operation unchanged.
- [ ] 3.2 Verify stdout/exit-code contracts are unchanged for `--status --json` and `--summary` (notice on stderr only).
- [ ] 3.3 Ensure `--doctor` emits NO deprecation notice (it remains a modifier).

## 4. Collapse `run` into `--detach`

- [ ] 4.1 Honor `--detach` on the base advance command: route `pipeline N --detach` to the same detached-launch entry point as `pipeline run N --detach` (reuse `handleRunSubcommand`/`spawnDetached`).
- [ ] 4.2 Keep the `run` keyword as an undocumented, deprecated alias (still dispatching); remove it from advertised help/docs but not from dispatch.
- [ ] 4.3 Do NOT create a `pipeline:run` host entry.

## 5. Host command surface (single source → both hosts)

- [ ] 5.1 Define a single declarative source listing the in-scope operations (`status`, `unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`, `triage`, `merge`, `release`, `roadmap`, `logs`) with the CLI invocation each forwards to and a one-line description.
- [ ] 5.2 Generate the Claude `commands/` entries (`/pipeline:<command>`) from that source in `scripts/build.mjs`; each forwards to the equivalent CLI invocation.
- [ ] 5.3 Generate the symmetric Codex overlay entries (`$pipeline:<command>`) from the same source.
- [ ] 5.4 Ensure `scripts/build.mjs` writes the new surface into the `plugin/` mirror so `build.mjs --check` passes.

## 6. Documentation

- [ ] 6.1 Update README mode/usage table to the `pipeline:<command>` shapes; annotate deprecated `--flag` forms.
- [ ] 6.2 Update `hosts/claude/SKILL.md` "Modes" table to `/pipeline:<command>` shapes (+ deprecation notes).
- [ ] 6.3 Update `hosts/codex/SKILL.md` "Modes" table to `$pipeline:<command>` shapes (+ deprecation notes).
- [ ] 6.4 Confirm the advance loop (`/pipeline N`, `$pipeline N`) is documented as the unchanged primary invocation.

## 7. Tests

- [ ] 7.1 Golden CLI-parsing tests: each new keyword (`status`/`unblock`/`override`/`cleanup`) dispatches to the correct handler with the right issue/PR number; advance loop unaffected.
- [ ] 7.2 Registry test: `COMMAND_REGISTRY` contains entries for `status`, `unblock`, `override`, `cleanup`; `lookupCommand` returns them; issue-number metadata is correct.
- [ ] 7.3 Deprecation-shim tests: each legacy flag still performs its op AND prints exactly one stderr notice; `--status --json` stdout unchanged; `--doctor` prints no notice.
- [ ] 7.4 Detach test: `pipeline N --detach` reaches the same detached-launch entry as `pipeline run N --detach`; no `pipeline:run` entry exists.
- [ ] 7.5 Host-surface drift-guard test: generated host command set ≡ the in-scope operation set, and is identical across Claude and Codex.

## 8. Mirror + CI

- [ ] 8.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` in the same change.
- [ ] 8.2 Run `npm run ci` from the repo root; confirm green (`ci:core` → `build.mjs --check` → `ci:install-smoke`).
