// Comparative reporting entry point (eval-comparative-reporting,
// `pipeline evals report <experiment-dir>`). Reads manifest.json, plan.json,
// runs.jsonl, failures.jsonl, and grades.jsonl (all read-only) and writes
// summary.json — never mutating any of its inputs, and deterministic given
// the same inputs and interval seed (report.test.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import { experimentDir } from "../results.ts";
import { qualityScore } from "./quality.ts";
import { pairAgainstBaseline } from "./pairing.ts";
import { bootstrapEffect, defaultIntervalMethod, DEFAULT_UNDERPOWERED_THRESHOLD } from "./intervals.ts";
import { paretoFrontier, type ParetoPoint } from "./pareto.ts";
import { groupBy, type GroupableEntry } from "./grouping.ts";
import { costFromDetail, summarizeCost } from "./cost.ts";
import type { CellRecord, ExperimentManifest, Fixture, RunPlan } from "../types.ts";
import type { ArtifactDescriptor } from "../trajectory/types.ts";
import type { GradeRecord, JudgeDisagreementRecord, ReviewGrade } from "../grading/types.ts";
import type { GroupDimension, LinkedArtifactEntry, ReliabilityRates, Summary, TreatmentSummary } from "./types.ts";
import { SUMMARY_SCHEMA_VERSION } from "./types.ts";

const GROUP_DIMENSIONS: GroupDimension[] = ["stage", "harness", "provider", "model", "effort", "category", "risk"];

export interface ReportIODeps {
  readFile?: (filePath: string) => Promise<string | null>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

async function defaultReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
}

function parseJsonl<T>(text: string | null): T[] {
  if (!text) return [];
  const records: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as T);
  }
  return records;
}

function stageDurationSec(record: CellRecord): number | null {
  const stages = record.detail?.stages;
  if (!Array.isArray(stages)) return null;
  let total = 0;
  for (const s of stages) {
    const d = (s as Record<string, unknown>).duration;
    if (typeof d === "number") total += d;
  }
  return total;
}

export interface GenerateSummaryOptions {
  baselineTreatmentId: string;
  seed?: number;
  underpoweredThreshold?: number;
  /** Opt-in (#536 task 6.1): additively attach trajectory/verifier artifact
   *  references for flagged cells — outliers, judge disagreements, false
   *  positives/negatives, and failed cells. Default (absent/false) output is
   *  byte-identical to the pre-#536 summary. */
  linkArtifacts?: boolean;
}

/** Standard deviation of quality scores, or `null` when fewer than two
 *  values (an outlier z-score is meaningless with n<2). */
function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

const OUTLIER_Z_SCORE_THRESHOLD = 2;

/** Deterministically dedupe artifact descriptors by content hash and sort by
 *  it, so `linked_artifacts` is stable across repeated summarization. */
function dedupeArtifacts(descriptors: ArtifactDescriptor[]): ArtifactDescriptor[] {
  const byHash = new Map<string, ArtifactDescriptor>();
  for (const d of descriptors) byHash.set(d.content_hash, d);
  return [...byHash.values()].sort((a, b) => a.content_hash.localeCompare(b.content_hash));
}

/** Compute the opt-in `linked_artifacts` field (#536 task 6.1): flags
 *  outliers (|z-score| over threshold within a treatment's graded, completed
 *  cells), judge disagreements, review false positives/negatives, and every
 *  failed cell — attaching each flagged cell's treatment trajectory
 *  descriptor (from its `runs.jsonl`/`failures.jsonl` record) and every
 *  verifier artifact descriptor available for it (grade + disagreement).
 *  Pure and deterministic given the same inputs. */
