# Roadmap

Single source of truth for the open backlog, now organized by **sem-ver release**. Last updated 2026-06-10.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value. **v1.0.0 shipped 2026-06-10** (tag `v1.0.0`, commit `450b537`) — the pipeline is external-ready. **v1.0.1 shipped 2026-06-10** (tag `v1.0.1`, commit `29a9bc3`) — dev-loop convergence. **v1.0.2 shipped 2026-06-11** (tag `v1.0.2`) — dev-loop convergence continued + first user-facing CLI niceties. **v1.0.3 shipped 2026-06-11** (tag `v1.0.3`) — contributor tooling (auto-regenerated `plugin/` mirror); see Shipped. Everything below v1.0.3 is the post-1.0.3 line.

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

**v1.0.3 — contributor tooling (shipped 2026-06-11, tag `v1.0.3`):**

| # | What | PR |
|---|------|-----|
| #124 | pre-commit hook auto-regenerates + stages the `plugin/` mirror after `core/` edits — kills the forgot-to-regen wasted round; `build.mjs --check` stays the enforcement | #126 |

**v1.0.2 — dev-loop convergence (cont.) + CLI niceties (shipped 2026-06-11, tag `v1.0.2`):**

| # | What | PR |
|---|------|-----|
| #108 | inject repo conventions into the `fix`/`test-fix` prompts (editing fix rounds no longer rely on best-effort host auto-load) | #121 |
| #115 | `--status` surfaces the needs-human punch-list (count + resume steps), not just the bare stage | #118 |
| #116 | warn when a `models.*` alias is set on a Codex-backed step (silently inert); nested `models` schema is now `.strict()` so typo'd keys fail loudly | #119 |
| #117 | CLI: add `--version` flag (print package version + exit); the install shim answers it before npm provisioning | #120 |

**v1.0.1 — dev-loop convergence (shipped 2026-06-10, tag `v1.0.1`):**

| # | What | PR |
|---|------|-----|
| #95 | pre-merge auto-rebase when a PR is CONFLICTING (no `pull_request` CI) | #105 |
| #75 | zero-machinery `plugin/` mirror regen after editing `core/` | #104 |
| #110 | convergence hotfix — severity-policy default fix, single-sourced rubric, enumerate-all + re-review ratchet, bounded rounds → `needs-human` terminal, fixer history, structured `category` field | #111 |
| #110 follow-up | default `block_threshold` → `medium`/`0.7`; mirror advisory findings to the PR (issue-only review comments slip the merge button) | #112 |
| #106 | OpenSpec spec-drift consistency guard — deterministic file-path (`specDeltaIsStale`) + structured `category: spec-divergence` marker, never prose (supersedes #109) | #113 |

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

