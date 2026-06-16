## Why

As agent-pipeline adds machine-readable surfaces (`events.jsonl`, `summary.json`,
`doctor --json`, and the #147 evidence bundle), three failure classes emerge with no
single owner: (1) an artifact write that throws aborts the run it is only supposed to
observe; (2) a JSONL line replayed into a later agent's context can carry injected
instructions; (3) consumers (Pipeline Desk) have no evolution contract and break on
schema changes. This change codifies the principles that govern every machine-facing
run artifact — non-fatal I/O, write-time injection screening, `schema_version`, and
`_`-prefix local-only fields — so all current and future surfaces share a consistent
safety baseline.

## What Changes

- **Non-fatal artifact I/O**: Every write/serialize path for a run artifact wraps its
  I/O in a try/catch; on failure it logs a warning and returns without propagating the
  error. A broken telemetry sink must never block a stage.
- **Write-time injection denylist**: Before persisting any event or record, a denylist
  of prompt-injection patterns (imperative phrases such as `ignore previous
  instructions`, `you are now`, `disregard`, `system:`) is checked against the
  serialized content. Matching content is redacted/escaped with a `[REDACTED-INJECTION]`
  placeholder, not silently dropped.
- **`schema_version` on every machine-readable record**: Every JSON/JSONL record
  written by the pipeline engine carries a `schema_version` integer field. A
  backward-compat promise is documented: field names and types are stable across minor
  versions; key order is not load-bearing; new fields may be added; removed fields are
  major-version bumps.
- **`_`-prefix local-only fields**: Fields that must not be surfaced to any remote or
  sync target (e.g., `_localPath`, `_workspacePath`) use a `_`-prefix convention. The
  README documents what the prefix means and lists the current local-only fields.
- **Filesystem-only data sharing**: Artifacts share data exclusively through the
  filesystem. No event bus, IPC daemon, or in-process event emitter is introduced as a
  cross-artifact communication channel.
- **Extend value-redaction to new run-dir artifacts**: The existing `[REDACTED]`
  secret-scrubbing applied to `CommandRecord`/`PromptRecord` in the evidence bundle is
  also applied to any new run-dir artifact (`events.jsonl`, `summary.json`,
  `doctor --json` output).

## Capabilities

### New Capabilities
- `run-artifact-conventions`: Cross-cutting conventions that every machine-facing
  pipeline artifact must satisfy: non-fatal I/O, write-time injection denylist,
  `schema_version`, `_`-prefix local-only fields, filesystem-only sharing, and
  value-redaction.

### Modified Capabilities
- `evidence-bundle`: Extend the non-fatal and redaction requirements already informally
  present in the bundle spec to include the injection denylist and explicit
  `schema_version` field requirements.

## Impact

- `core/scripts/stages/*.ts` and any utility that writes an artifact must wrap I/O in
  non-fatal try/catch.
- A shared `sanitize(content: string): string` helper (or inline pattern check) is
  added for injection screening at write-time.
- `evidence-bundle` schema gains a top-level `schema_version` field (already
  `schemaVersion: 1` in the bundle per the existing spec — align field name to
  `schema_version` or document the existing alias).
- README gains a new section: "Machine-readable artifact conventions" describing the
  `_`-prefix, `schema_version`, and backward-compat promise.
- No runtime behavior change to any stage logic — this is a safety-and-observability
  layer only.
