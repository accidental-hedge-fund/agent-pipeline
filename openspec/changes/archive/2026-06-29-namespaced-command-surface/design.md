## Context

`/pipeline` ships as a single skill on each host (`plugin/pipeline/skills/pipeline/SKILL.md`
for Claude, `hosts/codex/SKILL.md` for Codex). There is **no** `commands/`
directory today — every operation is a flag or positional sub-command parsed by
`core/scripts/pipeline.ts` and routed through `COMMAND_REGISTRY`
(`core/scripts/command-registry.ts`, landed with #263). The README documents the
install surface as `/pipeline` shown as `pipeline:pipeline` — i.e. the plugin
namespace is already `pipeline`, so `pipeline:<command>` entries are the natural
shape for additional commands in that namespace.

Two distinct layers are in play and must not be conflated:

1. **Host command surface** — what the user types in Claude Code / Codex
   (`/pipeline:status 42`). This is generated packaging (command files), mirrored
   into `plugin/` by `scripts/build.mjs`.
2. **CLI surface** — what actually executes (`pipeline.mjs status 42`), parsed by
   `pipeline.ts` against `COMMAND_REGISTRY`.

This change adds layer 1 and extends layer 2's keyword set so the two line up.

## Goals / Non-Goals

**Goals**
- One discoverable `pipeline:<command>` entry per in-scope operation, symmetric
  across both hosts, emitted from a single source.
- Keep the registry the single source of dispatch + flag validation; add keywords
  by adding registry entries, not by sprinkling new conditionals.
- Preserve every operation's behavior exactly — surface rename only.
- Keep the freeform (non-OpenSpec) and advance-loop paths untouched.

**Non-Goals**
- Changing any operation's behavior, arguments, or output (beyond adding a
  deprecation line to legacy flag forms).
- Adding operations not already present.
- Promoting behavior-tuning modifier flags to `:` entries.
- Removing the legacy flag forms in this release (removal is deferred to the next
  major).

## Decisions

### Decision: two capabilities — host surface (new) + registry keywords (modified)

