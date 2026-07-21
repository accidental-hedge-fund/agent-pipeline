// Output filesystem contract (openspec/changes/stage-eval-runner, design.md decision 7):
//   <output_dir>/<experiment-id>/{manifest.json,plan.json,runs.jsonl,failures.jsonl}
// manifest.json and plan.json are written once, before the first treatment runs.
// runs.jsonl / failures.jsonl are additive, append-only, one JSON object per line —
// mirrors run-store.ts's appendEvent non-fatal-write convention, and routes every
// line through the repo's existing secret/injection sanitizer before it is written.

import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets, sanitize } from "../artifact-sanitize.ts";
import type { CellRecord, CellResultClass, ExperimentManifest, RunPlan } from "./types.ts";

export interface ResultsWriterDeps {
  mkdir?: (dir: string) => Promise<void>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  appendFile?: (filePath: string, content: string) => Promise<void>;
  readFile?: (filePath: string) => Promise<string | null>;
}

async function defaultMkdir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
}
async function defaultWriteFile(filePath: string, content: string): Promise<void> {
  await fs.promises.writeFile(filePath, content, "utf8");
}
async function defaultAppendFile(filePath: string, content: string): Promise<void> {
  await fs.promises.appendFile(filePath, content, "utf8");
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

export function experimentDir(outputDir: string, experimentId: string): string {
  return path.join(outputDir, experimentId);
}

/** Write manifest.json and plan.json before the first treatment executes
 *  (design.md decision 1). Idempotent: safe to call again on resume. */
export async function writePlanArtifacts(
  outputDir: string,
  manifest: ExperimentManifest,
  plan: RunPlan,
  deps: ResultsWriterDeps = {},
): Promise<void> {
  const mkdirFn = deps.mkdir ?? defaultMkdir;
  const writeFileFn = deps.writeFile ?? defaultWriteFile;
  const dir = experimentDir(outputDir, manifest.experiment_id);
  await mkdirFn(dir);
  await writeFileFn(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFileFn(path.join(dir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

function resultsFileFor(resultClass: CellResultClass): "runs.jsonl" | "failures.jsonl" {
  return resultClass === "completed" ? "runs.jsonl" : "failures.jsonl";
}

/** Append one cell record to the correct stream (runs.jsonl for `completed`,
 *  failures.jsonl for infra_error/auth_error/timeout). Never rewrites an
 *  existing line; a write failure is logged and swallowed, matching
 *  run-store.ts's non-fatal-write convention — a broken result stream must
 *  never abort the rest of the experiment. Returns whether the record was
 *  durably written: a caller MUST NOT treat the cell as executed when this
 *  is `false` (review 2 finding 9752932c) — the cell has no record on disk,
 *  so the next `runExperiment` invocation's resume logic will retry it. */
export async function appendCellRecord(
  outputDir: string,
  record: CellRecord,
  deps: ResultsWriterDeps = {},
): Promise<boolean> {
  const mkdirFn = deps.mkdir ?? defaultMkdir;
  const appendFileFn = deps.appendFile ?? defaultAppendFile;
  const dir = experimentDir(outputDir, record.experiment_id);
  const filePath = path.join(dir, resultsFileFor(record.result_class));
  const line = `${sanitize(redactSecrets(JSON.stringify(record)))}\n`;
  try {
    await mkdirFn(dir);
    await appendFileFn(filePath, line);
    return true;
  } catch (err) {
    console.warn(`[pipeline] evals: appendCellRecord failed (non-fatal): ${(err as Error).message}`);
    return false;
  }
}

function parseJsonlLines(text: string): CellRecord[] {
  const records: CellRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    records.push(JSON.parse(trimmed) as CellRecord);
  }
  return records;
}

/** Read every previously-written cell record (both streams) for resume. */
export async function readExistingRecords(
  outputDir: string,
  experimentId: string,
  deps: ResultsWriterDeps = {},
): Promise<CellRecord[]> {
  const readFileFn = deps.readFile ?? defaultReadFile;
  const dir = experimentDir(outputDir, experimentId);
  const [runsText, failuresText] = await Promise.all([
    readFileFn(path.join(dir, "runs.jsonl")),
    readFileFn(path.join(dir, "failures.jsonl")),
  ]);
  return [
    ...(runsText ? parseJsonlLines(runsText) : []),
    ...(failuresText ? parseJsonlLines(failuresText) : []),
  ];
}
