# Roadmap

Single source of truth for the execution order of the open backlog. Last updated 2026-06-09.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value.

**Self-dev is proven.** On 2026-06-08/09 the pipeline shipped **12 issues developing itself** end-to-end (planning → review → fix → `ready-to-deploy`), including three systemic fixes it surfaced about its *own* behavior. The adversarial review layer caught real defects on every run (no-regression violations, a sentinel-injection vector, the "prompt ≠ enforce" class twice). The order below is value-ranked within decision-readiness tiers.

## Shipped

**Foundation (earlier):** **#13** configurable steps · **#15** test/build gate + bounded fix loop · **#11** last30days carry-forward.

**2026-06-08/09 run (→ `ready-to-deploy`):**

| # | What | PR |
|---|------|-----|
| #12 | eval gate step | #58 ✅ merged |
| #9 | installer installs/updates deps | #59 ✅ merged |
| #37 | last30days brief from full issue content | #60 ✅ merged |
| #16 | SHA-keyed review verdicts + re-review on HEAD move | #63 ✅ merged |
| #41 | OpenSpec context → all harness steps | #65 |
| #20 | commit traceability trailers | #66 |
| #26 | incorporate human plan comments into revision | #67 |
| #42 | README friendliness | #72 |
| #35 | explicit `init` command (labels + starter config) | #73 |

**Self-surfaced systemic fixes (filed and shipped mid-run):**

| # | What | PR |
|---|------|-----|
| #61 | dogfood the test gate (catch `plugin/` mirror staleness in-pipeline) | #62 ✅ merged |
| #64 | tighten SKILL.md monitor-filter guidance | #69 |
| #68 | harden harness-instruction steps (verify, don't just prompt) | #71 |

## Execution order (remaining)

### Tier 1 — runnable now (decision-complete, no blocker)

1. **#56** — Single-source the review verdict JSON schema (prompts ↔ `ReviewFinding`) + a drift-guard test. *Prevents the findings-dropped → `needs-attention/0` → blocked-run class (#45/#50/#52/#54) from returning.*
2. **#74** — Stamp test-fix-loop commits with `Issue:`/`Pipeline-Run:` trailers. *Closes the one commit path #20's audit invariant misses (surfaced by #68).*
3. **#75** — Harness regenerates the `plugin/` mirror after editing `core/`. *Root-cause for the recurring first-attempt test-gate retry; the #61 follow-up.*
4. **#76** — `--status` resolves an issue's PR by closing-reference/branch, not loose body-text match. *Cosmetic but misleading.*
5. **#70** — Per-step model configuration. *Decision-complete (2026-06-09): adds `implementing` + `docs` slots → final list `planning`/`implementing`/`review`/`fix`/`docs`, with startup validation of model identifiers.*
6. **#57** — Upgrade `review_standard`/`review_adversarial` prompts to world-class (severity rubric, confidence calibration, few-shot, diff-scoping). *Quality is a taste call — confirm direction or accept the pipeline's take.*

### Special — decision-complete, NOT a standard `/pipeline` run

- **#38** — Back-populate OpenSpec baseline capability specs from existing code. *Resolved (2026-06-09): author the baseline **directly into `openspec/specs/`** via a **reviewed agent pass** (per-spec fidelity check against the code), not the change→archive flow. Execute as a dedicated branch → PR → fidelity review; **do not add `pipeline:ready`**.*

### Tier 3 — architecture / research (need direction first)

- **#40** Configurable review harness · **#39** No-review mode — *how far to make review pluggable.*
- **#17** Review severity policy + audited overrides → **#18** Multiple review critics + quorum aggregation. *(#17 before #18.)*
- **#22** — Differentiated failure handling / escalation taxonomy.
- **#23** — Optional human approval checkpoints (graduated autonomy).
- **#19 + #25** — Compounding context (closed-loop learning + research-grounded planning) — build together.
- **#21** — Optional sandboxed execution of harness runs *(largest; last)*.

### Trackers / spikes

- **#14, #27** — dark-factory research epics; children are filed — keep as trackers or close.
- **#31** — SPIKE: convert to `/loop`.
- Compounding-context design (storage; what feeds planning/review) → before **#19/#25**.

## Decisions

- **#24** — The pipeline never extends past `ready-to-deploy` (no auto-merge / preview / soak-obs / canary / rollback). **Closed — still holds**, proven across the 2026-06-08/09 run (12 PRs left for human merge, zero auto-merges).

## Notes

- The **mirror-staleness dogfooding** (#61) is active: every run's test gate runs `npm run ci` (which includes `build.mjs --check`). **#75** removes the remaining manual-regen friction so core-editing fix rounds pass first-try.
- The **review layer** runs `reviewMode: prompt-harness` (the reviewer CLI invoked directly with a JSON-returning prompt; companion plugins optional) — standard + adversarial passes, both carrying real weight. **#56/#57** harden it further.
- Execution within a tier is value-ranked; tiers are ordered by decision-readiness (run what needs no decision first).
