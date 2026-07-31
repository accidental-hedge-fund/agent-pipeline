# agent-pipeline

**agent-pipeline** is a label-driven GitHub issue pipeline that advances an issue from backlog to `pipeline:ready-to-deploy` through a multi-stage state machine — planning → plan-review → implementing → design-gate → review → fix → pre-merge → visual-gate → eval-gate → shipcheck-gate. It does **not** auto-merge; you own the merge button.

It ships as a skill for **both Claude Code (`/pipeline`) and Codex (`$pipeline`)** from a single shared TypeScript core. **Both harnesses are required for every run**: one implements, and the other cross-reviews. By default, `/pipeline` uses Claude to implement and Codex to review; `$pipeline` inverts this. The pipeline is cross-harness by design — you cannot skip the reviewer install.

## Lifecycle

![agent-pipeline state machine — ready → deploy-ready, no human writes the code](docs/assets/state-machine.png)

`ready` is the queue/opt-in entry point. Once a run starts, long-running work is labelled and recorded under the concrete stages that are doing it: `planning`, `plan-review`, and `implementing`. Recoverable stops keep the active `pipeline:*` stage plus `blocked`; exhausted or ambiguous paths park at `needs-human`. The pipeline never guesses past uncertainty and never presses merge.

| Band | What happens |
| --- | --- |
| Spec before code | `planning` writes the implementation plan/spec, and when enabled, `plan-review` is **independent agent plan review** plus an optional **human feedback window** — not human sign-off. OpenSpec-backed repos reconcile and archive specs during `pre-merge`. |
| Structured review | Reviewers emit findings with severity, confidence, and file/line context. The same review input should lead to the same advance/block decision, not a model coin flip. |
| Bounded convergence | Review/fix rounds are capped by policy and guarded against recurring findings. If the run cannot converge cleanly, it stops with evidence instead of looping indefinitely. |
| Surgical fixes | `fix-1` and `fix-2` are scoped to reviewer findings. No opportunistic refactors, no scope creep, no destructive cleanup. |
| Gated stop | `pre-merge` checks CI, conflicts, mergeability, and spec archive. Optional `visual-gate`, `eval-gate`, and `shipcheck-gate` add further evidence before terminal. |
| Human merge | `ready-to-deploy` is terminal for the autonomous loop. A human owns the merge button. |

| Naive AI loop | agent-pipeline lifecycle |
| --- | --- |
| `prompt -> code -> merge` | `plan -> build -> review/fix -> gated stop` |
| Unreviewed, unbounded, opaque | Reviewed, bounded, audited, human-gated |

## Contents

- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [Install](#install)
- [Where to go next](#where-to-go-next)
- [Development](#development)
- [License](#license)

## Prerequisites

The pipeline is **cross-harness** — each run uses one CLI to implement and the *other* to review. **Both CLIs are required regardless of which host you install.**

- **Node ≥ 24** with **`npm`** (npm ships with Node and installs the core's dependencies — commander, js-yaml, zod). The core runs TypeScript directly via native type-stripping; no build step.
- **`git`** and **`gh`** on PATH, with `gh auth status` authenticated against the target repo.
- **Both `claude` and `codex` CLIs** on PATH and **authenticated** — each run uses one to implement and the other to review.
- **Review runs on the *other* harness, invoked directly** (`reviewMode: prompt-harness`): the reviewer CLI is called with the pipeline's own JSON-returning review prompt. **No review plugin is required** — you just need the other harness's CLI installed and authenticated.
- **Same-harness fallback (if the reviewer CLI is missing).** Cross-harness review is the design and the recommended setup. If the configured reviewer CLI is *not installed / not spawnable* at review time, the implementing harness reviews its own work instead, and every such review is **prominently labeled as a same-harness self-review**. A self-reviewed item still advances normally (the pipeline never merges). If *neither* harness is spawnable, the item blocks with a specific reason.
- `~/.agent-operating-contract.md` and a per-repo conventions file: `CLAUDE.md` (Claude) or `AGENTS.md` (Codex).
- **Optional:** the [OpenSpec](https://openspec.dev/) CLI (`npm i -g @fission-ai/openspec`) — only needed for repos that opt into the OpenSpec planning flow.
- No API keys — LLM budget comes from your `claude` / `codex` subscriptions.

The installer prints a prerequisite checklist during install (warnings do not block the install).

## Quickstart

**Step 1 — Install**

```bash
# Pinned to a released version (reproducible — recommended):
npx -y github:accidental-hedge-fund/agent-pipeline#v1.28.4 install

# Or track the latest default branch:
npx github:accidental-hedge-fund/agent-pipeline install
```

This detects which of `~/.claude` and `~/.codex` exist and installs to each. After installing for Codex, **restart Codex** to pick up the skill. Pin to a tag (`#v1.28.4`) for a reproducible install; the bare form tracks the latest default branch — see [Install a specific version](#install-a-specific-version).

**Step 2 — Label an issue and run**

```bash
# Create the pipeline:ready label if it doesn't exist yet
gh label create "pipeline:ready" --color 0075ca --description "Start the pipeline" 2>/dev/null || true

# Label any open issue to opt it in
gh issue edit N --add-label "pipeline:ready"
```

Then invoke from Claude Code:

```text
/pipeline N
```

Or from Codex (after restarting it):

```text
$pipeline N
```

The pipeline advances the issue through planning, implementation, cross-harness review, fix rounds, and pre-merge checks — without further manual input until it reaches a terminal or blocked state.

## Install

> Public repo under the `accidental-hedge-fund` org — no special access needed.

### Recommended: one command, both hosts

```bash
# Detects ~/.claude and ~/.codex; installs to each present host
npx github:accidental-hedge-fund/agent-pipeline install

# Or a specific host:
npx github:accidental-hedge-fund/agent-pipeline install --host claude
npx github:accidental-hedge-fund/agent-pipeline install --host codex
```

For a reproducible, non-interactive install — pin the released tag (`#v1.28.4`) and auto-accept the optional-dependency prompts with `--yes-deps`:

```bash
npx -y github:accidental-hedge-fund/agent-pipeline#v1.28.4 install --host claude --yes-deps
```

The bare commands above always track the **latest** default branch; add `#<tag>` to pin a release. The pipeline is **cross-harness** regardless of which host you install — `--host claude` only controls where the skill lands; the *other* harness's CLI is still required for review.

Or clone and run directly:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
node agent-pipeline/scripts/install.mjs install        # --host claude|codex|all  (default: all)
```

The installer copies the shared core and the right host overlay into `~/.claude/skills/pipeline` and/or `~/.codex/skills/pipeline`, writes a launcher shim, and pre-installs the core's dependencies. It honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. **Restart Codex** after a Codex install; Claude picks the skill up live.

After the core install, the installer may prompt for optional feature tools (OpenSpec CLI, last30days skill). Declining still completes the core install. Skip prompts with `--yes-deps` or `PIPELINE_INSTALL_DEPS=1`.

#### Claude as the primary harness (`/pipeline`)

Claude Code implements, Codex reviews.

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host claude
codex login                                            # the reviewer — review invokes `codex` directly
```

Review (`reviewMode: prompt-harness`) invokes the `codex` CLI directly with a JSON-returning prompt — **no review plugin needed**.

#### Codex as the primary harness (`$pipeline`)

Codex implements, Claude Code reviews.

```bash
npx github:accidental-hedge-fund/agent-pipeline install --host codex
claude auth login                                      # the reviewer — review invokes `claude` directly
```

Then restart Codex and run `$pipeline N`.

### Claude Code plugin marketplace (versioned, auto-updatable)

```text
/plugin marketplace add accidental-hedge-fund/agent-pipeline
/plugin install pipeline@ahf-tools
```

Update later with `/plugin marketplace update ahf-tools`.

### Install a specific version

```bash
npx -y github:accidental-hedge-fund/agent-pipeline#v1.28.4 install --host claude
```

Or clone and check out the tag:

```bash
gh repo clone accidental-hedge-fund/agent-pipeline
cd agent-pipeline && git checkout v1.28.4
node scripts/install.mjs install --host claude
```

Confirm what's installed with `pipeline --version` (or `/pipeline --version` / `$pipeline --version`).

### Updating an npx/clone install

```bash
npx github:accidental-hedge-fund/agent-pipeline update            # both hosts
npx github:accidental-hedge-fund/agent-pipeline update --host claude
```

Safe to re-run when `pipeline doctor` reports the install is behind the latest release.

### Onboarding a repo (optional convenience)

```text
/pipeline init
# or: $pipeline init
# or: pipeline init
```

Ensures pipeline labels, scaffolds a commented `.github/pipeline.yml`, and gitignores local artifact dirs. Additive — a normal `/pipeline N` still self-creates missing labels. See [concepts](docs/concepts.md) for details.

## Where to go next

| Doc | Contents |
| --- | --- |
| **[docs/cli.md](docs/cli.md)** | Full CLI reference (generated from the command registry) |
| **[docs/config.md](docs/config.md)** | `.github/pipeline.yml` key reference (generated from the Zod schema) |
| **[docs/concepts.md](docs/concepts.md)** | Gates, troubleshooting, dual-host packaging, advanced options |
| **[CHANGELOG.md](CHANGELOG.md)** | Per-version release history (generated from git tags) |
| **[ROADMAP.md](ROADMAP.md)** | Forward-looking release plan |

Configuration reference: start at [docs/config.md](docs/config.md). Common entry points:

```text
/pipeline status <N>          # or $pipeline:status <N>
/pipeline doctor
/pipeline intake --description "…"
```

The complete command inventory is in [docs/cli.md](docs/cli.md) — it is **not** hand-maintained in this README.

## Development

```bash
npm run setup-hooks               # one-time per clone: auto-regenerate plugin/ on core/ commits
cd core && npm ci && npm test     # node --test
node scripts/build.mjs            # regenerate plugin/ after editing core or the Claude overlay
node scripts/build.mjs --check    # CI gate: fail if committed plugin/ is stale
node scripts/generate-docs.mjs    # regenerate docs/cli.md, docs/config.md, CHANGELOG.md, SKILL tables
node scripts/generate-docs.mjs --check  # CI gate: fail if generated docs are stale
npm run ci                        # full CI (tests + mirror check + docs check + smokes + openspec)
```

After changing anything under `core/` or `hosts/claude/SKILL.md`, re-run `build.mjs` and commit the regenerated `plugin/`. After changing the command registry, command docs, or config schema, re-run `generate-docs.mjs` and commit the generated docs / SKILL regions.

## License

MIT License

Copyright (c) 2026 AHF

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