`namespaced-command-surface` owns the host-facing contract (the entries exist,
are symmetric, forward correctly, exclude modifiers, preserve the default loop).
`command-registry` is modified to add the four new keywords and the deprecation
shims. This keeps the registry the authoritative keyword list (its "every
recognized keyword has an entry" scenario is the drift guard) and keeps the
host-surface requirements host-agnostic.

### Decision: the host entry forwards to a CLI keyword, not to the legacy flag

`/pipeline:status 42` forwards to `pipeline status 42` (the new keyword), not to
`pipeline 42 --status` (the deprecated flag). This makes the keyword the
canonical surface and lets the flag form carry the deprecation notice. The four
promotions needed are `status`, `unblock`, `override`, `cleanup`; the other ten
in-scope operations are already keyword sub-commands, so only their host entry is
new.

### Decision: keyword promotions reuse the existing handlers verbatim

`status`/`unblock`/`override` operate on an issue number; their keyword form is
`pipeline <kw> <N> [arg]` (`needsIssueNumber: true`). `cleanup` takes no issue
number (`needsIssueNumber: false`). Each keyword's handler is the *same* function
the legacy flag dispatched — the promotion is parse-and-route only, so behavior
is provably identical. `allowedFlags` for each keyword is the set of modifier
flags that operation actually consumes (e.g. `status` accepts `--json`,
`--repo-path`, `--domain`, `--base`, `--profile`; `cleanup` mirrors the existing
`cleanup` registry entry minus the now-deprecated `cleanup` flag attribute).

### Decision: deprecation shim is a one-line stderr notice, behavior unchanged

When a legacy mode flag is provided (`--status`, `--summary`, `--unblock`,
`--override`, `--init`, `--cleanup`), the CLI performs the operation exactly as
before and additionally prints one line to **stderr** naming the replacement
(`note: '--status' is deprecated; use 'pipeline:status <N>' (or 'pipeline status
<N>'). This flag will be removed in the next major version.`). stderr (not
stdout) keeps machine-readable stdout contracts (`--status --json`, `--summary`)
intact. Exit codes are unchanged. This is the conservative reading of
@comamitc's Q1 default ("print a deprecation warning and still work").

### Decision: `run` is collapsed at the surface, retained internally

No `pipeline:run` host entry. `--detach` is wired onto the base advance command so
`pipeline N --detach` performs the detached launch (today `--detach` is only
honored inside the `run` branch via `handleRunSubcommand`). The `run` keyword is
kept as an **undocumented, deprecated** alias because `detach.ts`'s wrapper and
`spawnDetached` plumbing reference the existing detached-launch path; removing the
keyword outright is out of scope for a surface rename and risks the detached
launcher. This satisfies @comamitc's Q2 default ("collapse into `pipeline N
--detach`") at the user-facing surface without destabilizing internals.

### Decision (flagged): `--doctor` stays a modifier; `pipeline:doctor` = standalone `doctor`

@comamitc's Q1 comment lists `--doctor` among flags to deprecate. But `--doctor`
gates an advance run (run preflight, then advance, abort on failure) whereas the
standalone `pipeline doctor` runs preflight and exits — different operations. The
issue's own scope rule keeps behavior-tuning modifiers as `--` flags. So this
change treats `--doctor` as a modifier (kept, not deprecated) and maps
`pipeline:doctor` to the standalone `doctor` command. **Flagged for @comamitc
confirmation** in the proposal's open-questions; if the intent really is to
deprecate `--doctor`, the modifier→command merge is a separate, larger decision
(it would drop the gate-then-advance capability) and should be its own issue.

### Decision (flagged): `pipeline:summary <N>` is the issue-bundle path

`pipeline summary <run-id>` already prints a specific run's bundle (run-id
argument, domain-independent, offline). `pipeline N --summary` prints issue N's
bundle (issue-number argument). To avoid a collision, `--summary` is the form
that gets deprecated, and `pipeline:summary <N>` routes to the issue-bundle path
(matching the acceptance list's per-issue intent), while `pipeline summary
<run-id>` is unchanged. **Flagged for @comamitc** to confirm the argument
contract (issue-number vs run-id) for the `pipeline:summary` entry.

### Decision: emit the host surface from a single source via build.mjs

The Claude `commands/` files and the Codex overlay entries are generated from one
declarative list (the same operation set the registry enumerates) so the two
hosts cannot drift and the `plugin/` mirror regenerates deterministically. A
drift-guard test asserts the host command set equals the in-scope operation set
(mirroring the existing registry/`buildCmd()` cross-check test pattern).

## Risks / Mitigations

- **Risk: host menu now lists ~15 entries — clutter.** Mitigation: only the
  in-scope operations are promoted; advanced/internal CLI sub-commands
  (`config`, `path`, `refine-spec`, `improve`, `scoreboard`, `queue`,
  `remove-worktree`) are intentionally *not* given host entries this round — they
  remain CLI-reachable. Noted explicitly so the omission reads as deliberate, not
  forgotten.
- **Risk: deprecation notice breaks a script parsing stdout.** Mitigation: notice
  goes to stderr; stdout and exit codes are byte-for-byte unchanged. Covered by a
  test that asserts `--status --json` stdout is unchanged and the notice is on
  stderr.
- **Risk: host/registry drift.** Mitigation: single-source generation + a
  cross-check test asserting host entries ≡ in-scope operations, and the existing
  registry/`buildCmd()` cross-check still guards flag-rename drift.
- **Risk: collapsing `run` breaks detach.** Mitigation: keep `run` as a working
  alias; only stop advertising it and add the `--detach` base-advance path; a
  test asserts `pipeline N --detach` and `pipeline run N --detach` reach the same
  detached-launch entry point.

## Migration

No data migration. Existing muscle-memory invocations keep working for one major
version with a deprecation nudge. The next-major removal of the legacy flag forms
is a separate, tracked follow-up — not part of this change.
