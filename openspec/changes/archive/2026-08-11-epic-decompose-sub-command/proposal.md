## Why

agent-pipeline can intake one idea into one issue, roadmap-order an existing backlog, and loop-execute a selector — but it cannot take a large SPEC or Epic and fan it out into small, dependency-linked child issues that form a delivery roadmap. Operators today hand-split multi-capability epics, which burns a day of authoring and produces inconsistent dependency edges. Milestone **v1.42.0 — Work breakdown** lands a first-class `pipeline decompose` surface so cold-start or large incremental features become pipeline-ready children that existing `loop` / `queue` / merge-queue surfaces can execute without replacing those tools.

## What Changes

- Add `decompose` as a new **no-issue-number** positional sub-command keyword on the pipeline CLI (alongside `intake`, `sweep`, `roadmap`, etc.).
- **Default dry-run:** without `--apply`, print a proposed child graph (title, WHAT-not-HOW summary, AC outline, `depends_on`, effort) and perform **no** GitHub creates, branch/PR opens, or primary-checkout mutation.
- **`--apply`:** create **N** child issues with WHAT-not-HOW bodies, machine-usable dependency declarations consumable by existing work-list `depends_on` population, label parent as umbrella (`pipeline:epic`), open a **ROADMAP.md** update PR for human review — and **never** merge that PR or any child PR.
- Primary input: existing epic issue number (`--epic N`); optional `--description` seed to enrich decomposition context.
- Bounds: prefer S/M effort; refuse or force-split XL without override; configurable/CLI `max-children` / `max-effort`; cycle detection fails the preview (and apply) with a visible error.
- **Idempotent re-run:** re-decomposing the same epic does not create duplicate children.
- Parent remains umbrella and is **excluded from default milestone/label loop selectors**; explicit issue-number work lists may still name it.
- Compose only with existing surfaces — not a replacement for intake (1→1), sweep (re-spec existing), roadmap (order existing), or loop (execute).
- Docs: README + SKILL distinguish decompose from intake / roadmap-order-only / loop-execute.
- Unit tests with injectable harness/`gh`/git deps covering preview, apply, cycles, idempotency, and parent exclusion.

Out of scope (MVP — explicit follow-ups):

- Cold-start / greenfield pack from brief with little backlog (`--from-file` docs/OpenSpec convenience).
- OpenSpec-aware per-child (or parent+deltas) validate path.
- Pipeline Desk / UI binding.
- Auto-merge; replacing intake/sweep/roadmap; distributed fleet work.

## Acceptance criteria

- [ ] `pipeline decompose` is accepted as a no-issue-number keyword; help text lists it alongside peer authoring commands.
- [ ] Without `--apply`, the command prints proposed children (title, summary, AC outline, deps, effort) and creates no GitHub issues, no branch/PR, and no primary-checkout mutation.
- [ ] With `--apply --epic N`, the command creates N child issues whose bodies follow WHAT-not-HOW (Summary, User story, Acceptance criteria, Out of scope) and carry machine-usable dependency declarations for the shared declared-dependency grammar.
- [ ] Child issues receive a pipeline triage label: `pipeline:ready` when decision-complete, otherwise `pipeline:backlog` (documented and consistent).
- [ ] Parent epic remains open as umbrella, is labeled `pipeline:epic`, and is referenced from each child; parent is excluded from default milestone and label loop selectors; explicit issue-list selectors may still include it.
- [ ] Preview and apply refuse dependency cycles with a non-zero exit and a message naming the cycle; no silent cycle acceptance.
- [ ] Effort policy prefers S/M; proposals that require XL (or exceed max-effort) fail or force-split unless an explicit override is supplied; max children is bounded by config and CLI.
- [ ] `--apply` opens a ROADMAP.md PR targeting the default branch and never commits to the default branch and never merges.
- [ ] Re-running decompose for the same epic does not create duplicate child issues (idempotent apply).
- [ ] Unit tests inject harness/`gh`/git deps and cover preview, apply, cycles, idempotency, and parent exclusion with no real network, git, or subprocess in those tests.
- [ ] README and host SKILL document decompose as distinct from intake, roadmap, and loop.
- [ ] OpenSpec change validates; after implementation, `npm run ci` passes including mirror and docs gates.

## Capabilities

### New Capabilities

- `decompose-sub-command`: The `pipeline decompose` no-issue-number command — CLI dispatch, dry-run default, epic-seeded work breakdown, child issue creation, dependency edges, sizing bounds, cycle detection, idempotent re-run, parent umbrella disposition, and ROADMAP PR delivery (never merge).

### Modified Capabilities

- `pipeline-state-machine`: CLI positional dispatch gains `decompose` as a recognized no-issue-number keyword that does not advance stage labels.
- `command-registry`: Registry gains a `decompose` entry with correct metadata (`needsIssueNumber: false`, allowlisted flags, mutates GitHub only under `--apply`).

## Impact

- `core/scripts/pipeline.ts` — dispatch, help text, flag wiring (`--epic`, `--description`, `--apply`, `--release`, `--max-children`, `--max-effort`, override flags).
- `core/scripts/command-registry.ts` — `decompose` entry.
- `core/scripts/stages/decompose.ts` (new) — handler + injectable deps seam.
- `core/scripts/prompts/` — decomposition harness prompt (WHAT-not-HOW children + deps + effort).
- Loop/selector resolution — default milestone/label exclusion for `pipeline:epic`.
- Config schema (optional `decompose` block: max children, max effort defaults).
- `core/test/decompose*.test.ts` — unit coverage.
- `plugin/` mirror regeneration after any `core/` or host SKILL change.
- `README.md`, `hosts/claude/SKILL.md` / Codex skill surfaces — document the command.
- ROADMAP mutation helpers (reuse intake/release patterns for PR-only delivery).
