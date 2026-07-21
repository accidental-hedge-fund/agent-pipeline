# Roadmap

Single source of truth for the open backlog, now organized by **sem-ver release**. Last updated 2026-07-10.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value. **v1.0.0 shipped 2026-06-10** (tag `v1.0.0`, commit `450b537`) — the pipeline is external-ready. **v1.0.1 shipped 2026-06-10** (tag `v1.0.1`, commit `29a9bc3`) — dev-loop convergence. **v1.0.2 shipped 2026-06-11** (tag `v1.0.2`) — dev-loop convergence continued + first user-facing CLI niceties. **v1.0.3 shipped 2026-06-11** (tag `v1.0.3`) — contributor tooling (auto-regenerated `plugin/` mirror). **v1.0.4 shipped 2026-06-12** (tag `v1.0.4`) — recovery robustness: deterministic recovery + sharper hand-off moved into the skill; see Shipped. **v1.1.0 shipped 2026-06-13** (tag `v1.1.0`) — review quality (first minor): value-type drift guard, world-class review prompts, research-grounded planning, and closed-loop carry-forward lessons; see Shipped. **v1.1.1 shipped 2026-06-14** (tag `v1.1.1`) — capability/evidence hardening: deterministic `doctor` preflight and per-run evidence bundles; see Shipped. **v1.2.0 shipped 2026-06-15** (tag `v1.2.0`) — reviewer pluggability & per-step models: configurable review harness, self-review fallback, `models.implementing`, and override durability; see Shipped. **v1.2.1 shipped 2026-06-16** (tag `v1.2.1`) — pipeline-run reliability (first patch on the 1.2 line): shell-backed (`bash -c` + `pipefail`) configured gate commands, worktree dependency-install with issue-number capacity reclaim, and a resumable `implementing` stage; see Shipped. **v1.2.2 shipped 2026-06-16** (tag `v1.2.2`) — more pipeline-run reliability (second patch on the 1.2 line): persistently-failing pre-merge CI routes to `needs-human` instead of looping, the worktree harness never stages a `node_modules` symlink, and concurrent `git worktree add` is serialized against the shared `.git/config` lock; see Shipped. **v1.3.0 shipped 2026-06-16** (tag `v1.3.0`) — isolation & harness output quality (third minor): opt-in sandboxed harness execution (`harness_sandbox`) and a configurable format/lint normalization gate (`format_gate`) that runs format-before-test to a bounded fixed point; see Shipped. (Graduated-autonomy approval checkpoints #23 and bounded auto-loop #149 were re-scoped from this minor to **v1.4.0** — see Release plan.) **v1.4.0 shipped 2026-06-16** (tag `v1.4.0`) — private eval / shipcheck gate (fourth minor): an opt-in reviewer-owned acceptance-rubric gate (`shipcheck`) that runs before `ready-to-deploy`, advisory-first and default-off; see Shipped. **v1.5.0 shipped 2026-06-16** (tag `v1.5.0`) — Pipeline Desk desktop contracts (fifth minor): host-neutral launcher & install discovery (#153), machine-readable JSON status/preflight (#154), stable run directory + JSON events + non-hanging log-follow (#155), `.github/pipeline.yml` JSON-schema & validation command (#156), and run-artifact conventions — non-fatal I/O, write-time injection denylist, `schema_version`, local-only fields (#161) — so Pipeline Desk can supervise runs without scraping terminal prose; see Shipped. **v1.6.0 shipped 2026-06-17** (tag `v1.6.0`) — Intake & backlog automation (sixth minor): front-door intake (#158), release-PR automation (#170), the backlog-roadmap engine (#171), and the sweep re-spec/rebase command (#168); see Shipped. (#23 + #149 carried forward again, now to **v1.7.0** — the approval-gate forge-resistance security property still needs convergence.) **v1.7.0 shipped 2026-06-19** (tag `v1.7.0`) — Control plane & release_model; see Shipped. **v1.8.0 shipped 2026-06-19** (tag `v1.8.0`) — faster intake/sweep + fail-fast timeouts (eighth minor): intake/sweep spec-generation pinned to a fast model + a lean tool-free harness (no MCP, no repo exploration) → ~15× faster intake (#220/#247), plus configurable `intake_timeout`/`sweep_timeout` (#248/#250); see Shipped. **v1.9.0 shipped 2026-06-21** (tag `v1.9.0`) — Observability & reliability hardening; see Shipped. **v1.9.1 shipped 2026-06-24** (tag `v1.9.1`) — convergence & reliability fixes (first patch on the 1.9 line): planning no longer stalls on inherited `xhigh` reasoning (#278) and a mid-planning crash now resumes by restarting instead of waiting (#271); pre-merge/merge converge on repos with no branch-protection-required checks (#275) and when Actions never fires a run for the archive commit (#281); transient `gh` API failures retry instead of crashing the run (#270); worktrees are cleaned up after a successful merge (#296); plus a non-mutating spec-refinement contract for existing issues (#295), a faster roadmap engine for small backlogs (#292), and a `release.yml` annotated-tag guard (#289); see Shipped. Everything below v1.9.1 is the post-1.9.1 line. **v1.10.0 shipped 2026-06-28** (tag `v1.10.0`) — factory scoreboard + stage-level cost accounting; see Shipped. **v1.11.0 shipped 2026-06-28** (tag `v1.11.0`) — CLI dispatch v2: command registry + lifecycle/CLI-parsing split (#263), queue and budget mode (#305); see Shipped. **v1.12.0 shipped 2026-06-29** (tag `v1.12.0`) — move /pipeline off -- conventions (namespaced command surface, #273), pre-merge silently skips OpenSpec archive when openspec CLI unavailable (#308); see Shipped. **v1.12.1 shipped 2026-06-30** (tag `v1.12.1`) — ci_mode: local skip-GitHub-Actions gate (#350), OpenSpec config-commit path-scoped fix (#352), Codex no-sandbox env (#355); see Shipped. **v1.12.2 shipped 2026-07-01** (tag `v1.12.2`) — disambiguate OpenSpec spec-divergence so fix rounds keep progressing (#356); injectable-dep rule added to implementing and fix prompts (#360); see Shipped. **v1.12.3 shipped 2026-07-01** (tag `v1.12.3`) — Fix harness commit step lock-file side-effects; see Shipped. **v1.12.4 shipped 2026-07-02** (tag `v1.12.4`) — Pre-merge fix round: auto-apply bounded fix for correctness findings; see Shipped. **v1.13.0 shipped 2026-07-04** (tag `v1.13.0`) — Fix-stage recovery + logging portability + repo-map CLI; see Shipped. **v1.14.0 shipped 2026-07-07** (tag `v1.14.0`) — Convergence & evidence: post-fix re-review correctness, eval-gate fix routing, durable evidence, crash recovery; see Shipped. **v1.14.1 shipped 2026-07-07** (tag `v1.14.1`) — Gate/CLI reliability: test-gate capture resilience + wrapper --profile fix; see Shipped. **v1.15.0 shipped 2026-07-08** (tag `v1.15.0`) — Factory reliability: fix-round convergence, wedge-proof timeouts, de-flaked gates, single-operator human-input gate; see Shipped. **v1.15.1 shipped 2026-07-20** (tag `v1.15.1`) — Foundation reliability + release hygiene; see Shipped. **v1.15.2 shipped 2026-07-21** (tag `v1.15.2`) — Reviewer model/effort passthrough for codex + gitignored-artifact commit guard; see Shipped. Everything below v1.15.2 is the post-1.15.2 line.

**Self-dev is proven.** On 2026-06-08/09 the pipeline shipped **12 issues developing itself** end-to-end (planning → review → fix → `ready-to-deploy`), including three systemic fixes it surfaced about its *own* behavior. The adversarial review layer caught real defects on every run (no-regression violations, a sentinel-injection vector, the "prompt ≠ enforce" class twice).

**Direction (2026-06-10 simplification audit).** A full read-only audit mapped the default path and proposed a faster minimal pass. The maintainer accepted the audit's *factual findings* and the **do-not-simplify safety list**, but **rejected disabling or default-demoting any review step** — plan-review and the two-phase (standard + adversarial) review stay **on by default**; rigor is the product, latency is not bought by removing review coverage. Speed/churn work is therefore framed as **rigor-preserving**: better prompts, deterministic-ask removal, audited override policy, docs-fold, and dead-surface deletion. No umbrella/tracker meta-issues — issues are standalone and decision-complete.

## Forward Roadmap

The next line moves agent-pipeline from "AI writes code under review" toward an open-source **outer-loop harness** for agentic software delivery: plan quality, review memory, evidence, drift control, gates, and human-owned release. The open-source core should prove the operating model and emit durable evidence. Hosted dashboards, org policy management, long-lived audit history, enterprise integrations, and managed reliability are intentionally outside this repo's core boundary.

**v1.15.2 — Reviewer model/effort passthrough for codex + gitignored-artifact commit guard (shipped 2026-07-21, tag `v1.15.2`):**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Reviewer CLI model passthrough: honor a configured model (and effort) for the codex reviewer (#441) | #442 |
| | [Pipeline] Harness commit step silently drops gitignored artifacts — surface the exclusion loudly (#445) | #446 |

**v1.15.1 — Foundation reliability + release hygiene (patch):**

| # | What | Why |
|---|------|-----|
| #413 | Auto-tag workflow must not consume `RELEASE_TAG_TOKEN` at checkout | Release automation should fail only on release-tag pushes that actually need the secret, not on every main push. |
| #402 | Serialize or retry concurrent `git fetch origin main` ref-lock contention | Factory/queue usage must survive parallel runs without turning shared Git refs into blocked pipeline items. |
| #401 | Make sweep/intake spec generation capture the final spec, not tool-call narration | Backlog automation must be trustworthy before the repo can lean harder into public roadmap generation and issue shaping. |

**v1.16.0 — Outer-loop evidence + drift control (minor):**

| # | What | Why |
|---|------|-----|
| #365 | Archive legacy active OpenSpec changes left on `main` and add a default-branch drift check | This is the concrete Drift Backstop proof: stale implementation intent must not pollute current agent context. |
| #389 | Add cross-round review memory so later reviews do not contradict already-settled trade-offs | Review quality depends on durable reasoning context, not just another stateless adversarial pass. |
| #395 | Add a first-class visual-gate stage with reviewable artifact evidence | Buyer-visible evidence matters more than "the suite exited 0"; humans need screenshots/traces/diffs at release time. |
| #419 | Papercut capture: agent-logged friction events + CLI | Non-blocking friction agents push through today vanishes unrecorded; capturing it in run artifacts is the raw material for factory self-improvement. |
| #421 | Cluster recurring papercuts into backlog issues, with opt-in auto-file | The GitHub issue is this factory's only unit of work — recurring friction must become backlog issues the pipeline then fixes itself. |

**v1.17.0 — Factory observability: scoreboard exports + cost fidelity (minor):**

| # | What | Why |
|---|------|-----|
| #425 | Add day/week time-series output to the scoreboard | Trend data makes harness performance and reliability changes visible across release windows. |
| #427 | Add a self-contained HTML scoreboard export | Evaluation and factory evidence should be reviewable without the CLI or a hosted dashboard. |
| #429 | Capture actual per-call harness cost and its provenance | Comparative reports must distinguish actual, estimated, and unknown cost instead of treating missing telemetry as free. |

**v1.18.0 — Controlled multi-harness evaluation foundation (minor):**

| # | What | Why |
|---|------|-----|
| #431 | Add first-class Grok Build, Pi, and OpenCode CLI adapters alongside Claude and Codex | The deployed CLI harness, including its tool loop and OAuth route, is part of the treatment being measured. |
| #432 | Add a manifest-driven stage eval runner with frozen fixtures and isolated worktrees | Identical immutable inputs and isolated execution are required before harness/model/effort comparisons are credible. |

**v1.19.0 — Objective grading + API comparison (minor):**

| # | What | Why |
|---|------|-----|
| #433 | Add objective graders and comparative statistical reporting | Hidden checks, seeded defects, paired deltas, and confidence intervals turn run evidence into defensible decisions. |
| #434 | Extend API executors for OpenRouter controls and provider provenance | Direct API treatments need controlled reasoning parameters and resolved-provider evidence, and must remain distinct from OAuth CLI products. |

**Later (unscheduled) — Public adoption + category proof (draft, issues not yet filed; carried from the v1.17.0 draft when that slot became factory observability):**

| Theme | Candidate work |
|---|---|
| Category framing | Reframe README/docs around "outer-loop ownership" for agentic engineering: planning, review, evidence, drift, release accountability. |
| Drift Backstop mode | Add a mode that can evaluate any PR, not only pipeline-created PRs, for docs/config/generated-artifact/spec drift and missing evidence. |
| Evidence bundle contract | Stabilize a portable JSON schema plus PR/Markdown rendering for what was checked, which harness checked it, what changed, and what remains human-owned. |
| Policy packs | Ship repo-consumable policy/rubric packs for generated artifacts, docs drift, release readiness, visual evidence, and security-sensitive changes. |
| Factory Run demo | Publish a reproducible multi-issue demo showing scoreboard, run artifacts, caught defects, and the human merge boundary. |
| Event-sink boundary | Keep local events open-source while documenting the hosted-control-plane seam for searchable history, dashboards, audit, SSO/RBAC, and enterprise integrations. |

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

**v1.15.1 — Foundation reliability + release hygiene (shipped 2026-07-20, tag `v1.15.1`):**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Auto-tag releases when a release PR merges — eliminate the manual annotated-tag step (#411) | #412 |
| | [Pipeline] auto-tag-release workflow fails every main push when RELEASE_TAG_TOKEN is absent — secret consumed at checkout, before the release guard (#413) | #414 |
| | docs: organize forward roadmap by release | #415 |
| | [Pipeline] Sweep/intake spec generation captures tool-call narration instead of the final spec, failing section validation (#401) | #416 |
| | [Pipeline] Concurrent runs race on 'git fetch origin main' — ref-lock failure blocks a run at planning (#402) | #417 |
| | docs: scaffold v1.16.0 ROADMAP lane (papercuts) for intake | #418 |
| | intake: ROADMAP slots for #419 + #421 (papercuts, v1.16.0) | #420 |
| | docs: scaffold v1.17.0 ROADMAP lane (factory observability) for intake | #424 |
| | intake: ROADMAP slot for #425 — Add `--bucket day|week` time-series output to pipeline scoreboard | #426 |
| | intake: ROADMAP slot for #427 — Add self-contained HTML export to pipeline scoreboard | #428 |
| | intake: ROADMAP slot for #429 — Capture actual per-call cost from harness output, not just estimates | #430 |
| | docs: add evaluation and reasoning-assurance roadmap lanes | #435 |
| | intake: ROADMAP slot for #437 — Scoreboard grouping by harness, model, effort, and executor | #438 |
| | [Pipeline] [Pipeline] Intake/sweep spec prompt never says the harness is tool-free — spec model attempts repo exploration and burns the run on tool-call narration (residual of #401/#416) (#423) | #439 |

**v1.15.0 — Factory reliability: fix-round convergence, wedge-proof timeouts, de-flaked gates, single-operator human-input gate (shipped 2026-07-08, tag `v1.15.0`) — fifteenth minor:**

| # | What | PR |
|---|------|-----|
| | docs: add README lifecycle diagram | #335 |
| | [Pipeline] Detect stale installed engine: doctor check + documented update path when the install lags released fixes (#385) | #400 |
| | [Pipeline] fix stage dead-ends when all blocking findings are overridden or don't reproduce ('no new commits' block) (#391) | #404 |
| | [Pipeline] Review harness call can hang indefinitely past review_timeout — runCapped kill fires but the run never concludes (#398) | #405 |
| | [Pipeline] Flaky event-sink tests: stdin EPIPE races the close event, intermittently failing every test gate (#403) | #406 |
| | [Pipeline] Human-input gate counts the pipeline's own review comments as unacknowledged human input (#390) | #407 |
| | [Pipeline] Reviewer spawn crashes the entire run on NUL bytes in the prompt payload (ERR_INVALID_ARG_VALUE) (#393) | #408 |
| | [Pipeline] Fix/auto-fix rounds don't rebuild generated artifacts before committing (recurring dist-drift CI failures) (#387) | #409 |

**v1.14.1 — Gate/CLI reliability: test-gate capture resilience + wrapper --profile fix (shipped 2026-07-07, tag `v1.14.1`):**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Host wrapper injects --profile into core commands that reject it (refine-spec, scoreboard) (#383) | #394 |
| | [Pipeline] Test-gate output capture can die mid-stream (event-sink EPIPE), spuriously failing the gate with head-only truncated evidence (#384) | #397 |

**v1.14.0 — Convergence & evidence: post-fix re-review correctness, eval-gate fix routing, durable evidence, crash recovery (shipped 2026-07-07, tag `v1.14.0`) — fourteenth minor:**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Config: per-stage effort levels and model+effort config for review_harness (#366) | #375 |
| | [Pipeline] Per-stage executor delegation to external agent providers (#314) | #376 |
| | [Pipeline] Eval-gate output truncation cuts from the wrong end, dropping the diagnostic summary (#373) | #378 |
| | [Pipeline] Pre-merge auto-fix re-review evaluates the stale pre-fix diff, spuriously re-blocking after a correct auto-fix (#371) | #379 |
| | [Pipeline] Durable per-stage timing table + issue evidence history in PR comments (#377) | #380 |
| | [Pipeline] Eval-gate failure should route to a fix round with eval output as context (#372) | #381 |
| | [Pipeline] Crash-orphaned 'implementing' stage is unrecoverable by a fresh run (exits 0 with 'nothing to do') (#382) | #386 |

**v1.13.0 — Fix-stage recovery + logging portability + repo-map CLI (shipped 2026-07-04, tag `v1.13.0`):**

| # | What | PR |
|---|------|-----|
| #349 | [Pipeline] Fix stage: advance instead of blocking when fix was already applied externally (HEAD > review SHA) | #368 |
| #343 | [Pipeline] Logging portability | #369 |
| #367 | [Pipeline] pipeline config repo-map: CLI primitive to add/remove repo-map entries | #370 |

**v1.13.0 — Fix-stage recovery + logging portability + repo-map CLI (shipped 2026-07-04, tag `v1.13.0`) — thirteenth minor:**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Fix stage: advance instead of blocking when fix was already applied externally (HEAD > review SHA) (#349) | #368 |
| | [Pipeline] Logging portability (#343) | #369 |
| | [Pipeline] pipeline config repo-map: CLI primitive to add/remove repo-map entries (#367) | #370 |

**v1.12.4 — Pre-merge fix round: auto-apply bounded fix for correctness findings (shipped 2026-07-02, tag `v1.12.4`):**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Pre-merge fix round: auto-apply bounded fix for correctness findings before escalating to needs-human (#359) | #363 |

**v1.12.3 — Fix harness commit step lock-file side-effects (shipped 2026-07-01, tag `v1.12.3`):**

| # | What | PR |
|---|------|-----|
| | feat: add injectable-dep rule to implementing and fix prompts | #360 |
| | [Pipeline] Fix harness commit step should include npm lock-file side-effects (#358) | #361 |

**v1.12.2 — OpenSpec spec-divergence disambiguation + injectable-dep rule in prompts (shipped 2026-07-01, tag `v1.12.2`):**

| # | What | PR |
|---|------|-----|
| #356 | [Pipeline] Disambiguate OpenSpec spec-divergence so fix rounds keep progressing | #357 |
| #360 | Add injectable-dep rule to implementing and fix prompts; revert from CLAUDE.md | #360 |

**v1.12.1 — ci_mode local + OpenSpec config path + Codex no-sandbox (shipped 2026-06-30, tag `v1.12.1`):**

| # | What | PR |
|---|------|-----|
| #350 | [Pipeline] Add ci_mode: local option to skip GitHub Actions wait in pre-merge | #351 |
| #352 | [Pipeline] OpenSpec config left untracked causes dirty-worktree block before test gate | #354 |
| #355 | fix: allow Codex no-sandbox mode via env | #355 |

**v1.12.0 — Namespaced command surface + OpenSpec CLI guard (shipped 2026-06-29, tag `v1.12.0`):**

| # | What | PR |
|---|------|-----|
| #273 | [Pipeline] Move /pipeline off -- conventions (namespaced command surface) | — |
| #308 | [Pipeline] Pre-merge silently skips OpenSpec archive when openspec CLI unavailable | — |

**v1.11.0 — CLI dispatch v2 cont. + queue/budget (shipped 2026-06-28, tag `v1.11.0`):**

| # | What | PR |
|---|------|-----|
| #263 | Command registry + lifecycle/CLI-parsing split | #328 |
| #305 | Queue and budget mode | #330 |

**v1.10.0 — Factory scoreboard + stage-level cost accounting (shipped 2026-06-28, tag `v1.10.0`):**

| # | What | PR |
|---|------|-----|
| — | Factory scoreboard + stage-level cost accounting | — |

**v1.9.1 — Convergence & reliability fixes (shipped 2026-06-24, tag `v1.9.1`) — first patch on the 1.9 line:**

| # | What | PR |
|---|------|-----|
| | [Pipeline] Planning stalls ~20min: codex plan-review inherits global xhigh reasoning and rewrites the plan instead of returning a verdict (#278) | #291 |
| | [Pipeline] pre-merge gate polls to ci_timeout when GitHub Actions never fires a run for the archive commit (#281) | #290 |
| | [Pipeline] Roadmap engine is too slow for small backlogs (#292) | #293 |
| | chore(ci): add fast local gate + cancel superseded Actions runs | #294 |
| | [Pipeline] Expose non-mutating spec refinement contract for existing issues (#295) | #297 |
| | [Pipeline] A transient gh API failure (e.g. HTTP 401) crashes the whole pipeline run instead of retrying (#270) | #299 |
| | [Pipeline] Ability to clean up worktrees after successful merge (#296) | #298 |
| | [Pipeline] pipeline merge: hard-fails on repos with no branch-protection-required checks (#275) | #300 |
| | chore(openspec): archive merge-no-required-checks-fallback change | #307 |
| | [Pipeline] release.yml: annotated-tag guard + notes extraction fail under actions/checkout (#289) | #309 |
| | [Pipeline] Crash mid-planning strands the issue on the transient pipeline:planning label; resume waits instead of restarting (#271) | #310 |

**v1.9.0 — Observability & reliability hardening (shipped 2026-06-21, tag `v1.9.0`) — ninth minor:**

| # | What | PR |
|---|------|-----|
| | chore: gitignore .worktrees/ + .agent-pipeline/runs/ so pipeline runs don't dirty main | #267 |
| | [Pipeline] Align GitHub Actions CI with root npm run ci (#254) | #268 |
| | [Pipeline] Block pre-merge when OpenSpec archive commit fails (#255) | #269 |
| | [Pipeline] release.yml: published Release notes don't come from the annotated tag (--notes-from-tag yields the commit message / auto-notes) (#253) | #272 |
| | [Pipeline] Use shared gh wrapper for review follow-up issue/comment writes (#256) | #274 |
| | [Pipeline] Instrument GitHub call count and latency per pipeline run (#257) | #276 |
| | [Pipeline] Add fast worktree lookup and cache status snapshots (#258) | #277 |
| | [Pipeline] Make stage transitions and blocker writes idempotently auditable (#259) | #279 |
| | [Pipeline] Kill harness descendant processes on timeout (#260) | #280 |
| | [Pipeline] Prefer run-directory summary.json for pipeline summary mode (#261) | #282 |
| | [Pipeline] Treat last30days carry-forward context as untrusted prompt input (#262) | #283 |
| | [Pipeline] Migrate review comments to structured ReviewArtifact records (#264) | #285 |
| | [Pipeline] Unify freeform and OpenSpec planning flows behind shared phases (#265) | #286 |
| | [Pipeline] Add minimum benchmark and reliability regression suite for pipeline hotspots (#266) | #287 |

**v1.8.0 — Faster intake/sweep + fail-fast timeouts (shipped 2026-06-19, tag `v1.8.0`) — eighth minor:**

| # | What | PR |
|---|------|-----|
| #220 | intake/sweep: pin a fast model + lean tool-free harness call (~15× faster intake) | #247 |
| #248 | intake/sweep: configurable intake_timeout/sweep_timeout (fail-fast on a hung harness) | #250 |
| | chore: cover intake_timeout in test + document the new config keys in README | #251 |

**v1.7.0 — Control plane & release_model (shipped 2026-06-19, tag `v1.7.0`) — seventh minor:**

| # | What | PR |
|---|------|-----|
| | docs: schedule #186 as v1.6.1 (version-staleness detection) | #210 |
| | docs: drop closed research trackers #14/#27 from ROADMAP | #211 |
| | docs: restore intake/sweep *(none)* anchors + v1.7.0 detail section | #213 |
| | intake: ROADMAP slot for #214 — Roadmap `release_model` config: bundle issues into milestones | #215 |
| | docs: re-slot ROADMAP — v1.7.0 control plane & release_model; carried autonomy → v1.8.0 | #218 |
| | [Pipeline] Roadmap `release_model` config: bundle issues into milestones (#214) | #219 |
| | [Pipeline] `pipeline merge <pr>`: human-invoked PR-merge sub-command (loop-isolated; the autonomous loop never merges) (#217) | #221 |
| | [Pipeline] `pipeline triage <issue> --stage ready|backlog`: set an issue's pipeline stage label from the CLI (#216) | #222 |
| | [Pipeline] `pipeline --version` can report a stale version that lags `core/package.json` (running code != claimed version) (#186) | #224 |
| | [Pipeline] fix→review handoff: discover off-branch (detached) pipeline worktrees (#223) | #226 |
| | chore(config): tighten review_policy — block_threshold: high, min_confidence: 0.85 | #231 |
| | [Pipeline] Cache review verdict by diff-hash + delta-only pre-merge re-review to stop redundant non-deterministic re-reviews (#228) | #237 |
| | [Pipeline] Support area/category-scoped --override dispositions that survive re-review (finding keys drift) (#229) | #238 |
| | [Pipeline] Review convergence: calibrate severity (make LOW real) + add a non-blocking finding emission path (#236) | #239 |
| | [Pipeline] Review convergence: risk-proportional adversarial blocking (scale review-2 threshold by review-1 risk tier) (#232) | #240 |
| | [Pipeline] Review convergence: demote-and-advance at the adversarial round ceiling instead of hard-parking at needs-human (#233) | #241 |
| | [Pipeline] Review convergence: theme/surface-based recurrence guard (catch new-key-each-round whack-a-mole) (#234) | #242 |
| | [Pipeline] Review convergence: surgical fix rounds to prevent fix-introduced defects (#235) | #243 |
| | [Pipeline] bounded auto-loop mode: continue fix/review/test cycles within explicit budgets, then park with evidence (#149) | #244 |
| | [Pipeline] desktop contract: persist structured per-finding review records into the run directory (Review tab) (#209) | #245 |

**v1.6.0 — Intake & backlog automation (shipped 2026-06-17, tag `v1.6.0`) — sixth minor:**

| # | What | PR |
|---|------|-----|
| #170 | `pipeline release` sub-command: prepares a release PR (version bump in both `package.json` + `core/package-lock.json`, `plugin/` mirror regen, four-site ROADMAP scaffold, CI gate) and stops at the open PR. Rollback-safe — a clean-tree precondition (config-independent `--untracked-files=all`) makes any pre-branch abort restore the working tree losslessly; never tags/merges/publishes | #204 |
| #158 | front-door `intake` sub-command: expands a short description into a decision-complete issue (`/pm` contract) and proposes a matching ROADMAP update as a branch + PR. Orphan-safe — collision-resistant branch naming + a create-only (`--force-with-lease`) reservation over the same push transport, all before the irreversible issue creation; create-only label ensure | #205 |
| #171 | backlog-roadmap engine (`roadmap` mode): comprehends the repo, inventories the open backlog, builds a source-verified dependency graph, scores + dependency-orders, and emits a `plan.json` + living roadmap doc, with a mandatory adversarial-critique phase; gated + idempotent GitHub write-back | #206 |
| #168 | `sweep` sub-command: re-specs thin issues and rebases the roadmap (summary by default, `--apply` to write). Partial-failure-safe — `--apply` exits non-zero when roadmap delivery fails after issue rewrites, with step-aware recovery instructions | #207 |

Carried forward to **v1.7.0** (still deferred): **#23** graduated-autonomy approval checkpoints (recurrence-parked on a checkpoint-comment forge-resistance security property; PR #194 open) and **#149** bounded auto-loop (depends on #23).

**v1.5.0 — Pipeline Desk desktop contracts (shipped 2026-06-16, tag `v1.5.0`) — fifth minor:**

| # | What | PR |
|---|------|-----|
| #161 | run-artifact conventions: non-fatal artifact I/O, write-time injection denylist + field-level secret/role-marker redaction (`sanitizeDeep`, before `JSON.stringify`), `schema_version` on every record, documented `_`-prefixed local-only fields | #198 |
| #153 | host-neutral `pipeline` launcher + install discovery (`pipeline path --json`): dependency-free discovery that works even with absent/partial `core/node_modules`, best-effort postinstall, detached-`run` lifecycle-flag forwarding, watchdog process-**tree** kill, and child-side lock acquisition with a launcher handshake (closes the parent-death lock race) | #199 |
| #154 | machine-readable `runStatus --json` + `doctor --json`/`--is-ok`: latest-window label-event fetch (GraphQL `timelineItems`) so `last_event` reflects the current stage on long issues, and a truly-silent `doctor --is-ok` polling gate (config-resolution warnings suppressed) | #200 |
| #156 | `.github/pipeline.yml` JSON schema (`pipeline config schema`) + non-throwing `config validate` with severity-tiered, CST-located (offending-key line) diagnostics; rigor/cost-gating keys reject (never coerce) | #201 |
| #155 | stable run directory (`.agent-pipeline/runs/<run-id>/`): append-only `events.jsonl`, `run.json`, `summary.json`, always-written `terminal.log`; `--json-events` streams **every** lifecycle event (incl. stage-owned + terminal stage) to stdout; non-hanging `pipeline logs <id> --follow`; detached launch pinned to the same run store with a machine-readable `run-store.json` pointer (git-root-resolved) | #202 |

Carried forward to **v1.6.0** (still deferred): **#23** graduated-autonomy approval checkpoints (recurrence-parked on a checkpoint-comment forge-resistance security property; PR #194 open) and **#149** bounded auto-loop (depends on #23).

**v1.4.0 — private eval / shipcheck gate (shipped 2026-06-16, tag `v1.4.0`) — fourth minor:**

| # | What | PR |
|---|------|-----|
| #148 | opt-in reviewer-owned **shipcheck** acceptance gate before `ready-to-deploy` (default off): when configured, a reviewer harness scores the completed change against a rubric (`shipcheck.rubric_path`, falling back to the issue's acceptance criteria) and the gate blocks on a fail; wired into both the pre-merge and eval-gate exit paths so it cannot be bypassed. Verdict parsing rejects malformed/timed-out reviewer output; the rubric path is realpath-confined to the repo (no symlink escape) | #196 |

Carried forward to **v1.5.0** (still deferred): **#23** graduated-autonomy approval checkpoints (recurrence-parked on a checkpoint-comment forge-resistance security property; PR #194 open) and **#149** bounded auto-loop (depends on #23).

**v1.3.0 — isolation & harness output quality (shipped 2026-06-16, tag `v1.3.0`) — third minor:**

| # | What | PR |
|---|------|-----|
| #21 | opt-in sandboxed harness execution — `harness_sandbox` (default false): when true the claude implementer runs with `--permission-mode default` instead of `bypassPermissions`, threaded through every implementer/fix/test-gate-fix invoke; codex is already sandboxed via `--full-auto`. Sandboxed planning is confined to the issue worktree | #192 |
| #182 | configurable format/lint normalization gate — `format_gate` (default `[]`): each entry runs in the worktree (`auto_fix: true` commits + re-runs for stability; `auto_fix: false` is check-only and blocks on non-zero). Runs format-BEFORE-test and re-runs both to a bounded fixed point, so the pushed state is simultaneously formatted and tested (no auto-format ships untested, no test-fix ships unformatted); non-convergence blocks to `needs-human` | #193 |

Re-scoped to **v1.4.0** (deferred from this minor): **#23** graduated-autonomy approval checkpoints — converged 6→2→1 review findings but recurrence-parked on a checkpoint-comment forge-resistance security property (clearance must require a pipeline-authored SHA-bound comment, not arbitrary matching text); and **#149** bounded auto-loop, which depends on #23. PR #194 (#23) is left open for v1.4.0.

**v1.2.2 — pipeline-run reliability cont. (shipped 2026-06-16, tag `v1.2.2`) — second patch on the 1.2 line:**

More reliability fixes found while running `/pipeline` against a real downstream repo (pipeline-desk):

| # | What | PR |
|---|------|-----|
| #181 | pre-merge gate convergence: the OpenSpec archive step is idempotent (computes active candidates before its skip-shortcut) and a persistently-failing pre-merge CI routes to `needs-human` with the failure surfaced, instead of re-archiving/re-polling until the iteration cap | #189 |
| #180 | the worktree harness never creates or stages a `node_modules` symlink: staging excludes `node_modules` (via the worktree's resolved `info/exclude`, looked up with `git rev-parse --git-path`), so a tracked symlink can no longer slip into a commit and break CI | #190 |
| #183 | concurrent `git worktree add` is serialized against the shared `.git/config` lock via an atomic OS-level mutex keyed on the canonical git common dir (with bounded wait + ownership-safe stale reclaim), so two near-simultaneous runs no longer race | #187 |

**v1.2.1 — pipeline-run reliability (shipped 2026-06-16, tag `v1.2.1`) — first patch on the 1.2 line:**

Reliability fixes found while running `/pipeline` against a real downstream repo (pipeline-desk):

| # | What | PR |
|---|------|-----|
| #173 | configured `test_gate.command` is run through a shell so POSIX operators (`&&`, `\|\|`, `;`, `\|`) work instead of being passed as literal argv to the first program | #177 |
| #174 | fresh worktrees are dependency-installed (lockfile-detected package manager, or `setup_command`) before the test gate, with stale-worktree reclaim by **issue number** (excluded from the capacity count) and a setup timeout; also upgraded configured `test_gate.command` execution to `bash -c` with `set -o pipefail` so a failing pipeline stage fails the gate | #178 |
| #175 | `implementing` is a resumable entry point: on re-entry with an existing worktree/commit the gate→open-PR→review transition re-runs (branch resolved by name, same-repo PR reuse guarded against fork-PR spoofing, PR-creation race tolerated) | #179 |

(#176 — `--init` overwrite — closed as **already-fixed on `main`**: the `wx` exclusive-create guard + skip notice predate v1.2.0; the report was against a stale install whose running code lagged its `package.json`.)

**v1.2.0 — reviewer pluggability & per-step models (shipped 2026-06-15, tag `v1.2.0`) — second minor:**

| # | What | PR |
|---|------|-----|
| #39 | same-harness self-review fallback when the cross-harness reviewer CLI is unavailable — clearly labeled, failure-triggered at the invoke seam, no new config key | #163 |
| #40 | configurable review harness: a real, honored `review_harness` key to point the review step at an arbitrary reviewer CLI (implementer stays profile-owned) | #164 |
| #70 | per-step model config: adds the `models.implementing` slot (planning/implementing/review/fix); honored on claude, warns when inert on codex | #165 |
| #144 | override durability: stable shift-tolerant finding identity (`severity\|file\|line_bucket` + payload fingerprint) so a reworded/line-shifted re-emit keeps its `--override`; closes the override-key churn that made #19 take 5 rounds | #166 |

Tooling shipped alongside: config dogfooding — `.github/pipeline.yml` refreshed to the latest accepted format (PR #167); release automation — `release.yml` auto-publishes a GitHub Release on `v*` tag push (PR #169).

**v1.1.1 — capability/evidence hardening (shipped 2026-06-14, tag `v1.1.1`):**

| # | What | PR |
|---|------|-----|
| #146 | `doctor` / preflight: deterministic capability check (gh auth/repo, harness availability, worktree cleanliness, OpenSpec, mirror, deps, eval cmd) before expensive autonomous work — standalone `--doctor` + opt-in run-start gate; no model invocation | #151 |
| #147 | per-run evidence bundle: machine-readable artifact (issue/PR, branch, SHAs, stage transitions, harness identity, commands, test/eval outcomes, verdicts, overrides, recovery events) + human-readable summary; audit/debug only, not a second state machine | #152 |

(#143 — the `readConventions` truncation-fairness follow-up originally slotted here — was folded into #19's reserve-aware water-filling fix and shipped in v1.1.0; closed as done.)

**v1.1.0 — review quality (shipped 2026-06-13, tag `v1.1.0`) — first minor:**

| # | What | PR |
|---|------|-----|
| #85 | verdict drift guard extended to value-types/nesting, not just field names (every union arm validated; `\| null` fails closed, `\| undefined` normalizes) | #129 |
| #57 | world-class review prompts — severity rubric, confidence calibration, few-shot, diff-scoping/blast-radius, deterministic-ask removal, round-1↔round-2 differentiation | #130 |
| #25 | research-grounded planning — mine repo patterns + prior plans, emit checkable acceptance criteria (OpenSpec planning-context seam) | #141 |
| #19 | closed-loop learning — human-curated lessons carried forward via `readConventions` injection (no pipeline-written store); reserve-aware water-filling truncation hardened over 5 adversarial review rounds (all real findings; #143 folded in, #144 filed for override-key durability) | #142 |

**v1.0.4 — recovery robustness (shipped 2026-06-12, tag `v1.0.4`):**

| # | What | PR |
|---|------|-----|
| #131 | salvage uncommitted harness work (commit + test-gate-certify) instead of hard-blocking | #137 |
| #133 | recurrence-aware review loop — park earlier on an unchanged re-emit + `RECURRING`/`NEW` tags | #136 |
| #134 | stage-aware recovery recipe in `setBlocked` (the right resume verb per blocker; correct label, no unsafe actions) | #139 |
| #135 | override auto-resume — apply a human's recorded `--override` disposition automatically | #138 |

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
| **v1.0.4** ✅ shipped | patch | Dev-loop convergence (cont.) — recovery robustness | #131, #133, #134, #135 | Shipped 2026-06-12 (tag `v1.0.4`). Deterministic recovery + a sharper hand-off moved into the skill (salvage, recurrence-aware park, recovery recipes, override auto-resume); all zero-authority. See **Shipped** above. |
| **v1.1.0** ✅ shipped | minor | Review quality | #19, #25, #57, #85 | Shipped 2026-06-13 (tag `v1.1.0`) — first minor. New planning/review capability, no breaking change. See **Shipped** above for per-PR detail. (#84 closed — its enumerate-every-instance ask shipped early in v1.0.1 via #110.) |
| **v1.1.1** ✅ shipped | patch | Capability/evidence hardening | #146, #147 | Shipped 2026-06-14 (tag `v1.1.1`). Deterministic `doctor` preflight + per-run evidence bundles; no change to shipped run behavior. (#143 folded into v1.1.0.) See **Shipped** above. |
| **v1.2.0** ✅ shipped | minor | Reviewer pluggability & per-step models | #39, #40, #70, #144 | Shipped 2026-06-15 (tag `v1.2.0`) — second minor. Opt-in keys (reviewer selection, `models.implementing`) defaulting to identical behavior + override-durability hardening. See **Shipped** above. (Tooling: config dogfooding PR #167, release automation PR #169.) |
| **v1.2.1** ✅ shipped | patch | Pipeline-run reliability (pipeline-desk) | #173, #174, #175 | Shipped 2026-06-16 (tag `v1.2.1`). Reliability fixes from running `/pipeline` against a real downstream repo: shell-backed configured gate commands + pipefail, worktree dependency-install with issue-number capacity reclaim, resumable `implementing` stage. (#176 closed as already-fixed on `main`.) See **Shipped** above. |
| **v1.2.2** ✅ shipped | patch | Pipeline-run reliability cont. (pipeline-desk) | #180, #181, #183 | Shipped 2026-06-16 (tag `v1.2.2`). Second reliability patch: failing pre-merge CI → `needs-human` (no archive/poll loop), worktree harness never stages a `node_modules` symlink, and concurrent `git worktree add` serialized against `.git/config`. See **Shipped** above. |
| **v1.3.0** ✅ shipped | minor | Isolation & harness output quality | #21, #182 | Shipped 2026-06-16 (tag `v1.3.0`). Opt-in `harness_sandbox` (sandboxed implementer execution) + `format_gate` (format/lint normalization run before the test gate to a bounded fixed point). Both default off/empty → no behavior change. #23 + #149 re-scoped to v1.4.0 (see below). See **Shipped** above. |
| **v1.4.0** ✅ shipped | minor | Private eval / shipcheck gate | #148 | Shipped 2026-06-16 (tag `v1.4.0`). Opt-in reviewer-owned `shipcheck` acceptance-rubric gate before `ready-to-deploy` (default off; wired into pre-merge + eval exit paths; realpath-confined rubric; rejects malformed/timed-out verdicts). #23 + #149 carried to v1.5.0. See **Shipped** above. |
| **v1.5.0** ✅ shipped | minor | Pipeline Desk desktop contracts | #153, #154, #155, #156, #161 | Shipped 2026-06-16 (tag `v1.5.0`) — fifth minor. Machine-facing launch/discovery, JSON status/preflight, stable run directory + JSON events + non-hanging log-follow, config schema/validate, and run-artifact conventions so Pipeline Desk can supervise runs without scraping terminal prose. Human `/pipeline` / `$pipeline` flows unchanged. See **Shipped** above. (#23 + #149 carried to v1.6.0.) |
| **v1.6.0** ✅ shipped | minor | Intake & backlog automation | #158, #170, #171, #168 | Shipped 2026-06-17 (tag `v1.6.0`) — sixth minor. Front-door intake (#158), release-PR automation (#170), backlog-roadmap engine (#171), and the sweep re-spec/rebase command (#168). See **Shipped** above for the per-PR detail. (#23 + #149 carried to v1.7.0.) |
| **v1.6.1** *(folded into v1.7.0)* | patch | Version-staleness detection | #186 | **#186 shipped within v1.7.0** (merged via #224 before the `v1.7.0` tag) — no separate `v1.6.1` tag was cut. Added the `doctor` stale-install / version-coherence check + a `launcher-smoke` assertion that `--version` equals the installed `core/package.json`. |
| **v1.7.0** ✅ shipped | minor | Control plane & release_model | #214, #216, #217 | Shipped 2026-06-19 (tag `v1.7.0`). See **Shipped** above for the per-PR detail. |
| **v1.8.0** ✅ shipped | minor | Faster intake/sweep + fail-fast timeouts | #220, #248 | Shipped 2026-06-19 (tag `v1.8.0`) — eighth minor. Intake/sweep spec-generation pinned to a fast model (`models.intake`/`models.sweep`, default `sonnet`) + a lean tool-free harness (`--tools ""`/`--strict-mcp-config`; no MCP, no repo exploration) → ~15× faster intake (#220/#247); plus configurable `intake_timeout`/`sweep_timeout` (#248/#250). Additive keys; defaults preserve behavior. See **Shipped** above. |
| **v1.9.0** ✅ shipped | minor | Observability & reliability hardening | #256, #257, #258, #259, #260, #261, #262, #264, #265, #266 (+ #253, #254, #255) | Shipped 2026-06-21 (tag `v1.9.0`). See **Shipped** above for the per-PR detail. |
| **v1.10.0** ✅ shipped | minor | CLI dispatch v2 (command registry + conventions) | #263, #273 | Shipped 2026-06-28 (tag `v1.10.0`). Factory scoreboard + stage-level cost accounting; command registry + lifecycle/CLI-parsing split (#263), queue and budget mode (#305). See **Shipped** above. |
| **v1.11.0** ✅ shipped | minor | CLI dispatch v2 cont. + queue/budget | #305 | Shipped 2026-06-28 (tag `v1.11.0`). See **Shipped** above. |
| **v1.12.0** ✅ shipped | minor | Namespaced command surface + OpenSpec CLI guard | #273, #308 | Shipped 2026-06-29 (tag `v1.12.0`). Move /pipeline off -- conventions (namespaced command surface); pre-merge silently skips OpenSpec archive when openspec CLI unavailable. See **Shipped** above. |
| **v1.12.1** ✅ shipped | patch | ci_mode local + OpenSpec config path + Codex no-sandbox | #350, #352, #355 | Shipped 2026-06-30 (tag `v1.12.1`). See **Shipped** above. |
| **v1.12.2** ✅ shipped | patch | OpenSpec spec-divergence + injectable-dep rule in prompts | #356, #360 | Shipped 2026-07-01 (tag `v1.12.2`). See **Shipped** above. |
| **v1.12.3** ✅ shipped | patch | Fix harness commit step lock-file side-effects | #358 | Shipped 2026-07-01 (tag `v1.12.3`). See **Shipped** above for the per-PR detail. |
| **v1.12.4** ✅ shipped | patch | Pre-merge fix round: auto-apply bounded fix for correctness findings | #359 | Shipped 2026-07-02 (tag `v1.12.4`). See **Shipped** above for the per-PR detail. |
| **v1.13.0** ✅ shipped | minor | Fix-stage recovery + logging portability + repo-map CLI | #349, #343, #367 | Shipped 2026-07-04 (tag `v1.13.0`). See **Shipped** above for the per-PR detail. |
| **v1.14.0** ✅ shipped | minor | Convergence & evidence: post-fix re-review correctness, eval-gate fix routing, durable evidence, crash recovery | #373, #371, #377, #372, #382 | Shipped 2026-07-07 (tag `v1.14.0`). See **Shipped** above for the per-PR detail. |
| **v1.14.1** ✅ shipped | patch | Gate/CLI reliability: test-gate capture resilience + wrapper --profile fix | #384, #383 | Shipped 2026-07-07 (tag `v1.14.1`). See **Shipped** above for the per-PR detail. |
| **v1.15.0** ✅ shipped | minor | Factory reliability: fix-round convergence, wedge-proof timeouts, de-flaked gates, single-operator human-input gate | #391, #398, #403, #390, #393, #387 | Shipped 2026-07-08 (tag `v1.15.0`). See **Shipped** above for the per-PR detail. |
| **v1.15.1** ✅ shipped | patch | Foundation reliability + release hygiene | #401, #402, #413, #423 | Shipped 2026-07-20 (tag `v1.15.1`). See **Shipped** above for the per-PR detail. |
| **v1.15.2** ✅ shipped | patch | Reviewer model/effort passthrough for codex + gitignored-artifact commit guard | #441, #445 | Shipped 2026-07-21 (tag `v1.15.2`). See **Shipped** above for the per-PR detail. |
| **deferred** | minor | Graduated autonomy (forge-resistance) | #23 | Carried-forward **#23** (graduated-autonomy approval checkpoints — still parked on the checkpoint-comment forge-resistance security property, PR #194 open). #149 (bounded auto-loop) already shipped in v1.7.0. |
| **v1.16.0** | minor | Papercut capture: agent-logged friction events + CLI | #419 | Pipeline runs currently lose all record of small, non-blocking friction — a flaky command retried, a misleading error worked around, an undocumented setup step, a dead-end tool call — because none of it trips `blocker_set` or `human_intervention`. Additive; existing flows unchanged. |
| **v1.16.0** | minor | Cluster recurring papercuts into backlog issues, with opt-in auto-file | #421 | `pipeline improve` gains a new `papercut` cluster category: it reads agent-reported friction events captured across runs, groups recurring ones into clusters, and surfaces them in the same dry-run report and `--apply` issue-creation path used by existing categories (flaky-gate, token-waste) — including the same open-issue dedup. Additive; existing flows unchanged. |
| **v1.17.0** | minor | Add `--bucket day|week` time-series output to pipeline scoreboard | #425 | The `scoreboard` command gains an optional `--bucket day|week` flag that, when set, adds a chronological series of per-period aggregates to the report — each period carrying the same metrics scoreboard already reports for the full window (cost per ready PR, autonomy rate, fix rounds, needs-human rate, stage durations, pass rates). Additive; existing flows unchanged. |
| **v1.17.0** | minor | Add self-contained HTML export to pipeline scoreboard | #427 | The `scoreboard` command gains an HTML export mode that renders the same metrics scoreboard already computes — cost per ready PR, autonomy rate, fix rounds, needs-human rate, stage durations, and test/eval/shipcheck pass rates — into a single static HTML file. Additive; existing flows unchanged. |
| **v1.17.0** | minor | Capture actual per-call cost from harness output, not just estimates | #429 | Stage accounting captures the real cost of each harness call from that harness's own output/telemetry whenever the harness exposes it, rather than relying solely on operator-supplied `--estimate-cost` fallbacks. Additive; existing flows unchanged. |
| **v1.17.0** | minor | Scoreboard grouping by harness, model, effort, and executor | #437 | The `scoreboard` command gains an opt-in grouping flag that splits each stage's existing metrics — durations, fix rounds, review rounds and verdict outcomes, gate pass rates, needs-human rate, tokens, and cost — by who or what performed the work: harness, model, effort, or executor. Additive; existing flows unchanged. |
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
| #419 | minor | new sub-command | intake | v1.16.0 | — |
| #421 | minor | adds `papercuts.auto_file` key | intake | v1.16.0 | #419 |
| #425 | minor | new sub-command | intake | v1.17.0 | — |
| #427 | minor | new sub-command | intake | v1.17.0 | — |
| #429 | minor | new sub-command | intake | v1.17.0 | — |
| #437 | minor | new sub-command | intake | v1.17.0 | — |
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
