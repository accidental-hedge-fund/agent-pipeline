## Context

The host wrapper's job is to bake a per-host profile into every core
invocation. It does this by appending `--profile <profile>` to the passthrough
args unless the caller already supplied one. This is a **host-level** decision:
the profile is a property of *which packaged skill is installed* (`/pipeline`
for Claude, `$pipeline` for Codex), not of *which sub-command the operator
typed*.

The core CLI, however, validates flags **per command** against an allowlist
(`command-registry`, `validateFlags`). Only commands that declare `profile` in
their `allowedFlags` accept it; the rest exit 2 with
`'<cmd>' cannot be combined with --profile`. Because the wrapper injects the
flag into *all* commands but only *some* commands declare it, every profile-free
command is unreachable through the wrapper.

## Goals / Non-Goals

**Goals**
- Every documented `pipeline <command>` works through the installed wrapper.
- Fix the class (all profile-free commands, present and future), with one
  behavior applied consistently.
- Preserve strict allowlist rejection for every other undeclared flag.

**Non-Goals**
- Changing what `--profile` means for advance / stage commands.
- Adding new profile values.
- Changing the wrapper's unconditional injection.

## Decision: tolerate `--profile` in the core CLI (not a wrapper exemption)

The issue's acceptance criteria offer two shapes: (A) the wrapper skips profile
injection for profile-free commands, or (B) the core CLI tolerates `--profile`
on commands that don't use it. **We choose (B).**

Rationale:

1. **Single source of truth.** The `command-registry` capability explicitly
   requires that "adding a new sub-command … SHALL be sufficient … without
   editing any per-command conflict list elsewhere." A wrapper-side denylist of
   profile-free commands is exactly such a parallel list — it would live in
   plain JS (`entry.template.mjs`), have no access to the TypeScript registry,
   and silently drift every time a command is added or its flag support changes.
   Approach (B) keeps command knowledge in the registry.

2. **`--profile` is genuinely host-level.** The wrapper injects it for *every*
   command by design. Semantically it behaves like a universal/global option
   (akin to `--repo-path`), so the CLI treating it as always-allowed matches its
   real nature. The `merge` command already documents `--profile` as an
   always-applicable flag ("only --repo-path, --base, and --profile apply").

3. **Minimal, class-covering diff.** One carve-out in flag validation covers all
   three known commands and any future profile-free command, versus editing
   three (and counting) `allowedFlags` sets — which would still be per-instance,
   not per-class.

### Mechanism

`validateFlags(entry, cmd)` filters the explicitly-provided CLI options down to
those not in `entry.allowedFlags`. The change: `profile` is treated as
universally allowed — either by exempting the `profile` attribute name inside
`validateFlags`, or by an equivalent single carve-out at the one call site in
`pipeline.ts`. The profile value continues to be parsed by Commander; commands
that don't consume it simply ignore it (no behavior change).

A `UNIVERSAL_FLAGS` set (containing at least `profile`) is the natural home for
this, so the intent — "these flags are injected by the host layer and tolerated
everywhere" — is explicit and testable rather than a magic string.

### Why not add `profile` to every `allowedFlags` set?

That would fix the three known commands but re-open the class the moment a new
profile-free command is added without remembering to include `profile` — the
same footgun the registry's single-source requirement exists to prevent. A
universal carve-out is invariant under new commands.

## Risks / Trade-offs

- **Risk:** A future command that *should* reject `--profile` for a real reason
  can no longer do so via the allowlist. *Mitigation:* none is needed today —
  the wrapper injects `--profile` into everything, so any command that rejected
  it would be unreachable through the documented entry point, which is precisely
  the bug being fixed. `--profile` is host-level by construction.
- **Trade-off:** The allowlist is no longer the *complete* description of
  accepted flags (there is now a universal set). This is acceptable and made
  explicit via the named `UNIVERSAL_FLAGS` set plus a test asserting `profile`
  is a member.

## Testing

- A unit/integration test composes the wrapper's arg list (mirroring
  `entry.template.mjs`: `[...passthrough, "--profile", PROFILE]`) for each of
  `refine-spec`, `scoreboard`, and `release`, drives the CLI's flag-validation
  path, and asserts none is rejected on `profile`. The test must **bite**: under
  the current strict allowlist it fails for all three.
- A negative test asserts a non-universal undeclared flag (e.g. `--bogus` /
  `--dry-run` on `scoreboard`) is still rejected with exit code 2, proving the
  tolerance is scoped to `profile` and does not loosen the allowlist generally.
- Existing `merge` allowlist tests (which already assert `--profile` is
  accepted) continue to pass.
