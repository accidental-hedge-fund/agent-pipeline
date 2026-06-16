# Roadmap

Single source of truth for the open backlog, now organized by **sem-ver release**. Last updated 2026-06-14.

**Goal driving the order:** make the pipeline robust enough to **develop itself**, then continue by value. **v1.0.0 shipped 2026-06-10** (tag `v1.0.0`, commit `450b537`) — the pipeline is external-ready. **v1.0.1 shipped 2026-06-10** (tag `v1.0.1`, commit `29a9bc3`) — dev-loop convergence. **v1.0.2 shipped 2026-06-11** (tag `v1.0.2`) — dev-loop convergence continued + first user-facing CLI niceties. **v1.0.3 shipped 2026-06-11** (tag `v1.0.3`) — contributor tooling (auto-regenerated `plugin/` mirror). **v1.0.4 shipped 2026-06-12** (tag `v1.0.4`) — recovery robustness: deterministic recovery + sharper hand-off moved into the skill; see Shipped. **v1.1.0 shipped 2026-06-13** (tag `v1.1.0`) — review quality (first minor): value-type drift guard, world-class review prompts, research-grounded planning, and closed-loop carry-forward lessons; see Shipped. **v1.1.1 shipped 2026-06-14** (tag `v1.1.1`) — capability/evidence hardening: deterministic `doctor` preflight and per-run evidence bundles; see Shipped. **v1.2.0 shipped 2026-06-15** (tag `v1.2.0`) — reviewer pluggability & per-step models: configurable review harness, self-review fallback, `models.implementing`, and override durability; see Shipped. **v1.2.1 shipped 2026-06-16** (tag `v1.2.1`) — pipeline-run reliability (first patch on the 1.2 line): shell-backed (`bash -c` + `pipefail`) configured gate commands, worktree dependency-install with issue-number capacity reclaim, and a resumable `implementing` stage; see Shipped. **v1.2.2 shipped 2026-06-16** (tag `v1.2.2`) — more pipeline-run reliability (second patch on the 1.2 line): persistently-failing pre-merge CI routes to `needs-human` instead of looping, the worktree harness never stages a `node_modules` symlink, and concurrent `git worktree add` is serialized against the shared `.git/config` lock; see Shipped. **v1.3.0 shipped 2026-06-16** (tag `v1.3.0`) — isolation & harness output quality (third minor): opt-in sandboxed harness execution (`harness_sandbox`) and a configurable format/lint normalization gate (`format_gate`) that runs format-before-test to a bounded fixed point; see Shipped. (Graduated-autonomy approval checkpoints #23 and bounded auto-loop #149 were re-scoped from this minor to **v1.4.0** — see Release plan.) **v1.4.0 shipped 2026-06-16** (tag `v1.4.0`) — private eval / shipcheck gate (fourth minor): an opt-in reviewer-owned acceptance-rubric gate (`shipcheck`) that runs before `ready-to-deploy`, advisory-first and default-off; see Shipped. **v1.5.0 shipped 2026-06-16** (tag `v1.5.0`) — Pipeline Desk desktop contracts (fifth minor): host-neutral launcher & install discovery (#153), machine-readable JSON status/preflight (#154), stable run directory + JSON events + non-hanging log-follow (#155), `.github/pipeline.yml` JSON-schema & validation command (#156), and run-artifact conventions — non-fatal I/O, write-time injection denylist, `schema_version`, local-only fields (#161) — so Pipeline Desk can supervise runs without scraping terminal prose; see Shipped. (#23 + #149 carried forward again, now to **v1.6.0** — the approval-gate forge-resistance security property still needs convergence.) Everything below v1.5.0 is the post-1.5.0 line.

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
| **v1.6.0** | minor | Intake & backlog automation + carried autonomy | #158, #170, #171, #168, #23, #149 | Intake/backlog automation, plus carried-forward **#23** (graduated-autonomy approval checkpoints — still parked on the checkpoint forge-resistance security property, PR #194 open) and **#149** (bounded auto-loop, depends on #23). |
| **v1.6.0** | minor | Intake & backlog automation | #158 | Adds an opt-in no-issue-number `/pipeline` sub-command that specs a short description into a decision-complete GitHub issue (`/pm`-style) and proposes a matching `ROADMAP.md` update via PR — one front door that keeps the backlog and roadmap in sync. Additive; existing flows unchanged. |
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
| #23 | minor | adds key | graduated autonomy | v1.3.0 | — |
| #21 | minor | adds key | execution isolation | v1.3.0 | #93 ✓ |
| #149 | minor | adds key | bounded auto-loop | v1.3.0 | #23 / #21 / #133 ✓ |
| #148 | minor | adds key | private eval / shipcheck gate | v1.4.0 | #12 / #147 |
| #153 | minor | none | desktop launcher/discovery | v1.5.0 | — |
| #154 | minor | JSON output only | desktop status/preflight | v1.5.0 | #146 |
| #155 | minor | artifact/event format | desktop run events/logs | v1.5.0 | #147 |
| #156 | minor | schema output only | desktop config editor | v1.5.0 | — |
| #161 | patch | none | run-artifact conventions | v1.5.0 | #147 ✓ |
| #158 | minor | new sub-command | intake & roadmap sync | v1.6.0 | — |
| #14 | none | — | research | *(none)* | — |
| #27 | none | — | research | *(none)* | — |

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
