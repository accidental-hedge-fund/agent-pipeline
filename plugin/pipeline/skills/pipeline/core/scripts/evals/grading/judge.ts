// Optional model judge (eval-graders). Disabled by default; when it runs, it
// writes its own record and never moves a deterministic grade field
// (design.md decision 6). Judging exists to flag disagreement — disagreements
// are what a human adjudicates (adjudication.ts).

import * as path from "node:path";
import { buildVerifierEvidenceArtifact } from "../trajectory/collect.ts";
import { writeContentAddressedArtifact, type ArtifactStoreDeps } from "../trajectory/store.ts";
import type { BoundCeilings } from "../trajectory/bound.ts";
import type { GradeRecord, JudgeDisagreementRecord, JudgeRecord } from "./types.ts";

export interface JudgeVerdict {
  pass: boolean;
  note?: string;
}

export interface InvokeJudgeArgs {
  grade: GradeRecord;
}

export interface JudgeDeps {
  invokeJudge: (args: InvokeJudgeArgs) => Promise<JudgeVerdict>;
  judgeHarness: string;
  judgeModel: string;
  judgePromptVersion: string;
  /** Where to content-address this judge run's verifier evidence artifacts
   *  (#536). Omitting this skips artifact emission entirely — judge records
   *  and disagreement records are then produced without a
   *  `verifier_artifact` descriptor, which is a valid (if less diagnosable)
   *  outcome, never a failure. */
  artifactStore?: {
    repoDir: string;
    verifiersDir: string;
    deps?: ArtifactStoreDeps;
  };
  /** Configurable byte/event ceilings for judge verifier evidence artifacts
   *  (#536). Defaults to `DEFAULT_TRAJECTORY_CEILINGS` when absent, mirroring
   *  the deterministic grader's `verifierCeilings` (grade.ts). */
  verifierCeilings?: BoundCeilings;
}

/** Whether a deterministic grade reads as a pass — used only to detect a
 *  judge disagreement, never to compute or alter the grade itself. */
export function deterministicPass(grade: GradeRecord): boolean {
  switch (grade.payload.kind) {
    case "implementation-fix": {
      const g = grade.payload.grade;
      const hiddenOk = g.hidden_tests.total === 0 || g.hidden_tests.passed === g.hidden_tests.total;
      const acceptanceOk = g.acceptance.total === 0 || g.acceptance.completed === g.acceptance.total;
      return hiddenOk && acceptanceOk && g.regressions === 0;
    }
    case "review": {
      const f1 = grade.payload.grade.f1;
      return f1 !== null && f1 >= 0.5;
    }
    case "planning": {
      const g = grade.payload.grade;
      return g.requirement_coverage.total === 0 || g.requirement_coverage.covered / g.requirement_coverage.total >= 0.5;
    }
  }
}

/** Run the optional model judge over every deterministic grade. Never
 *  invoked unless the caller opts in (pipeline evals grade --judge). Returns
 *  judge records and any judge/deterministic disagreements, both separate
 *  from `grades`. */
