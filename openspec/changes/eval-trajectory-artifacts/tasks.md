## 1. Artifact model and storage

- [x] 1.1 Define artifact and descriptor types in `core/scripts/evals/trajectory/types.ts`: a
      treatment trajectory artifact (stage messages/output, tool events, actions, errors, timing,
      produced-artifact references, per-channel availability), a verifier evidence artifact
      (inputs, checks/evidence consulted, grader/judge id+version, intermediate decisions, final
      result), and an `ArtifactDescriptor` `{ path, content_hash, schema_version, byte_count,
      truncation_status }`. Every persisted shape carries a top-level `schema_version`.
- [x] 1.2 Implement a content-addressed writer in `core/scripts/evals/trajectory/store.ts`: hash
      the sanitized bytes, write under the experiment output directory keyed by hash, return a
      descriptor. Never rewrite an existing file; on a same-address differing-content collision,
      surface it and do not overwrite. Wrap the write in try/catch (non-fatal).

## 2. Sanitization and bounding

- [x] 2.1 Apply the existing run-artifact value-redaction and write-time injection denylist to
      artifact text before hashing/serialization, field-level before `JSON.stringify` (reuse the
      helpers behind `run-artifact-conventions`).
- [x] 2.2 Implement deterministic head/tail bounding against configurable byte and event ceilings;
      record dropped-event and dropped-byte counts and set `truncation_status`. Bounding the same
      input twice is byte-identical.

## 3. Treatment trajectory collection

- [x] 3.1 Collect a treatment trajectory per executed cell in the runner
      (`core/scripts/evals/`), capability-aware per harness: capture what the harness exposes, mark
      each unexposed channel `unavailable` with a reason (never empty-successful). Support CLI and
      API endpoint treatments.
- [x] 3.2 Ensure collection is best-effort: a collection/write error is recorded and leaves the
      cell's `result_class` unchanged.
- [x] 3.3 Attach the resulting `ArtifactDescriptor` to the cell's `runs.jsonl` record without
      embedding the trajectory inline.

## 4. Verifier evidence collection

- [x] 4.1 Emit a verifier evidence artifact from each deterministic grader; attach its descriptor to
      the `grades.jsonl` record.
- [x] 4.2 Emit a verifier evidence artifact from the optional model judge; attach its descriptor to
      the judge record and to any disagreement record. Keep treatment and verifier artifacts
      independently addressable.

## 5. Hidden-material containment

- [x] 5.1 Guarantee verifier-only material (hidden checks, golden answers, seeded-defect ground
      truth) is excluded from treatment trajectory capture and from the treatment-visible
      filesystem; confirm it appears only in verifier artifacts. Reuse the hidden-check exclusion
      boundary from the fixture contract.

## 6. Comparative reporting linking

- [x] 6.1 Add an opt-in flag to `pipeline evals report` that links trajectory/verifier artifact
      references for flagged cells (outliers, judge disagreements, false positives/negatives, failed
      cells) as additive references; default output stays byte-identical and no aggregate changes.

## 7. CLI and registry

- [x] 7.1 Add the collection ceilings and the report linking flag to config/CLI, and register any
      new flags and `--help` usage in `core/scripts/command-registry.ts`.

## 8. Tests (offline, fixtures only)

- [x] 8.1 CLI and API treatments each produce a trajectory artifact with correct per-channel
      availability.
- [x] 8.2 Unavailable tool telemetry is marked `unavailable`, not empty-successful.
- [x] 8.3 Secret redaction and injection sanitization applied before persistence; raw value absent.
- [x] 8.4 Deterministic head/tail truncation with drop accounting and byte-identical re-runs; a
      within-ceiling artifact is untruncated.
- [x] 8.5 Hidden-material non-leakage: no hidden check / golden answer / seeded-defect ground truth
      in a treatment trajectory or on a treatment-visible path.
- [x] 8.6 Descriptor `content_hash` verifies against artifact bytes; treatment and verifier
      artifacts are independently addressable.
- [x] 8.7 Judge disagreement produces a separate verifier artifact referenced by the disagreement
      record.
- [x] 8.8 Resume rewrites no existing artifact; identical duplicate content resolves to the existing
      artifact; a differing-content collision is surfaced, not overwritten. Write failure is
      non-fatal.
- [x] 8.9 Report linking: default output byte-identical when disabled; enabled adds references
      without changing aggregates; twice-summarized is byte-identical.
- [x] 8.10 All of the above run with no live model call, network, real git, or subprocess.

## 9. Docs, mirror, gate

- [x] 9.1 Document the trajectory/verifier artifacts, descriptors, ceilings, and the report linking
      flag in `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`, stating artifacts are diagnostic
      only and never gate a PR or move a grade.
- [x] 9.2 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [x] 9.3 Run `npm run ci` from the repo root and confirm it is green.
