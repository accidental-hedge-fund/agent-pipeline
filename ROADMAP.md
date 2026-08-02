# Roadmap

Single source of truth for the **forward-looking** open backlog, organized by **sem-ver release**. Last updated 2026-08-01.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value. **Historical release notes** live in [CHANGELOG.md](CHANGELOG.md) (generated from git tags) — this file no longer accretes per-release "Shipped" prose.

**Self-dev is proven.** On 2026-06-08/09 the pipeline shipped **12 issues developing itself** end-to-end (planning → review → fix → `ready-to-deploy`), including three systemic fixes it surfaced about its *own* behavior. The adversarial review layer caught real defects on every run.

**Direction (2026-06-10 simplification audit).** Plan-review and the two-phase (standard + adversarial) review stay **on by default**; rigor is the product. Speed/churn work is **rigor-preserving**. No umbrella/tracker meta-issues — issues are standalone and decision-complete.

## Forward Roadmap

The next line moves agent-pipeline from "AI writes code under review" toward an open-source **outer-loop harness** for agentic software delivery: plan quality, review memory, evidence, drift control, gates, and human-owned release. The open-source core should prove the operating model and emit durable evidence. Hosted dashboards, org policy management, long-lived audit history, enterprise integrations, and managed reliability are intentionally outside this repo's core boundary.


**Later (unscheduled) — Public adoption + category proof (draft, issues not yet filed; carried from the v1.17.0 draft when that slot became factory observability):**

| Theme | Candidate work |
|---|---|
| Category framing | Reframe README/docs around "outer-loop ownership" for agentic engineering: planning, review, evidence, drift, release accountability. |
| Drift Backstop mode | Add a mode that can evaluate any PR, not only pipeline-created PRs, for docs/config/generated-artifact/spec drift and missing evidence. |
| Evidence bundle contract | Stabilize a portable JSON schema plus PR/Markdown rendering for what was checked, which harness checked it, what changed, and what remains human-owned. |
| Policy packs | Ship repo-consumable policy/rubric packs for generated artifacts, docs drift, release readiness, visual evidence, and security-sensitive changes. |
| Factory Run demo | Publish a reproducible multi-issue demo showing scoreboard, run artifacts, caught defects, and the human merge boundary. |
| Event-sink boundary | Keep local events open-source while documenting the hosted-control-plane seam for searchable history, dashboards, audit, SSO/RBAC, and enterprise integrations. |

## Release plan (sem-ver)

