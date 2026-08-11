## 1. Engine-promote host default

- [ ] 1.1 Change omitted-host resolution in `core/scripts/stages/engine-promote.ts` from `codex` to `all` (including comments that still say default codex)
- [ ] 1.2 Align CLI `--host` help / usage strings in `core/scripts/pipeline.ts` (and command-docs if generated from source of truth) so the documented default is `all`
- [ ] 1.3 Confirm ship-adapter promote either inherits the new default or passes `host: "all"` explicitly; do not leave a codex-only override
- [ ] 1.4 Keep single-host and `all` values accepted; invalid host still fails closed

## 2. Ship playbook default

- [ ] 2.1 Change `examples/supervisor/shell/pipeline-ship-playbook.sh` so `HOST="${ENGINE_PROMOTE_HOST:-all}"` (not `codex`)
- [ ] 2.2 Update the playbook header comment for `ENGINE_PROMOTE_HOST` to document default `all` and list valid values
- [ ] 2.3 Keep the promote invocation passing explicit `--host "$HOST"` (no silent omission)

## 3. Regression coverage

- [ ] 3.1 Unit test: omitted host on promote builds install command with `--host all` (fails if default is `codex`)
- [ ] 3.2 Unit test: explicit `--host` / host option (e.g. `codex` or `claude`) is preserved in the install command
- [ ] 3.3 Test or static assertion: ship playbook unset default is `all` and honors `ENGINE_PROMOTE_HOST` override shape
- [ ] 3.4 Update any existing engine-promote tests that hard-assume default `codex` for omitted host

## 4. Docs surface

- [ ] 4.1 Align operator-facing docs that still claim engine-promote or playbook default host is `codex` for ship (e.g. playbook comments, `docs/cli.md` if present, supervisor docs) with default `all` and override
- [ ] 4.2 Leave intentionally scoped single-host examples (e.g. Hermes codex-only install) as explicit `--host codex`, not as the ship default

## 5. Mirror and verify

- [ ] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 5.2 Run `openspec validate engine-promote-all-hosts` (and `openspec validate --all` if required by local gate)
- [ ] 5.3 Run targeted tests for engine-promote / ship surfaces, then `npm run ci` from repo root
