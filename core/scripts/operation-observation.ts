// Typed operation observations for RecoverySupervisor adapters (#1329).
//
// Command, stage, and factory surfaces emit these records. They do not choose
// Cooling, wait, typed-request, or cancellation policy. RecoverySupervisor
// remains the sole lifecycle owner. This module is not a second supervisor,
// answer ledger, grant schema, or public CLI verb.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const OPERATION_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const OPERATION_OBSERVATION_DIR_DEFAULT = path.join(
  os.tmpdir(),
  "pipeline-operation-observations",
);

export type SideEffectCertainty = "known_complete" | "known_absent" | "uncertain";

export type ObservationLifecycleState = "active" | "cooling" | "waiting" | "complete";

export interface CapabilityRequestObservation {
  kind: "capability";
  capability: string;
  detail: string;
}

export interface OperationObservation {
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
}

function observationFileName(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

/** Persist one observation so RecoverySupervisor retains ownership across process exit. */
export function persistOperationObservation(
  obs: OperationObservation,
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): PersistedOperationObservation {
  fs.mkdirSync(dir, { recursive: true });
  const observation_id = `${Date.now().toString(16)}-${obs.form_id}-${randomBytes(4).toString("hex")}`;
  const recorded_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const record: PersistedOperationObservation = { ...obs, observation_id, recorded_at };
  const file = path.join(dir, observationFileName(observation_id));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
  fs.renameSync(tmp, file);
  return record;
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
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as PersistedOperationObservation;
      if (raw && raw.owned === true && raw.schema_version === OPERATION_OBSERVATION_SCHEMA_VERSION) {
        out.push(raw);
      }
    } catch {
      // skip unreadable records
    }
  }
  return out;
}

/** Production RecoverySupervisor adapter: persist observations durably. */
export function recoverySupervisorObservationSink(
  dir: string = OPERATION_OBSERVATION_DIR_DEFAULT,
): ReportOperationObservation {
  return (obs) => {
    persistOperationObservation(obs, dir);
  };
}

export const defaultRecoverySupervisorReport: ReportOperationObservation =
  recoverySupervisorObservationSink();

export function mechanicalFaultObservation(input: {
  operation: string;
  form_id: string;
  message: string;
  fault?: string | null;
  certainty?: SideEffectCertainty;
  capability_request?: CapabilityRequestObservation | null;
}): OperationObservation {
  return {
    schema_version: OPERATION_OBSERVATION_SCHEMA_VERSION,
    operation: input.operation,
    form_id: input.form_id,
    certainty: input.certainty ?? "uncertain",
    lifecycle: "cooling",
    human_owned: false,
    complete: false,
    cancelled: false,
    process_exit_is_completion: false,
    owned: true,
    fault: input.fault ?? "mechanical",
    message: input.message,
    capability_request: input.capability_request ?? null,
  };
}

export function reportMechanicalFault(
  report: ReportOperationObservation | undefined,
  input: Parameters<typeof mechanicalFaultObservation>[0],
): OperationObservation {
  const obs = mechanicalFaultObservation(input);
  (report ?? defaultRecoverySupervisorReport)(obs);
  return obs;
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
