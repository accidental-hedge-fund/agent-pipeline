## Context

See `proposal.md` for why.

Today `pipeline release` and `pipeline engine-promote` skip Factory
Reliability Gate (FRG) only when the CLI flag `--skip-frg` is set
(`ReleaseOpts.skipFrg` / `allowWithoutFrg`). After #1039 the factory
Tugboat default omits that flag. `.github/pipeline.yml` has no skip
key. `engine_track` is pin vs candidate, not a gate switch.

Release already reads `.github/pipeline.yml` through the gh-free
`resolveReleaseConfig` parse of `PartialConfigSchema`. Engine-promote
does not read pipeline.yml today.

**Class vs site (engine-dogfood bar):** the site is "this factory has
no repo-local FRG skip after #1039." The class is: any repo can declare
an optional `skip_frg` escape on `.github/pipeline.yml`. Both ship
commands share one resolution of CLI vs config. Unset/false stays
FRG-required. The next repo that needs the same escape sets the key.
It does not need a new mole or a path-local flag fork.

## Goals / Non-Goals

**Goals:**

- Add one optional boolean to the existing config schema.
- Resolve skip once and feed the existing skip path on both commands.
- Keep default FRG-on. Log when config, not the CLI flag, caused skip.
- Comment the key off in scaffold / `config sync`. Do not enable it on
  this factory repo.

**Non-Goals:**

- Teaching Tugboat to read `skip_frg` (Tugboat keeps its own
  `--skip-frg` + reason escape).
- Disabling `factory-gate`, auto-tag FRG (#1040), or `no-frg-*` pin
  honesty (#1041).
- A grant factory, `pipeline ship` product path, or merge-in-advance.
- Changing the `--skip-frg` CLI flag schema.

## Decisions

### 1. Key name is `skip_frg`; default is absence / false

**Choice:** Top-level optional boolean `skip_frg` on
`PartialConfigSchema`. Unset and `false` mean FRG is required.
`DEFAULT_CONFIG` SHALL omit the key (absence-default), same pattern as
`engine_track`. Scaffold and `config sync` render a commented
`# skip_frg: false` line whose comment uses the schema `.describe()`
text.

**Why not `engine_track`:** that key selects pin vs candidate. It is
not a gate switch.

**Why not a nested `release.skip_frg`:** the same escape applies to
engine-promote. A top-level key matches the issue and one resolver.

### 2. One shared skip resolution; CLI wins

**Choice:** Resolve skip as:

| CLI `--skip-frg` | `skip_frg` in yml | Effective skip | Logged source |
| --- | --- | --- | --- |
| present | any | skip | cli (`--skip-frg`) |
| absent | `true` | skip | config |
| absent | unset / `false` | no skip | none |

Config cannot force FRG on when the operator passed `--skip-frg`.

Both `pipeline release` and `pipeline engine-promote` MUST use this
same resolution, then pass the existing boolean into the existing skip
path (`skipFrg` / `allowWithoutFrg`). Config skip therefore also skips
the FRG-linked open soak-defect preflight on release, same as the CLI
flag.

**Why not two inline `cli \|\| config` sites:** the class is one
resolver. Two sites can drift on source logging or on "false means
required."

**Why not make config override CLI:** the issue forbids that. An
operator flag is the stronger escape.

### 3. Engine-promote reads the yml through the same gh-free parse

**Choice:** Read `skip_frg` from `.github/pipeline.yml` with the same
gh-free `PartialConfigSchema` parse release already uses. Do not call
full `resolveConfig()` (that shells out to `gh repo view`). Missing or
absent file is treated as unset.

**Why:** engine-promote is a local ship command. A GitHub identity
lookup is not required to honor a repo-local boolean.

### 4. Log source only when skip is active

**Choice:** Keep the current `--skip-frg` wording when the CLI flag
caused the skip. When only config caused the skip, the skip log MUST
name config (for example `skip_frg: true` in `.github/pipeline.yml`).
When both are set, log CLI. Do not add a new public JSON field for
this.

### 5. This factory repo stays FRG-on

**Choice:** Do not write `skip_frg: true` into this repository's
committed `.github/pipeline.yml`. After #1039 the factory default
remains FRG-on. A product or rescue checkout that needs the escape
sets the key locally.

**Why not set it here as a dogfood of the escape:** that would undo
#1039 on this factory.

### 6. Tugboat does not honor `skip_frg`

**Choice:** Out of scope. Tugboat still packs on the default path and
still requires `--skip-frg` + a logged reason to omit the pack. A repo
with `skip_frg: true` can skip FRG when an operator runs
`pipeline release` / `engine-promote` without the flag. Tugboat itself
is unchanged.

## Risks / Trade-offs

- **[Risk] A product repo sets `skip_frg: true` and ships without FRG.**
  → Mitigation: default remains required; skip log names config; this
  factory does not enable the key; `factory-gate` still exists.
- **[Risk] Engine-promote never reads yml, so config is a silent no-op.**
  → Mitigation: shared reader + unit tests on both commands that fail
  if config `true` still requires FRG.
- **[Risk] Skip-source wording drifts between release and promote.**
  → Mitigation: one resolver returns the source; both logs use it.
- **[Risk] Operators expect Tugboat to skip pack from the yml key.**
  → Mitigation: documented non-goal. Tugboat keeps its own escape.

## Migration Plan

- Additive schema key. Existing yml files stay valid.
- After `core/` edits, regenerate `plugin/` in the same change.
- Rollback: revert the change. Unset/false already means FRG required.

## Open Questions

None. The key name, default, precedence, and command scope are fixed
by the issue.
