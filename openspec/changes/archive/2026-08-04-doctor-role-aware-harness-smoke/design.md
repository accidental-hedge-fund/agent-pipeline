## Context

Today’s doctor path (`core/scripts/stages/doctor.ts`) is **static and model-free**: PATH/auth
probes, package state, OpenSpec availability, registry-driven harness readiness via
`adapter.preflight` / `adapter.runtimeSmoke`, prompt-byte coherence, etc. The adapter extension
registry (#783) already requires a cheap `runtimeSmoke` hook distinct from full stage invocation.
Production preflight-on-invoke (#636) fails closed on the exact resolved treatment **before** a
production stage spawn, but still does not prove that a live authenticated CLI can complete a
role-shaped turn, produce trailers, or emit contract-valid output.

`harness-adapters.test.ts` / the conformance kit assert interface members only. Mid-stage
failures from auth expiry, version drift, flag deprecation (#613), output-shape drift, and
detached PATH/env gaps remain invisible until expensive pipeline work has started.

Issue #780 (with the 2026-07-31 reconciliation upsert) asks for a **dynamic**, **registry-driven**,
**role-aware**, **treatment-exact** smoke under `pipeline doctor --harness-smoke` that is standalone
and promotion-gate ready, while keeping unit tests free of real subprocess I/O.

**Spec conflict to resolve deliberately:** living `doctor-preflight` currently says doctor SHALL
NOT invoke a language model “under any circumstances.” This change scopes that rule to the
default/static doctor path and carves an explicit opt-in exception for `--harness-smoke`. That is
not a silent average of rules — default doctor stays free; only the named flag spends tokens.

## Goals / Non-Goals

**Goals:**

1. Opt-in `pipeline doctor --harness-smoke` exercises every unique **configured**
   adapter/role/model/effort treatment with a cheap canned prompt in an isolated scratch repo.
2. Implementer smoke asserts mutation + trailers + output contract + optional telemetry.
3. Reviewer smoke asserts structured read-only verdict + no mutation + optional telemetry; no
   commit requirement for reviewer-only adapters.
4. Consume #783 declared readiness/`runtimeSmoke` hooks before the model call when useful.
5. Fold results into doctor’s human summary and `--json` envelope; non-zero exit on any smoke fail.
6. Unit-test orchestration through a deps seam; keep real CLI smoke out of `npm test`.
7. Document expected model spend in command help.

**Non-Goals:**

- Owning or re-implementing #636 static production preflight-on-invoke.
- Eval inventory / corpus / tier work (#600 / #602 / #603).
- Running harness smoke on every `pipeline doctor` by default or on every advance.
- Expanding CI unit suite to require live authenticated CLIs.
- Weakening review rigor, merge authority, or inventing ambient model defaults.
- Requiring every registered-but-unassigned adapter to be smoked.

## Decisions

### Decision 1 — Opt-in flag on `doctor`, not a separate top-level command

**Chosen:** `pipeline doctor --harness-smoke` (optionally composable with existing doctor flags such
as `--json` / `--fail-fast` where coherent).

**Rejected:** A new top-level `pipeline harness-smoke` command that forks doctor UX and JSON
shapes.

**Why.** Operators already reach for `doctor` for readiness. Reusing the summary/`--json`/exit-code
contract reduces surface area. Default doctor remains seconds-fast and free; the flag makes cost
explicit.

### Decision 2 — Two layers: declared readiness, then role-aware canned turn

**Chosen:**

1. **Readiness phase:** call the adapter’s declared `runtimeSmoke` (and/or preflight with the
   exact treatment model/effort when available). Fail the treatment early without a model call when
   readiness fails.
2. **Dynamic phase:** spawn the real CLI with a role-specific canned prompt in a throwaway scratch
   repository (git init + trivial file tree), using the exact configured model/effort when set.

**Rejected:** Only calling `runtimeSmoke` (already #783; does not prove trailers/contracts).
**Rejected:** Only full stage prompts (too expensive; not a “cheap” smoke).

**Why.** Matches the issue’s “consume adapter-declared smoke hooks” + E2E contract assertions
without turning doctor into a mini advance loop.

### Decision 3 — Role-specific success criteria (do not force commits on reviewers)

| Role | Spawn exit 0 | Commit + required trailers | Output contract | No repo mutation | Telemetry parse (when declared) |
| --- | --- | --- | --- | --- | --- |
| Implementer | required | required | required (implementer-facing smoke contract id) | N/A (mutation allowed in scratch) | required if adapter declares telemetry |
| Reviewer | required | **not** required | required (`review.verdict@1` or smoke-scoped equivalent) | required | required if adapter declares telemetry |

**Why.** Reviewer adapters are read-only by product contract; requiring commits would falsely fail
reviewer-only adapters and encourage unsafe “make a dummy commit” behavior in review mode.

### Decision 4 — Treatment set = unique configured coordinates, not all registered adapters

**Chosen:** Build the smoke plan from active configuration: resolved implementer and reviewer
adapter IDs, plus the model/effort values resolved for representative implementer-side and
reviewer-side stages (or the role-level `models.*` / `effort.*` / `review_harness` settings the
engine already resolves). Deduplicate identical `{adapter, role, model, effort}` tuples so the
same coordinate is not paid for twice. Include built-in and externally registered adapters when
configured. Unassigned registered adapters MAY be skipped.

**Rejected:** Smoke every registered adapter regardless of config (wastes tokens; not “configured”).
**Rejected:** Hardcoded claude/codex-only list (regresses #783 registry authority).

**Why.** Issue text and reconciliation upsert both require “every unique configured …
coordinate,” registry-driven.

### Decision 5 — Throwaway scratch repo, never the operator worktree

**Chosen:** Create an isolated temp directory, `git init`, minimal content, run the smoke with
cwd set to that root, assert, then clean up (best-effort). Never mutate the calling worktree or a
pipeline managed worktree for smoke side effects.

**Why.** Implementer smoke must be allowed to commit; polluting the operator tree would break
doctor’s own worktree-clean expectations and risk destructive mistakes.

### Decision 6 — Output contract reuse, not a parallel validator tree

**Chosen:** Implementer smoke validates product output through the central stage-output-contract
layer (#777) using a dedicated smoke-oriented contract id **or** an existing implementer-facing
contract that the canned prompt is designed to satisfy. Reviewer smoke validates through
`review.verdict@1` (or the same schema-backed path production review uses). Do not fork a second
JSON schema for verdicts.

**Why.** Drift between production validators and smoke validators would make the promotion gate
lie.

### Decision 7 — Deps seam for orchestration; live I/O only on real path

**Chosen:** Expose a `HarnessSmokeDeps` (name flexible) with injectable primitives for: treatment
enumeration inputs, scratch repo create/cleanup, adapter readiness invoke, harness spawn/capture,
git log/trailer inspect, contract validate, telemetry parse. Unit tests inject fakes and assert
planning, short-circuit, role assertions, and exit aggregation. The real deps implementation
performs subprocess I/O and is **not** imported by the unit-test suite’s network/git/subprocess
ban.

**Why.** Matches repo golden rule: unit tests do no real network/git/subprocess; live smoke is
intentionally outside that suite.

### Decision 8 — Composition with default doctor checks

**Chosen:** When `--harness-smoke` is set, run static doctor checks first (or interleave as today),
then run smoke treatments. Overall exit is non-zero if **any** static check or smoke treatment
fails. `--json` includes smoke results as named check records (or a nested `smoke` array with
stable names like `harness-smoke:<adapter>:<role>`). `--fail-fast` MAY stop after the first
failing smoke treatment once that mode is honored for doctor checks today.

**Why.** Operators want one command that answers “is this host ready for real work?” without
losing static signals.

### Decision 9 — Cost disclosure

**Chosen:** Help text (and prose/JSON summary footer when smoke runs) states that the smoke
performs approximately **one cheap model call per unique configured treatment** and may incur
provider cost/latency. No silent multi-call repair loops inside smoke by default (format-repair
budget remains 0 or at most the shared production default only if product requires it —
prefer fail-closed on pure shape fail for smoke to keep cost predictable).

**Why.** Issue explicitly requires spend documentation; surprise cost is a product failure mode.

## Risks / Trade-offs

- **[Risk] Spec conflict with model-free doctor** → **Mitigation:** MODIFIED `doctor-preflight`
  requirement that scopes “no model calls” to invocations without `--harness-smoke`; default path
  tests remain green.
- **[Risk] Flaky live smoke (provider outages, rate limits)** → **Mitigation:** clear failure
  class/remediation; smoke is opt-in and not part of CI unit suite; promotion-gate consumers can
  retry or quarantine.
- **[Risk] Cost growth with many treatments** → **Mitigation:** dedupe coordinates; cheap canned
  prompts; help-text spend disclosure; only configured treatments.
- **[Risk] Implementer smoke commits pollute environment** → **Mitigation:** scratch-only cwd +
  cleanup; never use managed worktree or protected branches.
- **[Risk] Canned prompt diverges from production stage contracts** → **Mitigation:** reuse
  central validators; document which contract ids smoke asserts; drift-guard unit test that smoke
  references registered contract ids.
- **[Risk] Detached PATH bugs not reproduced in doctor’s env** → **Mitigation:** smoke runs in the
  same process environment as doctor (operator’s shell); document that promotion gate should run
  under the same env as detached advance; absolute-exec resolution remains #636’s job.
- **[Risk] Reviewer adapters that cannot emit pure JSON without tools** → **Mitigation:**
  adapter-declared smoke guidance + failure remediation naming the adapter; do not silently skip
  contract validation.

## Migration Plan

1. Land flag + orchestration behind injected deps with unit tests (no live CLI required for CI).
2. Document help text and host SKILL snippets for `--harness-smoke`.
3. Operators run smoke manually; companion promotion-gate issue wires it as step 1 later.
4. Rollback: remove or ignore the flag; default doctor path unchanged.

## Open Questions

1. **Exact implementer smoke contract id** — use a dedicated `harness-smoke.implementer@1` that
   requires a tiny structured ack, or reuse an existing implementer-facing contract with a prompt
   designed to satisfy it? Prefer a dedicated cheap smoke contract if production contracts are too
   heavy for a one-shot cheap call; decide at implementation with minimal prompt text.
2. **Representative model/effort selection** — if many stages share an adapter but differ only by
   effort, smoke every unique pair vs pick one representative per role? Spec requires unique
   configured coordinates; implementation enumerates the resolved role-level (and any
   stage-distinct configured) pairs without inventing extras.
3. **Whether `--harness-smoke` implies running static doctor checks** — default yes (Decision 8);
   allow `--harness-smoke-only` only if implementation finds a real operator need (not required for
   v1).