export async function runJudging(
  grades: GradeRecord[],
  deps: JudgeDeps,
): Promise<{ judgeRecords: JudgeRecord[]; disagreements: JudgeDisagreementRecord[] }> {
  const judgeRecords: JudgeRecord[] = [];
  const disagreements: JudgeDisagreementRecord[] = [];

  for (const grade of grades) {
    const verdict = await deps.invokeJudge({ grade });

    // Verifier evidence artifact for this judge invocation (#536 task 4.2),
    // independently addressable from the deterministic grader's own artifact
    // for the same cell — best-effort/non-fatal, mirroring grade.ts. A
    // build/collision/write failure is durably recorded on the judge and
    // disagreement records via `verifier_artifact_error` (review 1 finding
    // 5ae0fa6e), not only console.warn'd.
    let verifierArtifact: JudgeRecord["verifier_artifact"];
    let verifierArtifactError: string | undefined;
    if (deps.artifactStore) {
      try {
        const artifact = buildVerifierEvidenceArtifact({
          cell_id: grade.cell_id,
          experiment_id: grade.experiment_id,
          verifier_kind: "judge",
          verifier_id: `${deps.judgeHarness}/${deps.judgeModel}`,
          verifier_version: deps.judgePromptVersion,
          inputs: { grade },
          // The deterministic grade is the evidence the judge verdict is
          // compared against (`deterministicPass` below) — subject to
          // `deps.verifierCeilings` like a grader's evidence_consulted.
          evidence_consulted: [grade],
          final_result: verdict,
          ceilings: deps.verifierCeilings,
        });
        const result = await writeContentAddressedArtifact(
          deps.artifactStore.repoDir,
          deps.artifactStore.verifiersDir,
          artifact as unknown as Record<string, unknown>,
          { truncationStatus: artifact.truncation.status },
          deps.artifactStore.deps,
        );
        if (result.status === "written" || result.status === "deduped") {
          verifierArtifact = result.descriptor;
        } else {
          verifierArtifactError = result.error;
          console.warn(`[pipeline] evals: judge verifier artifact for cell ${grade.cell_id} not recorded (non-fatal): ${result.error}`);
        }
      } catch (err) {
        verifierArtifactError = (err as Error).message;
        console.warn(`[pipeline] evals: judge verifier artifact collection for cell ${grade.cell_id} failed (non-fatal): ${verifierArtifactError}`);
      }
    }

    judgeRecords.push({
      cell_id: grade.cell_id,
      experiment_id: grade.experiment_id,
      fixture_id: grade.fixture_id,
      treatment_id: grade.treatment_id,
      replicate: grade.replicate,
      judge_harness: deps.judgeHarness,
      judge_model: deps.judgeModel,
      judge_prompt_version: deps.judgePromptVersion,
      verdict,
      ...(verifierArtifact ? { verifier_artifact: verifierArtifact } : {}),
      ...(verifierArtifactError ? { verifier_artifact_error: verifierArtifactError } : {}),
    });
    if (verdict.pass !== deterministicPass(grade)) {
      disagreements.push({
        cell_id: grade.cell_id,
        experiment_id: grade.experiment_id,
        fixture_id: grade.fixture_id,
        treatment_id: grade.treatment_id,
        replicate: grade.replicate,
        judge_prompt_version: deps.judgePromptVersion,
        note: `judge verdict pass=${verdict.pass} disagrees with deterministic grade pass=${deterministicPass(grade)}`,
        ...(verifierArtifact ? { verifier_artifact: verifierArtifact } : {}),
        ...(verifierArtifactError ? { verifier_artifact_error: verifierArtifactError } : {}),
      });
    }
  }

  return { judgeRecords, disagreements };
}

export interface JudgeResultsIODeps {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
}

/** Persist judge and disagreement records to `judges.jsonl` /
 *  `disagreements.jsonl` under the experiment directory — written fresh each
 *  invocation (mirrors grades.jsonl's regrade-is-byte-identical contract).
 *  Never invoked by `pipeline evals grade` today (no judge harness is wired
 *  yet — see pipeline.ts); exists so a caller with a real `invokeJudge` can
 *  persist judging output and so comparative reporting can link disagreement
 *  artifacts for flagged cells (#536 task 6). */
export async function writeJudgeResults(
  outputDir: string,
  experimentId: string,
  judgeRecords: JudgeRecord[],
  disagreements: JudgeDisagreementRecord[],
  deps: JudgeResultsIODeps = {},
): Promise<void> {
  const { experimentDir } = await import("../results.ts");
  const mkdirFn = deps.mkdir ?? (async (dir: string) => {
    const fs = await import("node:fs");
    await fs.promises.mkdir(dir, { recursive: true });
  });
  const writeFileFn = deps.writeFile ?? (async (filePath: string, content: string) => {
    const fs = await import("node:fs");
    await fs.promises.writeFile(filePath, content, "utf8");
  });
  const dir = experimentDir(outputDir, experimentId);
  await mkdirFn(dir);
  const judgesContent = `${judgeRecords.map((r) => JSON.stringify(r)).join("\n")}${judgeRecords.length > 0 ? "\n" : ""}`;
  const disagreementsContent = `${disagreements.map((r) => JSON.stringify(r)).join("\n")}${disagreements.length > 0 ? "\n" : ""}`;
  await writeFileFn(path.join(dir, "judges.jsonl"), judgesContent);
  await writeFileFn(path.join(dir, "disagreements.jsonl"), disagreementsContent);
}
