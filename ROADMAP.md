# Roadmap

Single source of truth for the execution order of the open backlog. Last updated 2026-06-10.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value.

**Self-dev is proven.** On 2026-06-08/09 the pipeline shipped **12 issues developing itself** end-to-end (planning → review → fix → `ready-to-deploy`), including three systemic fixes it surfaced about its *own* behavior. The adversarial review layer caught real defects on every run (no-regression violations, a sentinel-injection vector, the "prompt ≠ enforce" class twice).

**Direction (2026-06-10 simplification audit).** A full read-only audit mapped the default path and proposed a faster minimal pass. The maintainer accepted the audit's *factual findings* and the **do-not-simplify safety list**, but **rejected disabling or default-demoting any review step** — plan-review and the two-phase (standard + adversarial) review stay **on by default**; rigor is the product, latency is not bought by removing review coverage. Speed/churn work is therefore framed as **rigor-preserving**: better prompts, deterministic-ask removal, audited override policy, docs-fold, and dead-surface deletion. No umbrella/tracker meta-issues — issues are standalone and decision-complete.

## Shipped

**Foundation (earlier):** **#13** configurable steps · **#15** test/build gate + bounded fix loop · **#11** last30days carry-forward.

**2026-06-08/09 self-dev run (all merged):**

| # | What | PR |
|---|------|-----|
| #12 | eval gate step | #58 |
| #9 | installer installs/updates deps | #59 |
| #37 | last30days brief from full issue content | #60 |
| #16 | SHA-keyed review verdicts + re-review on HEAD move | #63 |
| #41 | OpenSpec context → all harness steps | #65 |
| #20 | commit traceability trailers | #66 |
| #26 | incorporate human plan comments into revision | #67 |
| #42 | README friendliness | #72 |
| #35 | explicit `init` command (labels + starter config) | #73 |
| #38 | OpenSpec baseline capability specs (reviewed agent pass) | #78 |

**Self-surfaced systemic fixes (filed and shipped mid-run):**

| # | What | PR |
|---|------|-----|
| #61 | dogfood the test gate (catch `plugin/` mirror staleness in-pipeline) | #62 |
| #64 | tighten SKILL.md monitor-filter guidance | #69 |
| #68 | harden harness-instruction steps (verify, don't just prompt) | #71 |
| #17 | review severity policy + audited overrides | #86 ✅ merged 2026-06-10 |

## Execution order (remaining)

### Tier 0 — in flight, finish first

1. **#56** — Single-source the review verdict JSON schema (prompts ↔ `ReviewFinding`) + drift-guard test. **Blocked at `fix-2`** on adversarial churn; now unblockable via the merged #17 policy — set `review_policy.block_threshold: high` in `.github/pipeline.yml` or run the audited `--override`. *Implemented by PR #83.*
2. **PR #83** — finalize and merge once #56 is unblocked. Carries the single-sourced `{{schema_block}}` constant the #57 prompt work builds on.

### Tier 1 — runnable now (decision-complete, no blocker)

3. **#76** — `--status` (and the shared `getPrForIssue`) resolve a PR by branch-prefix + `closingIssuesReferences`, not loose body-text match. *Bug; fixes all five call sites at once.*
4. **#91** — Fold docs into the implementation step; remove the pre-merge docs stage. *Docs become part of the **reviewed** diff and the happy path drops from two CI cycles to one. A rigor gain, not a cut.*
5. **#57 + #84** — Upgrade the review prompts (**both kept**): severity rubric, confidence calibration (aligned to #17's `min_confidence`), diff-scoping, **strip the deterministic asks** (`review_standard.md:20-21` — the test gate + CI already prove them), **differentiate round-1 vs round-2** to cut overlap, and **enumerate every instance per finding class** (#84) so a defect class converges in one round. *Sequence after PR #83 (shared schema block).*
6. **#93** — Delete dead surface: the accepted-but-ignored `harnesses` key, dead `auto_merge`, the near-duplicate `openclaw` profile, and decide the fate of the unreachable companion review runtime (keep `parseProseReview` — it serves prompt-harness codex output).
7. **#75** — Zero-machinery `plugin/` mirror regen: repo-local conventions instruction + commit the mirror after editing `core/`; #61 gate stays the backstop. *No generator-detection/config in the generic core.*
8. **#70** — Per-step model config: add `models.implementing` only; drop `models.docs` (folds into impl under #91) and the identifier allowlist; warn when `models.*` is set on a codex step.

