## Context

See `proposal.md` for motivation. Existing surfaces already cover:

| Surface | Role today |
|---------|------------|
| `pipeline intake` | 1 description → **1** issue + ROADMAP PR |
| `pipeline sweep` | Re-spec thin **existing** issues |
| `pipeline roadmap` | Order/score **existing** backlog |
| `pipeline loop` / queue | Execute a selector to R2D |
| `declared-dependency-grammar` + work-list population | **Consume** `depends_on` edges |

Missing: **author** a multi-child dependency graph from one epic, then hand off to those consumers.

Constraints that shape the design:

- Advance/loop never merge; authoring commands that open ROADMAP PRs (`intake`, `sweep --apply`, roadmap writeback) never merge either.
- Unit tests inject deps — no real network/git/subprocess.
- Edit `core/`, regenerate `plugin/` in the same change.
- Shared lexical grammar is the only free-text dependency parser; decompose must **write** edges the grammar can **read**.
- Selector resolution for loop lives in `resolveSelectorWorkList` (`pipeline.ts`); parent exclusion must plug in there (or a pure helper it calls), not only in docs.

## Goals / Non-Goals

**Goals:**

- One `stages/decompose.ts` handler with an injectable `DecomposeDeps` seam mirroring intake/sweep.
- Dry-run default identical in spirit to `sweep` / `roadmap` (`--apply` gates writes).
- Deterministic post-plan steps: validate bounds → detect cycles → idempotency match → create/label → ROADMAP PR.
- Parent umbrella label + selector exclusion so default milestone/label loops execute children, not the epic shell.
- ROADMAP delivery isolated from the operator primary checkout (throwaway worktree or existing isolation helper).

**Non-Goals:**

- Cold-start from file/OpenSpec path (`--from-file`).
- Per-child OpenSpec change scaffolding or `openspec validate` on children.
- Desk/UI binding; auto-merge; inventing edges from file similarity or list order beyond the harness plan.
- Replacing intake/sweep/roadmap/loop.
- Cross-host locking of decompose apply (host-local is enough; GitHub issues are the source of truth for idempotency).

## Decisions

### Decision 1 — New keyword `decompose`, not a flag on intake or roadmap

**Choice:** Positional `pipeline decompose` with its own registry entry and stage module.

**Why:** Intake is 1→1 with a different failure and reservation contract. Roadmap orders existing inventory. Sweep re-specs thin bodies. Decompose **creates N linked issues** — different mutability, idempotency, and UX. Alternatives rejected: `intake --epic` (overloads 1→1 contract); `roadmap --decompose` (roadmap is scoring/ordering, not issue authoring).

### Decision 2 — Dry-run default; `--apply` gates all irreversible writes

**Choice:** Match `sweep` / `roadmap`: no `--apply` ⇒ preview only. No separate `--dry-run` flag required for MVP (optional alias later if help consistency demands it).

**Why:** Operator-invoked authoring must not spam the backlog by default. Spec and acceptance criteria require zero creates without `--apply`.

### Decision 3 — One harness call returns a structured plan; rest is deterministic

**Choice:** Single model harness invocation with a JSON (or strictly parseable) plan schema:

```text
{
  children: [
    {
      key: string,          // stable plan identity for idempotency
      title: string,
      summary: string,
      user_story: string,
      acceptance_criteria: string[],
      out_of_scope: string[],
      open_questions?: string[],
      effort: "S" | "M" | "L" | "XL",
      depends_on_keys: string[]  // sibling keys, not issue numbers yet
    }
  ]
}
```

Map `depends_on_keys` → real issue numbers after create (or after idempotent match). Write body dependency lines using grammar-legal phrases (`Depends on: #N, #M`) and a `## Dependencies` section for redundancy.

**Why:** Intake/sweep already use one harness call then deterministic GitHub/ROADMAP steps. Sibling keys avoid the chicken-and-egg of unknown issue numbers during planning. Alternatives rejected: N harness calls per child (cost + inconsistent graph); freeform markdown-only plan (harder to validate cycles/bounds).

### Decision 4 — Sizing defaults and bounds

**Choice:**

| Bound | Default | Override |
|-------|---------|----------|
| `max_children` | 12 | CLI `--max-children`, config `decompose.max_children` |
| `max_effort` | `M` | CLI `--max-effort`, config `decompose.max_effort` |
| XL / above max | refuse | explicit `--allow-xl` (or equivalent single override) |

