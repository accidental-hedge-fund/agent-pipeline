// Factory control-identity validators (#890).
//
// Five distinct slots; refuse missing values and silent remaps. A non-Claude
// service controller is never rewritten to `codex`. Outer-host identity is
// resolved via outer-host evidence helpers without collapsing into controller
// or stage treatments.

import { OUTER_HOST_UNKNOWN } from "../outer-hosts/evidence.ts";
import {
  FACTORY_SERVICE_CONTROLLER_ID,
  FactoryError,
  type FactoryControlIdentities,
} from "./types.ts";

const SERVICE_CONTROLLER_RE = /^factory-macro@\d+$/;

export interface ValidateIdentitiesOptions {
  /** When true (factory mode enabled), all five slots are required. */
  factoryModeEnabled: boolean;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate five-way identity separation. Throws FactoryError("identity"|"validation").
 * Never rewrites controller identity to codex or any host adapter id.
 */
export function validateFactoryIdentities(
  raw: Partial<FactoryControlIdentities> | null | undefined,
  opts: ValidateIdentitiesOptions,
): FactoryControlIdentities {
  if (!opts.factoryModeEnabled) {
    // When disabled, identities are not required for ordinary commands.
    return {
      service_controller: raw?.service_controller?.trim() || FACTORY_SERVICE_CONTROLLER_ID,
      outer_host: raw?.outer_host?.trim() || OUTER_HOST_UNKNOWN,
      implementer_treatment: raw?.implementer_treatment?.trim() || "",
      reviewer_treatment: raw?.reviewer_treatment?.trim() || "",
      privileged_mutation_actor: raw?.privileged_mutation_actor?.trim() || "",
    };
  }

  const missing: string[] = [];
  if (!nonEmpty(raw?.service_controller)) missing.push("service_controller");
  if (!nonEmpty(raw?.outer_host)) missing.push("outer_host");
  if (!nonEmpty(raw?.implementer_treatment)) missing.push("implementer_treatment");
  if (!nonEmpty(raw?.reviewer_treatment)) missing.push("reviewer_treatment");
  if (!nonEmpty(raw?.privileged_mutation_actor)) missing.push("privileged_mutation_actor");
  if (missing.length > 0) {
    throw new FactoryError(
      "identity",
      `factory adoption requires distinct identity slots; missing: ${missing.join(", ")}`,
    );
  }

  const identities: FactoryControlIdentities = {
    service_controller: raw!.service_controller!.trim(),
    outer_host: raw!.outer_host!.trim(),
    implementer_treatment: raw!.implementer_treatment!.trim(),
    reviewer_treatment: raw!.reviewer_treatment!.trim(),
    privileged_mutation_actor: raw!.privileged_mutation_actor!.trim(),
  };

  // Service controller must be a factory-macro@N id — never a host/adapter shorthand.
  if (!SERVICE_CONTROLLER_RE.test(identities.service_controller)) {
    throw new FactoryError(
      "identity",
      `service_controller must match factory-macro@N (got "${identities.service_controller}"); ` +
        `refusing silent host alias (including recording a non-Claude controller as codex)`,
    );
  }

  // Refuse collapse of controller into outer host or stage treatments.
  if (identities.service_controller === identities.outer_host) {
    throw new FactoryError(
      "identity",
      "service_controller must remain distinct from outer_host",
    );
  }
  if (
    identities.service_controller === identities.implementer_treatment ||
    identities.service_controller === identities.reviewer_treatment
  ) {
    throw new FactoryError(
      "identity",
      "service_controller must remain distinct from implementer/reviewer treatments",
    );
  }

  // Explicit ban: never accept host adapter ids as controller (codex/claude/…).
  const hostish = new Set(["codex", "claude", "grok", "opencode"]);
  if (hostish.has(identities.service_controller.toLowerCase())) {
    throw new FactoryError(
      "identity",
      `service_controller "${identities.service_controller}" is a host/adapter id; ` +
        `use ${FACTORY_SERVICE_CONTROLLER_ID} (no silent remap)`,
    );
  }

  return identities;
}

/**
 * Resolve outer-host for a factory contract without inventing it from the
 * service controller id or stage treatments.
 */
export function resolveFactoryOuterHost(input: {
  explicit?: string | null;
  isRegistered?: (id: string) => boolean;
}): string {
  const raw = typeof input.explicit === "string" ? input.explicit.trim() : "";
  if (!raw) return OUTER_HOST_UNKNOWN;
  if (input.isRegistered && !input.isRegistered(raw)) return OUTER_HOST_UNKNOWN;
  return raw;
}
