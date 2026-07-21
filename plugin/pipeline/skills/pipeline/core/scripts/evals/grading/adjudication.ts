// Blinded human adjudication (eval-graders, design.md decision 7). Material
// presented for adjudication identifies the cell only by an opaque key —
// never harness/provider/model/effort — so an adjudicator resolving a
// judge/deterministic disagreement is an independent signal. Unblinding
// happens only at aggregation time, by rejoining on the key.

import { createHash } from "node:crypto";
import type { JudgeDisagreementRecord } from "./types.ts";
import type { AdjudicationRecord } from "./types.ts";

/** A stable, one-way opaque key derived from `cell_id` alone. Two calls with
 *  the same cell_id always agree; the key cannot be reversed to recover the
 *  cell_id (and therefore not the treatment axes it encodes). */
export function opaqueKeyForCell(cellId: string): string {
  return createHash("sha256").update(cellId).digest("hex").slice(0, 16);
}

/** The blinded material shown to a human adjudicator for one disagreement —
 *  deliberately excludes every field of `JudgeDisagreementRecord` except the
 *  opaque key and the disagreement note (which itself must name no
 *  harness/provider/model/effort — callers constructing `note` values are
 *  responsible for that; adjudication.test.ts guards it for the judge.ts
 *  producer). */
export interface BlindedAdjudicationMaterial {
  opaque_key: string;
  disagreement_note: string;
}

export function blindDisagreement(disagreement: JudgeDisagreementRecord): BlindedAdjudicationMaterial {
  return {
    opaque_key: opaqueKeyForCell(disagreement.cell_id),
    disagreement_note: disagreement.note,
  };
}

/** Resolve an adjudication record back to its cell by opaque key. Returns
 *  `undefined` when the key matches no known cell — the caller must not
 *  invent an association. */
export function resolveAdjudication(
  record: AdjudicationRecord,
  cellIds: string[],
): string | undefined {
  return cellIds.find((id) => opaqueKeyForCell(id) === record.opaque_key);
}
