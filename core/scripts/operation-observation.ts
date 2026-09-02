// Typed operation observations for RecoverySupervisor adapters (#1329).
//
// Command, stage, and factory surfaces emit these records. They do not choose
// Cooling, wait, typed-request, or cancellation policy. RecoverySupervisor
// remains the sole lifecycle owner. This module is not a second supervisor,
// answer ledger, grant schema, or public CLI verb.
//
// Persistence is a claim adapter: one atomic record per (domain,
// logical_operation_id), stored under pipeline state-home (not anonymous
// /tmp files). Recovery consumes that claim by identity.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLogicalOperationId, mintLogicalOperationId } from "./logical-operation.ts";

export const OPERATION_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type SideEffectCertainty = "known_complete" | "known_absent" | "uncertain";

export type ObservationLifecycleState = "active" | "cooling" | "waiting" | "complete";

export interface CapabilityRequestObservation {
  kind: "capability";
  capability: string;
  detail: string;
}

export interface OperationIdentity {
  domain: string;
  logical_operation_id: string;
  repository: string | null;
  issue: number | null;
  run_id: string | null;
}

export interface OperationObservation extends OperationIdentity {
  schema_version: typeof OPERATION_OBSERVATION_SCHEMA_VERSION;
  operation: string;
  form_id: string;
  certainty: SideEffectCertainty;
  lifecycle: ObservationLifecycleState;
  human_owned: false;
  complete: boolean;
  cancelled: false;
  process_exit_is_completion: false;
  /** RecoverySupervisor retains ownership of the Logical Operation. */
  owned: true;
  fault: string | null;
  message: string;
  capability_request: CapabilityRequestObservation | null;
}

export type ReportOperationObservation = (obs: OperationObservation) => void;

export interface PersistedOperationObservation extends OperationObservation {
  observation_id: string;
  recorded_at: string;
  transitioned_at?: string;
}

export function resolveOperationClaimDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENT_PIPELINE_STATE_HOME) {
    return path.join(path.resolve(env.AGENT_PIPELINE_STATE_HOME), "operation-claims");
  }
  if (env.PIPELINE_STATE_HOME) {
    return path.join(path.resolve(env.PIPELINE_STATE_HOME), "operation-claims");
  }
  if (env.XDG_STATE_HOME) {
    return path.join(path.resolve(env.XDG_STATE_HOME), "agent-pipeline", "operation-claims");
  }
  return path.join(os.homedir(), ".local", "state", "agent-pipeline", "operation-claims");
}

export const OPERATION_OBSERVATION_DIR_DEFAULT = resolveOperationClaimDir();

export function operationClaimKey(domain: string, logicalOperationId: string): string {
  return `${domain.trim().toLowerCase()}::${logicalOperationId}`;
}

