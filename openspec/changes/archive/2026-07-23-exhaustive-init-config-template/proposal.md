## Why

The `.github/pipeline.yml` scaffold written by `pipeline init` opens with the claim
"Every key is shown at its current default value", but that claim is **false**. The strict
config schema (`PartialConfigSchema` in `core/scripts/config.ts`) currently accepts 47
top-level keys; a fresh `pipeline init` template renders only a subset. On an empty config,
these accepted keys emit nothing at all:

- `repo`, `domain_name`, `domain_description`, `conventions_md_path` (rendered only when the
  operator already set them, via `optionalTop`).
- `roadmap`, `sweep`, `queue`, `trusted_override_actors`, `auto_merge_eligibility`,
  `context_snapshot` (each guarded by `config.X !== undefined ? … : undefined`, so absent on
  a fresh init).
- `design_gate` — accepted by the schema (`design_gate: z…`) and resolved in
  `resolveConfig`, but referenced **zero** times in the template render region.

This is both an **onboarding defect** (an operator cannot discover a supported capability
without reading TypeScript or release notes) and a **schema/template drift problem** (the two
representations of "what is configurable" have silently diverged, and nothing fails when they
do). The template is a hand-maintained second inventory of options that must be kept in lockstep
with the schema by discipline alone — exactly the kind of drift the pipeline is supposed to
guard mechanically.

## What Changes

- Make the `pipeline init` scaffold an **exhaustive, accurate, self-documenting** representation
  of the config schema: every top-level and nested accepted property appears, either active at
  its resolved default or as a commented opt-in example.
- Represent absence/auto-detection semantics honestly — an option whose "default" is absence says
  `absent` / `disabled` / `auto-detected` / `unlimited` (or the applicable semantic), not an
  invented placeholder value.
- Document enums (every accepted value), numerics (units, bounds, special values), and
  arrays/maps (valid shape + at least one representative example) for each option, plus a concise
  security / blast-radius note for opt-in mutation/authority, external execution, secret/auth,
  telemetry, sandbox, auto-loop, and auto-merge-eligibility settings.
- Correct the opening claim so the file's own top-of-file statement is mechanically true (or is
  narrowed to wording that accurately describes coverage).
- Derive both the JSON-Schema descriptions (`pipeline config schema`) and the template
  documentation from a **single shared field-metadata source of truth**, so adding a new config
  field requires its description, default/absence semantics, example, and security note in one
  place — no second hand-maintained option inventory.
- Add a **recursive schema-to-template drift test** that fails when any accepted top-level or
  nested schema property is missing from the template documentation, and a **defaults-parity
  test** that fails when a documented default diverges from `DEFAULT_CONFIG` or from the declared
  absence/auto-detection semantics.
- Extend `pipeline config sync` so it introduces newly-added commented options and updated
  guidance into an existing config while preserving the operator's set values and unrelated
  comments/formatting, under its existing effective-config-preserving contract.

Out of scope: changing runtime defaults or enabling any opt-in feature; embedding credentials or
environment-specific values; turning `init` into an interactive wizard; removing
`pipeline config schema` (the JSON Schema remains the machine-readable contract).

## Acceptance Criteria

- [ ] Every top-level and nested property accepted by `PartialConfigSchema` appears in a fresh
      `pipeline init` template, either active or as a commented opt-in example — including the
      currently-omitted `repo`, `domain_name`, `domain_description`, `conventions_md_path`,
      `roadmap`, `sweep`, `queue`, `trusted_override_actors`, `auto_merge_eligibility`,
      `context_snapshot`, and `design_gate`.
- [ ] Options with a built-in default show the exact resolved `DEFAULT_CONFIG` value; options
      whose default is absence say `absent` / `disabled` / `auto-detected` / `unlimited` (or the
      applicable semantic) rather than an invented placeholder.
- [ ] Each enum option lists every accepted value; each numeric documents its unit, bounds, and
      any special value; each array/map documents its valid shape and at least one representative
      example.
- [ ] Each option states what it controls and when it takes effect; opt-in mutation/authority,
      external execution, secret/auth, telemetry, sandbox, auto-loop, and auto-merge-eligibility
      options carry a concise security / blast-radius note.
- [ ] `models`, `effort`, `review_harness`, `executors`, and `stage_executors` accurately explain
      harness applicability and which combinations are inert (e.g. implementer-role keys on a
      codex implementer; the reviewer-alias passthrough contract).
- [ ] A fresh scaffold parses and validates via `resolveConfig` without modification and equals
      `DEFAULT_CONFIG` for every active key; uncommenting any single documented example yields a
      schema-valid value.
- [ ] A recursive schema-to-template drift test fails when any accepted top-level or nested schema
      property is absent from the template documentation.
- [ ] A defaults-parity test fails when a documented default diverges from `DEFAULT_CONFIG` or
      from the documented absence/auto-detection semantics.
- [ ] Adding a new config field to the shared field-metadata source is sufficient to make it
      appear (documented, with default semantics + example + security note where applicable) in
      both `pipeline config schema` and the `init` template — no second hand-maintained inventory.
- [ ] `pipeline config sync` adds newly-introduced commented options and refreshed guidance to an
      existing config while preserving the operator's set values and unrelated comments/formatting,
      and still refuses to write when the candidate would change effective configuration.
- [ ] The generated file's opening claim is mechanically true, or is replaced with narrower wording
      that accurately describes coverage.
