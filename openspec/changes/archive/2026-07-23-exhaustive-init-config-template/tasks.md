## 1. Establish shared field metadata

- [x] 1.1 Inventory every top-level and nested property accepted by `PartialConfigSchema`, and for
      each record: description, default vs. absence/auto-detection semantics, enum values, numeric
      unit/bounds/special values, array/map shape + one example, and whether it is a security-
      sensitive opt-in (mutation/authority, external execution, secret/auth, telemetry, sandbox,
      auto-loop, auto-merge-eligibility).
- [x] 1.2 Introduce a single shared field-metadata source co-located with the Zod field
      definitions, from which `pipeline config schema` descriptions are already (or become) derived.
      (Every schema field already carries a `.describe(...)` string, verified single-sourced into
      `pipeline config schema` via `z.toJSONSchema`; the template renderer's new blocks reuse those
      same semantics rather than authoring a second inventory.)
- [x] 1.3 Point `pipeline config schema` description generation at the shared metadata so it stays
      the single source with the template. (Already true via `generateConfigSchema()` →
      `z.toJSONSchema(PartialConfigSchema)`, which the new drift test now exercises directly.)

## 2. Make the init template exhaustive and honest

- [x] 2.1 Render every accepted key from the shared metadata — active at its `DEFAULT_CONFIG` value,
      or as a commented opt-in example with the correct absence/auto-detection semantic.
- [x] 2.2 Add the currently-omitted keys: `repo`, `domain_name`, `domain_description`,
      `conventions_md_path`, `roadmap`, `sweep`, `queue`, `trusted_override_actors`,
      `auto_merge_eligibility`, `context_snapshot`, and `design_gate`.
- [x] 2.3 Document enums (all values), numerics (unit/bounds/special values), and arrays/maps
      (shape + example) for every option.
- [x] 2.4 Attach concise security / blast-radius notes to the enumerated opt-in classes.
- [x] 2.5 Document `models`/`effort`/`review_harness`/`executors`/`stage_executors` harness
      applicability and inert combinations accurately (reviewer-alias passthrough contract;
      implementer-role keys inert on a codex implementer).
- [x] 2.6 Correct the opening claim so it is mechanically true, or narrow it to accurate coverage
      wording.

## 3. config sync

- [x] 3.1 Ensure `config sync` introduces newly-added commented options and refreshed guidance into
      an existing config while preserving operator-set values and unrelated comments/formatting.
- [x] 3.2 Confirm the effective-config equality gate still refuses writes that would change
      effective configuration, and init no-clobber behavior is unchanged. (Fixed `normalizeForSync`
      to merge `design_gate`/`auto_merge_eligibility` with `DEFAULT_CONFIG` instead of a bare
      passthrough, so the equality gate compares effective values correctly now that the template
      fully materializes those blocks.)

## 4. Guarding tests (prove they bite)

- [x] 4.1 Recursive schema-to-template drift test: walk `PartialConfigSchema` (top-level + nested)
      and fail when any accepted property is undocumented in the rendered template. Prove it fails
      when a key is removed from the template.
- [x] 4.2 Defaults-parity test: each active documented default matches `DEFAULT_CONFIG`, or the
      field is declared absence/auto-detected in metadata. Prove it fails on a divergent default.
- [x] 4.3 Round-trip test: fresh scaffold parses via `resolveConfig` and equals `DEFAULT_CONFIG`
      for every active key; uncommenting each documented example yields a schema-valid value.
- [x] 4.4 Security-note presence test: each enumerated opt-in class carries a security note.
- [x] 4.5 Opening-claim accuracy test: the top-of-file statement is mechanically true against the
      rendered coverage.

## 5. Mirror & gate

- [x] 5.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 5.2 `npm run ci` green (core tests, mirror check, install smoke, `openspec validate --all`).