### Tier 2 — reviewer pluggability (after #93's companion decision)

- **#39** No-review-harness fallback — degrade to a clearly-labeled same-harness self-review when the reviewer CLI is unavailable (failure-triggered, at the invoke seam, no new config key).
- **#40** Configurable review harness — generalize `invoke()` and make the reviewer selection key actually honored (turns the #93 dead key into real behavior).

### Tier 3 — compounding context / graduated autonomy (rescoped; need direction)

- **#19 + #25** — Closed-loop learning + research-grounded planning. **Rescoped:** human-curated lessons file via the existing `readConventions` injection (no pipeline-written store); strengthen the single planning prompt in-call (no fan-out calls). Build together.
- **#23** — Optional human approval checkpoints. **Rescoped:** labels+comments-only (SHA-bound checkpoint comment + `waiting` + re-invoke); no durable approval-record store.
- **#21** — Optional sandboxed execution. **Rescoped:** one opt-in key swapping to each harness's native sandbox mode (no container/E2B/Modal runtime). *Largest; last.*
- **#85** — Extend the verdict drift guard to value-type/nesting. **Deferred** until PR #83 lands; then a lightweight type-token comparison only.

### Trackers

- **#14, #27** — dark-factory research epics; children filed and individually dispositioned — keep as provenance.

## Decisions

- **#24** — The pipeline never extends past `ready-to-deploy` (no auto-merge / preview / canary / rollback). **Closed — still holds** (12 PRs left for human merge across the 2026-06-08/09 run, zero auto-merges).
- **Review steps stay on by default (2026-06-10).** Plan-review and both review rounds are not disabled or default-demoted. Per-repo `steps.*` toggles (#13) remain available for those who opt out; the default favors rigor.
- **#31 — SPIKE: convert to `/loop`. Closed: do not adopt.** Would replace a deterministic in-process loop with model-mediated re-invocations and fork the Claude-only `/loop` against the shared core; the cron/interval pattern was already rejected (`pipeline.ts:407-412`).
- **#18 — Multiple review critics + quorum. Closed: against direction.** N critics over the same diff amplify reviewer false-positive churn (the #17 problem) and build on dead config surface; the existing two-round review plus #57/#84 prompt work is the sanctioned path to depth.
- **#22 — Differentiated failure handling. Closed: already shipped** piecewise (test-gate fix loop, CI/conflict auto-rebase, auto-recover, openspec gate); the remaining label-taxonomy adds state with no routing payoff.
- **#74 — Test-fix trailer stamping. Closed: already resolved** on `main` (`test_fix.md:21-26` instructs; `testgate.ts:243-248` enforces; tests cover it).

## Notes

- The **review layer** runs `reviewMode: prompt-harness` (reviewer CLI invoked directly with a JSON-returning prompt; companion plugins optional) — standard + adversarial passes, both carrying real weight. #56/#57/#84 harden it; #17 (merged) gives it an audited convergence escape hatch.
- The **mirror-staleness dogfooding** (#61) is active: every run's test gate runs `npm run ci` (includes `build.mjs --check`). #75 removes the remaining manual-regen friction.
- Execution within a tier is value-ranked; tiers are ordered by decision-readiness.
- Withdrawn 2026-06-10: the umbrella tracker and the review-default-off proposals (no longer in the backlog).