function computeLinkedArtifacts(
  runs: CellRecord[],
  failures: CellRecord[],
  grades: GradeRecord[],
  disagreements: JudgeDisagreementRecord[],
  qualityByTreatmentFlat: Map<string, Array<{ cell_id: string; score: number }>>,
): LinkedArtifactEntry[] {
  const recordByCell = new Map<string, CellRecord>();
  for (const r of [...runs, ...failures]) recordByCell.set(r.cell_id, r);
  const gradeByCell = new Map(grades.map((g) => [g.cell_id, g]));

  const reasonsByCell = new Map<string, Set<string>>();
  const verifierArtifactsByCell = new Map<string, ArtifactDescriptor[]>();
  function flag(cellId: string, reason: string, verifierArtifact?: ArtifactDescriptor): void {
    if (!reasonsByCell.has(cellId)) reasonsByCell.set(cellId, new Set());
    reasonsByCell.get(cellId)!.add(reason);
    if (verifierArtifact) {
      if (!verifierArtifactsByCell.has(cellId)) verifierArtifactsByCell.set(cellId, []);
      verifierArtifactsByCell.get(cellId)!.push(verifierArtifact);
    }
  }

  for (const f of failures) {
    flag(f.cell_id, `failed:${f.result_class}`);
  }

  function reviewGradeOf(grade: GradeRecord): ReviewGrade | undefined {
    if (grade.payload.kind === "review") return grade.payload.grade;
    if (grade.payload.kind === "composite") {
      const reviewSub = grade.payload.grades.find((g) => g.kind === "review");
      return reviewSub?.kind === "review" ? reviewSub.grade : undefined;
    }
    return undefined;
  }
  for (const grade of grades) {
    const review = reviewGradeOf(grade);
    if (review && (review.false_positives > 0 || review.false_negatives > 0)) {
      flag(grade.cell_id, "false_positive_or_negative", grade.verifier_artifact);
    }
  }

  for (const [, entries] of qualityByTreatmentFlat) {
    const scores = entries.map((e) => e.score);
    const sd = stdDev(scores);
    if (sd === null || sd === 0) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    for (const entry of entries) {
      const z = Math.abs((entry.score - mean) / sd);
      if (z > OUTLIER_Z_SCORE_THRESHOLD) {
        flag(entry.cell_id, "outlier", gradeByCell.get(entry.cell_id)?.verifier_artifact);
      }
    }
  }

  for (const d of disagreements) {
    flag(d.cell_id, "judge_disagreement", d.verifier_artifact);
  }

  return [...reasonsByCell.entries()]
    .map(([cellId, reasons]) => ({
      cell_id: cellId,
      reasons: [...reasons].sort(),
      treatment_artifact: recordByCell.get(cellId)?.trajectory_artifact,
      verifier_artifacts: dedupeArtifacts(verifierArtifactsByCell.get(cellId) ?? []),
    }))
    .sort((a, b) => a.cell_id.localeCompare(b.cell_id));
}

export function generateSummary(
  manifest: ExperimentManifest,
  plan: RunPlan,
  runs: CellRecord[],
  failures: CellRecord[],
  grades: GradeRecord[],
  fixtures: Map<string, Fixture>,
  opts: GenerateSummaryOptions,
  disagreements: JudgeDisagreementRecord[] = [],
): Summary {
  const underpoweredThreshold = opts.underpoweredThreshold ?? DEFAULT_UNDERPOWERED_THRESHOLD;
  const intervalMethod = defaultIntervalMethod(opts.seed ?? manifest.seed);

  const treatmentIds = [...new Set(plan.cells.map((c) => c.treatment_id))].sort();
  const gradeByCell = new Map(grades.map((g) => [g.cell_id, g]));

  // Per-treatment quality-by-fixture (reduced-per-replicate happens in
  // pairAgainstBaseline; here we just collect every graded replicate's score).
  const qualityByTreatmentFixture = new Map<string, Map<string, number[]>>();
  // Per-treatment flat (cell_id, score) list — only consumed by the opt-in
  // outlier-linking computation below; never affects any aggregate.
  const qualityByTreatmentFlat = new Map<string, Array<{ cell_id: string; score: number }>>();
  for (const run of runs) {
    const grade = gradeByCell.get(run.cell_id);
    if (!grade) continue;
    if (!qualityByTreatmentFixture.has(run.treatment_id)) qualityByTreatmentFixture.set(run.treatment_id, new Map());
    const byFixture = qualityByTreatmentFixture.get(run.treatment_id)!;
    if (!byFixture.has(run.fixture_id)) byFixture.set(run.fixture_id, []);
    const score = qualityScore(grade);
    byFixture.get(run.fixture_id)!.push(score);
    if (!qualityByTreatmentFlat.has(run.treatment_id)) qualityByTreatmentFlat.set(run.treatment_id, []);
    qualityByTreatmentFlat.get(run.treatment_id)!.push({ cell_id: run.cell_id, score });
  }

  const plannedByTreatment = new Map<string, number>();
  for (const cell of plan.cells) {
    plannedByTreatment.set(cell.treatment_id, (plannedByTreatment.get(cell.treatment_id) ?? 0) + 1);
  }

  function reliabilityFor(treatmentId: string): ReliabilityRates {
    const planned = plannedByTreatment.get(treatmentId) ?? 0;
    const completed = runs.filter((r) => r.treatment_id === treatmentId).length;
    const failuresForTreatment = failures.filter((f) => f.treatment_id === treatmentId);
    const rateOf = (cls: string) =>
      planned === 0 ? 0 : failuresForTreatment.filter((f) => f.result_class === cls).length / planned;
    return {
      completion_rate: planned === 0 ? 0 : completed / planned,
      planned,
      completed,
      infra_error_rate: rateOf("infra_error"),
      auth_error_rate: rateOf("auth_error"),
      timeout_rate: rateOf("timeout"),
    };
  }

  function costFor(treatmentId: string) {
    const costs = runs.filter((r) => r.treatment_id === treatmentId).map((r) => costFromDetail(r.detail));
    return summarizeCost(costs);
  }

  function meanDurationFor(treatmentId: string): number | null {
    const durations = runs
      .filter((r) => r.treatment_id === treatmentId)
      .map(stageDurationSec)
      .filter((d): d is number => d !== null);
    return durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length;
  }

  const baselineValues = qualityByTreatmentFixture.get(opts.baselineTreatmentId) ?? new Map();

  const treatments: TreatmentSummary[] = treatmentIds.map((treatmentId) => {
    const isBaseline = treatmentId === opts.baselineTreatmentId;
    let qualityDelta = null;
    let excludedFixtures: string[] = [];
    if (!isBaseline) {
      const values = qualityByTreatmentFixture.get(treatmentId) ?? new Map();
      const pairing = pairAgainstBaseline(values, baselineValues);
      qualityDelta = bootstrapEffect(pairing.deltas, intervalMethod, underpoweredThreshold);
      excludedFixtures = pairing.excludedFixtures;
    }
    return {
      treatment_id: treatmentId,
      reliability: reliabilityFor(treatmentId),
      quality_delta_vs_baseline: qualityDelta,
      excluded_fixtures: excludedFixtures,
      mean_duration_sec: meanDurationFor(treatmentId),
      cost: costFor(treatmentId),
    };
  });

  // Pareto: one point per treatment using its own mean quality (unpaired —
  // Pareto positioning, not the paired-delta comparison above) against
  // duration/cost. A treatment missing the relevant axis is excluded from
  // that frontier.
  const meanQualityByTreatment = new Map<string, number>();
  for (const [treatmentId, byFixture] of qualityByTreatmentFixture) {
    const allScores = [...byFixture.values()].flat();
    meanQualityByTreatment.set(treatmentId, allScores.reduce((a, b) => a + b, 0) / allScores.length);
  }
  const durationPoints: ParetoPoint[] = treatments
    .filter((t) => meanQualityByTreatment.has(t.treatment_id) && t.mean_duration_sec !== null)
    .map((t) => ({ treatment_id: t.treatment_id, quality: meanQualityByTreatment.get(t.treatment_id)!, cost: t.mean_duration_sec! }));
  const costPoints: ParetoPoint[] = treatments
    .filter((t) => meanQualityByTreatment.has(t.treatment_id) && t.cost !== null && t.cost.mean_cost_usd !== null)
    .map((t) => ({ treatment_id: t.treatment_id, quality: meanQualityByTreatment.get(t.treatment_id)!, cost: t.cost!.mean_cost_usd! }));

  // Groups: over graded, completed cells only.
  const groupableEntries: GroupableEntry[] = runs
    .map((r) => {
      const grade = gradeByCell.get(r.cell_id);
      if (!grade) return null;
      const fixture = fixtures.get(r.fixture_id);
      return {
        treatment_id: r.treatment_id,
        stage: manifest.mode,
        category: fixture?.category ?? "unknown",
        risk: fixture?.risk ?? "unknown",
        quality: qualityScore(grade),
        completed: true,
      } satisfies GroupableEntry;
    })
    .filter((e): e is GroupableEntry => e !== null);

  const groups: Summary["groups"] = {};
  for (const dimension of GROUP_DIMENSIONS) {
    groups[dimension] = groupBy(groupableEntries, dimension);
  }

  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    experiment_id: manifest.experiment_id,
    baseline_treatment_id: opts.baselineTreatmentId,
    interval_method: intervalMethod,
    underpowered_threshold: underpoweredThreshold,
    treatments,
    pareto: {
      quality_vs_duration: paretoFrontier(durationPoints),
      quality_vs_cost: paretoFrontier(costPoints),
    },
    groups,
    ...(opts.linkArtifacts
      ? { linked_artifacts: computeLinkedArtifacts(runs, failures, grades, disagreements, qualityByTreatmentFlat) }
      : {}),
  };
}

