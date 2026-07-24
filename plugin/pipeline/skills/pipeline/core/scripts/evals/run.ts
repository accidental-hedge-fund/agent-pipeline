// Top-level orchestration for `pipeline evals plan` / `pipeline evals run`
// (openspec/changes/stage-eval-runner).

import * as fs from "node:fs";
import * as path from "node:path";
import type { PipelineConfig } from "../types.ts";
import { loadFixture, validateFixtureEntersStage, type LoadFixtureDeps } from "./fixture.ts";
import {
  computeConfigHash,
  computePromptHash,
  expandPlan,
  loadManifest,
  type LoadManifestDeps,
} from "./manifest.ts";
import { cellsRemaining, scheduleCells } from "./scheduler.ts";
import { appendCellRecord, experimentDir, readExistingRecords, writePlanArtifacts, type ResultsWriterDeps } from "./results.ts";
import { runCell, type CellExecutionDeps } from "./executor.ts";
import { buildTreatmentTrajectoryArtifact } from "./trajectory/collect.ts";
import { writeContentAddressedArtifact, type ArtifactStoreDeps } from "./trajectory/store.ts";
import type { BoundCeilings } from "./trajectory/bound.ts";
import type { Cell, CellRecord, ExperimentManifest, Fixture, RunPlan } from "./types.ts";

export interface FixtureLoaderDeps extends LoadFixtureDeps {
  listFixtureFiles?: (dir: string) => string[];
}

function defaultListFixtureFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
}

/** Load and validate every fixture file under a directory. Validation
 *  failures are aggregated: an invalid fixture fails the experiment before
 *  execution rather than being silently skipped (eval-fixture-contract). */
export function loadFixturesFromDir(dir: string, deps: FixtureLoaderDeps = {}): Map<string, Fixture> {
  const listFn = deps.listFixtureFiles ?? defaultListFixtureFiles;
  const fixtures = new Map<string, Fixture>();
  for (const filePath of listFn(dir)) {
    const fixture = loadFixture(filePath, deps);
    fixtures.set(fixture.fixture_id, fixture);
  }
  return fixtures;
}

export interface ExpandExperimentDeps extends LoadManifestDeps, FixtureLoaderDeps {}

/** Load the manifest, load and validate every fixture it references, and
 *  expand the deterministic run plan. Performs no I/O beyond reading the
 *  manifest/fixture files — invokes no harness and creates no worktree. */
export function expandExperiment(
  manifestPath: string,
  fixturesDir: string,
  deps: ExpandExperimentDeps = {},
): { manifest: ExperimentManifest; plan: RunPlan; fixtures: Map<string, Fixture> } {
  const fixtures = loadFixturesFromDir(fixturesDir, deps);
  const manifest = loadManifest(manifestPath, new Set(fixtures.keys()), deps);

  if (manifest.mode !== "end-to-end") {
    for (const fixtureId of manifest.fixture_ids) {
      validateFixtureEntersStage(fixtures.get(fixtureId)!, manifest.mode);
    }
  }

  const plan = expandPlan(manifest, fixtures);
  return { manifest, plan, fixtures };
}

function resolveOutputDir(cfg: PipelineConfig, manifest: ExperimentManifest): string {
  return path.isAbsolute(manifest.output_dir)
    ? manifest.output_dir
    : path.join(cfg.repo_dir, manifest.output_dir);
}

/** `pipeline evals plan <manifest>`: expand and persist the plan. Invokes no
 *  harness and creates no worktree. */
export async function planExperiment(
  cfg: PipelineConfig,
  manifestPath: string,
  fixturesDir: string,
  deps: ExpandExperimentDeps & ResultsWriterDeps = {},
): Promise<{ manifest: ExperimentManifest; plan: RunPlan }> {
  const { manifest, plan } = expandExperiment(manifestPath, fixturesDir, deps);
  await writePlanArtifacts(resolveOutputDir(cfg, manifest), manifest, plan, deps);
  return { manifest, plan };
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const item = items[idx++];
      await worker(item);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
}

export interface RunExperimentDeps extends ExpandExperimentDeps, ResultsWriterDeps, ArtifactStoreDeps {
  cellExecution?: CellExecutionDeps;
  /** Configurable byte/event ceilings for treatment trajectory artifacts
   *  (#536 task 7.1). Defaults to `DEFAULT_TRAJECTORY_CEILINGS` when absent. */
  trajectoryCeilings?: BoundCeilings;
}

