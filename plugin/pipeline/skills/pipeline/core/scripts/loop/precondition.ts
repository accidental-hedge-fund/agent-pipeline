// Loop precondition stage gate (#568, capability `loop-precondition-stage-gate`).
//
// A work-list item is admissible to the executable frontier only once it has reached the
// `pipeline:ready` precondition — `/pipeline` itself refuses to start work on a pre-`ready`
// item, so dispatching one is always a 0-transition no-op, never a genuine engine defect. This
// module is the pure classification step: given the contract and a ledger whose current-cycle
// reconciliation has already observed each item's live `pipeline:*` stage (loop/reconcile.ts),
// it decides which `pending` items are pre-pipeline and must be excluded this cycle, and builds
// the pruned contract the scheduler (loop/schedule.ts) evaluates instead.
//
// See openspec/changes/loop-precondition-stage-gate/design.md decisions 1-2: exclusion (not
// auto-promotion) evaluated against live truth each reconciliation pass, never frozen into the
// compiled contract or the run's identity. Pure — no gh, git, fs, clock, or store access.

import { LABEL_PREFIX } from "../types.ts";
import type { LoopContract, LoopLedger, LoopPreconditionExclusion } from "./types.ts";

/** The pipeline stage label required for a work-list item to be admissible. */
export const PRECONDITION_REQUIRED_STAGE = `${LABEL_PREFIX}ready`;

/** The closed set of stage suffixes (as recorded on {@link LoopExternalIdentity.pipeline_stage})
 *  that count as "not yet ready" — a deliberate operator hold, not a mid-pipeline stage. */
const PRE_PIPELINE_STAGE_SUFFIXES = new Set(["backlog"]);

/** True when `stage` — a `LoopExternalIdentity.pipeline_stage` value — is pre-pipeline: still
 *  `pipeline:backlog`, or no `pipeline:*` label at all (`null`). Every other stage (`ready`, any
 *  mid-flight advance-loop stage, `ready-to-deploy`) is at-or-past the precondition. */
export function isPrePipelineStage(stage: string | null): boolean {
  return stage === null || PRE_PIPELINE_STAGE_SUFFIXES.has(stage);
}

/** Renders a `LoopExternalIdentity.pipeline_stage` value into the label form
 *  {@link LoopPreconditionExclusion.observed_stage} records — `"none"` for no label, otherwise
 *  the full `pipeline:<stage>` label. */
function describeObservedStage(stage: string | null): string {
  return stage === null ? "none" : `${LABEL_PREFIX}${stage}`;
}

/** Derives a `pipeline_stage` value (see {@link LoopExternalIdentity.pipeline_stage}) from a raw
 *  label list — the shared primitive both the reconciliation observation (loop/reconcile.ts) and
 *  the dispatch-outcome safety net (loop/supervisor.ts Pass 2, design.md decision 3) derive it
 *  from, so "what counts as pre-pipeline" has exactly one definition. */
export function pipelineStageFromLabels(labels: readonly string[]): string | null {
  const label = labels.find((l) => l.startsWith(LABEL_PREFIX));
  return label ? label.slice(LABEL_PREFIX.length) : null;
}

/** Builds the durable exclusion record for `itemId` at the given observed `pipeline_stage`. */
export function buildPreconditionExclusion(itemId: string, stage: string | null): LoopPreconditionExclusion {
  return { item_id: itemId, required_stage: PRECONDITION_REQUIRED_STAGE, observed_stage: describeObservedStage(stage) };
}

/** Classifies every `pending` item whose current-cycle observed live identity is pre-pipeline
 *  into a durable {@link LoopPreconditionExclusion}. An item with no observed identity this cycle
 *  (reconciliation has not yet run, or observed nothing) is never excluded by this function —
 *  callers only get a meaningful result once `reconcile()` has populated
 *  `ledger.last_reconciliation.observed` for the current cycle. Order matches `contract.items`. */
export function classifyPreconditionExclusions(
  contract: LoopContract,
  ledger: LoopLedger,
): LoopPreconditionExclusion[] {
  const observed = ledger.last_reconciliation?.observed ?? {};
  const exclusions: LoopPreconditionExclusion[] = [];
  for (const item of contract.items) {
    const entry = ledger.items[item.id];
    if (!entry || entry.state !== "pending") continue;
    const identity = observed[item.id];
    if (!identity) continue;
    if (!isPrePipelineStage(identity.pipeline_stage)) continue;
    exclusions.push(buildPreconditionExclusion(item.id, identity.pipeline_stage));
  }
  return exclusions;
}

/** Returns a shallow contract copy with every item named in `excludedItemIds` removed from
 *  `items` — the pruned view the scheduler (`selectSchedulableSet`, loop/schedule.ts) evaluates,
 *  so a precondition-excluded item is never admitted to the frontier. Every other field
 *  (including `canonical_hash`/`run_id`) is unchanged: this is a scheduling-input view, never a
 *  persisted document. */
export function excludeContractItems(contract: LoopContract, excludedItemIds: ReadonlySet<string>): LoopContract {
  if (excludedItemIds.size === 0) return contract;
  return { ...contract, items: contract.items.filter((item) => !excludedItemIds.has(item.id)) };
}
