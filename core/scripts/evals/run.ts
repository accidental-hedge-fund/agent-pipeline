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
import { appendCellRecord, readExistingRecords, writePlanArtifacts, type ResultsWriterDeps } from "./results.ts";
import { runCell, type CellExecutionDeps } from "./executor.ts";
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

export interface RunExperimentDeps extends ExpandExperimentDeps, ResultsWriterDeps {
  cellExecution?: CellExecutionDeps;
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
    const { outcome, materializedPrompt, effectiveConfig } = await runCell(cfg, cell, fixture, manifest, deps.cellExecution);
    const record: CellRecord = {
      cell_id: cell.cell_id,
      experiment_id: cell.experiment_id,
      fixture_id: cell.fixture_id,
      treatment_id: cell.treatment_id,
      replicate: cell.replicate,
      prompt_hash: computePromptHash(materializedPrompt),
      config_hash: computeConfigHash(effectiveConfig),
      base_sha: cell.base_sha,
      result_class: outcome.result_class,
      detail: outcome.detail,
      error: outcome.error,
    };
    await appendCellRecord(outputDir, record, deps);
    executed.push(record);
  });

  return { manifest, plan, executed };
}
