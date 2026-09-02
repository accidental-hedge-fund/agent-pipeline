// Typed operation observations for RecoverySupervisor adapters (#1329).
//
// Command, stage, and factory surfaces emit these records. They do not choose
// Cooling, wait, typed-request, or cancellation policy. RecoverySupervisor
// remains the sole lifecycle owner. This module is not a second supervisor,
// answer ledger, grant schema, or public CLI verb.

export const OPERATION_OBSERVATION_SCHEMA_VERSION = 1 as const;

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
  report?.(obs);
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
