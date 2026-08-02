# Concepts & advanced topics

Hand-authored companion to the lean [README](../README.md). For the full **CLI inventory** see [cli.md](cli.md); for **config keys** see [config.md](config.md). This page does not re-list every command or config field.

A newcomer who completed Prerequisites, Install, and Quickstart in the README has a working setup **without** reading this page. Sections below are optional or advanced unless noted.

## Contents

- [How the two hosts share one core](#how-the-two-hosts-share-one-core)
- [Onboarding details](#onboarding-details)
- [Test/build gate](#testbuild-gate-optional-default-on)
- [Configurable steps (optional)](#configurable-steps-optional)
- [Human plan feedback (optional)](#human-plan-feedback-optional)
- [Review severity policy & audited overrides](#review-severity-policy--audited-overrides)
- [Design-interrogation gate (optional, default off)](#design-interrogation-gate-optional-default-off)
- [Visual gate (optional, default off)](#visual-gate-optional-default-off)
- [Eval gate (optional, default off)](#eval-gate-optional-default-off)
- [Shipcheck gate (optional, default off)](#shipcheck-gate-optional-default-off)
- [OpenSpec integration (optional)](#openspec-integration-optional)
- [last30days context (optional, default off)](#last30days-context-optional-default-off)
- [Commit traceability trailers (always on)](#commit-traceability-trailers-always-on)
- [Conventions & carry-forward lessons](#conventions--carry-forward-lessons)
- [Troubleshooting](#troubleshooting)
- [Desktop / editor integration](#desktop--editor-integration)
- [Repository layout](#repository-layout)

## How the two hosts share one core

Claude Code (`/pipeline`) and Codex (`$pipeline`) share one TypeScript engine under `core/`. Host-specific packaging lives in `hosts/claude` and `hosts/codex`; the Claude host also feeds the generated `plugin/` marketplace mirror. Dispatch, stages, review policy, and merge posture are identical across hosts — only the invocation token and install profile (who implements vs who reviews by default) differ.

## Onboarding details

`pipeline init` / `/pipeline:init`:

- Creates the standard `pipeline:*` labels if missing
- Scaffolds `.github/pipeline.yml` with documented defaults
- Ensures local-only paths under `.agent-pipeline/` are gitignored

Ignored local paths (must never be committed): `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`, `.agent-pipeline/history/`. Without that gitignore block, the first run can leave the worktree dirty and fail `pipeline doctor`'s `worktree-clean` check.

After `init`, commit the config, label an issue `pipeline:ready`, and run `/pipeline N` or `$pipeline N`.

## Test/build gate (optional, default on)

Before opening a PR, the pipeline can run the repo's own tests/build (`test_gate` in `.github/pipeline.yml`). Default **enabled**. On failure it routes to a bounded fix loop (`max_attempts`), then blocks with evidence. Set `test_gate.enabled: false` to disable. See [config.md](config.md) for keys.

The repo's own `test_gate.command` is typically `npm run ci`, which includes core tests, the `plugin/` mirror check, install-smoke, OpenSpec validation when present, **conditional docs freshness** (`ci:docs`), and scripts tests.

## Configurable steps (optional)

The `steps` block turns thoroughness steps on or off per repo:

- `plan_review` — cross-harness review of the plan before coding
- `standard_review` / `adversarial_review` — review-1 / review-2 and their fix rounds
- `docs` — include docs-update instructions in the implementing prompt

Structural safety steps (planning, implementing, pre-merge CI/mergeability) are **not** toggles. Unknown keys under `steps` are rejected at parse time.

Review verdicts are pinned to the commit they evaluated. Before pre-merge acts on a prior approval it re-checks that SHA against HEAD; a developer/fix commit after the verdict invalidates it and re-enters review. Pipeline-internal commits (docs/chore archive, etc.) do not.

### Human plan feedback

When `plan_review` is on, the pipeline posts an `## Implementation Plan` comment and runs agent plan review via the configured reviewer / secondary harness. When that reviewer is available, this is **independent agent plan review** — the plan-review control when the step is enabled, agent evidence, **not** human approval or human sign-off. If the reviewer CLI is missing or unspawnable, the same-harness fallback applies instead: the implementing harness reviews its own plan, and the posted plan review is **prominently labeled as a same-harness self-review**. That degraded path is still plan-review evidence and still advances (the pipeline never merges), but it is **not** independent agent plan review.

During the **human feedback window** after the plan is posted, comments you leave before the revision step are optional steering: they are folded into the revision alongside the reviewer's feedback. Any comment posted after the plan that doesn't start with a pipeline header is treated as human input.

When the feedback window ends with **no** human comments, plan revision proceeds from agent plan-review feedback only: missing human input **does not block the advance** and is **not recorded as human approval**. With no human comments, behavior is byte-for-byte identical to the agent-only path.

When human comments are present, the revised plan comment attributes contributors, and the revision **must** end with a `## Human Feedback Acknowledgement` section listing each commenter as `addressed — <reason>` or `declined — <reason>`.

**Authority boundary:** when the reviewer harness runs, independent agent plan review is the plan-review control; when same-harness fallback applies, the labeled self-review is the plan-review evidence and is **not** independent; the human feedback window is optional steering; **human attestation** (pipeline output markers / operator capability attestations) is provenance, not plan sign-off; **human approval / sign-off** remains the merge button at `ready-to-deploy` (and other true human-approval gates such as `needs-human` dispositions).

## Review severity policy & audited overrides

`review_policy` controls which findings block vs advise (`block_threshold`, `min_confidence`, round caps). Defaults favor fixing real issues over silent advise-past. See [config.md](config.md).

**Overrides** disposition a specific blocking finding and auto-resume:

```text
/pipeline N --override "<override-key>: rejected — <why>"
/pipeline N --override "category:rollback-safety: deferred #90 — tracked separately"
```

Overrides are audited in issue comments. The pipeline still never merges.

## Design-interrogation gate (optional, default off)

`design_gate` sits between `implementing` and `review-1`. It is inert unless enabled **and** a risk trigger matches. When it fires, the implementer records material design decisions; an independent reviewer challenges them under bounded rounds. No merge/release authority. See [config.md](config.md) for `triggers`, thresholds, and limits.

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

## Conventions & carry-forward lessons

Stage prompts embed an excerpt of the target repo's conventions file (`CLAUDE.md` / `AGENTS.md`, or `conventions_md_path`). The pipeline **only reads** that file — never writes it. Maintainers curate carry-forward lessons by hand.

## Troubleshooting

### Pipeline is blocked

```text
/pipeline:status N
/pipeline:doctor
```

Common outcomes: missing reviewer CLI (same-harness fallback or block), CI red, merge conflicts, review ceiling → `needs-human`, OpenSpec invalid. Use `/pipeline:unblock` or `/pipeline:override` as appropriate, or fix and re-label.

### Evidence bundle

Each run writes a local evidence bundle under `.agent-pipeline/runs/`. `pipeline summary <run-id>` (or issue-scoped summary) prints it offline.

### External event sink (optional)

`event_sink` can forward `events.jsonl` records to an operator-controlled command. Unset → local events only. See [config.md](config.md).

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
| `plugin/` | Generated mirror of `core/` + Claude host — do not hand-edit |
| `scripts/build.mjs` | Generate/check the plugin mirror |
| `scripts/generate-docs.mjs` | Generate/check CLI, config, CHANGELOG, SKILL command tables |
| `docs/` | Operator docs (`cli.md`, `config.md`, `concepts.md`) |
| `openspec/` | Living specs + in-flight changes |
| `ROADMAP.md` | Forward plan only |
| `CHANGELOG.md` | Generated release history |

## Generated docs contract

CLI and config references plus `CHANGELOG.md` and host SKILL command-table regions are **generated**. After changing `command-registry.ts` / `command-docs.ts`, the Zod schema in `config.ts`, or release tags:

```bash
node scripts/generate-docs.mjs
# or
npm run docs:generate
```

`npm run docs:check` / `node scripts/generate-docs.mjs --check` fails when committed artifacts are stale (same idea as `build.mjs --check` for `plugin/`).
