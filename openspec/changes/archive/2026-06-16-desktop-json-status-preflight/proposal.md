## Why

Pipeline Desk (the desktop UI) needs to read pipeline state and preflight results without scraping prose output or reimplementing pipeline/GitHub logic. The existing `--status` and `doctor` commands surface the right information for humans, but their output is unparseable by machines and can change without notice. A stable, versioned JSON contract unlocks all Pipeline Desk views (backlog, run-detail, health panel) from a single polling surface.

## What Changes

- `pipeline <issue> --status --json` prints a single unfenced JSON object containing the full issue status payload. Human `--status` output is **unchanged**.
- `pipeline doctor --json` prints a single unfenced JSON object containing per-check `{name, ok, reason, fix}` records. Human `doctor` output is **unchanged**.
- `pipeline doctor --is-ok` exits 0 (all checks pass) or 1 (any check fails) with **no output** — a cheap polling gate.
- Every JSON envelope carries a `schema_version` field and a top-level `status` discriminant. Field names and types are stable; key order is not load-bearing.
- Doctor JSON output **composes with** the existing `doctor-preflight` check implementations rather than duplicating them.

## Capabilities

### New Capabilities
- `machine-readable-status`: JSON output for `pipeline <issue> --status --json` — stable envelope for Pipeline Desk to render backlog/run-detail views.

### Modified Capabilities
- `doctor-preflight`: Add `--json` flag (structured JSON output with per-check records) and `--is-ok` flag (silent exit-0/1 gate) to the existing doctor command.

## Impact

- `core/scripts/pipeline.ts` — CLI argument parsing: add `--json` and `--is-ok` flags to `status` and `doctor` subcommands.
- `core/scripts/stages/` or new `core/scripts/status.ts` — status payload assembly logic.
- `core/scripts/stages/doctor*.ts` — extend doctor output path to emit structured JSON.
- `plugin/` mirror must be regenerated after every `core/` change.
- No changes to GitHub label semantics, the state machine, or any review/fix/pre-merge logic.
- Pipeline Desk consumers: new stable contract they can build against.

## Acceptance Criteria

- [ ] `pipeline <issue> --status --json` prints a valid, unfenced JSON object. No ```` ```json ```` fence, no leading/trailing prose.
- [ ] The JSON status payload includes at minimum: `schema_version`, `status` (discriminant e.g. `ok|blocked|needs-human|error`), `issue` (number + title), `stage`, `pr` (url + number, or null), `branch` (when known), `worktree` (path, when known), `last_event` (timestamp + description), `review_summary` (latest review verdict or null), `next_action` (human-readable string describing what the pipeline will do next), `config` (repo slug, domain).
- [ ] Human `pipeline <issue> --status` output is byte-for-byte identical to pre-change output (no regression).
- [ ] `pipeline doctor --json` prints a valid, unfenced JSON object containing `schema_version`, `status` (`ok|warnings|error`), and `checks` array where each entry is `{name, ok, reason, fix}`.
- [ ] `pipeline doctor --json` exits with code 1 when any check fails; exits 0 when all pass.
- [ ] `pipeline doctor --is-ok` exits 0 on all-pass, 1 on any-fail, with zero bytes of output in both cases.
- [ ] `pipeline doctor --json` check implementations are the **same functions** used by the existing human doctor command — no duplicated logic.
- [ ] Every JSON envelope in both commands carries `schema_version` (e.g. `"1"`).
- [ ] Status JSON and doctor JSON output are covered by unit tests using the existing `deps`/`Deps` injectable seam — no real network, git, or subprocess calls in tests.
- [ ] `npm run ci` passes (core tests green, mirror in sync, install smoke passes).