export async function reportExperiment(
  outputDir: string,
  experimentId: string,
  fixtures: Map<string, Fixture>,
  opts: GenerateSummaryOptions,
  deps: ReportIODeps = {},
): Promise<Summary> {
  const readFileFn = deps.readFile ?? defaultReadFile;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const dir = experimentDir(outputDir, experimentId);

  const manifestText = await readFileFn(path.join(dir, "manifest.json"));
  if (!manifestText) throw new Error(`report: no manifest.json found for experiment "${experimentId}" under ${outputDir}`);
  const manifest = JSON.parse(manifestText) as ExperimentManifest;

  const planText = await readFileFn(path.join(dir, "plan.json"));
  if (!planText) throw new Error(`report: no plan.json found for experiment "${experimentId}" under ${outputDir}`);
  const plan = JSON.parse(planText) as RunPlan;

  const runs = parseJsonl<CellRecord>(await readFileFn(path.join(dir, "runs.jsonl")));
  const failures = parseJsonl<CellRecord>(await readFileFn(path.join(dir, "failures.jsonl")));
  const grades = parseJsonl<GradeRecord>(await readFileFn(path.join(dir, "grades.jsonl")));
  // disagreements.jsonl is only ever read when linking is opted in — reading
  // it never changes the default (disabled) path (#536 task 6.1).
  const disagreements = opts.linkArtifacts
    ? parseJsonl<JudgeDisagreementRecord>(await readFileFn(path.join(dir, "disagreements.jsonl")))
    : [];

  const summary = generateSummary(manifest, plan, runs, failures, grades, fixtures, opts, disagreements);
  await writeFileFn(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