/** `pipeline evals run <manifest>`: expand + persist the plan, then execute
 *  every cell that has no completed record yet, in seed-derived
 *  harness-interleaved order, bounded by manifest.concurrency. Never
 *  re-executes or rewrites a previously completed cell (resume). */
export async function runExperiment(
  cfg: PipelineConfig,
  manifestPath: string,
  fixturesDir: string,
  deps: RunExperimentDeps = {},
): Promise<{ manifest: ExperimentManifest; plan: RunPlan; executed: CellRecord[] }> {
  const { manifest, plan, fixtures } = expandExperiment(manifestPath, fixturesDir, deps);
  const outputDir = resolveOutputDir(cfg, manifest);
  await writePlanArtifacts(outputDir, manifest, plan, deps);

  const scheduled = scheduleCells(plan.cells, manifest.seed);
  const existing = await readExistingRecords(outputDir, manifest.experiment_id, deps);
  const remaining = cellsRemaining(scheduled, existing);

  const executed: CellRecord[] = [];
  await runPool(remaining, manifest.concurrency, async (cell: Cell) => {
    const fixture = fixtures.get(cell.fixture_id)!;
    const { outcome, materializedPrompt, effectiveConfig, trajectory } = await runCell(cfg, cell, fixture, manifest, deps.cellExecution);

    // Treatment trajectory artifact (#536): best-effort and non-fatal — a
    // collection/write failure is logged and leaves the cell's result_class
    // untouched (task 3.2), but is durably recorded on the cell record itself
    // (review 1 finding 5ae0fa6e) rather than only console.warn'd, so a
    // consumer of runs.jsonl can distinguish "collection failed" from
    // "collection was never attempted / produced nothing".
    let trajectoryArtifact: CellRecord["trajectory_artifact"];
    let trajectoryArtifactError: string | undefined;
    try {
      const artifact = buildTreatmentTrajectoryArtifact({ ...trajectory, ceilings: deps.trajectoryCeilings });
      const trajectoriesDir = path.join(experimentDir(outputDir, manifest.experiment_id), "trajectories");
      const result = await writeContentAddressedArtifact(
        cfg.repo_dir,
        trajectoriesDir,
        artifact as unknown as Record<string, unknown>,
        { truncationStatus: artifact.truncation.status },
        deps,
      );
      if (result.status === "written" || result.status === "deduped") {
        trajectoryArtifact = result.descriptor;
      } else {
        trajectoryArtifactError = result.error;
        console.warn(`[pipeline] evals: trajectory artifact for cell ${cell.cell_id} not recorded (non-fatal): ${result.error}`);
      }
    } catch (err) {
      trajectoryArtifactError = (err as Error).message;
      console.warn(`[pipeline] evals: trajectory artifact collection for cell ${cell.cell_id} failed (non-fatal): ${(err as Error).message}`);
    }

    const record: CellRecord = {
      cell_id: cell.cell_id,
      experiment_id: cell.experiment_id,
      fixture_id: cell.fixture_id,
      treatment_id: cell.treatment_id,
      replicate: cell.replicate,
      prompt_hash: computePromptHash(materializedPrompt),
      config_hash: computeConfigHash(effectiveConfig),
      base_sha: cell.base_sha,
      env_surface_hash: fixture.env_surface_hash,
      result_class: outcome.result_class,
      detail: outcome.detail,
      error: outcome.error,
      ...(trajectoryArtifact ? { trajectory_artifact: trajectoryArtifact } : {}),
      ...(trajectoryArtifactError ? { trajectory_artifact_error: trajectoryArtifactError } : {}),
    };
    const persisted = await appendCellRecord(outputDir, record, deps);
    if (persisted) {
      executed.push(record);
    } else {
      // No durable record exists for this cell (review 2 finding 9752932c) —
      // do not report it as executed. The next `runExperiment` invocation's
      // resume logic (readExistingRecords/cellsRemaining) will see no record
      // on disk and retry it.
      console.warn(`[pipeline] evals: cell ${cell.cell_id} ran but its record could not be durably written — it will be retried`);
    }
  });

  return { manifest, plan, executed };
}
