# Concepts & advanced topics

Hand-authored companion to the lean [README](../README.md). For the **packaging contract** (CLI is the product; hosts are shims) see [packaging.md](packaging.md). For the full **CLI inventory** see [cli.md](cli.md); for **config keys** see [config.md](config.md). This page does not re-list every command or config field.

A newcomer who completed Prerequisites, Install, and Quickstart in the README has a working setup **without** reading this page. Sections below are optional or advanced unless noted.

## Contents

- [Packaging contract](packaging.md)
- [How hosts share one CLI](#how-hosts-share-one-cli)
- [Onboarding details](#onboarding-details)
- [Test/build gate](#testbuild-gate-optional-default-on)
- [Configurable steps (optional)](#configurable-steps-optional)
- [External supervisors (compose the CLI)](#external-supervisors-compose-the-cli)
- [Ship-path autonomy](#ship-path-autonomy)
- [Human plan feedback (optional)](#human-plan-feedback-optional)
- [Review severity policy & audited overrides](#review-severity-policy--audited-overrides)
- [Design-interrogation gate (optional, default off)](#design-interrogation-gate-optional-default-off)
- [Visual gate (optional, default off)](#visual-gate-optional-default-off)
- [Eval gate (optional, default off)](#eval-gate-optional-default-off)
- [Shipcheck gate (optional, default off)](#shipcheck-gate-optional-default-off)
- [OpenSpec integration (optional)](#openspec-integration-optional)
- [last30days context (optional, default off)](#last30days-context-optional-default-off)
- [Commit traceability trailers (always on)](#commit-traceability-trailers-always-on)
- [Planning-leverage and material-rework telemetry](#planning-leverage-and-material-rework-telemetry)
- [Risk-calibrated progressive planning (research)](#risk-calibrated-progressive-planning-research)
- [Conventions & carry-forward lessons](#conventions--carry-forward-lessons)
- [Park-release of managed worktrees](#park-release-of-managed-worktrees)
- [Troubleshooting](#troubleshooting)
- [Desktop / editor integration](#desktop--editor-integration)
- [Repository layout](#repository-layout)
- [Operator follow and notify](#operator-follow-and-notify)

## How hosts share one CLI

Hosts (Claude Code `/pipeline`, Codex `$pipeline`, and others) are shims around one TypeScript engine under `core/`. Host-specific packaging lives in `hosts/`. Dispatch, stages, review policy, and merge posture are identical across hosts — only the root invocation token and install profile differ. The product is the `pipeline` CLI; see [packaging.md](packaging.md). The transitional `plugin/` tree contains only the generated SKILL overlay until #1050; its companion catalog is `.claude-plugin/marketplace.json`. Neither is the distribution product or a copy of `core/`.

## Onboarding details

`pipeline init`:

- Creates the standard `pipeline:*` labels if missing
- Scaffolds `.github/pipeline.yml` with documented defaults
- Ensures local-only paths under `.agent-pipeline/` are gitignored

Ignored local paths (must never be committed): `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, `.agent-pipeline/history/`, `.agent-pipeline/frg/`, `.agent-pipeline/factory-release/`. Without that gitignore block, the first run can leave the worktree dirty and fail `pipeline doctor`'s `worktree-clean` check.

After `init`, commit the config, label an issue `pipeline:ready`, and run `/pipeline N` or `$pipeline N`.

## Test/build gate (optional, default on)

Before opening a PR, the pipeline can run the repo's own tests/build (`test_gate` in `.github/pipeline.yml`). Default **enabled**. On failure it routes to a bounded fix loop (`max_attempts`), then blocks with evidence. Set `test_gate.enabled: false` to disable. See [config.md](config.md) for keys.

The repo's own `test_gate.command` is typically `npm run ci`, which includes core tests, generated SKILL/catalog freshness, install-smoke, OpenSpec validation when present, **conditional docs freshness** (`ci:docs`), and scripts tests.

## Git push authentication (`git.push_auth`)

Every authoritative pipeline-owned delivery push (implement, fix, eval/visual
fix, OpenSpec archive, intake/sweep publish, merge-queue repair, and related
sites) uses one configured authentication mechanism:

| Mechanism | Config | When to use | Workflow files (`.github/workflows/**`) |
|-----------|--------|-------------|----------------------------------------|
| **ssh** (default) | omit `git:` or `git.push_auth: ssh` | Deploy key or SSH agent already on the host | Preferred — SSH has no GitHub `workflow` scope requirement |
| **https-token** | `git.push_auth: https-token:ENV_NAME` | Host must push over HTTPS | Token in `ENV_NAME` **must** include the GitHub `workflow` scope |
| **app** | — | Future GitHub App tokens | **Not implemented** — schema rejects `app` |

Rules:

- Config stores the **env-var name** only for HTTPS-token mode — never a
  literal secret in `.github/pipeline.yml`.
- Default is SSH so existing deploy-key hosts need no config change.
- `pipeline doctor` reports the resolved mechanism; HTTPS-token with an unset
  or empty env var fails the `git-push-auth` check (message names the env var,
  never the secret).
- Ambient `gh auth git-credential` is not the selected transport for the
  authoritative push path. Prefer not reconfiguring worktree remotes to
  HTTPS via `gh auth setup-git` when using SSH.

See [config.md](config.md) for the generated field description.

## Configurable steps (optional)

The `steps` block turns thoroughness steps on or off per repo:

- `plan_review` — cross-harness review of the plan before coding
- `standard_review` / `adversarial_review` — review-1 / review-2 and their fix rounds
- `docs` — include docs-update instructions in the implementing prompt

Structural safety steps (planning, implementing, pre-merge CI/mergeability) are **not** toggles. Unknown keys under `steps` are rejected at parse time.

Review verdicts are pinned to the commit they evaluated. Before pre-merge acts on a prior approval it re-checks that SHA against HEAD; a developer/fix commit after the verdict invalidates it and re-enters review. Pipeline-internal commits (docs/chore archive, etc.) do not.

## External supervisors (compose the CLI)

An external supervisor can compose the existing Pipeline CLI (`pipeline single`,
`pipeline train`, `pipeline loop`, `pipeline merge`, `pipeline merge-queue --apply`,
release and status commands). The repository does not ship a Hermes/Buzz/Slack
factory control plane, grant schema, or second durable scheduler. Ordinary
`pipeline advance`, `pipeline single`, and `pipeline loop` still stop at
`pipeline:ready-to-deploy` and never merge. Multi-issue integrate trains use
opt-in `pipeline train --merge`. `pipeline train --dry-run` prints a read-only
plan in default and `--merge` modes; omitting `--dry-run` still runs the live train.

`pipeline merge` keeps its normal ready-to-deploy, mergeability, required-check,
and exact-head gates. `pipeline merge-queue` is dry-run by default; `--apply` is
a separate operator-authorized batch surface and is never called by advance.
Repository content in `.github/pipeline.yml` cannot authorize merges or set
`auto_merge`.

Portable supervisor contract (intent → CLI, status JSON, multi-platform bootstrap):
[supervisor.md](./supervisor.md). Thin examples: [`examples/supervisor/`](../examples/supervisor/).

The current Grok profile must use exactly `grok-4.6` for planning,
implementation, and fixes. It has no Grok fallback. Codex remains the reviewer.
Product direction: [factory-simplification-plan.md](./factory-simplification-plan.md).

## Ship-path autonomy

Factory memory for train∘loop frontiers, the recovery ladder (classify →
deterministic recipe → verify/CI → bounded model repair → real human only for
human-authority classes), false-`needs-human` vs real human handoff, class-over-site
dogfood fixes, and anti-goals (no merge-in-advance, no second recoverer in
`train.ts`, no LLM-first recovery). Canonical short doctrine:
[ship-path-autonomy.md](./ship-path-autonomy.md). Supervisors that hit
`needs-human` / blocked must read that distinction — not every blocked outcome
is “wait for a human.”

### Human plan feedback

When `plan_review` is on, the pipeline posts an `## Implementation Plan` comment and runs agent plan review via the configured reviewer / secondary harness. When that reviewer is available, this is **independent agent plan review** — the plan-review control when the step is enabled, agent evidence, **not** human approval or human sign-off. If the reviewer CLI is missing or unspawnable, the same-harness fallback applies instead: the implementing harness reviews its own plan, and the posted plan review is **prominently labeled as a same-harness self-review**. That degraded path is still plan-review evidence and still advances (the pipeline never merges), but it is **not** independent agent plan review.

During the **human feedback window** after the plan is posted, comments you leave before the revision step are optional steering: they are folded into the revision alongside the reviewer's feedback. After the revised plan, `needs-human` fires only for operator-authored scope-change text. Verified pipeline output, a trusted review/delta heading with a terminal artifact, and closed operational notes (grill / ship-halt / don’t comment) do not park. Ambiguous trusted notes recover in-engine (re-plan), not as `needs-human`.

When the feedback window ends with **no** human comments, plan revision proceeds from agent plan-review feedback only: missing human input **does not block the advance** and is **not recorded as human approval**. With no human comments, behavior is byte-for-byte identical to the agent-only path.

When human comments are present, the revised plan comment attributes contributors, and the revision **must** end with a `## Human Feedback Acknowledgement` section listing each commenter as `addressed — <reason>` or `declined — <reason>`.

**Authority boundary:** when the reviewer harness runs, independent agent plan review is the plan-review control; when same-harness fallback applies, the labeled self-review is the plan-review evidence and is **not** independent; the human feedback window is optional steering; **human attestation** (pipeline output markers / operator capability attestations) is provenance, not plan sign-off. Plan-review is **not** human sign-off for high-risk work. Opt-in **pre-code human attestation** (`pre_code_attestation`, #575) is a separate risk-triggered control before implementing — required only when configured and a risk trigger matches; omitted configuration preserves autonomous advancement without that human gate. Merge authority remains outside the advance path. A direct operator (or external supervisor under operator authority) can invoke a loop-isolated merge surface. True human-decision gates such as `needs-human` dispositions remain human-owned.

## Review severity policy & audited overrides

`review_policy` controls which findings block vs advise (`block_threshold`, `min_confidence`, round caps). Defaults favor fixing real issues over silent advise-past. See [config.md](config.md).

**Overrides** disposition a specific blocking finding and auto-resume:

```text
/pipeline N --override "<override-key>: rejected — <why>"
/pipeline N --override "category:rollback-safety: deferred #90 — tracked separately"
/pipeline N --override "<override-key>: high_risk_accept: accept residual remediation_issue_url=https://… risk_acceptance_ref=RA-1"
```

Bare `"<key>: <reason>"` maps to `override_governance.default_class` when configured, or to the implicit `low_risk_deferred` class when the block is omitted (compatibility path). Optional class form: `"<key>: <class>: <reason>"`. Required evidence refs for a class are passed as `kind=value` tokens in the reason.

**Governed overrides (#693):** optional `override_governance` in `.github/pipeline.yml` defines a versioned class taxonomy with per-class max duration, approvers, required evidence, separation of duties, and renewal mode (`lite` | `human` | `none`). Only currently valid active decisions unblock; expired, invalidated, unauthorized, or superseded decisions leave the finding blocking. History is append-only with supersession/renewal lineage. Auto-resume after override runs only when the recorded decision is currently valid. See [config.md](config.md).

Overrides are audited in issue comments. The advance path still never merges.

## Pre-code human attestation (optional, default off)

`pre_code_attestation` sits between `plan-review` and `implementing` as the stage `pre-code-attestation`. It is **opt-in and risk-triggered**: when the config block is omitted or `enabled: false`, the gate is disabled and planning advances to implementing without a human hold (current autonomous behavior). When enabled but no risk trigger matches, the stage records `no-trigger-matched` and passes through. When a trigger matches, the pipeline requires a compact pre-code design dossier and affirmative attestation from an authenticated actor authorized under repository-owned policy before product code changes. Agent plan-review alone never clears a triggered gate. Distinct from plan-review (agent review) and from design-gate (post-code agent interrogation). See [config.md](config.md).

## Design-interrogation gate (optional, default off)

`design_gate` sits between `implementing` and `review-1`. It is inert unless enabled **and** a risk trigger matches. When it fires, the implementer records material design decisions; an independent reviewer challenges them under bounded rounds. No merge/release authority. Post-code agent interrogation — not the pre-code human attestation gate. See [config.md](config.md) for `triggers`, thresholds, and limits.

## Visual gate (optional, default off)

When `visual_gate.enabled`, the repo's E2E/visual suite runs after pre-merge (before eval-gate) inside the worktree. Exit code alone decides pass/fail. Optional `publish` commits captured artifacts to the PR branch as PR-visible evidence (repo-history tradeoff; default off). Tooling failures always block immediately.

## Eval gate (optional, default off)

When `eval_gate.enabled`, the repo's eval harness runs after visual-gate (before shipcheck / ready-to-deploy). `mode: gate` routes ordinary failures to a bounded fix round; `mode: advisory` always advances after recording. Tooling failures always block.

## Shipcheck gate (optional, default off)

When `shipcheck_gate.enabled`, the **reviewer** harness applies a private acceptance rubric (default `.github/shipcheck-rubric.md`) after eval-gate. Advisory mode records without blocking; gate mode can block on `fail` (and optionally `partial`).

## OpenSpec integration (optional)

If the target repo has an `openspec/` directory (or `openspec.enabled: on` / bootstrap), planning authors an OpenSpec change, reviews check against spec deltas, and pre-merge archives into living specs then runs `openspec validate --all`. Missing CLI with an active change to archive blocks pre-merge with an install hint.

## last30days context (optional, default off)

When `last30days.enabled: true`, a pre-planning brief from the [last30days skill](https://github.com/mvanhorn/last30days-skill) is injected into planning. Always non-blocking if the skill is missing. **Do not enable for issues with sensitive customer data** — the research topic is forwarded to external data sources after redaction.

## Commit traceability trailers (always on)

Every pipeline-produced commit carries:

```
Issue: #<n>
Pipeline-Run: <n>/<UTC-ISO-datetime>
```

The test/build gate enforces both trailers. There is no toggle.

## Planning-leverage and material-rework telemetry

Additive measurement for how planning investment relates to later review and correction cost (#702). It is the upstream companion to production/rework outcomes (#576). It does **not** auto-change planning depth, emit a productivity score, or claim causal impact.

### What is recorded

Events go through the same host-local `events.jsonl` `appendEvent` path as other run telemetry (stream `schema_version` stays `1`):

| Event type | Role |
| --- | --- |
| `planning_leverage_phase` | Phase boundary start/end for `alignment`, `planning`, `implementation`, `review`, `correction` |
| `assumption_lineage` | Stable assumption / open-question id with status across stages |
| `material_rework` | Material vs ordinary vs unknown classification for a fix round |
| `planning_leverage_snapshot` | Optional rolled-up raw + derived checkpoint |

Selected fields:

- `planning_depth`: `minimal` \| `standard` \| `deep` \| `unknown` (selected for the run, not post-hoc plan quality)
- `risk_class`: closed built-in vocabulary (pre-code classes + `unknown`)
- Durations: `elapsed_ms` only when both timestamps exist; `active_effort` uses `availability: unavailable` and `value_ms: null` when unknown — never `0` or a silent copy of elapsed
- Material criteria (OR): `scope_expansion`, `design_interface_change`, `replan_or_assumption_reopen`, `multi_round_blocking` — formatting-only edits are **ordinary**

### Reporting

`pipeline scoreboard` adds a `planning_leverage` section (human + JSON) with depth/risk histograms, observed phase elapsed, assumption open/resolved counts, and materiality breakdowns. Observed raw fields, derived ratios, and unavailable values are labeled separately. Missing telemetry yields zeros and a `telemetry_absent` diagnostic — not fabricated depths.

### Privacy and retention

- Default storage is host-local under `.agent-pipeline/runs/<run-id>/` (events + optional `planning_leverage.json`)
- Free text is denylist- and secret-redacted; no raw prompts, model transcripts, source dumps, or tokens
- Retention follows the scoreboard/run evidence window; expired runs drop out of default report totals
- Customer-hosted installs do not require a fleet collector

### Linkage to #576

Attribution may include `target_type: "production_outcome"` only when a durable outcome id exists. Missing production outcomes are omitted, not invented. In-pipeline material rework is distinct from post-delivery `follow_up_rework`.

## Risk-calibrated progressive planning (research)

Research package for **when** planning should stay light, deepen, zoom, preserve assumptions, or request **human** authority — designed from #702/#576 joins, not a single opaque risk score (#703).

- Durable note: [docs/research/risk-calibrated-progressive-planning.md](research/risk-calibrated-progressive-planning.md)
- Closed work/risk classes, routing actions, safe defaults, offline evaluation, and human-authority boundaries live in that note
- Future staged policy id: `progressive_planning_depth` — state remains **`draft`**; automated depth routing is **off** until evidence-sufficiency is recorded
- Optional pure offline helpers: `core/scripts/progressive-planning/` (composition only; not wired into advance)

This is **not** an always-on router. Longer plans or longer planning wall time are not success metrics.

## Conventions & carry-forward lessons

Stage prompts embed an excerpt of the target repo's conventions file (`CLAUDE.md` / `AGENTS.md`, or `conventions_md_path`). The pipeline **only reads** that file — never writes it. Maintainers curate carry-forward lessons by hand.

## Park-release of managed worktrees

`/pipeline` / `pipeline single` and `train --merge` share one park-release / automatic-remove gate. A clean managed worktree under `worktree_root` is released when **one** recoverability condition holds:

1. No unpushed commits, and the branch tip is on the remote **or** an open PR has a resolvable head SHA; or
2. **Bound merge-result proof** — the same issue, the same PR, the configured base branch, and a `merge_result_oid` the engine has proven is contained in `origin/<base>`.

After a squash merge GitHub deletes the head branch and pre-merge SHAs are not reachable from the base. That is **squash-merge unreachability**, not a git/network/auth failure. With bound proof, park-release removes the clean worktree and does not tell the operator to check connectivity or retry. Without bound proof, the worktree is retained with the existing not-reachable / `--force` wording (`pipeline remove-worktree <n> --force` when the operator takes that responsibility).

A true `ls-remote` transport or auth failure may still report git/network/auth. Dirty trees and filesystem cleanup failures retain **that** worktree, name the real cause, and do **not** change `pipeline:ready-to-deploy` or integrated state. `pipeline cleanup` only sweeps merged-PR worktrees and is **not** the required fix after a proven merge.

`max_concurrent_worktrees` counts on-disk managed worktrees for open issues that are not `pipeline:ready-to-deploy`. Park-released trees drop out of that count.

## Troubleshooting

### Pipeline is blocked

```text
pipeline status N
pipeline doctor
```

Common outcomes: missing reviewer CLI (same-harness fallback or block), CI red, merge conflicts, review ceiling → `needs-human`, OpenSpec invalid. Use `pipeline unblock` or `pipeline override` as appropriate, or fix and re-label.

### Evidence bundle

Each run writes a local evidence bundle under `.agent-pipeline/runs/`. `pipeline summary <issue-number|run-id>` prints the latest issue bundle or one exact run offline.

### External event sink (optional)

`event_sink` can forward `events.jsonl` records to an operator-controlled command. Unset → local events only. In `exclusive` mode the local file is skipped while the sink is healthy; on sink failure the engine falls back to a local `events.jsonl` write and records the failure in per-run write-health (status/doctor/summary). See [config.md](config.md).

### Product-fault reporting (optional, off by default)

`pipeline report` builds a sanitized product-fault payload for an operator-controlled intake. Disabled unless `product_fault` is configured.

## Desktop / editor integration

Machine-facing helpers (no change to human skill flows):

- `pipeline path --json` — discover installed host skill paths
- `pipeline run <N> --detach` — legacy detached advance for desktop launchers (prefer durable `single` / default advance for normal use)
- `pipeline config schema|validate|sync|repo-map` — config tooling
- Stable run directory + JSON events + log follow for supervisors (Pipeline Desk contracts)

## Repository layout

| Path | Role |
| --- | --- |
| `core/scripts/` | Engine (TypeScript, native type-stripping) |
| `core/test/` | Unit tests |
| `hosts/` | Per-host packaging (`claude`, `codex`, …) |
| `plugin/` | Generated SKILL overlay — transitional until #1050; not the product; do not hand-edit |
| `scripts/build.mjs` | Generate/check the SKILL overlay and marketplace catalog |
| `scripts/generate-docs.mjs` | Generate/check CLI, config, and CHANGELOG (not host SKILLs) |
| `docs/` | Operator docs (`packaging.md`, `cli.md`, `config.md`, `concepts.md`) |
| `openspec/` | Living specs + in-flight changes |
| `ROADMAP.md` | Human-readable forward plan (milestones own release plan membership) |
| `CHANGELOG.md` | Generated release history |

## Generated docs contract

CLI and config references plus `CHANGELOG.md` are **generated**. Host SKILLs are generated by `node scripts/build.mjs`, not this docs generator. After changing `command-registry.ts` / `command-docs.ts`, the Zod schema in `config.ts`, or release tags:

```bash
node scripts/generate-docs.mjs
# or
npm run docs:generate
```

`npm run docs:check` / `node scripts/generate-docs.mjs --check` fails when committed artifacts are stale (the same freshness contract `build.mjs --check` applies to its generated SKILL/catalog outputs).

**Release / tags:** `CHANGELOG.md` is derived from annotated `vX.Y.Z` tags.
After a release merge, ship-end `pipeline release ensure-tag` creates and
pushes `vX.Y.Z` from on-disk HMAC `.agent-pipeline/frg/<X.Y.Z>/latest.json`.
That path is gitignored, so `auto-tag-release.yml` must not fail the job when
the merged tree has no `latest.json`. If the tag already exists, auto-tag is a
successful no-op. After the tag is visible, `node scripts/release-docs-refresh.mjs`
refreshes the CHANGELOG on the default branch. Operator heal if that step failed:

```bash
node scripts/release-docs-refresh.mjs --version X.Y.Z --push
```

Release prepare (`pipeline release <version>`) does not invent the shipped tag entry (the tag does not exist yet). `pipeline release finish` merges only; it does not tag or publish. Ship-end `pipeline release ensure-tag` owns `vX.Y.Z` when FRG is gitignored.

## Operator follow and notify

Generated host SKILLs carry the compact contract. This page keeps the operator detail that left those essays.

### Run ids and follow commands

`pipeline status <N>` reports issue metadata (stage, blocker, PR). It does not discover a run id.

CLI dispatch is unchanged: `pipeline <N>` is a direct advance. `pipeline single <N>` and `pipeline loop` launch through the durable loop.

Direct numeric advance retains `advance_run_id` from the advance handoff (`run_id`). Follow:

```
pipeline logs <advance-run-id> --events --follow
```

Loop and `pipeline single` retain `loop_run_id` from the durable handoff. Follow:

```
pipeline loop logs <loop-run-id> --events --follow
```

After `loop_item_advance_linked` publishes `pipeline_run_id`, retain that value as `<advance-run-id>` and also follow:

```
pipeline logs <advance-run-id> --events --follow
```

Keep the loop follow active. On a later linkage or a terminal advance, stop or replace the prior advance follow. Advance `run_complete` stops or replaces only that advance follow. Keep the loop follow active while the loop remains live. Stop the loop-scoped follow set only on `loop_run_complete`, `loop_run_stopped`, or supervisor exit, in the same turn. Reattach an interrupted follow with the same retained ids. Interrupted follow is non-terminal. Cancelled wait is not completion.

After a confirmed terminal loop outcome, emit a final summary with starting-to-ending stage, elapsed time or transitions when available, PR URL when present, terminal state, the operator-authorized merge next step, and confirmation that follows stopped. After a confirmed terminal direct-advance outcome, emit the same fields for that advance. Merge is an operator-authorized next step, not an observer action. Premature supervisor exit is non-terminal failure/recovery, never completion.

`pipeline loop --audit` is a short synchronous read-only report. Drive and resume are long-running.

Supported loop selectors: `--milestone <name>`, `--label <label>`, `--range <spec>`, `--roadmap-slice <slice>`, and an explicit issue list (one or more issue numbers). Selector arguments are mutually exclusive with `--resume`. Combining a selector with `--resume` exits non-zero and names the conflict. `--audit` is read-only.

Diagnostic fallback for the raw loop stream: `<state-home>/runs/<loop_run_id>/events.jsonl`. State-home resolution order: `AGENT_PIPELINE_STATE_HOME` (preferred) or legacy `PIPELINE_STATE_HOME`; then `$XDG_STATE_HOME/agent-pipeline/loop`; then `~/.local/state/agent-pipeline/loop`. Do not use an informal `/tmp/pipeline-*.log` as the evidence contract.

Linked-advance follow remains required for complete mid-item stage progress until dense first-class loop progress ships (#611, #682). Re-attach after cancelled wait is #725. Loop-only follow covers schedule, hold, mirrored gate progress, and terminal loop events; it is insufficient alone for mid-item stage progress until those successors land.

### Material event kinds

Use `scripts/material-filter.mjs` on follow streams. Unfiltered `events.jsonl` stays the complete evidence file. Human-visible notify uses that material filter so test-gate output cannot surface fixture transitions for unrelated issue numbers, broad stdout matching cannot treat those lines as progress, and rapid duplicate notifications cannot auto-stop a host Monitor. The filter is a notification projection. It does not rewrite the run store.

Advance material kinds: `run_start`, `stage_start`, `stage_complete`, `pr_created`, `pr_updated`, `review_verdict`, `gate_result`, `blocker_set`, `blocker_cleared`, `run_complete`.

Loop material kinds: `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, `loop_item_advance_linked`, `loop_item_advance_finished`, `loop_item_stage_progress`, `loop_item_progress`, `loop_run_stopped`, `loop_run_complete`.

Optional loop kinds (burst-suppressed): `loop_schedule_evaluated`, `loop_reconciled`, `loop_merge_barrier_cleared`, `loop_item_paused`, `loop_item_waiting`, `loop_item_resumed`, `loop_item_abandoned`, `loop_item_skipped`, `loop_item_precondition_excluded`, `loop_recovery_attempt`, `loop_run_superseded`.

Definitive `loop_item_progress` statuses: `pass`, `fail`, `approve`, `needs_attention`, `attempted`, `success`, `exhausted`, `blocked`, `advanced`, `started`. Surface the first CI `waiting` in a stretch; suppress later identical waits. Suppress repeated CI `partial` and OpenSpec `skipped` outcomes.

Train material kinds: `run_start`, `train_work_list_resolved`, `train_wave_started`, `train_loop_linked`, `train_item_started`, `train_item_completed`, `train_pr_created`, `train_merge_attempted`, `train_merge_proven`, `train_merge_integrated`, `train_sibling_halted`, `train_wave_ended`, `run_complete`.

Train follow: parse `train_run_handoff` for `run_id`, then `pipeline logs <train-run-id> --events --follow` through the shared material filter. When `train_loop_linked` publishes a loop id, dual-follow that loop stream.

### Native `/goal` bootstrap

Starting a durable loop is an operator-owned two-step bootstrap inside a Claude Code session:

1. Run `/goal` to enter Claude Code's built-in autonomous mode.
2. Inside that `/goal` session, invoke `pipeline loop …`.

The Pipeline skill does not detect whether native goal mode is active. It does not invoke or re-enter that mode. It does not control the native goal session's lifecycle. Ending the native goal session is a host or operator action after `pipeline loop` reports its own terminal and reconciliation conditions. The skill neither ends that session nor merges.

### Adapters, update, lessons, artifacts, stages, release plan

Five local-CLI adapters: `claude`, `codex`, `grok`, `opencode`, `pi`. Login is operator-run before use. Similarly named effort levels are not comparable across harnesses.

| Adapter | Login | Example stage assignment |
| --- | --- | --- |
| `claude` | Run `claude` once to complete login | `harnesses: { implementer: claude }` |
| `codex` | `codex login` | `harnesses: { reviewer: codex }` |
| `grok` | `grok login` | `stage_executors: { implementing: grok-impl }` with a local-cli executor bound to `grok` |
| `opencode` | `opencode auth login` | `harnesses: { implementer: opencode }` |
| `pi` | Run `pi` once and complete `/login` | `harnesses: { implementer: pi }` |

Per-stage YAML example:

```yaml
harnesses:
  implementer: claude
  reviewer: codex
effort:
  implementing: medium
  review: high
```

Grok notify uses its outer-host manifest mapping (`grok_monitor_lines` / `monitor`). Portable fallback is stdout material lines via `events.jsonl` plus `material-filter.mjs`. Do not require Claude `PushNotification` on Grok.

Refresh an installed engine with:

```
npx github:accidental-hedge-fund/agent-pipeline update
```

Carry-forward lessons live in a maintainer-curated `## Lessons / Gotchas` section of the conventions file (`conventions_md_path`, else `CLAUDE.md`). No stage writes that file.

Local-only artifact paths (must stay gitignored): `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, `.agent-pipeline/history/`, `.agent-pipeline/evals/`, `.agent-pipeline/control-attributions.jsonl`, `.agent-pipeline/product-fault-reports.jsonl`, `.agent-pipeline/handoffs/`, `.agent-pipeline/outcomes/`, `.agent-pipeline/lineage/`, `.agent-pipeline/frg/`, `.agent-pipeline/harness-ownership/`, and `.agent-pipeline/factory-release/`.

Full stage inventory lives in living specs and engine `STAGES`, not in the generated SKILL. Loop selectors are documented above; see [cli.md](cli.md) for the generated verb inventory.

Release-plan rows live in `ROADMAP.md`. Columns: Release, Bump, Theme, Issues, Why. The unshipped row shape is `| **vX.Y.Z** | bump | theme | issues | why |`. `pipeline release <version>` prepares a release PR from the matching GitHub milestone plan. Release scaffolds a missing unshipped row when the `| *(none)* |` insert sentinel is present, or fails with remediation (file, copy-paste row, restore the sentinel) when it is not. `Ship milestone vX.Y.Z` maps to `pipeline ship --milestone vX.Y.Z`.

True-fast commands (`status`, `doctor`, read-only `pipeline loop --audit`) complete in seconds and need no Monitor. `status` completes in seconds. Loop drive/resume and `pipeline train` do not.
