// Grading entry point (eval-graders, `pipeline evals grade <experiment-dir>`).
//
// Reads manifest.json, runs.jsonl, failures.jsonl, and the fixtures; opens no
// runner-written file for writing; writes grades.jsonl fresh each invocation
// so regrading is byte-identical (design.md decision 1). Grades only
// `completed` cells whose fixture declares a grader_ref for the mode's
// applicable grader — a failure-class cell (infra_error/auth_error/timeout)
// is never graded, and a completed cell that is not gradeable is reported in
// `skipped`, never silently dropped. A cell whose mode has no single
// applicable grader (`end-to-end`, `plan-review`) may still emit a
// `composite` grade for whichever underlying review/planning stage output
// the executor captured and the fixture declares a grader_ref for.

import * as fs from "node:fs";
import * as path from "node:path";
import { experimentDir } from "../results.ts";
import { runBaselineChecks, type CheckRunnerDeps } from "./checks.ts";
import { gradeImplementationFix } from "./graders/implementation.ts";
import { parseReportedFindings, gradeReview } from "./graders/review.ts";
import { gradePlanning } from "./graders/planning.ts";
import { buildVerifierEvidenceArtifact } from "../trajectory/collect.ts";
import { writeContentAddressedArtifact, type ArtifactStoreDeps } from "../trajectory/store.ts";
import type { CellRecord, EvalMode, ExperimentManifest, Fixture } from "../types.ts";
import type { BoundCeilings } from "../trajectory/bound.ts";
import type { ArtifactDescriptor } from "../trajectory/types.ts";
import type { PipelineConfig } from "../../types.ts";
import type { CellIdentity, CompositeSubGradePayload, GradeRecord, GraderVersion, SkippedCell } from "./types.ts";

export interface GradeIODeps {
  readFile?: (filePath: string) => Promise<string | null>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

export interface GradeExperimentDeps extends GradeIODeps, ArtifactStoreDeps {
  checkRunner?: CheckRunnerDeps;
  /** Configurable byte/event ceilings for verifier evidence artifacts (#536
   *  task 7.1). Defaults to `DEFAULT_TRAJECTORY_CEILINGS` when absent. */
  verifierCeilings?: BoundCeilings;
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

function parseJsonl<T>(text: string): T[] {
  const records: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as T);
  }
  return records;
}

/** The grader applicable to a manifest's mode, if any. `plan-review`,
 *  `shipcheck`, and `end-to-end` have no grader defined by this change. */
export function graderIdForMode(mode: EvalMode): string | null {
  if (mode === "implementing" || mode === "fix") return "implementation-fix";
  if (mode === "review") return "review";
  if (mode === "planning") return "planning";
  return null;
}

export interface GradeExperimentResult {
  manifest: ExperimentManifest;
  grades: GradeRecord[];
  skipped: SkippedCell[];
}

