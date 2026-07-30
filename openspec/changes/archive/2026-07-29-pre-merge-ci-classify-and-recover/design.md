## Context

Today the pre-merge GitHub CI path (`advancePreMerge`, `ci_mode: "github"`) is escalate-only once checks are definitive and the one-shot rebase guard is exhausted (`pre_merge.ts` ~975–1005; living `pre-merge-ci-gate` requirements). #181 correctly stopped infinite archive/poll spin; #281 recovers **zero** check-runs on archive-only heads. There is **no** recovery for definitive **red** checks that look like infrastructure flakes or for archive-only heads whose first post-archive CI fails with non-product signatures.

Dogfood (#554 / PR #678): archive-only head failed with Node test-runner IPC deserialize (`Unable to deserialize cloned data due to invalid or unsupported version`) — infra/flake, not a product assertion — and the pipeline parked at needs-human with a thin block comment.

Constraints:

- Recovery budget MUST be durable across process restart and MUST NOT reintroduce #181 spin.
- Required CI is never waived.
- Merge-queue repair (#675) is out of scope.
- Review delta auto-fix (#359) is a separate path; this design may add an optional CI-assertion fix with its own durable marker.
- Unit tests inject I/O; no live network/git/subprocess.

## Goals / Non-Goals

**Goals:**

- Classify definitive CI failures into `infra` | `assertion` | `unknown` (issue table also says flake/product; map flake→infra, product→assertion in the public enum).
- Apply a finite, per-head-SHA recovery ladder before escalate.
- Prefer re-run / archive-aware recovery over hard block for infra and archive-only+prior-green cases.
- Emit high-quality block comments (URLs, SHAs, classification, log excerpt, recipe).
- Use a distinct `BlockerKind` for CI budget exhaustion so recipes and loop eligibility stay clear.

**Non-Goals:**

- Waiving required checks or shipping with red CI.
- Infinite re-archive / re-poll (#181 regression).
- Merge-queue / post-merge CI repair (#675).
- Changing `ci_mode: local` verification semantics.
- Building a general-purpose ML classifier; rules + log signatures are enough for v1.
- Multi-round free-form fix loops (at most one optional assertion fix when enabled).

## Decisions

### Decision 1: Public failure classes = `infra` | `assertion` | `unknown`

Normalize the issue’s dual naming:

| Class | Issue synonyms | Meaning |
|-------|----------------|---------|
| `infra` | flake | Runner/setup/IPC/OOM/cancelled/transient GH infrastructure |
| `assertion` | product | Real test/lint/type failures with assertion/compiler output |
| `unknown` | — | Cannot classify confidently |

**Rationale:** One stable enum for markers, comments, and tests. Mapping synonyms in docs avoids dual-code paths.

**Classification inputs (v1, deterministic rules):**

1. Check `bucket` / `state` (e.g. cancelled → lean `infra`).
2. Check `name` patterns when useful.
3. Optional short log excerpt (last meaningful error lines from failed job) matched against a small, maintainable signature list (e.g. `Unable to deserialize cloned data`, runner setup failures, OOM killer messages).
4. Assertion-like patterns: `AssertionError`, `expected … to`, TypeScript/ESLint exit with file:line diagnostics, test “fail” with assertion body.
5. Default: `unknown` when confidence is low (fail closed toward recovery only for `infra`; `unknown` may take the same single re-run budget as `infra` once, then escalate — see Decision 3).

**Alternatives considered:** LLM classification of logs — rejected for flakiness, cost, and non-determinism in a gate that must unit-test cleanly.

### Decision 2: Recovery ladder is ordered and per head SHA

On definitive red (`agg.failed.length > 0`), for the current PR head SHA:

1. **One-shot rebase** (existing): if `!rebaseAlreadyAttempted` and worktree available, try rebase+push; on success → `waiting` (“rebased; CI re-running”); on failure continue ladder. Marker remains worktree-local as today.
2. **Classify** failure set (aggregate: if any check is clearly `assertion`, treat overall as `assertion` when mixed; pure infra/cancel → `infra`; else `unknown`). Document mixed-set rule in code comments and tests.
3. **Infra / unknown re-run once:** if re-run not yet attempted for this head SHA, call injectable `rerunFailedChecks` (wraps `gh run rerun <id> --failed` or equivalent after resolving run id from check links / Actions API); mark durable re-run attempted; return `waiting`.
4. **Archive-only + prior green extension:** if head is archive-only vs `preArchiveSha`, prior SHA had successful checks, and classification is `infra` or `unknown`, and re-run already consumed (or re-run API unavailable), allow **one** close+reopen recovery for failed-run case (mirror #281 one-shot-per-SHA guard, separate marker key from zero-run). Prefer re-run first; close+reopen is fallback when re-run did not produce a new green cycle. Surface pre-archive green SHA in evidence.
5. **Optional assertion auto-fix (config-capped):** if `cfg.pre_merge_ci_assertion_fix` (name TBD) enables it and overall class is `assertion` and auto-fix not yet attempted for this head SHA: invoke a single surgical implementer fix pass (reuse existing fix harness seams where practical), push, mark attempted, return `waiting`. Default **off** or cap `0` so dogfood risk is opt-in until proven.
6. **Escalate:** `setBlocked(..., "ci-exhausted")` with rich reason; return `blocked`. Never return bare infinite `waiting`.

**Rationale:** Matches operator expectation (“converge, then escalate”) without reviving spin. Re-run is cheap and addresses the dogfood flake; assertion fix is optional because wrong auto-fix burns rounds.

**Alternatives considered:** Always auto-fix on any red — rejected (scope creep, #181-adjacent loops). Re-run forever with backoff — rejected (#181).

### Decision 3: `unknown` gets one re-run, not assertion fix

`unknown` shares the single re-run budget with `infra`. It does **not** get assertion auto-fix (avoid guessing product edits). After re-run still red → escalate with classification `unknown` in the comment.

### Decision 4: Durable markers live in the run store keyed by head SHA

Markers that MUST survive process restart:

- `ciRerunAttemptedForSha`
- `ciArchiveFailRecoveryAttemptedForSha` (close+reopen for red archive-only path, if used)
- `ciAssertionFixAttemptedForSha`

**Prefer run-store / polling context persistence** over `/tmp` or worktree-only files: pre-merge already uses `PreMergePollingContext` for `noRunRecoveryAttemptedForSha` and `preArchiveSha`. Extend that context **and** flush fields to the durable run directory so a new process resuming the same run reloads them.

Worktree-local markers alone fail when the process dies and a new advance starts without the same in-memory ctx. Rebase marker stays as today (worktree file) unless a follow-up unifies markers.

**Rationale:** Issue requires durable budget; run-scoped markers match “per head SHA for this pre-merge attempt.”

### Decision 5: Injectable seams for re-run and log excerpt

Add deps on `AdvancePreMergeDeps` (names illustrative):

- `rerunFailedWorkflows(cfg, prNumber, failedChecks) → { attempted: boolean; runIds?: string[] }`
- `fetchCheckLogExcerpt(cfg, check) → string | null` (bounded last N lines / chars)
- optional `runCiAssertionFix(...)` if assertion path implemented

Production wrappers live in `gh.ts` using confirmed `gh` shapes (verify with real `gh run …` / API before coding). Tests fake these seams.

### Decision 6: Blocker kind `ci-exhausted` + recipe

Add `ci-exhausted` to `BLOCKER_KINDS` and `BLOCKER_RECIPES`:

- Directs operator to inspect failing check URLs, fix product failures or re-run flakes manually if budget already used, push if code fix, remove `blocked`, re-run pipeline.
- Distinct from `test-gate-exhausted` (local test gate) and generic `needs-human` (review product judgment).

Update `blocked-recipes.test.ts` snapshots / exhaustive coverage (existing requirements already require map completeness).

Human-intervention mapping: prefer `test-build-failure` for `ci-exhausted` when bridging to intervention taxonomy (existing kind list already has `test-build-failure`).

### Decision 7: Modify existing “CI failure … blocks to needs-human” requirement via full MODIFIED + ADDED ladder

Do not leave the living requirement saying “always setBlocked needs-human on definitive red after rebase.” Replace with: after recovery budget exhausted, block with `ci-exhausted` and rich reason. Keep scenarios that prove no infinite wait.

Block-reason requirement expands: URLs, SHA(s), classification, excerpt, recipe (via kind).

### Decision 8: Scope of `gh` re-run

Use failed-run re-run (`gh run rerun <run-id> --failed` or Actions re-run failed jobs API), not “re-run all workflows on the PR,” to minimize Actions minutes and side effects. Resolve run id from check `link` when possible; if resolution fails, treat as re-run unavailable → fall through ladder (archive recovery or escalate) without spinning.

## Risks / Trade-offs

- **[Misclassification]** Assertion treated as infra → useless re-run then escalate (still correct terminal). Infra treated as assertion with fix enabled → wasted fix round. → Mitigation: conservative rules; default assertion fix off; prefer `unknown` + one re-run.
- **[Re-run API / permissions]** Token cannot re-run → fall through without loop. → Mitigation: attempt once, record failure, continue ladder.
- **[Close+reopen noise]** Timeline events on archive-only red. → Mitigation: only after re-run exhausted (or unavailable), only archive-only+prior green, one-shot per SHA.
- **[Durable marker gaps]** If markers only in memory, restart re-runs forever. → Mitigation: Decision 4 run-store persistence + tests simulating restart.
- **[Log fetch cost/size]** Huge logs. → Mitigation: hard cap on excerpt size; best-effort null on failure.
- **[Mixed failed checks]** Product + flake together. → Mitigation: mixed rule prefers `assertion` so we do not paper over real failures with re-run-only.

## Migration Plan

1. Land OpenSpec change (this planning step).
2. Implement classification + re-run path + markers + `ci-exhausted` recipe with unit tests; regenerate `plugin/`.
3. Default assertion auto-fix **disabled** unless dogfood shows need.
4. Roll forward: existing PRs mid-pre-merge get new behavior on next advance; no data migration.
5. Rollback: revert change; old escalate-only behavior returns. Markers are additive.

## Open Questions

- Exact config key names (`pre_merge_ci_assertion_fix`, `pre_merge_ci_rerun_enabled`) — finalize at implement; defaults must preserve safety.
- Whether `unknown` should skip close+reopen and only re-run (leaning: allow same archive-only path as `infra` once).
- Whether pre-archive green evidence requires a new run-store event type or can live in existing `recordCommand` / accounting events only.
