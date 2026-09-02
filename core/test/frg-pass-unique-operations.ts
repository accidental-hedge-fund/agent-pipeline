import {
  REQUIRED_LIFECYCLE_CLASSES_1333,
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
    // Explicit executed-coverage overlay for FRG tests that are not the #1333
    // matrix proof. Production computeFrgEvidence without overlay fail-closes.
    matrix_covered_lifecycle_classes: [...REQUIRED_LIFECYCLE_CLASSES_1333],
  };
}
