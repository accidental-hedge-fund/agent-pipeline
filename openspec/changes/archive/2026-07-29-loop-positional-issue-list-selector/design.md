## Context

`pipeline:loop` advertises five selector forms (milestone, label, range, roadmap-slice,
explicit issue list) plus `--resume` / `--audit` / `--new-run`. Four of the five selectors
are flags; the issue list is positional. Downstream is already correct:

- `runLoopCommand(opts, cmd.args.slice(1))` passes remaining positionals as
  `RawLoopArgs.issues`.
- `normalizeLoopArgs` validates each token as `/^\d+$/`, builds
  `{ type: "work-list", value: issues }`, and enforces mutual exclusion with other
  selectors and with `--resume`.

The dead path is the top-level extra-positionals guard in `pipeline.ts` (the
`maxPositionals` ternary). It special-cases several commands (2 or 3 positionals) and
defaults to **1**. For `loop` that means only the keyword itself is allowed — any
issue number after `loop` is "extra" and exits 2 before the loop branch runs.

This is the same defect class as #610 (`--new-run` missing from the loop flag
allowlist): documented surface exists behind a first-line CLI guard that never lets it
through. Nested `pipeline loop logs …` is unaffected (early return before the guard).

## Goals / Non-Goals

**Goals:**

- Make `pipeline loop <N> [<N>…]` reachable end-to-end so argument normalization
  produces a `work-list` selector.
- Keep invalid tokens and multi-selector conflicts as preflight errors (existing
  messages), not top-level "unexpected argument(s)" for a valid issue list.
- Add a regression test that would have failed on the pre-fix guard.
- Preserve every other command's positional cap.

**Non-Goals:**

- New selector syntax (comma-separated tokens, `@file`, etc.). Space-separated issue
  numbers remain the only documented list form; a single `649,551` token continues to
  fail issue-number validation.
- Changing `MAX_RANGE_SPAN`, `--range` expansion, milestone/label/roadmap resolution,
  supersession, audit, durable store, or per-item execution.
- Generalizing the positional guard into a full declarative registry of arity (follow-up
  if more multi-positional commands appear).
- Addressing the unrelated pre-merge CI non-gating-check note on #554 (separate issue if
  pursued).

## Decisions

### 1. Fix the top-level guard; do not re-thread issues

**Choice:** Extend the `maxPositionals` computation so `cmd.args[0] === "loop"` allows
`1 + MAX_RANGE_SPAN` positionals (`loop` + up to `MAX_RANGE_SPAN` issue numbers). Leave
`runLoopCommand(opts, cmd.args.slice(1))` unchanged.

**Why:** The handoff to preflight already exists; the only bug is the guard firing first.
Reusing `MAX_RANGE_SPAN` (already exported from `loop-preflight.ts` for range expansion)
gives one consistent ceiling for materialized work-lists without inventing a second
constant.

**Rejected:** Skip the guard entirely for `loop` (unbounded argv). Acceptable per the
issue, but a hard ceiling matching range keeps accidental mega-argv from allocating a
huge `issues` array before any check.

**Rejected:** Parse and validate issue numbers inside the top-level guard. Would
duplicate `normalizeLoopArgs` and split error paths; preflight already owns that
contract.

**Rejected:** Only allow a second positional (one issue). The documented and previously
used form is a multi-issue list; a single-issue list is insufficient for the filed
repro (`649 551 541 334`).

### 2. Keep validation and mutual exclusion in preflight

Non-numeric tokens, empty lists combined with other modes, and multi-selector conflicts
remain `LoopArgError` / preflight failures. The dispatcher only stops treating a valid
multi-issue list as "unexpected arguments."

### 3. Regression test placement

**Choice:** Unit-level coverage that proves multi-issue positionals reach
`runLoopCommand` / normalization as a `work-list`, without requiring a live durable
loop engine (inject `LoopCliDeps` as existing `loop-command.test.ts` does), **and/or**
a pure helper test if the max-positionals policy is extracted. Prefer the smallest
test that fails on the pre-fix `maxPositionals` default and passes after the fix.

If extracting a pure `maxPositionalsFor(cmd)` helper makes the guard testable without
spawning the full CLI process, that is preferred; otherwise follow existing
`detach.test.ts` / `pipeline-cli.test.ts` CLI-spawn patterns for exit-code 2
assertions — but keep the harness free of network/git when possible.

### 4. Plugin mirror

Any `core/` edit regenerates `plugin/` via `node scripts/build.mjs` in the same change
(golden rule).

## Risks / Trade-offs

- **[Risk] Operators paste comma-separated lists** → still rejected as non-numeric
  tokens. **Mitigation:** out of scope; usage/error text already names "issue list" as
  space-separated in living facade scenarios (`418 419 420`). Optional follow-up docs
  only if operators keep tripping on commas.
- **[Risk] Guard uses a magic number instead of `MAX_RANGE_SPAN`** → drift between range
  and list ceilings. **Mitigation:** import/reuse `MAX_RANGE_SPAN` from
  `loop-preflight.ts` (or a tiny shared constant already owned by that module).
- **[Risk] Very large work-lists that pass the ceiling still thrash the supervisor** →
  pre-existing; range already allows up to `MAX_RANGE_SPAN` issues. No new product
  commitment.
- **[Trade-off] Surgical guard tweak vs declarative arity registry** → one-command fix
  matches #610's surgical style and the issue scope; a registry of positionals is a
  larger refactor deferred unless a third multi-positional command hits the same wall.

## Migration Plan

- No data migration; pure CLI reachability fix.
- Operators who work around via `--label` / `--range` can keep doing so; issue-list
  form becomes available without config changes.
- Rollback: revert the guard change; no durable state depends on it.

## Open Questions

(none blocking — issue root cause and fix shape are explicit; maintainer recommends
v1.29.0 after v1.28.x loop hotfixes.)
