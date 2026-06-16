## Why

Pipeline Desk needs to launch and supervise `agent-pipeline` runs as subprocesses, but there is no stable, host-neutral entrypoint: it must know whether the user installed the Claude skill, the Codex skill, a marketplace copy, or a local dev checkout — and a launched run dies if the launching process exits. These two gaps block desktop integration.

## What Changes

- **New `pipeline run <issue> --detach` flag**: escapes the harness process group (`setsid`/double-fork so the run survives SIGTERM on the launcher), holds an advisory `flock` to serialize concurrent launches, applies a `--timeout` watchdog, and writes an always-appended completion sentinel with exit code to the run directory so a poller can classify running/done/crashed without parsing prose.
- **New `pipeline path` subcommand**: reports installed core path, version string, and host coverage in four machine-readable states — missing, Claude-only, Codex-only, or both — via `--json` for programmatic callers. Non-JSON output is human-readable.
- **README section**: documents the desktop-safe launch/discovery path so integrators do not need to read source.
- No changes to `/pipeline` or `$pipeline` human interfaces; no daemon; no move of prompt/state-machine logic.

## Capabilities

### New Capabilities

- `detached-launcher`: Process-group escape, flock serialization, timeout watchdog, and machine-readable completion sentinel for `pipeline run --detach`.
- `host-install-discovery`: `pipeline path` subcommand that enumerates installed hosts and reports coverage in four states (missing / Claude-only / Codex-only / both).

### Modified Capabilities

<!-- None: existing cli-version-flag and cross-host-profiles requirements are unchanged; this change adds adjacent capabilities rather than modifying their contracts. -->

## Impact

- `core/scripts/pipeline.ts`: new `--detach` flag on the `run` subcommand; new `path` subcommand.
- `core/scripts/` (new files): `detach.ts` (launcher logic), `discovery.ts` (host-install probe).
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/_shared/`: no structural change; README gains a new desktop-integration section.
- No breaking changes to existing CLI flags or label-driven state machine.

## Acceptance Criteria

- [ ] `pipeline run <issue> --detach` launches a run that keeps advancing after the launching process terminates (SIGTERM-proof via process-group escape).
- [ ] The run directory contains a completion sentinel file written atomically on exit; the sentinel includes the process exit code so a poller can classify running / done / crashed with no prose parsing.
- [ ] Concurrent `--detach` launches for the same issue are serialized by an advisory flock (second caller waits or fails fast — not silently races).
- [ ] `--timeout <seconds>` watchdog kills a hung detached run and writes the sentinel with a non-zero exit code.
- [ ] `pipeline path` (human-readable) and `pipeline path --json` (machine-readable) both report: installed core path, version string, and host coverage in one of four states: missing / Claude-only / Codex-only / both.
- [ ] `pipeline --version` continues to work without any Claude/Codex chat invocation (no regression).
- [ ] Existing skill/plugin installs (`/pipeline` and `$pipeline`) are unaffected.
- [ ] README documents the desktop-safe `pipeline run --detach` launch command and `pipeline path --json` discovery call.