function observationFileName(key: string): string {
  return `${key.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

export function mintObservationIdentity(input: {
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  mint?: () => string;
}): OperationIdentity {
  const domain = String(input.domain ?? "").trim();
  if (!domain) {
    throw new Error("operation observation: domain is required");
  }
  const logical_operation_id =
    (typeof input.logical_operation_id === "string" && input.logical_operation_id.trim()) ||
    (input.mint ?? mintLogicalOperationId)();
  if (!isLogicalOperationId(logical_operation_id)) {
    throw new Error("operation observation: logical_operation_id is required");
  }
  return {
    domain,
    logical_operation_id,
    repository: typeof input.repository === "string" && input.repository.trim() ? input.repository.trim() : null,
    issue: typeof input.issue === "number" && Number.isInteger(input.issue) ? input.issue : null,
    run_id: typeof input.run_id === "string" && input.run_id.trim() ? input.run_id.trim() : null,
  };
}

function stableObservationId(obs: OperationObservation): string {
  return `${obs.logical_operation_id}:${obs.form_id}:${obs.operation}`;
}

function sameClaimIdentity(a: OperationObservation, b: OperationObservation): boolean {
  return (
    a.domain === b.domain &&
    a.logical_operation_id === b.logical_operation_id &&
    a.form_id === b.form_id &&
    a.operation === b.operation
  );
}

function readClaimFile(file: string): PersistedOperationObservation | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedOperationObservation;
    if (!raw || raw.owned !== true || raw.schema_version !== OPERATION_OBSERVATION_SCHEMA_VERSION) {
      return null;
    }
    if (!raw.domain || !isLogicalOperationId(raw.logical_operation_id)) return null;
    return raw;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function writeClaimAtomic(file: string, record: PersistedOperationObservation): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  fs.renameSync(tmp, file);
}

export type PersistOperationObservationDeps = {
  /** Exclusive create (`wx`). Tests inject EEXIST races. */
  exclusiveCreate?: (file: string, contents: string) => void;
};

function exclusiveCreateClaim(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
}

/** Persist one observation as an atomic claim keyed by domain + logical operation. */
export function persistOperationObservation(
  obs: OperationObservation,
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
  deps: PersistOperationObservationDeps = {},
): PersistedOperationObservation {
  if (!obs.domain?.trim() || !isLogicalOperationId(obs.logical_operation_id)) {
    throw new Error("operation observation: domain and logical_operation_id are required");
  }
  fs.mkdirSync(dir, { recursive: true });
  const key = operationClaimKey(obs.domain, obs.logical_operation_id);
  const file = path.join(dir, observationFileName(key));
  const recorded_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  let createRace = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const existing = readClaimFile(file);
    if (existing && sameClaimIdentity(existing, obs)) {
      const duplicate =
        existing.lifecycle === obs.lifecycle &&
        existing.fault === obs.fault &&
        existing.complete === obs.complete &&
        existing.message === obs.message;
      if (duplicate) return existing;
      // Concurrent create: an admission wx winner must not discard a cooling/fault
      // report that lost the exclusive create.
      if (
        createRace &&
        obs.lifecycle === "active" &&
        obs.fault === null &&
        obs.complete === false &&
        (existing.fault !== null ||
          existing.complete ||
          existing.lifecycle === "cooling" ||
          existing.lifecycle === "waiting" ||
          existing.lifecycle === "complete")
      ) {
        return existing;
      }
      const next: PersistedOperationObservation = {
        ...existing,
        ...obs,
        observation_id: existing.observation_id,
        recorded_at: existing.recorded_at,
        transitioned_at: recorded_at,
      };
      writeClaimAtomic(file, next);
      return next;
    }
    const record: PersistedOperationObservation = {
      ...obs,
      observation_id: stableObservationId(obs),
      recorded_at,
    };
    if (existing === null) {
      try {
        (deps.exclusiveCreate ?? exclusiveCreateClaim)(file, JSON.stringify(record));
        return record;
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") throw err;
        createRace = true;
        continue;
      }
    }
    writeClaimAtomic(file, record);
    return record;
  }
  const record: PersistedOperationObservation = {
    ...obs,
    observation_id: stableObservationId(obs),
    recorded_at,
  };
  writeClaimAtomic(file, record);
  return record;
}

export function loadOwnedOperationClaim(
  domain: string,
  logicalOperationId: string,
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): PersistedOperationObservation | null {
  const file = path.join(dir, observationFileName(operationClaimKey(domain, logicalOperationId)));
  const rec = readClaimFile(file);
  if (!rec) return null;
  if (!rec.owned || rec.complete || rec.human_owned || rec.cancelled) return null;
  return rec;
}

export function listPersistedOperationObservations(
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): PersistedOperationObservation[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: PersistedOperationObservation[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const rec = readClaimFile(path.join(dir, name));
    if (rec) out.push(rec);
  }
  return out;
}

/** RecoverySupervisor consumer: retain ownership from a durable claim. */
export function consumeOwnedOperation(claim: PersistedOperationObservation): {
  owned: true;
  lifecycle: ObservationLifecycleState;
  domain: string;
  logical_operation_id: string;
  issue: number | null;
  run_id: string | null;
} {
  if (!claim.owned || claim.complete || claim.human_owned || claim.cancelled) {
    throw new Error("recovery supervisor: claim is not an owned Logical Operation");
  }
  return {
    owned: true,
    lifecycle: claim.lifecycle,
    domain: claim.domain,
    logical_operation_id: claim.logical_operation_id,
    issue: claim.issue,
    run_id: claim.run_id,
  };
}

/** Production RecoverySupervisor adapter: persist claims durably by identity. */
export function recoverySupervisorObservationSink(
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): ReportOperationObservation {
  return (obs) => {
    persistOperationObservation(obs, dir);
  };
}

export const defaultRecoverySupervisorReport: ReportOperationObservation =
  recoverySupervisorObservationSink();

function observationBase(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  certainty?: SideEffectCertainty;
  lifecycle: ObservationLifecycleState;
  complete: boolean;
  fault: string | null;
  capability_request?: CapabilityRequestObservation | null;
}): OperationObservation {
  const identity = mintObservationIdentity(input);
  return {
    schema_version: OPERATION_OBSERVATION_SCHEMA_VERSION,
    operation: input.operation,
    form_id: input.form_id,
    ...identity,
    certainty: input.certainty ?? "uncertain",
    lifecycle: input.lifecycle,
    human_owned: false,
    complete: input.complete,
    cancelled: false,
    process_exit_is_completion: false,
    owned: true,
    fault: input.fault,
    message: input.message,
    capability_request: input.capability_request ?? null,
  };
}

export function ownedAdmissionObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "active",
    complete: false,
    fault: null,
    certainty: "uncertain",
  });
}

export function completedOperationObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "complete",
    complete: true,
    fault: null,
    certainty: "known_complete",
  });
}

export function mechanicalFaultObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  domain: string;
  logical_operation_id?: string | null;
  repository?: string | null;
  issue?: number | null;
  run_id?: string | null;
  fault?: string | null;
  certainty?: SideEffectCertainty;
  capability_request?: CapabilityRequestObservation | null;
}): OperationObservation {
  return observationBase({
    ...input,
    lifecycle: "cooling",
    complete: false,
    fault: input.fault ?? "mechanical",
    certainty: input.certainty ?? "uncertain",
    capability_request: input.capability_request ?? null,
  });
}

export function reportOwnedOperation(
  report: ReportOperationObservation | undefined,
  obs: OperationObservation,
): OperationObservation {
  (report ?? defaultRecoverySupervisorReport)(obs);
  return obs;
}

export function reportMechanicalFault(
  report: ReportOperationObservation | undefined,
  input: Parameters<typeof mechanicalFaultObservation>[0],
): OperationObservation {
  return reportOwnedOperation(report, mechanicalFaultObservation(input));
}

export function memoryObservationSink(): {
  observations: OperationObservation[];
  reportObservation: ReportOperationObservation;
} {
  const observations: OperationObservation[] = [];
  return {
    observations,
    reportObservation(obs) {
      observations.push(obs);
    },
  };
}