Post-1.0 the open backlog is **entirely additive or internal hardening — no breaking changes.** This was verified 2026-06-10 by a per-issue classification with an adversarial breaking-change check; the verifier agreed on all 14 issues. (**#106**, filed later the same day, was classified patch/additive on the same basis — internal hardening, no config or output-schema change.) Each new key (#40, #70, #23, #21) is optional and its **default reproduces current behavior**, so existing configs and runs are unchanged — that, not schema mechanics, is what keeps these MINOR rather than MAJOR. (Top-level config is `.strict()`, so an old config that omits the new key still validates; the new key is always added *optional*, never required. Note `models.*` is itself non-`.strict()` with required inner fields, so #70's `models.implementing` must land as an added **optional** field, not a new required one.) A 2.0 would instead require removing/renaming a key, changing a *deliberate* default, making a dead key live, or breaking the verdict output schema — nothing open does that. **Exception — placeholder/defect defaults:** fixing a default that was an un-finalized placeholder (never a deliberate contract) is a *patch*, not a 2.0, provided the prior behavior stays reachable via explicit config. The **1.0.1** convergence hotfix applies this — it flips `review_policy.block_threshold` `low`→`medium` (and `min_confidence` `0`→`0.7`) because `low/0` was the #17 placeholder that made the policy block on *every* finding and never converge; `block_threshold: low` restores the old behavior verbatim.

| Release | Bump | Theme | Issues | Why this bump |
|---|---|---|---|---|
| **v1.0.1** ✅ shipped | patch | Dev-loop convergence | #95, #75, #110, #106 | Shipped 2026-06-10 (tag `v1.0.1`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.0.2** ✅ shipped | patch | Dev-loop convergence (cont.) + CLI niceties | #108, #115, #116, #117 | Shipped 2026-06-11 (tag `v1.0.2`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.0.3** ✅ shipped | patch | Dev-loop convergence (cont.) — contributor tooling | #124 | Shipped 2026-06-11 (tag `v1.0.3`). Pre-commit hook auto-regenerates + stages the `plugin/` mirror so contributors only edit `core/`. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.0.4** ✅ shipped | patch | Dev-loop convergence (cont.) — recovery robustness | #131, #133, #134, #135 | Shipped 2026-06-12 (tag `v1.0.4`). Deterministic recovery + a sharper hand-off moved into the skill (salvage, recurrence-aware park, recovery recipes, override auto-resume); all zero-authority. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.1.0** ✅ shipped | minor | Review quality | #19, #25, #57, #85 | Shipped 2026-06-13 (tag `v1.1.0`) — first minor. New planning/review capability, no breaking change. See [CHANGELOG.md](CHANGELOG.md). (#84 closed — its enumerate-every-instance ask shipped early in v1.0.1 via #110.) |
| **v1.1.1** ✅ shipped | patch | Capability/evidence hardening | #146, #147 | Shipped 2026-06-14 (tag `v1.1.1`). Deterministic `doctor` preflight + per-run evidence bundles; no change to shipped run behavior. (#143 folded into v1.1.0.) See [CHANGELOG.md](CHANGELOG.md). |
| **v1.2.0** ✅ shipped | minor | Reviewer pluggability & per-step models | #39, #40, #70, #144 | Shipped 2026-06-15 (tag `v1.2.0`) — second minor. Opt-in keys (reviewer selection, `models.implementing`) defaulting to identical behavior + override-durability hardening. See [CHANGELOG.md](CHANGELOG.md). (Tooling: config dogfooding PR #167, release automation PR #169.) |
| **v1.2.1** ✅ shipped | patch | Pipeline-run reliability (pipeline-desk) | #173, #174, #175 | Shipped 2026-06-16 (tag `v1.2.1`). Reliability fixes from running `/pipeline` against a real downstream repo: shell-backed configured gate commands + pipefail, worktree dependency-install with issue-number capacity reclaim, resumable `implementing` stage. (#176 closed as already-fixed on `main`.) See [CHANGELOG.md](CHANGELOG.md). |
| **v1.2.2** ✅ shipped | patch | Pipeline-run reliability cont. (pipeline-desk) | #180, #181, #183 | Shipped 2026-06-16 (tag `v1.2.2`). Second reliability patch: failing pre-merge CI → `needs-human` (no archive/poll loop), worktree harness never stages a `node_modules` symlink, and concurrent `git worktree add` serialized against `.git/config`. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.3.0** ✅ shipped | minor | Isolation & harness output quality | #21, #182 | Shipped 2026-06-16 (tag `v1.3.0`). Opt-in `harness_sandbox` (sandboxed implementer execution) + `format_gate` (format/lint normalization run before the test gate to a bounded fixed point). Both default off/empty → no behavior change. #23 + #149 re-scoped to v1.4.0 (see below). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.4.0** ✅ shipped | minor | Private eval / shipcheck gate | #148 | Shipped 2026-06-16 (tag `v1.4.0`). Opt-in reviewer-owned `shipcheck` acceptance-rubric gate before `ready-to-deploy` (default off; wired into pre-merge + eval exit paths; realpath-confined rubric; rejects malformed/timed-out verdicts). #23 + #149 carried to v1.5.0. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.5.0** ✅ shipped | minor | Pipeline Desk desktop contracts | #153, #154, #155, #156, #161 | Shipped 2026-06-16 (tag `v1.5.0`) — fifth minor. Machine-facing launch/discovery, JSON status/preflight, stable run directory + JSON events + non-hanging log-follow, config schema/validate, and run-artifact conventions so Pipeline Desk can supervise runs without scraping terminal prose. Human `/pipeline` / `$pipeline` flows unchanged. See [CHANGELOG.md](CHANGELOG.md). (#23 + #149 carried to v1.6.0.) |
| **v1.6.0** ✅ shipped | minor | Intake & backlog automation | #158, #170, #171, #168 | Shipped 2026-06-17 (tag `v1.6.0`) — sixth minor. Front-door intake (#158), release-PR automation (#170), backlog-roadmap engine (#171), and the sweep re-spec/rebase command (#168). See [CHANGELOG.md](CHANGELOG.md). (#23 + #149 carried to v1.7.0.) |
| **v1.6.1** *(folded into v1.7.0)* | patch | Version-staleness detection | #186 | **#186 shipped within v1.7.0** (merged via #224 before the `v1.7.0` tag) — no separate `v1.6.1` tag was cut. Added the `doctor` stale-install / version-coherence check + a `launcher-smoke` assertion that `--version` equals the installed `core/package.json`. |
| **v1.7.0** ✅ shipped | minor | Control plane & release_model | #214, #216, #217 | Shipped 2026-06-19 (tag `v1.7.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.8.0** ✅ shipped | minor | Faster intake/sweep + fail-fast timeouts | #220, #248 | Shipped 2026-06-19 (tag `v1.8.0`) — eighth minor. Intake/sweep spec-generation pinned to a fast model (`models.intake`/`models.sweep`, default `sonnet`) + a lean tool-free harness (`--tools ""`/`--strict-mcp-config`; no MCP, no repo exploration) → ~15× faster intake (#220/#247); plus configurable `intake_timeout`/`sweep_timeout` (#248/#250). Additive keys; defaults preserve behavior. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.9.0** ✅ shipped | minor | Observability & reliability hardening | #256, #257, #258, #259, #260, #261, #262, #264, #265, #266 (+ #253, #254, #255) | Shipped 2026-06-21 (tag `v1.9.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.10.0** ✅ shipped | minor | CLI dispatch v2 (command registry + conventions) | #263, #273 | Shipped 2026-06-28 (tag `v1.10.0`). Factory scoreboard + stage-level cost accounting; command registry + lifecycle/CLI-parsing split (#263), queue and budget mode (#305). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.11.0** ✅ shipped | minor | CLI dispatch v2 cont. + queue/budget | #305 | Shipped 2026-06-28 (tag `v1.11.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.12.0** ✅ shipped | minor | Namespaced command surface + OpenSpec CLI guard | #273, #308 | Shipped 2026-06-29 (tag `v1.12.0`). Move /pipeline off -- conventions (namespaced command surface); pre-merge silently skips OpenSpec archive when openspec CLI unavailable. See [CHANGELOG.md](CHANGELOG.md). |
| **v1.12.1** ✅ shipped | patch | ci_mode local + OpenSpec config path + Codex no-sandbox | #350, #352, #355 | Shipped 2026-06-30 (tag `v1.12.1`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.12.2** ✅ shipped | patch | OpenSpec spec-divergence + injectable-dep rule in prompts | #356, #360 | Shipped 2026-07-01 (tag `v1.12.2`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.12.3** ✅ shipped | patch | Fix harness commit step lock-file side-effects | #358 | Shipped 2026-07-01 (tag `v1.12.3`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.12.4** ✅ shipped | patch | Pre-merge fix round: auto-apply bounded fix for correctness findings | #359 | Shipped 2026-07-02 (tag `v1.12.4`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.13.0** ✅ shipped | minor | Fix-stage recovery + logging portability + repo-map CLI | #349, #343, #367 | Shipped 2026-07-04 (tag `v1.13.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.14.0** ✅ shipped | minor | Convergence & evidence: post-fix re-review correctness, eval-gate fix routing, durable evidence, crash recovery | #373, #371, #377, #372, #382 | Shipped 2026-07-07 (tag `v1.14.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.14.1** ✅ shipped | patch | Gate/CLI reliability: test-gate capture resilience + wrapper --profile fix | #384, #383 | Shipped 2026-07-07 (tag `v1.14.1`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.15.0** ✅ shipped | minor | Factory reliability: fix-round convergence, wedge-proof timeouts, de-flaked gates, single-operator human-input gate | #391, #398, #403, #390, #393, #387 | Shipped 2026-07-08 (tag `v1.15.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.15.1** ✅ shipped | patch | Foundation reliability + release hygiene | #401, #402, #413, #423 | Shipped 2026-07-20 (tag `v1.15.1`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.15.2** ✅ shipped | patch | Reviewer model/effort passthrough for codex + gitignored-artifact commit guard | #441, #445 | Shipped 2026-07-21 (tag `v1.15.2`). See [CHANGELOG.md](CHANGELOG.md). |
| **deferred** | minor | Graduated autonomy (forge-resistance) | #23 | Carried-forward **#23** (graduated-autonomy approval checkpoints — still parked on the checkpoint-comment forge-resistance security property, PR #194 open). #149 (bounded auto-loop) already shipped in v1.7.0. |
| **v1.16.0** ✅ shipped | minor | Papercut capture: agent-logged friction events + CLI | #419 | Shipped 2026-07-21 (tag `v1.16.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.16.0** | minor | Cluster recurring papercuts into backlog issues, with opt-in auto-file | #421 | `pipeline improve` gains a new `papercut` cluster category: it reads agent-reported friction events captured across runs, groups recurring ones into clusters, and surfaces them in the same dry-run report and `--apply` issue-creation path used by existing categories (flaky-gate, token-waste) — including the same open-issue dedup. Additive; existing flows unchanged. |
| **v1.17.0** ✅ shipped | minor | Add `--bucket day|week` time-series output to pipeline scoreboard | #425 | The `scoreboard` command gains an optional `--bucket day| Shipped 2026-07-21 (tag `v1.17.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.17.0** | minor | Add self-contained HTML export to pipeline scoreboard | #427 | The `scoreboard` command gains an HTML export mode that renders the same metrics scoreboard already computes — cost per ready PR, autonomy rate, fix rounds, needs-human rate, stage durations, and test/eval/shipcheck pass rates — into a single static HTML file. Additive; existing flows unchanged. |
| **v1.17.0** | minor | Capture actual per-call cost from harness output, not just estimates | #429 | Stage accounting captures the real cost of each harness call from that harness's own output/telemetry whenever the harness exposes it, rather than relying solely on operator-supplied `--estimate-cost` fallbacks. Additive; existing flows unchanged. |
| **v1.17.0** | minor | Scoreboard grouping by harness, model, effort, and executor | #437 | The `scoreboard` command gains an opt-in grouping flag that splits each stage's existing metrics — durations, fix rounds, review rounds and verdict outcomes, gate pass rates, needs-human rate, tokens, and cost — by who or what performed the work: harness, model, effort, or executor. Additive; existing flows unchanged. |
| **v1.18.0** ✅ shipped | minor | Controlled multi-harness evaluation foundation: Grok Build/Pi/OpenCode adapters + manifest-driven stage eval runner | #431, #432, #481 | Shipped 2026-07-21 (tag `v1.18.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.19.0** ✅ shipped | minor | Objective grading + API comparison: eval graders with statistical reporting + OpenRouter executor experiment controls | #433, #434 | Shipped 2026-07-21 (tag `v1.19.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.20.0** ✅ shipped | minor | Risk-triggered design-interrogation gate + large-prompt harness delivery | #436, #492 | Shipped 2026-07-21 (tag `v1.20.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.21.0** ✅ shipped | minor | Durable goal orchestration behind pipeline:loop | #451 | Shipped 2026-07-21 (tag `v1.21.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.22.0** ✅ shipped | minor | Factory robustness: fix-stage recovery, gate/installer/worktree hardening, structured fix outcomes | #486, #484, #485, #450, #443, #472, #473, #506 | Shipped 2026-07-22 (tag `v1.22.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.23.0** ✅ shipped | minor | Review-quality context: bounded delta rounds, immutable resolved-finding evidence, PR-visible visual artifacts | #483, #496, #463 | Shipped 2026-07-23 (tag `v1.23.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.24.0** ✅ shipped | minor | Factory hygiene: release-discovery tolerance + cross-host auto-file serialization | #498, #459 | Shipped 2026-07-23 (tag `v1.24.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.25.0** ✅ shipped | minor | Correction intelligence: structured correction ledger, correction compiler, closed-loop attribution + salvage/intake/init hardening | #521, #522, #504, #539, #499, #500, #501 | Shipped 2026-07-23 (tag `v1.25.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.26.0** ✅ shipped | minor | Integrated Durable Orchestration: in-repo pipeline:loop supervisor + conflict-aware parallel execution | #509, #510, #511, #512, #513, #538, #514, #515, #529, #530, #531, #528 | Shipped 2026-07-24 (tag `v1.26.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.27.0** ✅ shipped | minor | Trace-Driven Eval Engineering: human-approved trace-to-fixture authoring + bounded eval-diagnosis trajectory artifacts | #535, #536 | Shipped 2026-07-24 (tag `v1.27.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.28.0** ✅ shipped | minor | Factory-hardening & customer-hosted foundations: supervisor run-fatal fixes, pre-merge integrity, install/salvage papercuts, and orchestration/telemetry/fault-reporting designs | #568, #570, #571, #579, #567, #547, #553, #505, #503, #502, #581 | Shipped 2026-07-25 (tag `v1.28.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.28.1** ✅ shipped | patch | Factory-hardening patch: loop needs-human hold + phantom `pipeline:blocked` run-fatal fix, evaluator isolation restoration, eval effort/verdict correctness, repo-configurable harness roles, and loop-surface papercuts | #616, #607, #608, #610, #614, #620, #621, #625, #606, #609 | Shipped 2026-07-28 (tag `v1.28.1`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.28.2** ✅ shipped | patch | Loop progress followability + factory papercuts: early handoff, durable logs follow, advance-run linkage, long-running skill packaging; worktree reclaim safety, open-PR pagination, nested node_modules verify, plan-revision Feedback Incorporated repair | #622, #623, #624, #658, #665, #666, #667, #668 | Shipped 2026-07-29 (tag `v1.28.2`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.28.3** ✅ shipped | patch | Loop progress + pre-merge recovery: stage progress, dual-follow, CI/delta auto-fix recovery, offramp metrics, event-follow terminal exit | #554, #611, #615, #679, #680, #681, #682, #683, #684, #699 | Shipped 2026-07-30 (tag `v1.28.3`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.28.4** ✅ shipped | patch | Pre-merge auto-fix noop re-verify: do not hard-block when autofix makes no commit and HEAD already satisfies findings | #698 | Shipped 2026-07-30 (tag `v1.28.4`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.29.0** ✅ shipped | minor | Docs/packaging truth, plan-review authority docs, human-gated merge-queue (dry-run + release-when-complete), evals ordered primary-reviewer pairs | #574, #627, #673, #676, #601 | Shipped 2026-07-30 (tag `v1.29.0`). See [CHANGELOG.md](CHANGELOG.md). |
| **v1.29.1** ✅ shipped | patch | v1.29.1 | #712, #714, #716, #718, #722, #723, #725, #730, #731, #742, #747 | Shipped 2026-07-31 (tag `v1.29.1`). See [CHANGELOG.md](CHANGELOG.md). |
| *(none)* | — | Unscheduled / no release | — | _Structural insertion anchor for `intake`/`sweep` — **do not remove**. Issues that map to no release lane (research, indefinitely-deferred) list here._ |

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
| #131 | patch | none | recovery robustness | v1.0.4 | — |
| #133 | patch | none | recovery robustness | v1.0.4 | — |
| #134 | patch | none | recovery robustness | v1.0.4 | — |
| #135 | patch | none | recovery robustness | v1.0.4 | — |
| #19 | minor | none | review quality | v1.1.0 | #25 (co-ship) |
| #25 | minor | none | review quality | v1.1.0 | #19 (co-ship) |
| #57 | minor | none | review quality | v1.1.0 | #56 ✓ / #83 ✓ / #86 ✓ |
| #85 | patch | none | review quality | v1.1.0 | #83 ✓ |
| #143 | patch | none | context truncation hardening | v1.1.1 | #19 ✓ |
| #146 | patch | none | capability preflight | v1.1.1 | — |
| #147 | patch | none | evidence bundle | v1.1.1 | — |
| #39 | minor | none | reviewer pluggability | v1.2.0 | — |
| #40 | minor | adds key | reviewer pluggability | v1.2.0 | #39 |
| #70 | minor | adds key | per-step models | v1.2.0 | #91 ✓ |
| #144 | patch | none | convergence robustness | v1.2.0 | — |
| #23 | minor | adds key | graduated autonomy | deferred | PR #194 |
| #263 | minor | none | CLI dispatch v2 (command registry) | v1.10.0 | #273 |
| #273 | minor | none | CLI dispatch v2 (conventions) | v1.10.0 | #263 |
| #21 | minor | adds key | execution isolation | v1.3.0 | #93 ✓ |
| #149 | minor | adds key | bounded auto-loop | ✅ v1.7.0 | #21 / #133 ✓ |
| #220 | minor | adds keys | faster intake/sweep (model pin + lean harness) | ✅ v1.8.0 | — |
| #248 | minor | adds keys | fail-fast intake/sweep timeouts | ✅ v1.8.0 | #220 |
| #148 | minor | adds key | private eval / shipcheck gate | v1.4.0 | #12 / #147 |
| #153 | minor | none | desktop launcher/discovery | v1.5.0 | — |
| #154 | minor | JSON output only | desktop status/preflight | v1.5.0 | #146 |
| #155 | minor | artifact/event format | desktop run events/logs | v1.5.0 | #147 |
| #156 | minor | schema output only | desktop config editor | v1.5.0 | — |
| #161 | patch | none | run-artifact conventions | v1.5.0 | #147 ✓ |
| #158 | minor | new sub-command | intake & roadmap sync | v1.6.0 | — |
| #170 | minor | new sub-command | release-PR automation | v1.6.0 | — |
| #171 | minor | adds `roadmap:` config + new mode | backlog-roadmap engine | v1.6.0 | #158 |
| #168 | minor | new sub-command | sweep re-spec / roadmap rebase | v1.6.0 | #158 / #171 |
| #186 | patch | none | version-staleness detection | v1.6.1 | — |
| #214 | minor | adds `roadmap.release_model` config | release_model / milestone grouping | ✅ v1.7.0 | #171 |
| #216 | minor | new sub-command | triage (stage labels) | ✅ v1.7.0 | — |
| #217 | minor | new sub-command | human-invoked PR merge | ✅ v1.7.0 | — |
| #419 | minor | new sub-command | intake | ✅ v1.16.0 | — |
| #421 | minor | adds `papercuts.auto_file` key | intake | ✅ v1.16.0 | #419 |
| #425 | minor | new sub-command | intake | ✅ v1.17.0 | — |
| #427 | minor | new sub-command | intake | ✅ v1.17.0 | — |
| #429 | minor | new sub-command | intake | ✅ v1.17.0 | — |
| #437 | minor | new sub-command | intake | ✅ v1.17.0 | — |
| _(anchor)_ | — | — | structural insertion anchor for `intake`/`sweep` (do not remove) | *(none)* | — |

**How this maps to the prior value-tiers.** The earlier "Tier 0–3" ordering was value/decision-readiness ranked; this release plan is the same remaining work re-grouped by sem-ver theme and is now the execution spine. Notable moves to surface (not silently average): **#75** (was Tier 1) leads **v1.0.1** as a zero-config self-heal; **#70** (was Tier 1) joins the reviewer/model-config minor in **v1.2.0**; **#85** (was Tier 3, deferred on #83) folds into the **v1.1.0** review-quality bundle now that #83 has shipped; **#95** (previously untiered) joins #75 in the first patch. Within each release, issues stay value-ranked.

## Remaining work — detail (grouped by release)

### Recovery-automation design line (retained from v1.0.4 — shipped)

> **Design line (from the 2026-06-12 recovery-direction analysis; governs future recovery work):** automate a recovery step *only* when it adds **zero new authority over what ships** — a human's prior decision (#135), a deterministic gate that re-certifies (#131), or a re-entry/diagnosis that never advances past review (#133/#134). The bright line is **authority, not intelligence**: the hand-off can get arbitrarily smart; the *decision* (override-vs-fix-vs-adopt, retry-harder) stays with a human. `needs-human` is a feature, not a deficiency.

### v1.1.0 — review quality (shipped 2026-06-13, tag `v1.1.0`)

As-built (see **Shipped** for PRs):

- **#19 + #25** — Closed-loop learning + research-grounded planning, shipped as the rescoped pair: human-curated lessons carried forward via the existing `readConventions` injection (no pipeline-written store), and an in-call strengthened planning prompt that mines repo patterns/prior plans and emits checkable acceptance criteria (no fan-out calls). #19's `readConventions` truncation was hardened over five adversarial review rounds into a **reserve-aware water-filling** allocation (every at-risk lessons/gotchas section fairly represented, bounded regardless of count); the deferred follow-up #143 was folded into that fix, and **#144** was filed for the residual override-key-durability weakness it exposed (→ v1.2.0).
- **#57** — Review prompts upgraded to world-class: confidence calibration (aligned to #17's `min_confidence`), few-shot examples, diff-scoping/blast-radius, false-positive-cost framing, risk-first standard-prompt structure, deterministic-ask removal, and round-1↔round-2 differentiation — on top of the rubric + enumerate-every-instance already shipped via #110.
- **#85** — Verdict drift guard extended to value-types/nesting (every union arm validated; `| null` fails closed, `| undefined` normalizes), not just field names.

### v1.1.1 — capability/evidence hardening (shipped 2026-06-14, tag `v1.1.1`)

SmallHarness-inspired hardening that makes runs cheaper to diagnose and less likely to waste harness time on setup defects. As-built (see **Shipped** for PRs):

- **#146** — `doctor` / preflight capability checks before expensive autonomous work: GitHub auth/repo access, harness availability, worktree cleanliness, OpenSpec availability, plugin mirror state, dependency state, and declared eval command availability. Standalone `--doctor` plus an opt-in run-start gate; deterministic, no model invocation. (Review caught a real spec-divergence where the config-enabled run-start path still ran `gh` before the preflight — fixed before ship.)
- **#147** — Per-run evidence bundle: compact machine-readable artifact recording issue/PR, branch, commit SHAs, stage transitions, harness identity, prompts/context inputs, commands, test/eval outcomes, review verdicts, overrides, recovery events, and final handoff state, plus a printable human-readable summary. An audit/debug artifact, not a second state machine.
- **#143** — folded into #19's reserve-aware water-filling truncation fix and shipped in v1.1.0; closed as done (not a separate v1.1.1 deliverable).

### v1.2.0 — reviewer pluggability & per-step models (shipped 2026-06-15, tag `v1.2.0`)

- **#39** — No-review-harness fallback: degrade to a clearly-labeled same-harness self-review when the reviewer CLI is unavailable (failure-triggered, at the invoke seam, **no new config key**).
- **#40** — Configurable review harness: generalize `invoke()` and add a real, honored reviewer-selection key. *Note: #93 deleted the old ignored `harnesses` key, so this **adds a fresh key** (purely additive), not a revival of a dead one.* Sequence after #39.
- **#70** — Per-step model config: add `models.implementing` only; drop `models.docs` (folds into impl under #91) and the identifier allowlist; warn when `models.*` is set on a codex step.
- **#144** — Override durability: keep a recorded `--override` applying when the reviewer rewords a finding's title (stable finding identity instead of raw-title hash). Convergence-robustness item surfaced by #19's 5-round truncation churn — defer-via-override couldn't converge because each reworded title minted a new key. Same non-convergence family as #133. *Recommended identity (from the 2026-06-14 evaluation; both upstreams converge on it):* `normalize(file) + line_bucket(line, ±3) + normalize(title)` — shift-tolerant, used by **both** `--override` matching and #133's RECURRING/NEW tagging (`compound-engineering/ce-code-review` + `tracker-defer.md`).
- **Config dogfooding (PR #167)** — refreshes the repo's own `.github/pipeline.yml` to the latest accepted schema, surfacing the v1.2.0/v1.1.1 keys (`review_harness` #40, `models.implementing` #70, `doctor.*` #146) at their verified defaults. Active settings unchanged; pure documentation/format refresh, validated through `resolveConfig` against the `.strict()` schema.
- **Release automation (PR #169)** — `.github/workflows/release.yml` publishes a GitHub Release on every `v*` tag push (notes from the annotated tag; version-vs-`package.json` guard; pre-release tags marked prerelease, not Latest). Closes the gap where Releases lagged tags, so `releases/latest` + the Releases list Pipeline Desk reads ([pipeline-desk #19](https://github.com/accidental-hedge-fund/pipeline-desk/issues/19)) stay current. The maintainer still owns the version bump, the merge, and the tag push (golden rule #4 intact). Larger pre-merge automation (a `pipeline release` sub-command) is tracked separately for a later release.

### v1.3.0 — graduated autonomy & isolation (minor)

- **#23** — Optional human approval checkpoints. **Rescoped:** labels+comments-only (SHA-bound checkpoint comment + `waiting` + re-invoke); one config key, default empty; no durable approval-record store.
- **#21** — Optional sandboxed execution. **Rescoped:** one opt-in key swapping to each harness's native sandbox mode (no container/E2B/Modal runtime), plus the SmallHarness-inspired deterministic write-boundary guard: snapshot allowed paths before/after harness invocation and block unexpected writes outside the target worktree/generated-artifact allowlist. *Largest; last.*
- **#149** — Bounded auto-loop mode: optional budgets for additional fix/review/test/eval continuations, respecting checkpoints, sandbox settings, override policy, and recurrence detection. When the budget is exhausted, park in `needs-human` with evidence instead of silently spinning. This borrows SmallHarness's auto-loop idea without adding merge/deploy authority.

### v1.4.0 — evidence gates & private evals (minor)

- **#148** — Private eval / shipcheck gate: optional reviewer-owned acceptance rubric before `ready-to-deploy`, separate from the implementing harness. It can inspect the issue, plan, acceptance criteria, changed files, test/eval summaries, OpenSpec deltas, and evidence bundle. Advisory-first; gate mode can block later when stable. This extends #12's repo-provided eval command gate with a private acceptance rubric and keeps the builder from grading itself.

### v1.5.0 — Pipeline Desk desktop contracts (minor)

Pipeline Desk is a separate lightweight desktop cockpit over `agent-pipeline`. The engine should stay skill-first and CLI-first; this release adds the machine-facing contracts the desktop app needs so it can launch, observe, validate, and recover runs without reimplementing the state machine.

> **Contract shapes sharpened against the 2026-06-14 evaluation of `everyinc/compound-engineering-plugin` + `garrytan/gstack`** (read-only review). Neither upstream is a state-machine engine; both confirm agent-pipeline's architecture is ahead. What they provide is a proven *contract vocabulary* — append-only `events.jsonl` (`gstack/lib/jsonl-store.ts`), a detached launcher with a completion sentinel (`gstack/bin/gstack-detach`), `doctor --json` always-valid-even-on-failure (`gstack/bin/gstack-gbrain-detect`), severity-tiered config validation (`gstack/bin/gstack-config`), and a single unfenced `status`-discriminant envelope (`compound-engineering/ce-code-review`). The sharpened acceptance criteria live on each issue. Explicitly **not** adopted: prose state machines, silent-default config, a multi-harness converter platform, or any event bus/IPC daemon (filesystem-only artifacts).

- **#153** — Host-neutral launcher and install discovery: stable desktop-safe subprocess entrypoint, version discovery, installed-host coverage (missing / Claude-only / Codex-only / both), and Claude-first profile selection while preserving `/pipeline` and `$pipeline`. Sharpened with a detached-run launcher (`gstack-detach` semantics: process-group escape, advisory lock, timeout watchdog, completion sentinel).
- **#154** — JSON status and preflight output: machine-readable issue/repo state plus deterministic `doctor --json`, composing with #146. Sharpened: one unfenced JSON object with a `status` discriminant, valid even when every check fails, a silent `--is-ok` exit gate, and a `schema_version` + backward-compat field promise.
- **#155** *(keystone — #154 status and `logs --follow` layer on it)* — Stable run directory, JSON events, and log-follow: `.agent-pipeline/runs/<run-id>/` with `run.json`, `events.jsonl` (append-only), `terminal.log` (always written, preserving PTY fallback), and `summary.json`. Sharpened: **builds on #147's evidence bundle** (reshape its monolithic per-issue `evidence.json` into an append-only event log; one artifact family, not two).
- **#156** — JSON Schema and validation command for `.github/pipeline.yml`. Sharpened: keep `.strict()` loudness; add severity-tiered validation that **rejects** typos in rigor/cost-gating keys (exit 1, value preserved) rather than coercing, with line-numbered diagnostics.
- **#161** — Run-artifact conventions underpinning the above: non-fatal observability I/O (a write failure never breaks the run it records), a write-time prompt-injection denylist on appended records, `schema_version` on every machine record, and a `_`-prefix local-only-field convention.

Compatibility rule: Pipeline Desk will support legacy PTY streaming until these contracts are available, but `agent-pipeline` should treat these contracts as the preferred M5+ integration path. `schema_version` enables graceful degradation: a desktop that finds no run dir / no `schema_version` falls back to PTY-streaming an older engine.

### v1.6.0 — intake & backlog automation (minor)

- **#158** — Front-door intake sub-command. A new no-issue-number `/pipeline` mode (alongside `--init` / `--cleanup` / `--version`) takes a short description, expands it into a decision-complete spec using the same contract as the `/pm` issue-spec agent (Summary / User story / Acceptance criteria / Out of scope / Open questions; WHAT-not-HOW), **creates the GitHub issue** with the right `pipeline:*` + `release:*` labels, and **proposes a `ROADMAP.md` update** — release-plan row, per-issue sem-ver row, and detail section — as a branch + PR for human review. The model-invoking spec step is the only non-deterministic part; issue creation and roadmap editing are deterministic given the spec. A dry-run prints the proposed issue + roadmap diff with no writes. Keeps the "pipeline never merges" contract: a human owns the roadmap-PR and release-slot decisions. **Open design forks** (in the issue): reuse `/pm` vs. embed an equivalent prompt; how the version is chosen / whether a new lane may be proposed; structured vs. anchor-based roadmap editing.

### v1.7.0 — control plane & release_model (minor)

- **#214** — The backlog-roadmap engine gains a `roadmap.release_model` setting (`semver` or `continuous`) that controls how its ranked plan is grouped into milestones, populating the roadmap's currently-empty `milestones[]` output and (idempotently) mirroring the grouping to GitHub milestones/labels — `plan.json` as the generated source of truth, GitHub as the engine-owned mirror.
- **#216** — `pipeline triage <issue> --stage ready|backlog`: a deterministic CLI command to move an issue between the pre-pipeline stage labels (single-sourced; pipeline-desk's stage dropdown calls it).
- **#217** — `pipeline merge <pr>`: a human-invoked, **loop-isolated** PR-merge command — the autonomous `advance` loop never merges (rule #4); pipeline-desk's merge button calls it.

### v1.8.0 — faster intake/sweep + fail-fast timeouts (minor)

- **#220 / #247** — Intake (and its batch sibling `sweep`) spec-generation pinned to a fast model via new `models.intake` / `models.sweep` aliases (default `sonnet`) and run through a lean tool-free harness mode (`--tools ""` + `--strict-mcp-config`: no built-in tools, no MCP servers, no repo exploration). Measured ~15× faster intake (4m11s → 17s on a representative prompt). Additive; defaults preserve behavior.
- **#248 / #250** — Configurable `intake_timeout` / `sweep_timeout` (default 600s) so a hung spec-generation harness fails fast instead of at the 20-min default.

### v1.9.0 — carried autonomy / forge-resistance (minor)

- **#23** — Graduated-autonomy approval checkpoints, carried forward from the v1.5.0–v1.8.0 lines. Parked on a checkpoint-comment forge-resistance security property (clearance must require a pipeline-authored SHA-bound comment, not arbitrary matching text); PR #194 open. (#149 bounded auto-loop already shipped in v1.7.0.)

### v1.16.0 — papercuts: agent-logged friction capture + batch fix loop (minor)

Open lane; issues filed via `intake` (bullets inserted below by intake runs). Theme: a first-class capture channel for the small non-blocking friction agents currently push through silently — retried flaky commands, misleading errors, undocumented setup steps, dead-end tool calls — recorded as run-artifact events (not a committed repo file: parallel worktrees make one conflict-prone, and the lessons convention forbids pipeline writes to the conventions file), plus the batch loop that clusters recurring friction into `pipeline:backlog` issues the factory then fixes itself. All additive and opt-in; defaults preserve current behavior.

- **#419** — Pipeline runs currently lose all record of small, non-blocking friction — a flaky command retried, a misleading error worked around, an undocumented setup step, a dead-end tool call — because none of it trips `blocker_set` or `human_intervention`.
- **#421** — `pipeline improve` gains a new `papercut` cluster category: it reads agent-reported friction events captured across runs, groups recurring ones into clusters, and surfaces them in the same dry-run report and `--apply` issue-creation path used by existing categories (flaky-gate, token-waste).

### v1.17.0 — factory observability: scoreboard exports & cost fidelity (minor)

- **#437** — The `scoreboard` command gains an opt-in grouping flag that splits each stage's existing metrics — durations, fix rounds, review rounds and verdict outcomes, gate pass rates, needs-human rate, tokens, and cost — by who or what performed the work: harness, model, effort, or executor.
- **#425** — The `scoreboard` command gains an optional `--bucket day|week` flag that, when set, adds a chronological series of per-period aggregates to the report — each period carrying the same metrics scoreboard already reports for the full window (cost per ready PR, autonomy rate, fix rounds, needs-human rate, stage durations, pass rates).
- **#427** — The `scoreboard` command gains an HTML export mode that renders the same metrics scoreboard already computes — cost per ready PR, autonomy rate, fix rounds, needs-human rate, stage durations, and test/eval/shipcheck pass rates — into a single static HTML file.
- **#429** — Stage accounting captures the real cost of each harness call from that harness's own output/telemetry whenever the harness exposes it, rather than relying solely on operator-supplied `--estimate-cost` fallbacks.
Open lane; issues filed via `intake` (bullets inserted below by intake runs). Theme: improve local maintainer inspection of generic Agent Pipeline run evidence through time-bucketed scoreboard series, offline HTML snapshots, and accurate harness-cost provenance. This lane is limited to local Agent Pipeline artifacts and generic factory telemetry. It excludes organization/customer data, delivery KPIs, ROI or billing systems, stakeholder/client reporting, hosted analytics, branding, and external transmission. All changes are additive and opt-in; defaults preserve current behavior.

### v1.18.0 — controlled multi-harness evaluation foundation (minor)

- **#431** — Generalize the existing Claude/Codex invocation seam into typed CLI harness adapters and add Grok Build, Pi, and OpenCode, preserving native OAuth/headless behavior while recording resolved harness/provider/model/effort provenance.
- **#432** — Add a manifest-driven evaluation runner that expands harness × provider × model × effort treatments, replays frozen stage fixtures or isolated end-to-end runs in fresh worktrees, randomizes execution order, and writes resumable result artifacts without mutating production GitHub state.

This lane establishes the controlled execution boundary. It deliberately does not claim that similarly named effort settings are equivalent across providers, and it treats the complete deployed CLI product — not only its nominal model — as the unit under test.

### v1.19.0 — objective grading + API comparison (minor)

- **#433** — Grade experiment runs with hidden deterministic checks, seeded review defects, acceptance rubrics, regression/scope checks, optional independent judging, paired per-fixture deltas, confidence intervals, and quality/resource Pareto reporting. Depends on #432's fixture and result contracts.
- **#434** — Extend OpenAI-compatible API executors for per-treatment model overrides, provider-aware reasoning parameters, structured output, request controls, and resolved OpenRouter/provider usage provenance. Depends on #429's cost semantics and integrates with #432's experiment identity.

This lane turns controlled runs into defensible comparisons and adds direct API treatments without conflating them with native OAuth CLI harnesses.

### v1.20.0 — reasoning assurance + design interrogation (minor)

- **#436** — Add a risk-triggered design-interrogation gate that records material implementation-time decisions, assumptions, invariants, rejected alternatives, evidence, and generalization boundaries; an independent reviewer challenges those choices before advancement, with bounded recurrence-aware resolution and the full chain preserved in the evidence bundle.

This lane closes the gap between one-shot plan review and diff-scoped implementation review. It is deliberately limited to configured high-risk surfaces—such as concurrency, storage, auth, migrations, infrastructure, public APIs, and large architectural changes—so deeper reasoning assurance does not become universal ceremony. It records explicit decision evidence, never hidden chain-of-thought, and adds no merge or release authority.

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
- Every open issue carries a `release:v*` label mirroring this plan (applied 2026-06-10).
- Withdrawn 2026-06-10: the umbrella tracker and the review-default-off proposals (no longer in the backlog).