export async function gradeExperiment(
  cfg: PipelineConfig,
  outputDir: string,
  experimentId: string,
  fixtures: Map<string, Fixture>,
  deps: GradeExperimentDeps = {},
): Promise<GradeExperimentResult> {
  const readFileFn = deps.readFile ?? defaultReadFile;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const dir = experimentDir(outputDir, experimentId);
  const verifiersDir = path.join(dir, "verifiers");

  // Emit and content-address this grade's verifier evidence artifact (#536
  // task 4.1). `evidenceConsulted` is where verifier-only material (hidden
  // checks, seeded-defect ground truth) is permitted to live — it never
  // leaks into the treatment trajectory (task 5). Best-effort/non-fatal: a
  // build/collision/write failure leaves the grade record without a
  // descriptor, but is returned as `error` so the caller can durably record
  // it on the grade record rather than only console.warn'ing it (review 1
  // finding 5ae0fa6e).
  async function emitVerifierArtifact(
    identity: CellIdentity,
    verifierId: string,
    verifierVersion: string,
    inputs: unknown,
    evidenceConsulted: unknown[],
    finalResult: unknown,
  ): Promise<{ descriptor?: ArtifactDescriptor; error?: string }> {
    try {
      const artifact = buildVerifierEvidenceArtifact({
        cell_id: identity.cell_id,
        experiment_id: identity.experiment_id,
        verifier_kind: "grader",
        verifier_id: verifierId,
        verifier_version: verifierVersion,
        inputs,
        evidence_consulted: evidenceConsulted,
        final_result: finalResult,
        ceilings: deps.verifierCeilings,
      });
      const result = await writeContentAddressedArtifact(
        cfg.repo_dir,
        verifiersDir,
        artifact as unknown as Record<string, unknown>,
        { truncationStatus: artifact.truncation.status },
        deps,
      );
      if (result.status === "written" || result.status === "deduped") {
        return { descriptor: result.descriptor };
      }
      console.warn(`[pipeline] evals: verifier artifact for cell ${identity.cell_id} not recorded (non-fatal): ${result.error}`);
      return { error: result.error };
    } catch (err) {
      const error = (err as Error).message;
      console.warn(`[pipeline] evals: verifier artifact collection for cell ${identity.cell_id} failed (non-fatal): ${error}`);
      return { error };
    }
  }

  const manifestText = await readFileFn(path.join(dir, "manifest.json"));
  if (!manifestText) {
    throw new Error(`grading: no manifest.json found for experiment "${experimentId}" under ${outputDir}`);
  }
  const manifest = JSON.parse(manifestText) as ExperimentManifest;

  const runsText = await readFileFn(path.join(dir, "runs.jsonl"));
  const runs = runsText ? parseJsonl<CellRecord>(runsText) : [];
  // failures.jsonl is also read (design.md decision 1) so a failure-class
  // cell is explicitly accounted for below rather than assumed absent from
  // the stream this loop processes.
  const failuresText = await readFileFn(path.join(dir, "failures.jsonl"));
  const failures = failuresText ? parseJsonl<CellRecord>(failuresText) : [];

  const graderId = graderIdForMode(manifest.mode);
  const grades: GradeRecord[] = [];
  const skipped: SkippedCell[] = [];
  const baselineCache = new Map<string, Record<string, boolean>>();

  for (const record of [...runs, ...failures]) {
    const identity: CellIdentity = {
      cell_id: record.cell_id,
      experiment_id: record.experiment_id,
      fixture_id: record.fixture_id,
      treatment_id: record.treatment_id,
      replicate: record.replicate,
    };
    // A failure-class cell (infra_error/auth_error/timeout) contributes to
    // reliability reporting only — never a quality grade (eval-graders
    // review 2 finding 370add6f).
    if (record.result_class !== "completed") {
      skipped.push({ ...identity, reason: `cell result_class is "${record.result_class}" — reliability only, not graded` });
      continue;
    }
    const fixture = fixtures.get(record.fixture_id);
    if (!fixture) {
      skipped.push({ ...identity, reason: `fixture "${record.fixture_id}" not found` });
      continue;
    }
    if (!graderId) {
      // The manifest's mode has no single applicable grader (e.g.
      // `end-to-end`, `plan-review`), but the executor may still have
      // captured a real review or planning stage's output as part of that
      // composite cell — grade whichever of those the fixture declares a
      // grader_ref for, rather than discarding them (review 2 finding
      // b493406e).
      const detailForComposite = record.detail ?? {};
      const compositeGrades: CompositeSubGradePayload[] = [];
      const compositeGraders: GraderVersion[] = [];
      // Each sub-grader gets its own verifier evidence artifact (review 1
      // finding c7218eb4) — collapsing every composite sub-grade into a
      // single "composite" artifact made it impossible to independently
      // address which grader produced a given piece of evidence.
      const compositeVerifierArtifacts: NonNullable<GradeRecord["verifier_artifacts"]> = [];
      const compositeVerifierArtifactErrors: NonNullable<GradeRecord["verifier_artifact_errors"]> = [];
      if (detailForComposite.findings !== undefined) {
        const reviewRef = fixture.grader_refs.find((r) => r.grader === "review");
        if (reviewRef) {
          const findings = parseReportedFindings(detailForComposite.findings as unknown[] | undefined);
          const grade = gradeReview(fixture, findings);
          compositeGrades.push({ kind: "review", grade });
          compositeGraders.push({ grader: reviewRef.grader, version: reviewRef.version });
          const { descriptor, error } = await emitVerifierArtifact(
            identity,
            reviewRef.grader,
            reviewRef.version,
            { reported_findings: findings },
            fixture.seeded_defects ?? [],
            grade,
          );
          if (descriptor) compositeVerifierArtifacts.push({ grader: reviewRef.grader, version: reviewRef.version, artifact: descriptor });
          if (error) compositeVerifierArtifactErrors.push({ grader: reviewRef.grader, version: reviewRef.version, error });
        }
      }
      if (detailForComposite.output_text !== undefined) {
        const planningRef = fixture.grader_refs.find((r) => r.grader === "planning");
        if (planningRef) {
          const outputText = (detailForComposite.output_text as string) ?? "";
          const grade = gradePlanning(fixture, outputText);
          compositeGrades.push({
            kind: "planning",
            grade,
            self_assessment_observed: detailForComposite.self_assessment,
          });
          compositeGraders.push({ grader: planningRef.grader, version: planningRef.version });
          const { descriptor, error } = await emitVerifierArtifact(
            identity,
            planningRef.grader,
            planningRef.version,
            { output_text: outputText },
            fixture.acceptance_criteria ?? [],
            grade,
          );
          if (descriptor) compositeVerifierArtifacts.push({ grader: planningRef.grader, version: planningRef.version, artifact: descriptor });
          if (error) compositeVerifierArtifactErrors.push({ grader: planningRef.grader, version: planningRef.version, error });
        }
      }
      if (compositeGrades.length === 0) {
        skipped.push({ ...identity, reason: `manifest mode "${manifest.mode}" has no applicable grader` });
      } else {
        grades.push({
          ...identity,
          graders: compositeGraders,
          payload: { kind: "composite", grades: compositeGrades },
          ...(compositeVerifierArtifacts.length > 0 ? { verifier_artifacts: compositeVerifierArtifacts } : {}),
          ...(compositeVerifierArtifactErrors.length > 0 ? { verifier_artifact_errors: compositeVerifierArtifactErrors } : {}),
        });
      }
      continue;
    }
    const ref = fixture.grader_refs.find((r) => r.grader === graderId);
    if (!ref) {
      skipped.push({ ...identity, reason: `fixture declares no grader_ref for "${graderId}"` });
      continue;
    }

    const detail = record.detail ?? {};
    if (graderId === "implementation-fix") {
      const candidateChecks = (detail.checks as Record<string, boolean>) ?? {};
      const allChecks = [...fixture.public_checks, ...(fixture.hidden_checks ?? [])];
      let baseline = baselineCache.get(fixture.fixture_id);
      if (!baseline) {
        baseline =
          allChecks.length > 0
            ? await runBaselineChecks(cfg, fixture.fixture_id, fixture.base_commit, allChecks, deps.checkRunner)
            : {};
        baselineCache.set(fixture.fixture_id, baseline);
      }
      const changedPaths = detail.changed_paths as string[] | undefined;
      const grade = gradeImplementationFix(fixture, candidateChecks, baseline, changedPaths);
      const { descriptor: verifierArtifact, error: verifierArtifactError } = await emitVerifierArtifact(
        identity,
        ref.grader,
        ref.version,
        { candidateChecks, changedPaths, allowed_change_paths: fixture.allowed_change_paths },
        [{ public_checks: fixture.public_checks, hidden_checks: fixture.hidden_checks ?? [], baseline, acceptance_criteria: fixture.acceptance_criteria ?? [] }],
        grade,
      );
      grades.push({
        ...identity,
        graders: [{ grader: ref.grader, version: ref.version }],
        payload: { kind: "implementation-fix", grade },
        ...(verifierArtifact ? { verifier_artifact: verifierArtifact } : {}),
        ...(verifierArtifactError ? { verifier_artifact_error: verifierArtifactError } : {}),
      });
    } else if (graderId === "review") {
      const findings = parseReportedFindings(detail.findings as unknown[] | undefined);
      const grade = gradeReview(fixture, findings);
      const { descriptor: verifierArtifact, error: verifierArtifactError } = await emitVerifierArtifact(
        identity,
        ref.grader,
        ref.version,
        { reported_findings: findings },
        fixture.seeded_defects ?? [],
        grade,
      );
      grades.push({
        ...identity,
        graders: [{ grader: ref.grader, version: ref.version }],
        payload: { kind: "review", grade },
        ...(verifierArtifact ? { verifier_artifact: verifierArtifact } : {}),
        ...(verifierArtifactError ? { verifier_artifact_error: verifierArtifactError } : {}),
      });
    } else if (graderId === "planning") {
      const outputText = (detail.output_text as string) ?? "";
      const grade = gradePlanning(fixture, outputText);
      const { descriptor: verifierArtifact, error: verifierArtifactError } = await emitVerifierArtifact(
        identity,
        ref.grader,
        ref.version,
        { output_text: outputText },
        fixture.acceptance_criteria ?? [],
        grade,
      );
      grades.push({
        ...identity,
        graders: [{ grader: ref.grader, version: ref.version }],
        payload: { kind: "planning", grade, self_assessment_observed: detail.self_assessment },
        ...(verifierArtifact ? { verifier_artifact: verifierArtifact } : {}),
        ...(verifierArtifactError ? { verifier_artifact_error: verifierArtifactError } : {}),
      });
    }
  }

  grades.sort((a, b) => a.cell_id.localeCompare(b.cell_id));
  const content = `${grades.map((g) => JSON.stringify(g)).join("\n")}${grades.length > 0 ? "\n" : ""}`;
  await writeFileFn(path.join(dir, "grades.jsonl"), content);

  return { manifest, grades, skipped };
}
