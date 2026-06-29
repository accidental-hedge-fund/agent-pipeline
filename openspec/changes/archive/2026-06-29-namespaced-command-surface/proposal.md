## Why

Today every distinct pipeline operation is a flag (or positional) on a single
`/pipeline` command: `/pipeline N --status`, `/pipeline doctor`,
`/pipeline intake --description "…"`, `/pipeline N --unblock "…"`. There is no way
to discover the operations from the Claude Code / Codex skill menu, and invoking
one means remembering which flag combines with which sub-command.

The ecosystem has converged on a `namespace:command` shape — `codex-plugin-cc`
exposes `/codex:review`, `/codex:rescue`, `/codex:status` as *distinct named
commands* rather than flags on one `/codex` command, so each action is
self-describing in the menu. This change migrates `/pipeline`'s operation
selectors to that same shape: each operation gets its own `pipeline:<command>`
entry on both hosts (`/pipeline:status`, `$pipeline:status`, …), while the
advance loop (`/pipeline N`) stays the primary, unchanged invocation.

This is co-scoped with the command-registry refactor (#263, already landed): the
registry is the single source of truth for keyword dispatch and flag validation,
so the keyword promotions here are registry edits plus a thin host command
surface — not a parser rewrite.

## What Changes

- **Host command surface (new).** Add a generated `pipeline:<command>` entry for
  each operation in the issue scope — `status`, `unblock`, `override`, `summary`,
  `doctor`, `init`, `cleanup`, `intake`, `sweep`, `triage`, `merge`, `release`,
  `roadmap`, `logs` — on **both** hosts (Claude Code `commands/` →
  `/pipeline:<command>`; Codex overlay → `$pipeline:<command>`). Each entry
  forwards to the equivalent underlying CLI invocation. The surface is emitted by
  `scripts/build.mjs` from a single source so the two hosts stay symmetric and the
  `plugin/` mirror stays in sync.
- **CLI keyword promotion.** Promote the remaining *mode-selecting* flags to
  positional sub-command keywords in `COMMAND_REGISTRY` so the host entries map to
  real keywords: add `status`, `unblock`, `override`, and `cleanup` keywords.
  (`doctor`, `init`, `intake`, `sweep`, `triage`, `merge`, `release`, `roadmap`,
  `logs` are already keyword sub-commands; only their host entry is new.)
- **Deprecation shims (not removal, this release).** The old mode-selecting flag
  forms — `--status`, `--summary`, `--unblock`, `--override`, `--init`,
  `--cleanup` — keep working but print a one-line deprecation notice pointing at
  the `:command` form. They are slated for removal in the next major version. (Per
  @comamitc's stated default for Q1.)
- **`run` collapses into `--detach`.** No `pipeline:run` entry is created. The
  detached-launch surface becomes `pipeline N --detach` (the `--detach` modifier
  is wired onto the base advance command). The legacy `run` keyword is retained as
  an undocumented, deprecated alias so the detached-launcher internals are not
  destabilized. (Per @comamitc's stated default for Q2.)
- **Modifier flags stay flags.** Flags that *tune behavior within* a command
  (`--dry-run`, `--once`, `--domain`, `--base`, `--repo-path`, `--model`,
  `--json`, `--detach`, `--timeout`, `--apply`, `--follow`, `--stage`,
  `--release`, `--description`, `--next`, `--repo`, …) are **not** promoted to `:`
  entries.
- **Docs + tests.** README and all inline help/SKILL.md mode tables (both hosts)
  reflect the new shapes; the golden CLI-parsing tests cover every new keyword and
  every deprecation shim.

## Capabilities

### New Capabilities
- `namespaced-command-surface`: the host-facing `pipeline:<command>` /
  `$pipeline:<command>` command set — one discoverable entry per operation,
  emitted symmetrically to both hosts from a single source, each forwarding to the
  equivalent CLI invocation, with the advance loop preserved as the default
  invocation and modifier flags excluded from promotion.

### Modified Capabilities
- `command-registry`: add `status`, `unblock`, `override`, and `cleanup` as
  recognized keyword sub-commands with registry entries (each with its
  `needsIssueNumber`/`allowedFlags`/… metadata); add the deprecation-shim
  requirement for the legacy mode-selecting flag forms; record that `run` is a
  deprecated, undocumented alias and `pipeline N --detach` is the canonical
  detached-launch form.

## Open Questions / Conflicts to confirm with @comamitc

These two items in the issue scope are genuinely ambiguous; the spec deltas
encode the conservative reading and flag both for confirmation rather than
silently guessing (see `design.md` for full reasoning):

1. **`--doctor` is a modifier, not a mode.** @comamitc's Q1 comment lists
   `--doctor` among the flags to deprecate toward a `:command`. But `--doctor`
   (run preflight, then advance, aborting on failure) is semantically different
   from the standalone `pipeline doctor` (run preflight and exit). By the issue's
   own rule — "modifier flags that tune behavior within a command stay as `--`
   flags" — `--doctor` is a modifier and is **kept**; `pipeline:doctor` maps to
   the standalone `doctor` command. Confirm this distinction.
2. **`summary` keyword collision.** `pipeline summary <run-id>` already exists
   (print a specific run's evidence bundle, run-id arg), while `pipeline N
   --summary` prints issue N's bundle (issue-number arg). `pipeline:summary` must
   disambiguate. The delta keeps `pipeline summary <run-id>` as-is and routes
   `pipeline:summary <N>` to the issue-bundle path, with `--summary` deprecated.
   Confirm the argument contract.

## Acceptance Criteria

- [ ] Each operation in scope is invocable as a distinct `pipeline:<command>`
  entry on the Claude host (`/pipeline:status`, `/pipeline:unblock`,
  `/pipeline:override`, `/pipeline:summary`, `/pipeline:doctor`, `/pipeline:init`,
  `/pipeline:cleanup`, `/pipeline:intake`, `/pipeline:sweep`, `/pipeline:triage`,
  `/pipeline:merge`, `/pipeline:release`, `/pipeline:roadmap`, `/pipeline:logs`)
  and appears in the skill/command menu.
- [ ] The same command set is available on the Codex host as
  `$pipeline:<command>` with symmetric behavior (same operation, same arguments).
- [ ] `/pipeline N` (and `$pipeline N`) — the advance loop with no sub-command —
  continues to work unchanged and remains the primary invocation.
- [ ] `status`, `unblock`, `override`, and `cleanup` are recognized as keyword
  sub-commands by the CLI (`pipeline status N`, `pipeline unblock N "<answer>"`,
  `pipeline override N "<spec>"`, `pipeline cleanup`), each routed to the same
  handler the corresponding legacy flag invoked.
- [ ] Each new keyword has a `COMMAND_REGISTRY` entry whose `needsIssueNumber`,
  `allowedFlags`, `mutatesGitHub`, `needsConfig`, `needsGhAuth`, and `supportsJson`
  fields are correct, and the registry remains the single dispatch/validation
  source (no per-command conflict list added elsewhere).
- [ ] Invoking a deprecated flag form (`pipeline N --status`, `--summary`,
  `--unblock`, `--override`, `pipeline --init`, `pipeline --cleanup`) still
  performs the operation **and** prints exactly one deprecation notice naming the
  replacement `:command` form, on stderr, without changing the operation's exit
  code or output contract.
- [ ] No `pipeline:run` entry exists; `pipeline N --detach` performs the detached
  launch that `pipeline run N --detach` performed; the legacy `run` keyword still
  dispatches (undocumented) so the detached launcher is not broken.
- [ ] Modifier flags (`--dry-run`, `--once`, `--domain`, `--base`, `--repo-path`,
  `--model`, `--json`, `--detach`, `--timeout`, `--apply`, `--follow`, `--stage`,
  `--release`, `--description`, `--next`, `--repo`) are NOT exposed as `:command`
  entries and continue to work as flags within their commands.
- [ ] `--doctor` (preflight-then-advance gate) is retained as a modifier flag and
  is NOT deprecated; `pipeline:doctor` maps to the standalone `pipeline doctor`.
- [ ] README and both hosts' SKILL.md mode tables document the `pipeline:<command>`
  / `$pipeline:<command>` shapes and mark the deprecated flag forms.
- [ ] Golden CLI-parsing tests cover: every new keyword sub-command, the
  registry-entry presence for each, each deprecation-shim notice, and that the
  advance loop is unaffected.
- [ ] The behavior of every migrated operation is otherwise unchanged — this is a
  surface rename, not a behavior change.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror (including the new
  host command surface) and `npm run ci` passes end-to-end.
