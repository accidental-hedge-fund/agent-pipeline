# Roadmap

Single source of truth for the open backlog, now organized by **sem-ver release**. Last updated 2026-06-10.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value. **v1.0.0 shipped 2026-06-10** (tag `v1.0.0`, commit `450b537`) — the pipeline is external-ready; everything below is the post-1.0 line.

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

**v1.0.0 — external-ready (tagged 2026-06-10, commit `450b537`):**

| # | What | PR |
|---|------|-----|
| #56 | single-source the review verdict JSON schema (prompts ↔ `ReviewFinding`) + drift-guard test | #83 |
| #98 | pre-merge #16 gate must not re-review pipeline-internal commits (the autonomous-convergence fix) | #99 |
| #76 | `--status` resolves a PR by `closingIssuesReferences`/branch, not loose body-text (folds #97) | #96 |
| #91 | fold docs into the implementation step; remove the pre-merge docs stage (one CI cycle) | #100 |
| #93 | delete dead surface: ignored `harnesses` key, `auto_merge`, `openclaw` profile, companion runtime | #102 |
| — | repo `CLAUDE.md` — conventions contract for the self-dev pipeline | #101 |

## Release plan (sem-ver)

Post-1.0 the open backlog is **entirely additive or internal hardening — no breaking changes.** This was verified 2026-06-10 by a per-issue classification with an adversarial breaking-change check; the verifier agreed on all 14 issues. (**#106**, filed later the same day, was classified patch/additive on the same basis — internal hardening, no config or output-schema change.) Each new key (#40, #70, #23, #21) is optional and its **default reproduces current behavior**, so existing configs and runs are unchanged — that, not schema mechanics, is what keeps these MINOR rather than MAJOR. (Top-level config is `.strict()`, so an old config that omits the new key still validates; the new key is always added *optional*, never required. Note `models.*` is itself non-`.strict()` with required inner fields, so #70's `models.implementing` must land as an added **optional** field, not a new required one.) A 2.0 would instead require removing/renaming a key, changing a *deliberate* default, making a dead key live, or breaking the verdict output schema — nothing open does that. **Exception — placeholder/defect defaults:** fixing a default that was an un-finalized placeholder (never a deliberate contract) is a *patch*, not a 2.0, provided the prior behavior stays reachable via explicit config. The **1.0.1** convergence hotfix applies this — it flips `review_policy.block_threshold` `low`→`high` (and `min_confidence` `0`→`0.7`) because `low/0` was the #17 placeholder that made the policy block on *every* finding and never converge; `block_threshold: low` restores the old behavior verbatim.

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.0.1** | patch | Dev-loop convergence | #95, #75, #110, #106 | Self-heal fixes (#95/#75, shipped) + the loop-convergence hotfix (**#110**: severity-default fix, rubric, ratchet, bounded rounds → `needs-human`) + the spec-drift gate redesign (**#106**) that *consumes* #110's structured `category` field — co-shipped so the field is load-bearing in the same release, not speculative surface. All hand-built (they can't dogfood the loop they fix). |
| **v1.0.2** | patch | Dev-loop convergence (cont.) | #108 | Inject repo conventions into the `fix`/`test-fix` prompts. Sequences after #110 — shares the `fix.md` / `buildFixPrompt` path. |
| **v1.1.0** | minor | Review quality | #19, #25, #57, #84, #85 | New planning/review capability, no breaking change. #19↔#25 ship together; #84 builds on #57; #85 (patch) folds in as same-theme gate hardening. |
| **v1.2.0** | minor | Reviewer pluggability & per-step models | #39, #40, #70 | Adds opt-in keys (reviewer selection, `models.implementing`) that default to identical behavior. Order: #39 → #40 → #70. |
| **v1.3.0** | minor | Graduated autonomy & isolation | #23, #21 | Adds opt-in keys defaulting empty/off — the trust/isolation layer on a stable, configurable base. |
| *(none)* | — | Research trackers | #14, #27 | Decomposed research epics; they spawn child issues and ship no code themselves, so they map to no release. |

Per-issue sem-ver detail (✓ = dependency already merged in v1.0.0):

| # | Impact | Config | Theme | → Release | Depends on |
|---|--------|--------|-------|-----------|------------|
| #95 | patch | none | dev-loop convergence | v1.0.1 | — |
| #75 | patch | none | dev-loop convergence | v1.0.1 | #61 ✓ |
| #110 | patch | changed default (placeholder/defect) | dev-loop convergence | v1.0.1 | — |
| #106 | patch | none | dev-loop convergence | v1.0.1 | #110 (co-ship) |
| #108 | patch | none | dev-loop convergence | v1.0.2 | #110 |
| #19 | minor | none | review quality | v1.1.0 | #25 (co-ship) |
| #25 | minor | none | review quality | v1.1.0 | #19 (co-ship) |
| #57 | minor | none | review quality | v1.1.0 | #56 ✓ / #83 ✓ / #86 ✓ |
| #84 | minor | none | review quality | v1.1.0 | #57 |
| #85 | patch | none | review quality | v1.1.0 | #83 ✓ |
| #39 | minor | none | reviewer pluggability | v1.2.0 | — |
| #40 | minor | adds key | reviewer pluggability | v1.2.0 | #39 |
| #70 | minor | adds key | per-step models | v1.2.0 | #91 ✓ |
| #23 | minor | adds key | graduated autonomy | v1.3.0 | — |
| #21 | minor | adds key | execution isolation | v1.3.0 | #93 ✓ |
| #14 | none | — | research | *(none)* | — |
| #27 | none | — | research | *(none)* | — |

**How this maps to the prior value-tiers.** The earlier "Tier 0–3" ordering was value/decision-readiness ranked; this release plan is the same remaining work re-grouped by sem-ver theme and is now the execution spine. Notable moves to surface (not silently average): **#75** (was Tier 1) leads **v1.0.1** as a zero-config self-heal; **#70** (was Tier 1) joins the reviewer/model-config minor in **v1.2.0**; **#85** (was Tier 3, deferred on #83) folds into the **v1.1.0** review-quality bundle now that #83 has shipped; **#95** (previously untiered) joins #75 in the first patch. Within each release, issues stay value-ranked.

## Remaining work — detail (grouped by release)

### v1.0.1 — dev-loop convergence (patch)

- **#95** — pre-merge polling hangs when a PR is **CONFLICTING**: no `pull_request` CI runs ever start, so the gate polls to its timeout. Detect CONFLICTING + auto-rebase. *Real run-loop hang; zero config; no in-set deps.*
- **#75** — Zero-machinery `plugin/` mirror regen: repo-local conventions instruction + commit the mirror after editing `core/`; the #61 test gate stays the backstop. *No generator-detection/config in the generic core. Kills the recurring one-attempt fix-round waste.*
- **#110** — **Convergence hotfix.** review-2 never terminated — it looped to the iteration cap on nearly every non-doc change, proven across two repos/instances (agent-pipeline #106, contractiq #275). Three causes: the *drip* (reviewer surfaces one finding per round + full re-review every commit), the `low/0` *block-on-everything* default (#17's policy inert at its own default), and *no honest terminal*. Fix: default `block_threshold: high` / `min_confidence: 0.7` / `max_adversarial_rounds: 3`; a single-sourced severity rubric; enumerate-all + a re-review ratchet; bounded rounds → new `needs-human` terminal with a punch-list; full cross-round fixer history; an optional structured `category` field. *Hand-built (it can't dogfood the loop it fixes); `block_threshold: low` restores old behavior; sem-ver rule amended for the placeholder-defect default.*
- **#106** — OpenSpec spec deltas go **stale on a material review fix**: fix rounds edit code but aren't told (or verified) to revise the change's `specs/**`, so `maybeArchiveOpenspec` folds a stale delta into the living specs and re-review anchored on the stale delta can fight the now-correct code. Make the spec follow the code on the fix path + a verify-don't-prompt pre-merge consistency guard, keyed on #110's structured `category` field / a deterministic file-path signal — **not** prose inference (the original detector was an adversarially-unwinnable keyword matcher). *Co-ships with #110 so the `category` field has its consumer in-release. Minimal fix (a); the heavier `review → plan-revision` edge (b) defers to v1.1.0 if needed.*

### v1.0.2 — dev-loop convergence, continued (patch)

- **#108** — `fix` & `test-fix` prompts don't inject repo conventions, so editing fix rounds rely on best-effort host auto-load. Inject conventions into those prompts. *Sequence after #110 — shares the `fix.md` / `buildFixPrompt` path.*

### v1.1.0 — review quality (minor)

- **#19 + #25** — Closed-loop learning + research-grounded planning. **Rescoped:** human-curated lessons file via the existing `readConventions` injection (no pipeline-written store); strengthen the single planning prompt in-call (no fan-out calls). Mutual pair — build together.
- **#57 + #84** — Upgrade the review prompts (**both kept**): severity rubric, confidence calibration (aligned to #17's `min_confidence`), diff-scoping, **strip the deterministic asks** (`review_standard.md:20-21` — the test gate + CI already prove them), **differentiate round-1 vs round-2** to cut overlap, and **enumerate every instance per finding class** (#84) so a defect class converges in one round. *Builds on the single-sourced `{{schema_block}}` shipped in #83.*
- **#85** — Extend the verdict drift guard to value-type/nesting (lightweight type-token comparison only). *Unblocked now that #83 has shipped; same review-gate theme.*

### v1.2.0 — reviewer pluggability & per-step models (minor)

- **#39** — No-review-harness fallback: degrade to a clearly-labeled same-harness self-review when the reviewer CLI is unavailable (failure-triggered, at the invoke seam, **no new config key**).
- **#40** — Configurable review harness: generalize `invoke()` and add a real, honored reviewer-selection key. *Note: #93 deleted the old ignored `harnesses` key, so this **adds a fresh key** (purely additive), not a revival of a dead one.* Sequence after #39.
- **#70** — Per-step model config: add `models.implementing` only; drop `models.docs` (folds into impl under #91) and the identifier allowlist; warn when `models.*` is set on a codex step.

### v1.3.0 — graduated autonomy & isolation (minor)

- **#23** — Optional human approval checkpoints. **Rescoped:** labels+comments-only (SHA-bound checkpoint comment + `waiting` + re-invoke); one config key, default empty; no durable approval-record store.
- **#21** — Optional sandboxed execution. **Rescoped:** one opt-in key swapping to each harness's native sandbox mode (no container/E2B/Modal runtime). *Largest; last.*

### Trackers (no release)

- **#14, #27** — dark-factory research epics; children filed and individually dispositioned — keep as provenance.

## Decisions

- **#24** — The pipeline never extends past `ready-to-deploy` (no auto-merge / preview / canary / rollback). **Closed — still holds** (12 PRs left for human merge across the 2026-06-08/09 run, zero auto-merges).
- **Review steps stay on by default (2026-06-10).** Plan-review and both review rounds are not disabled or default-demoted. Per-repo `steps.*` toggles (#13) remain available for those who opt out; the default favors rigor.
- **#31 — SPIKE: convert to `/loop`. Closed: do not adopt.** Would replace a deterministic in-process loop with model-mediated re-invocations and fork the Claude-only `/loop` against the shared core; the cron/interval pattern was already rejected (`pipeline.ts:407-412`).
- **#18 — Multiple review critics + quorum. Closed: against direction.** N critics over the same diff amplify reviewer false-positive churn (the #17 problem) and build on dead config surface; the existing two-round review plus #57/#84 prompt work is the sanctioned path to depth.
- **#22 — Differentiated failure handling. Closed: already shipped** piecewise (test-gate fix loop, CI/conflict auto-rebase, auto-recover, openspec gate); the remaining label-taxonomy adds state with no routing payoff.
- **#74 — Test-fix trailer stamping. Closed: already resolved** on `main` (`test_fix.md:21-26` instructs; `testgate.ts:243-248` enforces; tests cover it).

## Notes

- The **review layer** runs `reviewMode: prompt-harness` (reviewer CLI invoked directly with a JSON-returning prompt; companion plugins optional) — standard + adversarial passes, both carrying real weight. #56 (shipped in 1.0) single-sourced the verdict schema; #57/#84/#85 harden the prompts and drift guard; #17 (merged) gives it an audited convergence escape hatch.
- The **mirror-staleness dogfooding** (#61) is active: every run's test gate runs `npm run ci` (includes `build.mjs --check`). #75 removes the remaining manual-regen friction.
- Within a release, issues are value-ranked; releases are ordered by dependency + theme cohesion (v1.0.1 first — lowest-risk, no deps, hardens the self-dev loop).
- Every open issue carries a `release:v*` label mirroring this plan (applied 2026-06-10); research trackers #14/#27 are intentionally unlabeled.
- Withdrawn 2026-06-10: the umbrella tracker and the review-default-off proposals (no longer in the backlog).
