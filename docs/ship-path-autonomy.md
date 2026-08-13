# Ship-path autonomy doctrine

Short factory memory for operators and agents. Long rationale lives in epic
[#1028](https://github.com/figid-ai/agent-pipeline/issues/1028) and spine issues
#1020 / #1023 / #1025 / #1021. This page is the pin-sized constitution.

Related: [concepts](./concepts.md) · [supervisor contract](./supervisor.md)

## 1. Ship path

`pipeline train` advances over **base-eligible frontiers** via the loop/advance
wave. When merge is authorized, an optional serial **merge barrier** integrates
code-stacked dependencies so a child can land on base after its parent.

That is **not**:

- N× `pipeline single` STOP shells as a fake train
- “all ready-to-deploy, then merge everything” when a child still needs parent
  commits on base

Ordinary `advance` / `single` / `loop` stop at `pipeline:ready-to-deploy` and
never merge.

## 2. Recovery ladder

When a ship-path item fails, recover in this order:

1. **Classify** the failure (scratch identity, stale labels, capacity, workflow
   engine, true human authority, product judgment).
2. **Deterministic recipe** first: unlink scratch, resync, pin head, clear
   stale block — engine-owned, not operator janitor work.
3. **Verify** / re-review / rerun CI as the class requires.
4. **Bounded model repair** (`repair_pipeline_item` / fix harness) only after
   the deterministic path is exhausted or inapplicable.
5. **Real human handoff** only for human-authority classes (product judgment,
   missing authority). That path is handoff such as #647 — not scratch cleanup.

## 3. False human vs real human

**Not** true `human-decision-required` / janitor work:

- engine scratch and identity drift
- stale labels or workflow-engine defects
- capacity and host-local lock contention that the engine can clear or requeue

**Real** human / wait:

- product judgment only a human can make
- missing authority or sign-off
- external capability the run cannot obtain

Do not park engine-owned faults as `needs-human` and wait for a human to delete
files or re-label by hand.

## 4. Class over site

Engine dogfood failures must fix the **shared** classifier, recipe, gate
adoption, or controller. A pure path-local patch is incomplete unless it also
lands the class law so the next identical fault does not need a new mole issue
(#1013 → #1017 → #1020 pattern).

When planning or intake authors engine/self-host/ship-path-recover work, the
plan or issue body must answer:

1. **class vs site** — shared surface vs path-local only
2. **which shared surfaces** change (classifier / recipe / gate / controller)
3. **non-recurrence** — how the next identical fault does not require a new mole

Spot-fix-only / path-local-only plans are insufficient for that class.

## 5. Anti-goals

- Threshold → general LLM as the **first** recoverer
- A second recoverer inside `train.ts`
- PR stacking onto a parent PR head (prefer base-eligible + merge barrier)
- Merge inside `advance` / `loop` (merge stays operator-authorized and
  loop-isolated)
- Reversing papercut backlog policy (#538) for papercuts

## Coexistence with surgical fix

Ordinary **product review findings** still use surgical minimal-diff,
destructive-operation guard, and pre-commit self-check. Ship-path autonomy
**adds** factory-class judgment for engine recovery, pipeline self-host, and
dogfood autonomy work. It does not authorize always-broaden product fixes.

## Prompt pin

Harness plan / implement / fix / intake (and related authoring) runs inject a
versioned short preamble derived from this doctrine. Marker:

`<!-- pipeline-ship-path-autonomy: v1 -->`

Bump the marker version when this constitution changes in a way that must reach
every new harness process.
