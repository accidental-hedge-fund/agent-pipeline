// Durable grill-run store (#1369). Copies the loop-store I/O seam (atomic
// write, exclusive create). Does not import the loop supervisor or contract.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import {
  parseGrillManifest,
  type GrillManifest,
} from "./grill-selector.ts";
import type { TypedRequestKind } from "./grill-decisions.ts";

export const GRILL_STATE_HOME_ENV = "AGENT_PIPELINE_STATE_HOME";
export const GRILL_LEDGER_SCHEMA = "grill-ledger.v1" as const;

export type GrillIssueStatus =
  | "pending"
  | "in_progress"
  | "waiting"
  | "ready"
  | "failed"
  | "ineligible"
  | "migrated";

export interface GrillDocsAction {
  kind: "context_term" | "adr";
  term_id?: string;
  payload_sha256: string;
  necessity: "required" | "advisory";
  pr_url?: string;
}

export interface GrillTypedRequestRecord {
  node_id: string;
  kind: TypedRequestKind;
  handoff_class: string;
  handoff_id?: string;
}

export interface GrillIssueState {
  issue: number;
  /** Stable admitted operation retained across publication retries/resume. */
  logical_operation_id?: string;
  status: GrillIssueStatus;
  migrated: boolean;
  facts: string[];
  accepted_node_ids: string[];
  typed_requests: GrillTypedRequestRecord[];
  docs_actions: GrillDocsAction[];
  ready_gate: { ok: boolean; reason?: string; code?: string };
  evidence: string[];
  last_body_sha256?: string;
  error?: string;
}

export interface GrillLedger {
  schema_version: typeof GRILL_LEDGER_SCHEMA;
  run_id: string;
  status: "running" | "waiting" | "complete" | "failed";
  issues: Record<string, GrillIssueState>;
  docs_pr_url?: string;
  merge_commands: string[];
}

export interface GrillStoreDeps {
  fsExists(p: string): Promise<boolean>;
  readTextFile(p: string): Promise<string | null>;
  writeFileAtomic(p: string, content: string): Promise<void>;
  createFileExclusive(p: string, content: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  listDir(p: string): Promise<string[]>;
  now(): Date;
  uuid(): string;
  env: NodeJS.ProcessEnv;
}

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === ".." || runId.includes("..")) {
    throw new Error(`invalid grill run id "${runId}"`);
  }
}

export function resolveGrillStateHome(deps: Pick<GrillStoreDeps, "env">): string {
  const env = deps.env;
  if (env[GRILL_STATE_HOME_ENV]) {
    return path.join(path.resolve(env[GRILL_STATE_HOME_ENV]!), "grill");
  }
  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "grill");
  }
  return path.join(homedir(), ".local", "state", "agent-pipeline", "grill");
}

export function grillRunDir(deps: Pick<GrillStoreDeps, "env">, runId: string): string {
  assertSafeRunId(runId);
  return path.join(resolveGrillStateHome(deps), "runs", runId);
}

function manifestPath(dir: string): string {
  return path.join(dir, "manifest.json");
}
function ledgerPath(dir: string): string {
  return path.join(dir, "ledger.json");
}
function eventsPath(dir: string): string {
  return path.join(dir, "events.jsonl");
}

export function newGrillRunId(now: Date, uuid: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
  const token = uuid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "run";
  return `grill-${stamp}-${token}`;
}

export async function initGrillRun(
  deps: GrillStoreDeps,
  manifest: GrillManifest,
  ledger: GrillLedger,
): Promise<void> {
  const dir = grillRunDir(deps, manifest.run_id);
  await deps.mkdirp(dir);
  const created = await deps.createFileExclusive(
    manifestPath(dir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  if (!created) {
    throw new Error(`grill run "${manifest.run_id}" already exists`);
  }
  await deps.writeFileAtomic(ledgerPath(dir), `${JSON.stringify(ledger, null, 2)}\n`);
}

export async function loadGrillManifest(
  deps: GrillStoreDeps,
  runId: string,
): Promise<GrillManifest> {
  const text = await deps.readTextFile(manifestPath(grillRunDir(deps, runId)));
  if (!text) throw new Error(`grill run "${runId}" not found`);
  const parsed = parseGrillManifest(JSON.parse(text));
  if (!parsed) throw new Error(`grill run "${runId}" manifest is invalid`);
  return parsed;
}

export async function loadGrillLedger(deps: GrillStoreDeps, runId: string): Promise<GrillLedger> {
  const text = await deps.readTextFile(ledgerPath(grillRunDir(deps, runId)));
  if (!text) throw new Error(`grill run "${runId}" ledger not found`);
  return JSON.parse(text) as GrillLedger;
}

export async function saveGrillLedger(
  deps: GrillStoreDeps,
  ledger: GrillLedger,
): Promise<void> {
  const dir = grillRunDir(deps, ledger.run_id);
  await deps.writeFileAtomic(ledgerPath(dir), `${JSON.stringify(ledger, null, 2)}\n`);
}

export async function appendGrillEvent(
  deps: GrillStoreDeps,
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const dir = grillRunDir(deps, runId);
  const file = eventsPath(dir);
  const prev = (await deps.readTextFile(file)) ?? "";
  const line = `${JSON.stringify({ at: deps.now().toISOString(), ...event })}\n`;
  await deps.writeFileAtomic(file, prev + line);
}

export function emptyLedger(runId: string, issueIds: number[]): GrillLedger {
  const issues: Record<string, GrillIssueState> = {};
  for (const id of issueIds) {
    issues[String(id)] = {
      issue: id,
      status: "pending",
      migrated: false,
      facts: [],
      accepted_node_ids: [],
      typed_requests: [],
      docs_actions: [],
      ready_gate: { ok: false },
      evidence: [],
    };
  }
  return {
    schema_version: GRILL_LEDGER_SCHEMA,
    run_id: runId,
    status: "running",
    issues,
    merge_commands: [],
  };
}

export interface GrillStatusCounts {
  selected: number;
  migrated: number;
  waiting: number;
  ready: number;
  failed: number;
}

export function grillStatusCounts(ledger: GrillLedger, selected: number): GrillStatusCounts {
  const states = Object.values(ledger.issues);
  return {
    selected,
    migrated: states.filter((s) => s.migrated).length,
    waiting: states.filter((s) => s.status === "waiting").length,
    ready: states.filter((s) => s.status === "ready").length,
    failed: states.filter((s) => s.status === "failed").length,
  };
}

export function realGrillStoreDeps(env: NodeJS.ProcessEnv = process.env): GrillStoreDeps {
  return {
    fsExists: async (p) => fs.existsSync(p),
    readTextFile: async (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    writeFileAtomic: async (p, content) => {
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, content, "utf8");
      fs.renameSync(tmp, p);
    },
    createFileExclusive: async (p, content) => {
      const dir = path.dirname(p);
      fs.mkdirSync(dir, { recursive: true });
      try {
        const fd = fs.openSync(p, "wx");
        fs.writeFileSync(fd, content, "utf8");
        fs.closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    },
    mkdirp: async (p) => {
      fs.mkdirSync(p, { recursive: true });
    },
    listDir: async (p) => {
      try {
        return fs.readdirSync(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
    },
    now: () => new Date(),
    uuid: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    env,
  };
}
