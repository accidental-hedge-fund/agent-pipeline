## Context

The pipeline engine writes several machine-readable artifacts during a run: the #147
evidence bundle (`evidence.json`), the #155 run directory files (`events.jsonl`,
`summary.json`), and the `doctor --json` output. Each was built independently with no
shared safety contract. The risk that surfaces: a transient I/O error in artifact
writing aborts the run it is only observing; a JSONL line replayed into a later agent's
context carries injected instructions; a consumer (Pipeline Desk) breaks silently on a
schema field rename.

The 2026-06-14 gstack evaluation (`lib/jsonl-store.ts`, `ARCHITECTURE.md`,
`bin/gstack-telemetry-log`) demonstrated four proven patterns for exactly these
problems. This design adopts those patterns as conventions, not code.

## Goals / Non-Goals

**Goals:**
- Define the non-fatal I/O wrapper shape for all artifact writes.
- Define the write-time injection-screening contract (patterns, disposition, logging).
- Establish `schema_version` as a required field on every machine-readable record.
- Define `_`-prefix semantics for local-only fields.
- Document backward-compat promise so consumers can rely on it.
- Extend existing `[REDACTED]` secret-scrubbing to all run-dir artifacts.

**Non-Goals:**
- Changing what the pipeline records (scope of #147 / #155).
- Introducing any network telemetry, daemon, or event bus.
- Migrating the evidence bundle's existing `schemaVersion` field name (document
  the alias; align only in a future major version bump).
- Adding injection screening to human-facing CLI output (only machine-readable
  artifacts are in scope).

## Decisions

### D1 — Non-fatal wrapper is a thin try/catch at the call site, not a base class

**Decision**: Each artifact write wraps its I/O in an inline `try { … } catch (e) {
logWarn('artifact write failed', e) }`. No shared base class or decorator.

**Rationale**: The pattern is simple enough that a shared abstraction adds indirection
without reducing code. A `logWarn` call is already available everywhere write paths
exist. An inline catch also makes the failure path obvious to the next reader.

**Alternative considered**: A `safeWrite(fn)` utility wrapper. Rejected — the added
indirection hides the failure mode. Simple is better here.

---

### D2 — Injection denylist is a pure string → string `sanitize()` function

**Decision**: A single `sanitize(content: string): string` helper (co-located with
artifact write utilities) checks the serialized JSON string against a denylist of
injection patterns (case-insensitive regex). Matching spans are replaced with
`[REDACTED-INJECTION]`. The function is called before any append/write to a
machine-readable artifact.

**Rationale**: Operate on the final serialized string, not individual field values —
this catches cross-field injections (e.g., a value that becomes a prompt directive only
in serialized context). Redacting with a visible placeholder (not silent deletion)
preserves record structure and makes redaction auditable.

**Injection pattern set (initial)**:
- `ignore previous instructions`
- `disregard (all|any|the above|previous)`
- `you are now`
- `system:`
- `<\|im_start\|>` / `<\|im_end\|>` (model control tokens)
- `assistant:` at line-start in a multi-line string

Patterns are defined as a named constant `INJECTION_PATTERNS` in the sanitize module,
not embedded in call sites, so they can be extended without touching callers.

**Alternative considered**: Per-field type-based screening. Rejected — too fragile;
injection can span multiple fields and only appears when serialized.

---

### D3 — `schema_version` is an integer, not a semver string

**Decision**: Every machine-readable record carries `schema_version: <integer>`. The
initial value for all existing and new records is `1`. A bump to `2` signals a breaking
field removal/rename. New optional fields do not bump the version.

**Rationale**: Integer versions are simpler to compare in consumer code than semver.
The backward-compat promise (add fields freely; remove/rename = major bump) is modeled
after JSON Schema's additive-evolution norm.

**Field name**: `schema_version` (snake_case, consistent with the existing evidence
bundle's `schemaVersion` field). The proposal notes the evidence bundle uses
`schemaVersion`; during implementation align the evidence bundle to `schema_version`
via a one-time migration in the same change, OR document both names as aliases and
defer alignment to v2. Implementer should choose the simpler path.

---

### D4 — `_`-prefix marks local-only fields; stripping is at-write, not at-read

**Decision**: Any field whose value must not leave the local machine (absolute paths,
workspace paths, local-only tokens) is named with a leading `_` (e.g., `_localPath`,
`_workspacePath`). Documentation lists all current `_`-prefixed fields. No runtime
stripping occurs on write (the fields exist in the file); the prefix is a
human/tooling convention, not an automated filter.

**Rationale**: The artifacts are local-only files. Automated stripping on write would
remove information useful for local debugging. The `_`-prefix makes the convention
visible in the schema and discoverable via grep.

---

### D5 — No shared event bus or IPC; filesystem is the only cross-artifact channel

**Decision**: Artifacts do not subscribe to or emit events to each other. If one
artifact needs data produced by another, the producer writes it to disk and the
consumer reads from the agreed path.

**Rationale**: The pipeline already relies on the filesystem as its state store (label
transitions on GitHub, worktree paths, stateDir). Adding a runtime event bus would
introduce a process-lifetime dependency and complicate the sandbox / subprocess model.

## Risks / Trade-offs

**[Risk] Injection patterns are too broad** → Mitigation: Start conservative (exact
phrase matching with word-boundary anchors). Expansion is additive and can be done
without a schema bump. Log every redaction so false positives surface quickly in
testing.

**[Risk] `schema_version` field added to existing artifacts breaks consumers** →
Mitigation: `schema_version` is additive. Per the backward-compat promise, consumers
that read old records without the field should default it to `0` or ignore absence.

**[Risk] Non-fatal I/O hides bugs during development** → Mitigation: The warning log
includes the full error and stack. In test environments the test harness should assert
no warnings were logged for artifact writes.

**[Risk] `_`-prefix convention is not enforced at runtime** → Mitigation: Document in
README; add a lint rule or test that asserts no `_`-prefixed field appears in a
sync/export code path (if such a path is ever added).
