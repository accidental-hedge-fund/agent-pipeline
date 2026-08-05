## Context

Agent Pipeline already runs deterministic format/test gates (`testgate.ts`, `format-gate.ts`) before or around review, records commands into the evidence bundle (`recordCommand`, `CommandRecord`), and posts human blockers on gate failure. Review stages (`review-1`, `review-2`, delta re-review via the SHA gate, and — when enabled — every agent in the #645 ensemble) still receive issue/plan/diff/conventions without a **first-class, SHA-pinned suite evidence object**.

Related landed or in-flight surfaces:

- `test-build-gate` / `test-gate-ci-parity` / `test-gate-non-product-dirty` — command resolution, dirty-tree trust, timeouts, fix loop
- `evidence-bundle` / `run-store` / `run-directory-layout` — `.agent-pipeline/runs/<run-id>/`, `events.jsonl`, `summary.json`
- `review-sha-gating` / `review-artifact-record` — review verdicts are SHA-bound; Tester evidence must follow the same candidate discipline
- `review-ensemble` (#645) — all agents must share one independent test record for the candidate
- `stage-cost-accounting` / `factory-scoreboard` — structured metrics without prose parsing
- #633 operator-visible artifact-write failure signal — reuse disposition when write fails
- #692 (later) — unified immutable `evidence_subject` across all assurance families; #646 must not invent a conflicting Tester-only identity vocabulary
- #691 (later) — trusted verifier surface; Tester producer remains engine/deterministic code, not the candidate tree’s ability to redefine the verifier

Hard prerequisite for product value: #645 ensemble (closed/landed in this milestone window). Compose with #575 attestation later; do not block.

## Goals / Non-Goals

**Goals:**

1. Define a versioned **TesterEvidence** schema with candidate SHA binding, run/issue identity, config digest, worktree + bounded toolchain fingerprint, timing, status taxonomy, per-command results, optional per-test results, and bounded redacted output.
2. Produce the artifact from **deterministic** gate execution paths already owned by the engine.
3. Persist the full record in the run evidence surfaces; summarize for humans.
4. Inject the **same** SHA-matched artifact into every reviewer evaluating that candidate (single reviewer and ensemble).
5. Classify missing / malformed / SHA-mismatched / stale evidence explicitly; never imply pass without trustworthy evidence.
6. Invalidate and regenerate after candidate-changing commits (fix rounds, salvage, external head movement).
7. Allow supplemental targeted-check records that cannot overwrite authority.
8. Expose scoreboard-readable structured metrics.
9. Keep identity fields forward-compatible with #692 `evidence_subject`.

**Non-Goals:**

- Universal test framework or mandatory per-test extraction for every repo.
- Deterministic model reviewers.
- Reviewer rewrite of suite outcomes.
- New stage label solely for Tester.
- Replacing CI / eval / visual / shipcheck evidence.
- Full #692 subject unification or #691 verifier-surface productization.
- Cross-host durable suite result cache (host-local run store remains the source for a run).

## Decisions

### Decision 1 — Artifact produced by gate runners, not a new stage

**Chosen:** Emit/update `TesterEvidence` inside (or immediately after) existing deterministic gate execution — primarily `runTestGate` and any format/pre-review deterministic command set already invoked by the engine for that candidate — writing into the current run directory / evidence bundle.

**Rejected:** A new `pipeline:tester` stage label and state-machine hop (issue non-goal; adds label churn without rigor). **Rejected:** Asking the implementer/writer harness to emit the suite record (untrusted).

**Why.** Reuses command resolution, timeout, dirty-tree trust, and fix-loop semantics already specified. Reviewers consume a record of what the engine already ran.

### Decision 2 — Schema shape and status taxonomy

**Chosen (illustrative; exact TypeScript lands in implementation):**

```ts
type TesterEvidence = {
  schema_version: 1;
  kind: "tester_evidence";
  // Identity — forward-compatible with #692 evidence_subject fields
  candidate_sha: string;          // full 40-char HEAD at production time
  run_id: string;
  issue: number;
  pr: number | null;
  worktree_id: string;            // managed path basename or stable id, not full host path if sensitive
  config_digest: string;          // hash of effective test/format gate config + resolved command identity
  toolchain_fingerprint: {        // bounded, privacy-safe
    node?: string;
    npm?: string;
    os?: string;
    // allowlisted keys only; no env dump
  };
  started_at: string;             // ISO 8601
  ended_at: string;
  duration_ms: number;
  overall_status:
    | "passed"
    | "failed"
    | "timeout"
    | "tooling_failure"
    | "partial"
    | "disabled"
    | "not_run"
    | "unavailable"
    | "stale";
  overall_reason?: string;        // required for non-passed terminal classifications
  commands: TesterCommandResult[];
  tests?: TesterTestResult[];     // optional; only when extractor exists
  output_excerpt: string;         // bounded + redacted
  producer: {
    component: "test-build-gate" | "format-gate" | "combined" | string;
    engine_version?: string;
  };
  // Optional reserved nest for #692 without requiring it now:
  evidence_subject?: Record<string, unknown>; // absent in v1; do not invent competing keys
};

type TesterCommandResult = {
  identity: string;               // stable label (configured cmd or detected)
  exit_code: number | null;
  duration_ms: number;
  status: "passed" | "failed" | "timeout" | "tooling_failure" | "skipped" | "not_run";
  output_excerpt: string;         // bounded + redacted
};

type TesterTestResult = {
  name: string;
  status: "passed" | "failed" | "skipped" | "unknown";
  duration_ms?: number;
  // no raw stack dumps beyond bounded excerpt if needed later
};
```

**Status meanings (normative intent):**

| Status | Meaning |
| --- | --- |
| `passed` | All required commands exited 0 under trusted clean-tree rules |
| `failed` | At least one required command exited non-zero for product/test failure |
| `timeout` | Kill/timeout classification on a required command |
| `tooling_failure` | Runner/spawn/infra failure distinct from test assertion failure when classifiable |
| `partial` | Multi-command set where some completed and others did not (distinguishable per-command rows remain) |
| `disabled` | Gate configured off |
| `not_run` | Gate enabled but no command resolved / intentionally not executed yet |
| `unavailable` | Trustworthy result cannot be produced (e.g. dirty product tree pre-run, write failure, missing run store) with reason |
| `stale` | Artifact exists but `candidate_sha` ≠ current HEAD (or explicit invalidate after fix) |

**Rejected:** Collapsing timeout/tooling/disabled into a single `failed`. **Rejected:** Inferring `passed` from absent artifact under fail-closed.

### Decision 3 — SHA match, staleness, and post-fix regeneration

**Chosen:**

1. At production time, pin `candidate_sha` to worktree HEAD (injected `gitHead` seam).
2. Before any review verdict may treat Tester evidence as current, acquisition compares `artifact.candidate_sha` to the review candidate HEAD.
3. Mismatch → classify `stale` (or refuse load and synthesize an acquisition result with `stale` / `unavailable`); **never** pass through as `passed`.
4. After any candidate-changing commit (test-fix, review-fix, salvage, external push observed before review), prior artifact is invalid; the engine MUST re-run the deterministic producer path (or mark unavailable if re-run cannot run) before review relies on suite evidence.
5. Pipeline-internal commits that do **not** change the product candidate (e.g. OpenSpec archive docs-only commits classified internal by existing `isPipelineInternalCommit`) SHALL NOT force suite re-run solely because HEAD moved, consistent with review-SHA gate doctrine — but if HEAD’s product tree would differ, re-run. Implementation MUST use the same internal-commit classifier already used by the review SHA gate rather than inventing a second definition.

**Rejected:** Reusing a pass from SHA A for SHA B. **Rejected:** “Re-review on any SHA change including pure internal docs” cascade for suite re-run when the product tree is unchanged — mirror review-SHA internal-commit discipline.

### Decision 4 — Fail-open / fail-closed configuration

**Chosen:** Config block (illustrative):

```yaml
tester_evidence:
  # When trustworthy SHA-matched evidence is missing/malformed/stale at review acquisition:
  # - fail_closed (default for rigor): review path MUST NOT treat suite as passed;
  #   stage disposition is explicit (block or continue with "suite evidence unavailable" —
  #   never silent pass implication in prompts or scoreboard).
  # - fail_open: review may proceed with explicit unavailable classification in the prompt
  #   and artifacts; still MUST NOT claim passed.
  on_missing: fail_closed   # fail_closed | fail_open
  max_output_chars: 4000    # bound for excerpts
  # optional allowlisted extractors later; absent = no per-test rows
```

Both modes **forbid implying pass without evidence**. The difference is only whether missing suite evidence alone is a hard review/pre-review block vs an explicit unavailable annotation that still allows model review of the diff.

**Default:** `fail_closed` for this repo’s rigor posture unless an existing test-gate skip (disabled / no command) already means “no suite required,” which maps to `disabled` / `not_run` rather than a false pass.

**Rejected:** Silent omission of the artifact section from the review prompt when missing (implies nothing to see / maybe fine).

### Decision 5 — Review injection and ensemble sharing

**Chosen:** A single pure loader (e.g. `loadTesterEvidenceForReview({ runDir, candidateSha, … })`) returns either a SHA-matched artifact, a classified stale/unavailable record, or null mapped through the fail-open/closed policy into a **prompt section**:

```
## Authoritative Tester evidence (engine-produced, SHA-pinned)
… structured summary + status …
## Supplemental targeted checks (reviewer-optional; cannot replace suite evidence)
… empty or appended later …
```

- All ensemble agents receive the **same** core section (Decision 7 of #645: shared prompt material; identity suffix only).
- Targeted checks a reviewer runs are recorded separately (`kind: "tester_targeted_check"`) and never flip `overall_status` on the authoritative artifact.

**Rejected:** Per-agent suite re-runs as the authority. **Rejected:** Letting targeted-check pass overwrite suite fail.

### Decision 6 — Extractors optional and allowlisted

**Chosen:** Per-test rows only when a repository-provided or engine-supported extractor is configured/allowlisted and parse succeeds. Malformed extractor output → command-level results still stand; per-test array omitted or marked unknown; overall status remains driven by command exit codes, not extractor success.

**Rejected:** Requiring JUnit/TAP everywhere. **Rejected:** Failing the whole suite classification solely because an optional extractor failed when exit code was 0 (prefer `tests` absent + diagnostic rather than flipping `passed` → `failed`).

### Decision 7 — Persistence, redaction, human summary

**Chosen:**

- Full JSON under the run directory (e.g. `tester-evidence.json` and/or embedded in `summary.json` + an `events.jsonl` event `tester_evidence`).
- All string fields through existing secret-redaction + injection denylist.
- Bounded excerpts via existing output-cap helpers (parameterized by `max_output_chars`).
- Human PR/issue comment: short summary (status, SHA short, command count, duration) — not the full log.
- Artifact write failure: reuse #633 disposition (operator-visible; do not pretend the write succeeded).

**Rejected:** Posting full test logs to GitHub. **Rejected:** Full `process.env` fingerprint.

### Decision 8 — Scoreboard / accounting

**Chosen:** Structured fields on the artifact and/or a `stage_accounting`-adjacent event allow:

- Tester wall duration (`duration_ms`)
- command count and per-status tallies
- overall_status histogram across runs
- count/cost of supplemental targeted checks (when recorded) as **redundant** suite cost diagnostics

Scoreboard MUST read structured fields, not regex the human summary.

### Decision 9 — Forward compatibility with #692

**Chosen:** Use field names that map cleanly onto planned `evidence_subject` (candidate SHA, run id, issue/pr, config digest, engine fingerprint). Do **not** mint a parallel `tester_subject_id` that later conflicts. Optional nested `evidence_subject` MAY remain absent until #692; readers ignore unknown fields.

**Rejected:** A Tester-only identity enum that renames core identity concepts away from the shared subject design.

### Decision 10 — Test strategy

| Layer | Coverage |
| --- | --- |
| Schema / pure classify | pass, fail, timeout, tooling, partial, disabled, not_run, unavailable, stale SHA match |
| Producer unit tests | Injected `runTests` / dirty / head seams; artifact fields; no real subprocess |
| Extractor | well-formed → tests[]; malformed → command results preserved |
| Review acquisition | match, mismatch→stale, missing + fail_closed, missing + fail_open (never imply pass) |
| Post-fix | new HEAD invalidates; regeneration required before “current” evidence |
| Ensemble | N agents see identical authoritative section |
| Redaction | secrets not in excerpts; bound length |
| Scoreboard | metrics from structured fields |

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Extra suite re-runs after every internal docs commit | Reuse `isPipelineInternalCommit` / product-tree discipline from review-SHA gate |
| Fail-closed too strict for repos with no tests | Map disabled/no-command to `disabled`/`not_run` without blocking when gate already skips |
| Ensemble prompt size growth | Bounded excerpts; summary section + pointer to run path |
| Extractor ecosystem sprawl | Allowlist only; default off |
| #692 field churn | Keep identity flat and generic; avoid Tester-specific subject vocabulary |
| Write failure silent | #633-style visible failure; status `unavailable` |

## Migration Plan

1. Land schema + producer behind existing gate path; write artifact when run store present.
2. Wire review prompt injection with default fail_closed; single-reviewer path first (same code as ensemble).
3. Ensemble inherits shared section automatically via shared prompt assembly.
4. Scoreboard fields additive; older runs without artifact remain valid with “tester metrics absent” diagnostics.
5. No label migration; no archive of living specs until implementation archives this change.

Rollback: config `tester_evidence` omit / disable injection (if a kill-switch is needed) while keeping producer optional — prefer keeping producer on for honesty even if injection is gated.

## Open Questions

1. Exact default for `on_missing` when `test_gate.enabled: false` — treat as `disabled` evidence (no review block) vs omit section. **Recommendation:** emit `disabled` artifact so prompts are explicit.
2. Whether format-gate commands are merged into the same Tester artifact or remain separate command rows under `producer: combined`. **Recommendation:** one artifact per candidate with multi-command rows when both run for that SHA.
3. Whether plan-review (pre-implementation) receives Tester evidence at all. **Recommendation:** only when a candidate product SHA exists with a prior trusted run; plan-review of pure plan text may show `not_run` — do not invent fake suite results.
