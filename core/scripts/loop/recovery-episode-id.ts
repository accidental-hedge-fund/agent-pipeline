import * as crypto from "node:crypto";

export interface RecoveryEpisodeIdentityKey {
  operation: string;
  invariant: string;
  candidate_epoch: string;
  evidence_identity: string;
}

/** Stable identity shared by store compatibility normalization and recovery. */
export function recoveryEpisodeId(key: RecoveryEpisodeIdentityKey): string {
  const canonical = [
    "pipeline-recovery-episode@1",
    key.operation,
    key.invariant,
    key.candidate_epoch,
    key.evidence_identity,
  ].join("\0");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}
