// Grouping by stage, harness, provider/auth class, model, effort, task
// category, and risk (eval-comparative-reporting). A dimension value absent
// from a record lands in an explicit "unknown" bucket rather than being
// dropped or merged into a named group.

import type { Treatment } from "../types.ts";
import type { GroupDimension, GroupEntry } from "./types.ts";

export const UNKNOWN_GROUP = "unknown";

/** Reverse of manifest.ts's treatmentId(): "harness=x,model=y" -> {harness,model}.
 *  An empty string (an all-default treatment) parses to `{}`. */
export function parseTreatmentId(treatmentId: string): Treatment {
  if (treatmentId.length === 0) return {};
  const treatment: Treatment = {};
  for (const part of treatmentId.split(",")) {
    const [key, value] = part.split("=");
    if (key === "harness" || key === "provider" || key === "model" || key === "effort") {
      treatment[key] = value;
    }
  }
  return treatment;
}

export interface GroupableEntry {
  treatment_id: string;
  stage: string;
  category: string;
  risk: string;
  quality: number;
  completed: boolean;
}

function valueForDimension(entry: GroupableEntry, dimension: GroupDimension): string {
  if (dimension === "stage") return entry.stage;
  if (dimension === "category") return entry.category;
  if (dimension === "risk") return entry.risk;
  const treatment = parseTreatmentId(entry.treatment_id);
  return treatment[dimension] ?? UNKNOWN_GROUP;
}

export function groupBy(entries: GroupableEntry[], dimension: GroupDimension): GroupEntry[] {
  const buckets = new Map<string, GroupableEntry[]>();
  for (const entry of entries) {
    const value = valueForDimension(entry, dimension) || UNKNOWN_GROUP;
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value)!.push(entry);
  }
  const result: GroupEntry[] = [];
  for (const [value, bucketEntries] of buckets) {
    const n = bucketEntries.length;
    const meanQuality = bucketEntries.reduce((sum, e) => sum + e.quality, 0) / n;
    const completionRate = bucketEntries.filter((e) => e.completed).length / n;
    result.push({ value, n, mean_quality: meanQuality, completion_rate: completionRate });
  }
  return result.sort((a, b) => a.value.localeCompare(b.value));
}
