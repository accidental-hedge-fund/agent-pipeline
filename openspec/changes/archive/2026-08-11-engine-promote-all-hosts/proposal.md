## Why

After a milestone ship completes, `engine-promote` installs the released engine to only the Codex skill tree. Claude Code, Grok (symlink → Claude), and OpenCode stay on the previous release. That was observed on the v1.35.0 ship (2026-08-11): the shared launcher and Codex skill reached 1.35.0 while Claude/Grok/OpenCode remained on 1.34.0. The root cause is silent `codex` defaults on the ship promote path (`ENGINE_PROMOTE_HOST` and `engine-promote` when `--host` is omitted). A ship is a cross-tool release and must land the new engine on every configured outer host.

## What Changes

- The supervisor ship playbook SHALL default the engine-promote install host to `all` (not `codex`) when `ENGINE_PROMOTE_HOST` is unset, and SHALL still honor an explicit operator override to a single host.
- The `pipeline engine-promote` command and its install resolution SHALL default install host selection to `all` when `--host` is omitted, matching the installer's multi-host default and ship operator intent.
- The in-engine ship coordinator promote phase SHALL install via the same multi-host default (or an explicit equivalent) so `pipeline ship` does not leave non-Codex hosts stale.
- Promote logs, state text, and machine-readable promote output SHALL record the effective `--host` value (or resolved host set) — no silent default.
- Operators SHALL still be able to scope install to one host (`ENGINE_PROMOTE_HOST=codex`, `--host claude`, etc.).
- Unit/regression coverage SHALL prove ship-path host resolution defaults to `all`, honors overrides, and fails a reversion that restores a silent `codex`-only ship default.

### Acceptance criteria

- [ ] After a successful ship promote for version `X.Y.Z` with no host override, each managed host skill tree that the installer would update under `--host all` reports the new version (at minimum Codex, Claude, Grok when installed as the Claude-linked path, and OpenCode, honoring `CODEX_HOME` / `CLAUDE_CONFIG_DIR` / `OPENCODE_CONFIG_DIR` when set).
- [ ] When the operator sets `ENGINE_PROMOTE_HOST` or `--host` to a single host name, promote installs only that host and does not expand to `all`.
- [ ] The promote path records the effective host value(s) in operator-visible log and/or JSON result fields (for example install command line includes `--host <value>` and logs name the host; no path that omits host and silently assumes `codex`).
- [ ] A unit or script-level regression proves: (a) ship playbook host resolution defaults to `all` when `ENGINE_PROMOTE_HOST` is unset; (b) an explicit `ENGINE_PROMOTE_HOST` / `--host` override is honored; (c) bare `engine-promote` without `--host` resolves install host to `all` (or the ship path always passes an explicit non-codex-default host — whichever design is chosen, the test must fail if ship promote silently reverts to `codex` only).
- [ ] Scope stays on promote host selection and logging: no change to merge authority, advance/loop terminal stage, pin/FRG rules, or installer host-tree layout contracts beyond the host selector default used by promote.

## Capabilities

### New Capabilities

- `engine-promote`: Self-host promote contract for pin + tag install after a published release — install host selection default, operator override, and visibility of the effective host in logs/results.

### Modified Capabilities

- `supervisor-ship-playbook`: Ship playbook engine-promote phase host default and override (`ENGINE_PROMOTE_HOST` → `--host`).
- `ship-coordinator`: In-engine `pipeline ship` promote phase must use multi-host install default (or explicit `all`) so ship composition does not leave non-Codex hosts on the prior release.

## Impact

- **Primary surfaces:** `examples/supervisor/shell/pipeline-ship-playbook.sh` (`ENGINE_PROMOTE_HOST` default and promote invocation); `core/scripts/stages/engine-promote.ts` (host default when omitted); `core/scripts/pipeline.ts` (CLI `--host` default / help text); `core/scripts/stages/ship-adapter.ts` (ship promote opts); docs/runbooks that still document a codex-only ship promote default.
- **Operators / ships:** Post-ship installs land on every configured host unless scoped; scoped installs remain available for recovery and single-host hosts.
- **Tests:** Host-resolution unit coverage in `core/test/engine-promote.test.ts` and/or playbook-level default assertion; no live network or real skill-tree mutation in unit tests.
- **Out of scope:** Changing installer layout for individual hosts; merge/auto-merge; FRG requirements; advancing beyond `ready-to-deploy`; adding new outer hosts to the registry.