`L` is allowed only when `max_effort` is raised to `L` or higher. Refuse entire plan on violation (no partial apply).

**Why:** Issue acceptance criteria require bounded children and S/M preference without silent backlog spam.

### Decision 5 — Cycle detection on the plan graph before any create

**Choice:** Pure function over adjacency of plan keys (and any edges to existing issue ids in the plan). Fail closed with named cycle path.

**Why:** Work-list compile also refuses cycles, but detecting at authoring time prevents orphan children. Reuse the same DFS/Kahn style as `compileContractItems` if a pure export exists; otherwise a small pure helper under decompose with unit tests.

### Decision 6 — Parent label `pipeline:epic` + selector exclusion

**Choice:**

1. Ensure label `pipeline:epic` (create-only).
2. On apply, add it to the parent.
3. In `resolveSelectorWorkList`, for `milestone` and `label` selectors, drop issues whose labels include `pipeline:epic`.
4. Explicit work-list selectors unchanged.

**Why:** Issue requires parent excluded from **default** loop selectors without blocking intentional `pipeline loop 123` on the epic number. Alternatives rejected: only omit `pipeline:ready` on parent (milestone selectors would still pull it); close the parent (loses umbrella tracking).

### Decision 7 — Child triage: ready vs backlog

**Choice:** If `open_questions` is empty/absent → `pipeline:ready`; else `pipeline:backlog`. Document in README/SKILL.

**Why:** Matches “decision-complete → ready” language in the issue; keeps incomplete children out of ready selectors until refined (sweep/refine-spec).

### Decision 8 — Idempotency via provenance marker + stable `key`

**Choice:** Embed in each child body:

```html
<!-- pipeline-decompose: parent=#123 key=<slug> -->
```

plus human-visible `Parent epic: #123`. On re-apply, list open issues (or search) for markers with that parent; match by `key`; skip create when matched; create only missing keys if the plan grew (document: additive re-run may add new keys; never duplicate same key).

**Why:** Title-only matching collides and renames break. Markers are stable and testable. Alternatives rejected: GitHub project fields (extra API surface); native sub-issues only (not portable enough as sole source yet).

### Decision 9 — ROADMAP PR pattern

**Choice:** Reuse intake-style three-structure mutation where applicable (release-plan row / per-issue rows / detail bullets for each child under target release), or a single epic section that lists children with deps — prefer **per-child rows consistent with intake** so roadmap reconcile remains honest. Branch name collision-resistant (`decompose/<epic>-<token>`). Open PR; never merge. Use throwaway worktree isolation consistent with roadmap writeback isolation where feasible.

**Why:** Operators already review intake ROADMAP PRs; same review path. Default-branch commits are forbidden by golden rules and issue AC.

### Decision 10 — Compose with consumers; do not reimplement loop

**Choice:** After apply, success output prints suggested next command, e.g. `pipeline loop --milestone <lane>` or label selector for children. No auto-start of loop from decompose.

**Why:** Keeps operator authority and merge policy intact.

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| Harness returns inconsistent or cyclic graph | Schema validation + cycle/bound checks fail closed before writes |
| Partial apply (some children created, then crash) | Create in deterministic key order; idempotent re-run fills missing keys; surface partial state in error |
| ROADMAP PR races with concurrent intake | Collision-resistant branch; PR never force-pushes unrelated refs; pin base SHA like intake |
| Epic label exclusion surprises operators who used `epic:foo` theme labels | Only `pipeline:epic` is excluded; theme `epic:*` labels remain for roadmap grouping |
| Large epics blow token budget | `max_children` bound; prompt asks for vertical S/M slices; refuse XL without override |
| Duplicate children if marker stripped by humans | Treat missing markers as non-owned; optional title+parent heuristic only as soft warning in dry-run, not as sole create gate |

## Migration Plan

1. Ship command behind normal release train (milestone v1.42.0); no data migration.
2. Existing epics without `pipeline:epic` are unchanged until an operator runs decompose or labels them.
3. Rollback: remove/ignore the command entry; leftover labels and children remain valid backlog items.

## Open Questions

- Exact default for `--release` when omitted: propose next open ROADMAP lane (intake-like) vs leave children without `release:*` until roadmap PR assigns lanes. **Lean intake-like proposal** unless ROADMAP parse fails, then create children without release label and still open PR with rationale.
- Whether additive re-run (new keys only) should require `--extend` vs default. **Lean default additive for new keys, never recreate matched keys** — document in SKILL.
