## Context

See proposal.md for the v1.35.0 production failure (Codex-only promote after ship).

Relevant current shapes:

1. **Ship playbook** — `examples/supervisor/shell/pipeline-ship-playbook.sh` sets `HOST="${ENGINE_PROMOTE_HOST:-codex}"` and invokes `pipeline engine-promote --for "$version" --host "$HOST" --skip-frg --json`. Header docs still say default `codex`.
2. **CLI / stage** — `pipeline engine-promote` accepts `--host codex|claude|grok|opencode|all`; when omitted, `runEnginePromote` uses `opts.host ?? "codex"`. The install command line always includes `--host <value>` once resolved.
3. **In-engine ship** — `ship-adapter` promote calls `runEnginePromote({ version, repoDir })` with no `host`, so it inherits the stage default (`codex`).
4. **Installer** — `scripts/install.mjs` already supports `--host all` (and the documented default for a bare install is multi-host). Runbook `docs/runbooks/ship-milestone.md` already shows `engine-promote --for X.Y.Z --host all` for the manual thin ship path — the playbook default contradicts that operator guidance.

No new host registry work is required; this change only selects the host argument the installer already understands.

## Goals / Non-Goals

**Goals:**

- Make every ship promote path (playbook and `pipeline ship`) install with effective host `all` unless the operator scopes the host.
- Align bare `engine-promote` without `--host` with that multi-host default so silent `codex` cannot reappear through the ship adapter.
- Keep single-host override working via env and CLI.
- Make the effective host visible in logs/results (already largely true once `--host` is explicit; ensure defaults are not silent).
- Prove default and override with unit/script tests that fail if ship promote reverts to codex-only.

**Non-Goals:**

- Changing which directories the installer writes per host, Grok symlink policy, or OpenCode layout.
- Changing pin/FRG promote rules, rollback semantics, or publish verification.
- Adding merge authority, auto-merge, or a new stage on advance/loop.
- Requiring live multi-host skill-tree mutation inside unit tests.
- Expanding the outer-host registry.

## Decisions

### D1 — Default install host for promote is `all`, not `codex`

**Decision:** When no host is specified, `runEnginePromote` and the CLI resolve host to `all`. The ship playbook default for `ENGINE_PROMOTE_HOST` becomes `all`. Ship-adapter may omit `host` and inherit that default, or pass `host: "all"` explicitly; either is acceptable if the effective install uses `all`.

**Why not keep CLI default `codex` and only fix the playbook?**  
Ship-adapter does not pass `--host` today. A playbook-only fix leaves `pipeline ship` on the old default. A single shared default in the stage removes the dual-default footgun (playbook says one thing, stage another). The installer already treats `all` as the multi-host install selector.

**Alternatives considered:**

| Approach | Reject reason / defer |
| --- | --- |
| Playbook-only default `all`; keep stage default `codex` | `pipeline ship` and bare CLI still codex-only; dual defaults remain |
| Stage default stays `codex`; ship-adapter always passes `all` | Works for ship, but bare `engine-promote` after a release still surprises multi-host operators; docs already show `--host all` for ship |
| New config key in `.github/pipeline.yml` | Overkill for a default; env/CLI override is enough |

### D2 — Operator override remains env + CLI only

**Decision:** Keep `ENGINE_PROMOTE_HOST` (playbook) and `--host` (CLI) as the scoped-install controls. Valid values remain the installer's host set: `codex`, `claude`, `grok`, `opencode`, `all` (and any host already accepted by the current CLI validation). Invalid host values continue to fail closed at the CLI.

**Why:** Matches existing operator surface; no new config schema or grant document fields.

### D3 — Effective host must appear in install command and promote logging

**Decision:** Continue building the install argv with an explicit `--host <resolved>` (never omit the flag). Promote step logs SHALL include the resolved host (existing `[engine-promote] installing … (host=…)` style is sufficient when host is the resolved value). JSON `install_command` already embeds the flag once the default is correct.

**Why:** Acceptance requires no silent default; the operator log of the v1.35.0 ship showed `--host codex` — visibility already works when the resolved value is wrong; keep that visibility for the correct default.

### D4 — Regression tests target host resolution, not live skill trees

**Decision:** Unit-test pure resolution and command construction:

- Default host when opts omit host → `all` (install command contains `--host all`).
- Explicit host override → that host in the command.
- Playbook: assert default expansion is `all` (static grep/fixture of the script default, or a tiny pure helper if extraction is cleaner) and that `ENGINE_PROMOTE_HOST=codex` still produces `--host codex` in the promote invocation shape.

Do not require unit tests to mutate real `~/.claude` / `~/.codex` trees.

### D5 — Docs and help text follow the code default

**Decision:** Update playbook header comment (`ENGINE_PROMOTE_HOST` default), CLI `--host` help, and any supervisor docs that still claim playbook default `codex`, so they state default `all` and document single-host override. Do not rewrite unrelated hermes deploy examples that intentionally pin `--host codex` for a codex-only host.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Multi-host install is slower or fails on a host the operator does not use | Installer already skips/handles missing host bases; operator can set `ENGINE_PROMOTE_HOST` / `--host` to one host; failures still surface via promote exit status |
| **BREAKING** for operators who relied on bare `engine-promote` installing only Codex | Document in proposal/changelog; override remains one flag; ship intent was always multi-tool |
| Playbook installed under `~/.local/bin` lags the repo example | Same as other playbook fixes: operators refresh from the shipped/repo script; core default still protects `pipeline ship` and bare CLI |
| Dual sources of truth if only one surface is updated | Tasks require playbook + stage default + ship path + tests in one change |

## Migration Plan

1. Land code/doc/test changes via normal PR for #989.
2. Operators running the repo or next-released engine get the new default on the next promote.
3. Operators with a copied `pipeline-ship-playbook` under `~/.local/bin` should reinstall or re-copy the script (or export `ENGINE_PROMOTE_HOST=all` until they do).
4. Rollback: revert defaults to `codex` restores prior behavior (known multi-host drift after ship).

## Open Questions

- None that block specs or tasks. Optional later: whether promote JSON should add a dedicated `host` field in addition to embedding host in `install_command` (nice-to-have; not required if install_command and logs already name the host).
