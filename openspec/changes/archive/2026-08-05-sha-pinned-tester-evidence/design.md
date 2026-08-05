## Context

Agent Pipeline already runs deterministic format/test gates (`testgate.ts`, `format-gate.ts`) before or around review, records commands into the evidence bundle (`recordCommand`, `CommandRecord`), and posts human blockers on gate failure. Review stages (`review-1`, `review-2`, delta re-review via the SHA gate, and — when enabled — every agent in the #645 ensemble) still receive issue/plan/diff/conventions without a **first-class, SHA-pinned suite evidence object**.

Related landed surfaces:

- `test-build-gate` / `runTestGate` / `runFormatAndTestGates` — command resolution, dirty-tree trust, timeouts, fix loop
- `evidence-bundle` / `run-store` / `run-directory-layout` — `.agent-pipeline/runs/<run-id>/`, `events.jsonl`, `summary.json`, atomic tmp+rename writes
- `review-sha-gating` / `pipeline-commits.isPipelineInternalCommit` — review verdicts are SHA-bound; Tester evidence follows the same candidate discipline
- `review-ensemble` (#645, landed) — `invokeReviewEnsemble` shares one `options.prompt` + optional identity suffix only
- `stage-cost-accounting` / `factory-scoreboard` — structured metrics without prose parsing
- #633 operator-visible event-stream write-health — reuse for Tester artifact write failure
- #692 (later) — unified `evidence_subject`; #646 must not invent a conflicting Tester-only identity vocabulary

Hard prerequisite for product value: #645 ensemble (landed). Compose with #575 attestation later; do not block.

## Goals / Non-Goals

**Goals:**

1. Versioned **TesterEvidence** schema with SHA pin, identity, config digest, bounded toolchain fingerprint, timing, status taxonomy, command rows, optional per-test rows, bounded redacted output.
2. Produce only from deterministic `runTestGate` outcomes (not the writer model).
3. Persist full record in run evidence surfaces; summarize for humans.
4. Inject the **same** SHA-matched artifact (or shared stale/missing classification) into every reviewer evaluating that candidate, via **one** shared prompt assembly before `invokeReviewEnsemble`.
5. Explicit missing / malformed / stale disposition; never imply pass without trustworthy evidence.
6. After candidate-changing commits, prior artifact is non-current until `runTestGate` regenerates for the new HEAD.
7. Supplemental targeted-check records that cannot overwrite authority.
8. Scoreboard-readable structured metrics.
9. Identity fields forward-compatible with #692 `evidence_subject`.

**Non-Goals:**

- Universal test framework or mandatory per-test extraction.
- Deterministic model reviewers.
- Reviewer rewrite of suite outcomes.
- New stage label solely for Tester.
- Replacing CI / eval / visual / shipcheck evidence.
- Full #692 subject unification or #691 verifier-surface productization.
- Cross-host durable suite result cache.
- Merging format-gate command results into the v1 Tester suite authority (format remains a separate gate).

## Decisions

### Decision 1 — Artifact produced by `runTestGate` only (not a new stage)

**Chosen:** Emit/update `TesterEvidence` inside `runTestGate` after each terminal outcome that has a recordable run surface (`runDir` preferred; `stateDir` may hold a mirror pointer). Format-gate and format↔test convergence (`runFormatAndTestGates`) do **not** write suite authority themselves; the final `runTestGate` call on the post-format HEAD is the writer.

**Rejected:** New `pipeline:tester` stage. **Rejected:** Writer/model-authored suite record. **Rejected:** Per-reviewer suite re-run as authority.

**Observational only:** Existing gate pass/block/fix-loop routing stays authoritative. Tester evidence is the structured evidence form of that execution — not a parallel policy engine and not a second gate.

### Decision 2 — v1 command inventory and status precedence

**v1 command inventory (authoritative suite set):**

| Order | Identity | Source | Required for suite authority? |
| --- | --- | --- | --- |
| 1 | Resolved test/build command label | `cfg.test_gate.command` (bash -c pipefail) **or** `detectTestCommand` auto-detect | Yes — sole required command |

**Explicitly out of v1 Tester command inventory:**

- `format_gate[]` entries (separate gate; may auto-commit and move HEAD; still block via existing format routing).
- `build_command` fold (#387) (separate build-failed routing).
- CI / eval / visual / shipcheck.
- Reviewer ad-hoc shell (supplemental only — Decision 6).

**v1 is single-command.** Multi-command rows and `partial` are schema-ready for a later multi-command producer; production writer emits exactly one command row when the gate runs a command, or zero command rows for disabled / not_run / pre-run unavailable paths.

**Plumb timeout:** Extend `RunTestsResult` (or the producer-local view of it) to surface `timed_out` distinctly from `toolingError` / non-zero exit. Today `runTests` only folds timeout into `passed: false` without a first-class flag — v1 producer MUST distinguish timeout.

**Status precedence for `overall_status` (evaluate top-first; first match wins):**

1. `disabled` — `cfg.test_gate.enabled === false` (no command executed).
2. `not_run` — enabled but no command configured/detected (skip without run).
3. `unavailable` — product-dirty hard block before/after run trust failure; empty/whitespace misconfigured command treated as non-pass unavailable or failed with reason (match existing gate blockReason; never `passed`); recording path absent is not forced into overall_status when no write occurs.
4. `tooling_failure` — spawn/capture error exhausted (`toolingError` / `toolingFailure`).
5. `timeout` — required command killed for gate timeout (`timed_out`).
6. `failed` — clean non-zero exit (product/test failure).
7. `passed` — clean exit 0 under trusted clean-tree rules.
8. `partial` — reserved for multi-command sets where some required commands completed and others did not (not produced by the single-command v1 writer).
9. `stale` — **acquisition-only** classification when stored `candidate_sha ≠` review HEAD (or schema-invalid treated as unavailable/malformed, not as a stored `stale` production status). Producer never writes `overall_status: "stale"` as a successful suite result for the current HEAD.

Command-row `status` uses: `passed` | `failed` | `timeout` | `tooling_failure` | `skipped` | `not_run`.

### Decision 3 — Artifact lifecycle (storage, lookup, atomic write, retention)

**Storage (canonical):**

| Surface | Path / key | Role |
| --- | --- | --- |
| Primary file | `{runDir}/tester-evidence.json` | Full structured `TesterEvidence` for the **latest successful write** in this run |
| Event | `events.jsonl` type `tester_evidence` | Outcome signal (overall_status, candidate_sha, duration_ms, command_count) for scoreboard/status |
| Summary | `summary.json` optional field `tester_evidence` summary or path pointer | Compact; must not replace primary file |
| Legacy stateDir | optional best-effort mirror under issue state if only `stateDir` is available | Same redaction rules; prefer `runDir` |

**Atomic write:** Mirror `evidence-bundle` / `run-store` pattern: write `{path}.tmp` → `rename` to final; sanitizeDeep + redactSecrets on all string fields before serialize. Inject `BundleDeps`-style I/O in tests.

**Lookup order (acquisition — fixed, never opportunistic):**

1. Read `{runDir}/tester-evidence.json` only (no directory walk, no alternate-SHA search).
2. If missing → classification `missing`.
3. If unreadable / JSON parse fail / schema validation fail → `malformed`.
4. If well-formed and `artifact.candidate_sha === candidateHeadSha` (full 40-char, case-normalized hex compare) → `current` with artifact.
5. If well-formed and SHA mismatch → `stale` (return classification + optional non-authoritative artifact for audit only). **Never** treat mismatch as current; **never** silently select another record.

**Prior-SHA retention:** v1 keeps **one** on-disk current file per run (overwrite on each successful producer write). Historical productions remain only as prior `events.jsonl` lines (and any prior summary snapshots). No multi-SHA index that could auto-pick a matching older SHA for review.

**Write-failure disposition:** If atomic write fails after a suite run:

- Do **not** append a success-shaped `tester_evidence` event that claims the full record is stored.
- Elevate/update run write-health consistent with #633 (`write-health.json` / event-stream write-health pattern) with operator-visible signal.
- Acquisition later sees missing/stale prior file and applies `on_missing`.
- Human summary comment MUST NOT claim full structured record stored when write failed.

### Decision 4 — Single regeneration seam vs acquisition-only load

**Producer seam (sole writer):** `runTestGate` → after terminal outcome (pass, fail, timeout, tooling, dirty unavailable, disabled, not_run), when `runDir` (or recording surface) is available, call `produceTesterEvidence(...)` / `writeTesterEvidence(...)`.

Call sites that already run the gate (and therefore regenerate when HEAD moves):

- Implementing / planning post-implement path via `runFormatAndTestGates` → final `runTestGate`
- Fix stage via `runFormatAndTestGates` after candidate-changing fix commits
- Pre-merge `ci_mode: local` inline `runTestGate`
- Any other existing `runTestGate` caller with `runDir`

**Acquisition seam (sole reader for review):** `loadTesterEvidenceForReview({ runDir, candidateSha, cfg })` — pure load + validate + SHA match + map through `on_missing`. **Does not regenerate.** **Does not run tests.**

**Regeneration policy:**

- After every candidate-changing product commit, the advance loop’s existing re-entry into format+test / `runTestGate` **is** the regeneration path. No second orchestrator inside review.
- Pipeline-internal commits classified by `isPipelineInternalCommit` that do not change product HEAD semantics follow the same SHA-match rule: acquisition requires exact SHA match; internal docs commits that change HEAD still invalidate the file until producer re-runs (if the internal commit path does not re-run the gate, acquisition yields stale/missing and `on_missing` applies — do **not** invent a false pass-reuse story). Prefer re-running the producer when product tree may have changed; do not special-case “reuse pass across SHA.”
- If regeneration cannot run before review (write failure, gate skipped unexpectedly, operator path that jumps to review without gate): apply configured `tester_evidence.on_missing` — **do not invent passed evidence**.

### Decision 5 — `tester_evidence` config shape and fail-open / fail-closed

```yaml
tester_evidence:
  # Disposition when trustworthy SHA-matched evidence is missing, malformed, or stale
  # at review acquisition (not when a well-formed disabled/not_run artifact is current).
  on_missing: fail_closed   # fail_closed | fail_open  (default: fail_closed)
  max_output_chars: 4000    # per-excerpt cap (command, overall, reasons); default 4000
  max_artifact_chars: 48000 # aggregate serialized artifact budget after redaction; default 48000
  # extractors: []          # allowlisted extractor ids; default empty = no per-test rows
```

**Validation:** Zod on `PartialConfigSchema` with `.describe()` on every key (same pattern as `test_gate` / `review_ensemble`). Unknown keys fail strict config. Defaults merge in `resolveConfig` / DEFAULT_CONFIG. Template init comments via existing render path in `config.ts`.

**Semantics (both modes never imply pass):**

| Mode | When evidence is missing / malformed / stale | When evidence is current `disabled` / `not_run` |
| --- | --- | --- |
| `fail_closed` (default) | **Withhold review model invocation** for that code-review round; hard-block or re-route with operator-visible reason that suite evidence is non-current. Do not advance as if suite-backed. Exception: operator `--override` / existing human-unblock paths remain audited. | Treat as current explicit non-suite state; review **may** proceed with that status labeled (gate already decided suite not required). |
| `fail_open` | Review model **proceeds**; prompt includes explicit unavailable/stale/malformed section; still MUST NOT claim suite passed. | Same as fail_closed for current disabled/not_run. |

**Prompt injection when review runs:** Always render a labeled section (authoritative suite evidence or explicit non-current classification). Never silently omit the section.

### Decision 6 — Schema shape (illustrative; lands in `tester-evidence.ts`)

```ts
type TesterEvidence = {
  schema_version: 1;
  kind: "tester_evidence";
  candidate_sha: string;       // full 40-char
  run_id: string;
  issue: number;
  pr: number | null;
  worktree_id: string;         // basename / managed id only — never raw host home path
  config_digest: string;       // sha256 hex of canonical config serialization
  toolchain_fingerprint: {
    node?: string;             // process.version
    platform?: string;         // process.platform
    arch?: string;             // process.arch
    // allowlist ONLY — no env dump, no npm config secrets
  };
  started_at: string;
  ended_at: string;
  duration_ms: number;
  overall_status: TesterOverallStatus;
  overall_reason?: string;
  commands: TesterCommandResult[];
  tests?: TesterTestResult[];
  output_excerpt: string;
  producer: {
    component: "test-build-gate";
    engine_version?: string;
  };
  // absent in v1; readers ignore unknown fields — #692 forward-compat
  evidence_subject?: Record<string, unknown>;
};

type TesterTargetedCheck = {
  schema_version: 1;
  kind: "tester_targeted_check";
  candidate_sha: string;
  run_id: string;
  issue: number;
  identity: string;            // command label
  exit_code: number | null;
  duration_ms: number;
  status: "passed" | "failed" | "timeout" | "tooling_failure";
  output_excerpt: string;      // bounded + redacted
  recorded_at: string;
  /** Only engine-recorded deterministic runs may set machine success. */
  source: "deterministic_runner";
  producer: { component: string };
};
```

**Supplemental targeted-check contract:**

- **Trusted producer:** only a deterministic engine runner (same class as test-gate spawn helpers). Model prose “I ran npm test and it passed” is **untrusted supplemental prose** in the review transcript — not a `TesterTargetedCheck` success record.
- **Persistence:** `{runDir}/targeted-checks.jsonl` (append-only) and/or events of type `tester_targeted_check`. **Never** overwrites `tester-evidence.json`.
- **Accounting:** optional count / sum(duration_ms) as redundant-check diagnostics on scoreboard.
- **v1 minimum:** schema + pure helpers + prompt labels + non-overwrite invariant tests. Optional record API may ship without a full reviewer-CLI spawn path if no deterministic reviewer-check runner exists yet — but then no machine-recorded targeted success is claimed.

### Decision 7 — Config digest and identity allowlists

**`config_digest`:** sha256 hex of UTF-8 canonical JSON with **sorted keys**, fields exactly:

```json
{
  "command_identity": "<resolved label or null>",
  "test_gate.enabled": true,
  "test_gate.timeout": 300,
  "max_output_chars": 4000
}
```

No env vars, no secrets, no absolute paths. Digest input is the effective resolved values used for this run (not the raw YAML blob).

**`worktree_id`:** `path.basename(wtPath)` (managed worktree directory name under `worktree_root`), not the full absolute path.

**`toolchain_fingerprint` allowlist:** `node`, `platform`, `arch` only.

### Decision 8 — Extractors

- Optional allowlist `tester_evidence.extractors: string[]` (default `[]`).
- Interface: pure function `(output: string) => { ok: true; tests: TesterTestResult[] } | { ok: false; reason: string }`.
- Malformed / unknown extractor id: **no** fabricated test rows; command-level authority unchanged; optional diagnostic on `overall_reason` only if useful (does not flip `passed` → `failed`).
- v1 may ship with **zero** built-in extractors (empty allowlist) while keeping the seam and tests for malformed/absent behavior.

### Decision 9 — Review injection and #645 ensemble (concrete seam)

**Single assembly point:** Before any code-review model invoke, build the core prompt once, then append the Tester section once:

1. `buildReviewStandardPrompt` / `buildReviewAdversarialPrompt` / delta-review builder / plan-review builder
2. `appendTesterEvidenceSection(prompt, loadTesterEvidenceForReview(...))` — pure string append; labels authoritative vs supplemental
3. Pass that string as `options.prompt` into **`invokeReviewEnsemble`** (landed in `review-ensemble.ts`)

Ensemble (`promptFor`) already appends only an identity suffix. Therefore every ensemble agent receives **identical** Tester bytes without per-agent injection.

**Call sites that MUST use the same acquisition helper:**

| Path | File / seam |
| --- | --- |
| review-1 / review-2 | `stages/review-routing.ts` → `invokePromptHarnessReview` before `invokeReviewEnsemble` |
| pre-merge delta / SHA re-review | `stages/pre-merge-sha-gate.ts` before `invokeReviewEnsemble` |
| plan-review | `stages/planning.ts` before `invokeReviewEnsemble` (typically `not_run` / missing classification — still same helper) |

**Compatibility:** Ensemble is landed (#645). No alternate per-role injection. Stage-executor bypass for review-1/2 remains mutually exclusive with ensemble (`assertNoEnsembleStageExecutorBypass`); when stage_executors is used, the **same** pre-built prompt (including Tester section) is what the executor receives.

**Untrusted data:** Tester excerpts are untrusted content in the prompt (existing sanitize/redact before inject). Label clearly as engine-recorded suite evidence vs model claims.

### Decision 10 — Redaction and bounds

- All Tester strings through `redactSecrets` + `sanitize` (same chokepoint as `makeCommandRecord` / evidence-bundle).
- Per-field cap: `max_output_chars` (default 4000); mark truncation explicitly.
- Aggregate: if serialized artifact exceeds `max_artifact_chars`, further truncate excerpts until under budget or fail write as unavailable (prefer truncate excerpts with marker over silent unbounded growth).
- No full env dump; no unbounded test log in comments or bundle.

### Decision 11 — Human summary vs full record

- Full JSON in `tester-evidence.json` + event signal.
- Optional human comment: status, short SHA, command count, duration only.
- Comment is not a substitute for the structured record.

### Decision 12 — Scoreboard

Read structured fields from `tester-evidence.json` and/or `tester_evidence` events: `duration_ms`, command count, `overall_status`, optional targeted-check count/cost. Runs without artifact remain scorable for non-Tester metrics; Tester metrics absent/missing — never inferred passed.

### Decision 13 — Forward compatibility with #692

Flat identity fields (`candidate_sha`, `run_id`, `issue`, `pr`, `config_digest`, engine fingerprint concepts). No `tester_subject_id`. Optional nested `evidence_subject` absent in v1.

## Approach (implementation pattern)

Follow the existing **deps-injected gate + pure classifier + atomic run-dir write** pattern established by `core/scripts/testgate.ts` (`TestGateDeps` with injectable `runTests` / `gitHead` / dirty seams; `stateDir`/`runDir` optional so unit tests have zero filesystem side effects) and `core/scripts/evidence-bundle.ts` (atomic `.tmp` + rename; `makeCommandRecord` redaction chokepoint; `OUTPUT_EXCERPT_CAP`).

1. Add pure module `core/scripts/tester-evidence.ts` (types, status derivation, SHA match, config digest, prompt section renderer, schema validate).
2. Extend `RunTestsResult` / producer mapping so timeout is first-class.
3. Call writer at end of `runTestGate` when `runDir` available.
4. Persist via run-store-compatible write + `appendEvent`; wire write-health on failure.
5. Config block + types defaults.
6. Single `loadTesterEvidenceForReview` + `appendTesterEvidenceSection` used by review-routing, pre-merge-sha-gate, planning plan-review **before** `invokeReviewEnsemble`.
7. Scoreboard pure extractors for Tester metrics.
8. Unit tests with injected fakes only; regenerate `plugin/`; `npm run ci`.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Extra suite re-runs after internal docs commits | Same SHA-match rule; producer only on `runTestGate`; no false pass reuse |
| Fail-closed blocks review when gate disabled | Current `disabled`/`not_run` artifacts are current, not missing |
| Ensemble prompt size | Bounded excerpts; summary section |
| Extractor sprawl | Empty allowlist default |
| Write failure silent | #633 write-health; no success event/comment claim |
| Treating Tester as second gate | Document observational; keep block/fix in existing gate routing |
| Format-gate HEAD movement | Final `runTestGate` after format convergence writes evidence for final HEAD |

## Migration Plan

1. Schema + pure helpers + tests.
2. Producer on `runTestGate` + persistence.
3. Review acquisition + fail_closed default; shared prompt append before ensemble.
4. Scoreboard additive fields.
5. No label migration.

Rollback: omit injection via config kill-switch only if needed; prefer keeping producer on for honesty.

## Test matrix (mapped to acceptance)

| Case | Proves |
| --- | --- |
| Pass → `overall_status: passed`, SHA pin | production schema |
| Non-zero exit → `failed` | status taxonomy |
| Timeout flag → `timeout` not collapsed to failed-only | precedence |
| toolingError → `tooling_failure` | precedence |
| enabled false → `disabled`, no command spawn | disabled |
| no command → `not_run` | not_run |
| dirty product tree → `unavailable` | trust failure |
| malformed extractor / no extractor | command authority preserved |
| multi-command partial (pure helper) | schema ready for partial |
| SHA match current / mismatch stale | acquisition |
| missing + fail_closed withholds invoke | fail-closed |
| missing + fail_open invokes with unavailable section | fail-open |
| malformed stored JSON | not treated as passed |
| post-fix new HEAD requires new write | regeneration |
| ensemble: N agents identical Tester core bytes | #645 shared prompt |
| redaction + per-field + aggregate bound | bounds |
| write failure → no success event; write-health elevated | #633 |
| targeted check cannot flip suite failed → passed | supplemental |
| scoreboard metrics from structured fields | no prose parse |
| plan-review / sha-gate / review-1 share helper | single acquisition |

## Open Questions (resolved)

1. **Default on_missing when gate disabled:** emit `disabled` artifact; treat as current explicit state (not missing). **Resolved.**
2. **Format-gate in Tester inventory:** out of v1 suite authority. **Resolved.**
3. **Plan-review:** same acquisition helper; usually not_run/missing classification. **Resolved.**
4. **fail_closed vs withhold invoke:** withhold model invoke on missing/stale/malformed under fail_closed; proceed under fail_open with explicit section. **Resolved.**
