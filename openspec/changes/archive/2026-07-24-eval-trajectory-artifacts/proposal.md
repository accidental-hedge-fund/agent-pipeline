## Why

The stage eval runner (#432) writes one compact `CellRecord` per cell to `runs.jsonl`, and the
grading layer (#433) writes one `grades.jsonl` record per graded cell plus optional judge and
disagreement records. Those streams are deliberately small: they carry identity keys, a
`result_class`, stage summaries, selected grading inputs, and — for judging — a verdict. That is
enough to *rank* treatments, but not enough to *diagnose* a surprising result.

When a cell scores badly (or suspiciously well), the maintainer's next question is "what actually
happened". Did the treatment reward-hack the hidden check, fake completion, cite irrelevant
evidence, or misuse a tool — or did the *verifier* score it wrong: a flawed grader, a
hallucinating judge, a mis-seeded fixture? Today the only way to answer that is to re-run the cell
by hand, which reintroduces the anecdote the runner was built to eliminate — and a re-run is not
the same execution. The [source discussion](https://x.com/vtrivedy10/status/2079976006644072796)
makes the point directly: to refine an eval you must be able to inspect **both** the agent
trajectory and the verifier trajectory of the specific cell you are questioning.

This change persists that evidence as bounded, sanitized, immutable **per-cell artifacts**
referenced by hash. The JSONL result and grade streams stay compact indexes; the heavy diagnostic
detail lives in content-addressed artifacts that the streams point to. Treatment evidence and
verifier evidence are stored as independently addressable artifacts so a maintainer can inspect
both sides of a judge/test disagreement without conflating them.

## What Changes

- **Treatment trajectory artifacts** (`eval-trajectory-artifacts`): each executed cell MAY emit
  one immutable treatment trajectory artifact capturing bounded stage messages/output, tool calls
  and their results *when the harness exposes them*, actions, errors, timing, and references to any
  artifacts the treatment produced. Raw provider chain-of-thought is never requested and never
  required — structured messages, tool events, outputs, and produced-artifact references are
  sufficient.
- **Verifier evidence artifacts**: deterministic graders and the optional model judge each emit a
  **separate** verifier evidence artifact carrying the inputs and checks/evidence consulted, the
  grader/judge identity and version, intermediate structured decisions when available, and the
  final result. Treatment and verifier artifacts are independently addressable.
- **Reference-by-descriptor**: `runs.jsonl`, `grades.jsonl`, judge records, and disagreement
  records reference their artifacts by a descriptor `{ path, content_hash, schema_version,
  byte_count, truncation_status }` — a repo-relative path plus content hash — rather than embedding
  the trajectory inline. The append-only streams stay compact.
- **Best-effort and capability-aware**: collection never fails a cell. Telemetry a harness does not
  expose (e.g. tool-call structure from a CLI treatment) is recorded as explicitly `unavailable`
  with a reason, never fabricated as an empty-but-successful trajectory.
- **Sanitized and bounded**: every artifact is secret-redacted and injection-sanitized before
  persistence, reusing the run-artifact write-time denylist. Configurable byte and event ceilings
  apply **deterministic head/tail retention** and record exactly what was dropped (counts and
  bytes), so truncation is visible and reproducible.
- **Hidden-material containment**: hidden checks, golden answers, seeded-defect ground truth, and
  any verifier-only material never appear in a treatment trajectory artifact and never reach the
  treatment-visible filesystem. Verifier-only material lives only in verifier artifacts.
- **Resume-safe and content-addressed**: artifacts are content-addressed; a resumed run never
  rewrites an existing trajectory artifact, and duplicate collection is either satisfied by the
  existing content-addressed artifact or rejected visibly — never silently overwritten.
- **Opt-in outlier linking in reporting** (`eval-comparative-reporting`): comparative reporting is
  unchanged by default, but MAY link trajectory artifacts for flagged cells — outliers, judge
  disagreements, false positives/negatives, and failed cells — deterministically, without altering
  any aggregate or the default output.
- **Deterministic CI coverage**: a checked-in synthetic fixture set plus recorded cell/grade
  records exercises collection, sanitization, truncation, unavailability, hidden-material
  non-leakage, resume, and hash verification with no live model call, network, real git, or
  subprocess.

## Acceptance Criteria

- [ ] An executed eval cell emits an immutable treatment trajectory artifact containing bounded
      stage messages/output, tool calls and results when the harness exposes them, actions, errors,
      timing, and references to produced artifacts.
- [ ] A deterministic grader and an optional model judge each emit a **separate** verifier evidence
      artifact containing its inputs, the checks/evidence consulted, grader/judge identity and
      version, intermediate structured decisions when available, and the final result.
- [ ] `runs.jsonl`, `grades.jsonl`, judge records, and disagreement records reference their
      artifacts by `{ path, content_hash, schema_version, byte_count, truncation_status }` rather
      than embedding the trajectory, and each descriptor's `content_hash` verifies against the
      referenced file's bytes.
- [ ] Treatment and verifier artifacts for one cell are independently addressable: a maintainer can
      resolve and open each side of a judge/test disagreement without one reference pointing at the
      other's content.
- [ ] Harness telemetry the treatment does not expose is recorded as `unavailable` with a reason;
      no unavailable channel is written as an empty successful trajectory.
- [ ] A secret env assignment and an injection role-marker present in captured trajectory text are
      replaced with the run-artifact redaction placeholders before the artifact is persisted; the
      raw value never appears in the artifact.
- [ ] An artifact exceeding the configured byte or event ceiling is truncated by deterministic
      head/tail retention, records the dropped event count and dropped byte count, and sets
      `truncation_status` accordingly; truncating the same input twice yields byte-identical output.
- [ ] No treatment trajectory artifact and no treatment-visible filesystem path contains a hidden
      check body, golden answer, seeded-defect ground truth, or other verifier-only material.
- [ ] Raw chain-of-thought is neither requested from nor required of any harness; a treatment that
      exposes only structured messages, tool events, and outputs still yields a complete artifact.
- [ ] A resumed run over an experiment whose trajectory artifacts already exist rewrites none of
      them; a duplicate collection for the same content resolves to the existing artifact, and a
      collision on a differing body is surfaced rather than overwriting.
- [ ] Comparative reporting output is byte-identical to the pre-change output when outlier linking
      is disabled; with linking enabled it adds artifact references for flagged cells without
      changing any aggregate, and summarizing twice remains byte-identical.
- [ ] Artifact writes are non-fatal and every artifact and reference descriptor carries a
      `schema_version`, consistent with the run-artifact conventions.
- [ ] Tests cover CLI and API treatments, unavailable tool telemetry, judge disagreement,
      hidden-material non-leakage, secrets, injection text, deterministic truncation, resume, and
      artifact hash verification — all against checked-in fixtures with no live model call, network,
      real git, or subprocess.

## Out of Scope

- Storing unrestricted provider chain-of-thought.
- A hosted tracing backend or trajectory-viewer UI.
- Changing any deterministic grade based on judge reasoning or on trajectory content.
- Putting large trajectories directly in the append-only result or grade streams.
- Capturing normal production runs beyond the evidence the run store already supports (this change
  is scoped to eval cells).
- The experiment scheduler, worktree isolation, cell execution (#432), and the grading math (#433);
  this change consumes their records and adds referenced evidence.
