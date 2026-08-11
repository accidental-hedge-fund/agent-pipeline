## 1. Engine-promote host default

- [x] 1.1 Change omitted-host resolution in `core/scripts/stages/engine-promote.ts` from `codex` to `all` (including comments that still say default codex)
- [x] 1.2 Align CLI `--host` help / usage strings in `core/scripts/pipeline.ts` (and command-docs if generated from source of truth) so the documented default is `all`
- [x] 1.3 Confirm ship-adapter promote either inherits the new default or passes `host: "all"` explicitly; do not leave a codex-only override
- [x] 1.4 Keep single-host and `all` values accepted; invalid host still fails closed

## 2. Ship playbook default

- [x] 2.1 Change `examples/supervisor/shell/pipeline-ship-playbook.sh` so `HOST="${ENGINE_PROMOTE_HOST:-all}"` (not `codex`)
- [x] 2.2 Update the playbook header comment for `ENGINE_PROMOTE_HOST` to document default `all` and list valid values
- [x] 2.3 Keep the promote invocation passing explicit `--host "$HOST"` (no silent omission)

## 3. Regression coverage

- [x] 3.1 Unit test: omitted host on promote builds install command with `--host all` (fails if default is `codex`)
- [x] 3.2 Unit test: explicit `--host` / host option (e.g. `codex` or `claude`) is preserved in the install command
- [x] 3.3 Test or static assertion: ship playbook unset default is `all` and honors `ENGINE_PROMOTE_HOST` override shape
- [x] 3.4 Update any existing engine-promote tests that hard-assume default `codex` for omitted host
- [x] 3.5 Pure helper + doctor check: legacy installed playbook with `:-codex` fails closed without override; `:-all` passes; missing playbook skips (#989 review 1)

## 3b. Rollout enforcement for already-installed playbook

- [x] 3b.1 Document mandatory pre-ship refresh / versioned-path / `ENGINE_PROMOTE_HOST=all` in `docs/runbooks/ship-milestone.md`
- [x] 3b.2 Doctor check `supervisor:ship-playbook-promote-host` fails on legacy codex-only installed playbook when env override is unset

## 4. Docs surface

- [x] 4.1 Align operator-facing docs that still claim engine-promote or playbook default host is `codex` for ship (e.g. playbook comments, `docs/cli.md` if present, supervisor docs) with default `all` and override
- [x] 4.2 Leave intentionally scoped single-host examples (e.g. Hermes codex-only install) as explicit `--host codex`, not as the ship default

## 5. Mirror and verify

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [x] 5.2 Run `openspec validate engine-promote-all-hosts` (and `openspec validate --all` if required by local gate)
- [x] 5.3 Run targeted tests for engine-promote / ship surfaces, then `npm run ci` from repo root
