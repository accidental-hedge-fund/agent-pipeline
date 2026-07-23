## 1. Establish shared field metadata

- [ ] 1.1 Inventory every top-level and nested property accepted by `PartialConfigSchema`, and for
      each record: description, default vs. absence/auto-detection semantics, enum values, numeric
      unit/bounds/special values, array/map shape + one example, and whether it is a security-
      sensitive opt-in (mutation/authority, external execution, secret/auth, telemetry, sandbox,
      auto-loop, auto-merge-eligibility).
- [ ] 1.2 Introduce a single shared field-metadata source co-located with the Zod field
      definitions, from which `pipeline config schema` descriptions are already (or become) derived.
- [ ] 1.3 Point `pipeline config schema` description generation at the shared metadata so it stays
      the single source with the template.

## 2. Make the init template exhaustive and honest

- [ ] 2.1 Render every accepted key from the shared metadata — active at its `DEFAULT_CONFIG` value,
      or as a commented opt-in example with the correct absence/auto-detection semantic.
- [ ] 2.2 Add the currently-omitted keys: `repo`, `domain_name`, `domain_description`,
      `conventions_md_path`, `roadmap`, `sweep`, `queue`, `trusted_override_actors`,
      `auto_merge_eligibility`, `context_snapshot`, and `design_gate`.
- [ ] 2.3 Document enums (all values), numerics (unit/bounds/special values), and arrays/maps
      (shape + example) for every option.
- [ ] 2.4 Attach concise security / blast-radius notes to the enumerated opt-in classes.
- [ ] 2.5 Document `models`/`effort`/`review_harness`/`executors`/`stage_executors` harness
      applicability and inert combinations accurately (reviewer-alias passthrough contract;
      implementer-role keys inert on a codex implementer).
- [ ] 2.6 Correct the opening claim so it is mechanically true, or narrow it to accurate coverage
      wording.

## 3. config sync

- [ ] 3.1 Ensure `config sync` introduces newly-added commented options and refreshed guidance into
      an existing config while preserving operator-set values and unrelated comments/formatting.
- [ ] 3.2 Confirm the effective-config equality gate still refuses writes that would change
      effective configuration, and init no-clobber behavior is unchanged.

## 4. Guarding tests (prove they bite)

- [ ] 4.1 Recursive schema-to-template drift test: walk `PartialConfigSchema` (top-level + nested)
      and fail when any accepted property is undocumented in the rendered template. Prove it fails
      when a key is removed from the template.
- [ ] 4.2 Defaults-parity test: each active documented default matches `DEFAULT_CONFIG`, or the
      field is declared absence/auto-detected in metadata. Prove it fails on a divergent default.
- [ ] 4.3 Round-trip test: fresh scaffold parses via `resolveConfig` and equals `DEFAULT_CONFIG`
      for every active key; uncommenting each documented example yields a schema-valid value.
- [ ] 4.4 Security-note presence test: each enumerated opt-in class carries a security note.
- [ ] 4.5 Opening-claim accuracy test: the top-of-file statement is mechanically true against the
      rendered coverage.

## 5. Mirror & gate

- [ ] 5.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 5.2 `npm run ci` green (core tests, mirror check, install smoke, `openspec validate --all`).