Post-1.0 the open backlog is **entirely additive or internal hardening — no breaking changes.** This was verified 2026-06-10 by a per-issue classification with an adversarial breaking-change check; the verifier agreed on all 14 issues. (**#106**, filed later the same day, was classified patch/additive on the same basis — internal hardening, no config or output-schema change.) Each new key (#40, #70, #23, #21) is optional and its **default reproduces current behavior**, so existing configs and runs are unchanged — that, not schema mechanics, is what keeps these MINOR rather than MAJOR. (Top-level config is `.strict()`, so an old config that omits the new key still validates; the new key is always added *optional*, never required. Note `models.*` is itself non-`.strict()` with required inner fields, so #70's `models.implementing` must land as an added **optional** field, not a new required one.) A 2.0 would instead require removing/renaming a key, changing a *deliberate* default, making a dead key live, or breaking the verdict output schema — nothing open does that. **Exception — placeholder/defect defaults:** fixing a default that was an un-finalized placeholder (never a deliberate contract) is a *patch*, not a 2.0, provided the prior behavior stays reachable via explicit config. The **1.0.1** convergence hotfix applies this — it flips `review_policy.block_threshold` `low`→`medium` (and `min_confidence` `0`→`0.7`) because `low/0` was the #17 placeholder that made the policy block on *every* finding and never converge; `block_threshold: low` restores the old behavior verbatim.

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.0.1** ✅ shipped | patch | Dev-loop convergence | #95, #75, #110, #106 | Shipped 2026-06-10 (tag `v1.0.1`). See **Shipped** above for the per-PR detail. |
| **v1.0.2** ✅ shipped | patch | Dev-loop convergence (cont.) + CLI niceties | #108, #115, #116, #117 | Shipped 2026-06-11 (tag `v1.0.2`). See **Shipped** above for the per-PR detail. |
| **v1.0.3** ✅ shipped | patch | Dev-loop convergence (cont.) — contributor tooling | #124 | Shipped 2026-06-11 (tag `v1.0.3`). Pre-commit hook auto-regenerates + stages the `plugin/` mirror so contributors only edit `core/`. See **Shipped** above. |
| **v1.1.0** | minor | Review quality | #19, #25, #57, #85 | New planning/review capability, no breaking change. #19↔#25 ship together; #85 (patch) folds in as same-theme gate hardening. (#84 closed — its enumerate-every-instance ask shipped early in v1.0.1 via #110.) |
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
| #115 | patch | none | dev-loop convergence | v1.0.2 | — |
| #116 | patch | models keys → optional + `.strict()` | config visibility | v1.0.2 | — |
| #117 | patch | none | CLI niceties | v1.0.2 | — |
| #124 | patch | none (dev-tooling, not shipped) | dev-loop convergence | v1.0.3 | — |
| #19 | minor | none | review quality | v1.1.0 | #25 (co-ship) |
| #25 | minor | none | review quality | v1.1.0 | #19 (co-ship) |
| #57 | minor | none | review quality | v1.1.0 | #56 ✓ / #83 ✓ / #86 ✓ |
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

### v1.1.0 — review quality (minor)

- **#19 + #25** — Closed-loop learning + research-grounded planning. **Rescoped:** human-curated lessons file via the existing `readConventions` injection (no pipeline-written store); strengthen the single planning prompt in-call (no fan-out calls). Mutual pair — build together.
- **#57** — Upgrade the review prompts. ✅ *Already shipped via #110:* the severity rubric (`SEVERITY_RUBRIC` → `{{severity_rubric}}`) and **enumerate every instance per finding class** (which closed #84). **Remaining:** confidence calibration (aligned to #17's `min_confidence`), few-shot examples, diff-scoping/blast-radius, false-positive-cost framing, risk-first standard-prompt structure, **strip the deterministic asks** (`review_standard.md:20-21` — the test gate + CI already prove them), and **differentiate round-1 vs round-2** to cut overlap. *Builds on the single-sourced `{{schema_block}}` shipped in #83.*
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
- **#18 — Multiple review critics + quorum. Closed: against direction.** N critics over the same diff amplify reviewer false-positive churn (the #17 problem) and build on dead config surface; the existing two-round review plus #57 prompt work is the sanctioned path to depth.
- **#22 — Differentiated failure handling. Closed: already shipped** piecewise (test-gate fix loop, CI/conflict auto-rebase, auto-recover, openspec gate); the remaining label-taxonomy adds state with no routing payoff.
- **#74 — Test-fix trailer stamping. Closed: already resolved** on `main` (`test_fix.md:21-26` instructs; `testgate.ts:243-248` enforces; tests cover it).
- **#84 — Adversarial prompt enumerate-every-instance. Closed: superseded by #110 (shipped v1.0.1).** The instruction *"Enumerate EVERY material finding at or above the severity bar in this pass — do not hold secondary issues back for a later round"* is live in both review prompts (`review_adversarial.md:52`, `review_standard.md:29`) and the old "prefer one strong finding" bias was removed; the structured `category` field carries multi-location findings. The remaining review-prompt upgrades live in #57. *(Closed 2026-06-11 from a backlog-validity audit; adversarially verified.)*
- **Dedup the committed `core/`→`plugin/` mirror? Closed: no — keep it, automate the regen (→ #124, v1.0.3).** Verified the `/plugin marketplace add` install path *requires* a committed `plugin/` tree on the default branch (Claude Code copies plugins to a cache — no build-on-install, cannot reference files outside the plugin dir, skips out-of-tree symlinks). So the duplication is load-bearing, not waste. Symlink, generate-on-release, and drop-the-marketplace were all rejected (broken by the copy-only constraint / unverified ref-targeting / capability loss). The only real cost is the doubled diff + forgotten-regen rounds, which #124 removes by automating *authoring* (local pre-commit hook), keeping the mirror and the `build.mjs --check` gate intact.

## Notes

- The **review layer** runs `reviewMode: prompt-harness` (reviewer CLI invoked directly with a JSON-returning prompt; companion plugins optional) — standard + adversarial passes, both carrying real weight. #56 (shipped in 1.0) single-sourced the verdict schema; #57/#85 harden the prompts and drift guard; #17 (merged) gives it an audited convergence escape hatch.
- The **mirror-staleness dogfooding** (#61) is active: every run's test gate runs `npm run ci` (includes `build.mjs --check`). #75 removes the remaining manual-regen friction.
- Within a release, issues are value-ranked; releases are ordered by dependency + theme cohesion (v1.0.1 first — lowest-risk, no deps, hardens the self-dev loop).
- Every open issue carries a `release:v*` label mirroring this plan (applied 2026-06-10); research trackers #14/#27 are intentionally unlabeled.
- Withdrawn 2026-06-10: the umbrella tracker and the review-default-off proposals (no longer in the backlog).
