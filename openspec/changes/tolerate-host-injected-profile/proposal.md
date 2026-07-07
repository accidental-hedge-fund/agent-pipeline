## Why

The generated host wrapper (`hosts/_shared/entry.template.mjs`, installed as
`~/.claude/skills/pipeline/scripts/pipeline.mjs`) unconditionally appends
`--profile <profile>` to every core invocation unless the caller already passed
one:

```js
const args = ["--experimental-strip-types", entry, ...passthrough];
if (!passthrough.includes("--profile")) args.push("--profile", PROFILE);
```

But the core CLI enforces an allowlist-based per-command flag check
(`command-registry`): a command whose `allowedFlags` set does not contain
`profile` exits 2 with `pipeline: '<cmd>' cannot be combined with --profile.
These are separate commands.` Several profile-free commands — confirmed
`refine-spec`, `scoreboard`, and `release` — do not declare `profile`, so they
fail through the **only documented entry point**. The wrapper is where the
profile is baked in for the whole host, so injecting it is correct; the defect
is that the CLI treats a host-level flag as a command-level one.

Today the operator's only workaround is to bypass the wrapper and invoke
`core/scripts/pipeline.ts` directly — exactly the internal path the wrapper
exists to hide.

## What Changes

- Make `--profile` a **universally tolerated** flag: the CLI's per-command
  flag validation SHALL never report `profile` as an offending flag, for any
  registered command, regardless of whether that command consumes the profile
  value. Commands that do not use the profile SHALL ignore it and behave
  identically to an invocation without it.
- This fixes the **class**, not the three known instances: any current or
  future profile-free command automatically tolerates the wrapper-injected
  flag, with no per-command allowlist edits and no wrapper-side denylist that
  could drift from the registry.
- The host wrapper's unconditional injection is unchanged — it is correct.
- Regenerate the `plugin/` mirror and the installed wrapper artifacts in the
  same change.

## Capabilities

### Modified Capabilities

- `command-registry`: the allowlist-based flag validation SHALL treat the
  host-injected `profile` option as universally allowed on every registered
  command, so a profile-free command invoked through the host wrapper is not
  rejected. The allowlist SHALL remain strict for every other undeclared flag.

## Impact

- `core/scripts/command-registry.ts` (or the single call site in
  `core/scripts/pipeline.ts` that consumes `validateFlags`) — `profile` becomes
  universally allowed; no per-command `allowedFlags` set needs a `profile`
  entry added.
- `core/scripts/pipeline.ts` — no behavioral change beyond the tolerance; the
  profile value is still parsed and, where irrelevant, simply unused.
- `hosts/_shared/entry.template.mjs` — unchanged (injection remains
  unconditional).
- `plugin/` and the installed wrapper template — regenerated via
  `node scripts/build.mjs`.
- No change to what `--profile` *means* for the advance loop / stage commands,
  no new profile values.

## Acceptance Criteria

- [ ] `pipeline refine-spec --title "<t>" --body "<b>"` invoked through the
      generated host wrapper exits 0 and emits the JSON contract.
- [ ] `pipeline scoreboard` invoked through the host wrapper exits 0 and prints
      the report.
- [ ] `pipeline release <version>` invoked through the host wrapper does not
      exit 2 on the `--profile` flag (it proceeds to its normal version
      handling).
- [ ] The fix is applied as a single behavior — `--profile` universally
      tolerated by the CLI — not a per-command wrapper exemption or a
      per-command `allowedFlags` edit for each of the three known commands.
- [ ] A genuinely unsupported flag on a profile-free command (e.g.
      `pipeline scoreboard --bogus`) is still rejected with exit code 2 — the
      profile tolerance does not weaken the allowlist for any other flag.
- [ ] A regression test drives the wrapper-arg composition (unconditional
      `--profile` injection) against the profile-free commands `refine-spec`,
      `scoreboard`, and `release`, and would fail under the current
      unconditional-injection-plus-strict-allowlist behavior.
- [ ] Regenerated host artifacts (`plugin/`, installed wrapper template) ship in
      the same change; `node scripts/build.mjs --check` passes.
- [ ] `npm run ci` passes with no regressions.
