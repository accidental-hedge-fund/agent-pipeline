// Canonical hashing for factory execution-contract revisions (#890).
//
// Hash is computed over a documented body that excludes the `canonical_hash`
// field itself. Key order is sorted so equivalent bodies hash identically
// regardless of which outer host compiled them.

import { createHash } from "node:crypto";
import type { FactoryExecutionContractBody } from "./types.ts";

/** Deterministic JSON stringification (sorted object keys). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Build the hashed body object from a contract body (or partial). Callers
 * pass the accepted body without `canonical_hash`.
 */
export function factoryHashedBody(body: FactoryExecutionContractBody): Record<string, unknown> {
  return {
    schema: body.schema,
    factory_run_id: body.factory_run_id,
    revision: body.revision,
    repo: {
      name: body.repo.name,
      base_branch: body.repo.base_branch,
      observed_base_sha: body.repo.observed_base_sha,
    },
    selector: { type: body.selector.type, value: body.selector.value },
    issue_ids: [...body.issue_ids],
    pr_ids: [...body.pr_ids],
    milestones: [...body.milestones],
    dependency_edges: body.dependency_edges.map((e) => ({ from: e.from, to: e.to })),
    linked_runs: {
      loop_run_id: body.linked_runs.loop_run_id ?? null,
      loop_contract_hash: body.linked_runs.loop_contract_hash ?? null,
      advance_run_id: body.linked_runs.advance_run_id ?? null,
      legacy_run_identity: body.linked_runs.legacy_run_identity ?? null,
    },
    identities: {
      service_controller: body.identities.service_controller,
      outer_host: body.identities.outer_host,
      implementer_treatment: body.identities.implementer_treatment,
      reviewer_treatment: body.identities.reviewer_treatment,
      privileged_mutation_actor: body.identities.privileged_mutation_actor,
    },
    fingerprints: {
      authority_policy: body.fingerprints.authority_policy,
      engine_pin: body.fingerprints.engine_pin,
      configuration: body.fingerprints.configuration,
      treatment: body.fingerprints.treatment,
    },
    coarse_phase: body.coarse_phase,
    completion_policy: body.completion_policy,
    next_action: body.next_action,
    prior_revision: body.prior_revision,
    prior_canonical_hash: body.prior_canonical_hash,
    live_state_reason: body.live_state_reason,
    accepted_at: body.accepted_at,
  };
}

/** sha256 hex of the stable serialization of the hashed body. */
export function computeFactoryCanonicalHash(body: FactoryExecutionContractBody): string {
  return createHash("sha256").update(stableStringify(factoryHashedBody(body)), "utf8").digest("hex");
}
