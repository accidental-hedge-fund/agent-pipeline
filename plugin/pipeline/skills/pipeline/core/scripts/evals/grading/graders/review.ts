// Review grader (eval-graders). Deterministic finding<->seeded-defect
// matching by path + line-range overlap — no model call in the match
// (design.md decision 4).

import { rangesOverlap, severityRank } from "../checks.ts";
import type { Fixture, SeededDefect } from "../../types.ts";
import type { ReviewGrade } from "../types.ts";

export interface ReportedFinding {
  file: string;
  line_start: number;
  line_end: number;
  severity: string;
}

/** Loosely parse the `findings` array captured off harness stdout — a
 *  malformed entry is dropped rather than thrown, since a treatment's
 *  reported findings are untrusted input, not a grading precondition. */
export function parseReportedFindings(raw: unknown[] | undefined): ReportedFinding[] {
  if (!raw) return [];
  const findings: ReportedFinding[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.file !== "string" || typeof f.line_start !== "number" || typeof f.line_end !== "number" || typeof f.severity !== "string") {
      continue;
    }
    findings.push({ file: f.file, line_start: f.line_start, line_end: f.line_end, severity: f.severity });
  }
  return findings;
}

function matchesDefect(finding: ReportedFinding, defect: SeededDefect): boolean {
  return finding.file === defect.path && rangesOverlap(finding.line_start, finding.line_end, defect.line_start, defect.line_end);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function gradeReview(fixture: Fixture, reportedFindings: ReportedFinding[]): ReviewGrade {
  const defects = fixture.seeded_defects ?? [];
  const matchedDefectIds = new Set<string>();
  const matchedFindingIdx = new Set<number>();
  const severityDeltas: number[] = [];

  for (const defect of defects) {
    const idx = reportedFindings.findIndex((f, i) => !matchedFindingIdx.has(i) && matchesDefect(f, defect));
    if (idx !== -1) {
      matchedDefectIds.add(defect.defect_id);
      matchedFindingIdx.add(idx);
      severityDeltas.push(severityRank(reportedFindings[idx].severity) - severityRank(defect.expected_severity));
    }
  }

  const truePositives = matchedDefectIds.size;
  const falseNegatives = defects.length - truePositives;
  const falsePositives = reportedFindings.length - matchedFindingIdx.size;

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);

  return {
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision,
    recall,
    f1,
    severity_calibration: severityDeltas,
  };
}
