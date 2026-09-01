import {
  passingUniqueOperationAttempts,
  passingUniqueOperationManifest,
} from "../scripts/operation-reliability.ts";

/** Spread into computeFrgEvidence inputs that expect release-eligible unique-operation SLOs. */
export function frgPassUniqueOperations(releaseIdentity = "1.30.0") {
  return {
    unique_operations: passingUniqueOperationAttempts(),
    unique_operation_manifest: passingUniqueOperationManifest({
      release_identity: releaseIdentity,
    }),
  };
}
