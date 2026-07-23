## Context

`pipeline init` scaffolds `.github/pipeline.yml` (`scaffoldDefaultConfig` →
`buildConfigTemplate` → `renderConfigTemplate`). `pipeline config sync` re-renders an existing
config through the same `renderConfigTemplate` and refuses to write if the effective config would
change (`normalizeForSync` equality gate). `pipeline config schema` emits a JSON Schema derived
from `PartialConfigSchema`, whose `.describe(...)` strings are the tooltip descriptions.

Today the template is a large hand-authored `parts: string[]` array. Its per-key lines, defaults,
comments, and commented opt-in blocks are maintained **independently** of both the Zod schema and
`DEFAULT_CONFIG`. Nothing fails when a new schema key is added without a matching template line —
which is exactly how `design_gate`, and the ten keys named in #504, drifted out of coverage.

## Goals / Non-Goals

Goals:
- One source of truth from which both the JSON-Schema descriptions and the template documentation
  are produced, so schema/template drift is structurally impossible for new fields.
- Exhaustive, honest, self-documenting template output (defaults vs. absence semantics; enums,
  units, bounds, shapes, examples; security notes).
- Mechanical drift + defaults-parity tests that fail loudly on the next omission.

Non-Goals:
- No change to runtime defaults or opt-in enablement.
- No interactive wizard.
- No removal of `pipeline config schema`.
- Not re-architecting the whole config system — only the documentation/derivation seam and the
  guarding tests.

## Decisions

### Single field-metadata source of truth
Introduce shared per-field documentation metadata (description, default vs. absence/auto-detection
semantics, enum values, numeric unit/bounds/special values, array/map shape + example, and an
optional security note) that both `pipeline config schema` descriptions and the template renderer
consume. Prefer attaching or co-locating this metadata with the Zod field definitions (the schema
already carries `.describe(...)`), so a new field's metadata lives next to its schema declaration.
This is the "avoid a second hand-maintained option inventory" acceptance criterion.

Trade-off: the template still needs YAML-rendering structure (nesting, commented-vs-active,
grouping/whitespace) that pure metadata does not capture. The decision is that *documentation
content* (text, defaults, examples, security) is single-sourced from metadata, while the renderer
owns only *layout*. The drift test guards the layer that can still be forgotten (a new key never
laid out), so forgetting a key fails CI rather than shipping silently.

### Absence semantics are first-class, not placeholders
For keys whose resolved "default" is absence (`repo`, `conventions_md_path`, `setup_command`
auto-detection, `event_sink`, `roadmap`, `sweep`, `queue`, `trusted_override_actors`,
`auto_merge_eligibility`, `context_snapshot`, `executors`/`stage_executors`, optional
`review_policy` sub-keys, etc.), the metadata declares the semantic (`absent` / `disabled` /
`auto-detected` / `unlimited`) and the renderer emits a commented opt-in example rather than an
invented active default. This preserves the existing "a fresh scaffold equals `DEFAULT_CONFIG`
for every active key" round-trip guarantee — commented lines contribute nothing to the parsed
config — while still exhaustively documenting the option.

### Recursive drift test walks the schema, not key strings
The drift test SHALL walk `PartialConfigSchema` recursively (top-level and nested object
properties) and assert each accepted property path is documented in the rendered template. A test
that only greps top-level key strings is explicitly insufficient (per #504's implementation note):
it must cover nested properties and fail on schema evolution. The defaults-parity test SHALL,
for each active documented default, compare against `DEFAULT_CONFIG` (or assert the field is
declared absence/auto-detected in metadata). Because type-stripping performs no `tsc` check, these
invariants MUST be enforced by real runtime tests (per CLAUDE.md).

### config sync introduces new documentation without touching operator values
`config sync` continues to re-render through the shared template and keeps its effective-config
equality gate (`normalizeForSync`), so newly-introduced commented options and refreshed guidance
land in an existing file while set values are preserved and the write is refused if effective
config would change. The init no-clobber behavior is unchanged.

## Risks / Trade-offs

- **Template size grows** (every key now present). Mitigation: commented opt-in blocks keep the
  active surface equal to today's defaults; grouping/whitespace keeps it scannable.
- **Metadata refactor could regress the round-trip/equality guarantees.** Mitigation: the existing
  scaffold-equals-defaults and sync-preserves-effective-config tests remain, plus the new drift and
  parity tests; all must be proven to bite (fail without the change).
- **Security-note wording is judgement-laden.** Mitigation: scope the required note to the
  enumerated opt-in classes (mutation/authority, external execution, secret/auth, telemetry,
  sandbox, auto-loop, auto-merge-eligibility) and assert presence per-class in tests.

## Migration

Backward compatible. Existing configs are unaffected until an operator runs `config sync`, which
only adds commented documentation and refreshes comments without changing effective values.
