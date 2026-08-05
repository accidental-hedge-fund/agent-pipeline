// Shared outer-host conformance kit (#784).
//
// Asserts required declaration fields, support-or-fallback completeness,
// install managed-path + user-owned exclusion when install is supported, and
// identity independence from stage adapter fields.

import type {
  OuterHostCapability,
  OuterHostCapabilityArea,
  OuterHostManifest,
} from "./types.ts";
import {
  OUTER_HOST_CAPABILITY_AREAS,
  OUTER_HOST_MANIFEST_VERSION,
  PORTABLE_OBSERVATION_BASELINE,
} from "./types.ts";

export interface OuterHostConformanceFailure {
  host: string;
  check: string;
  message: string;
}

export interface OuterHostConformanceReport {
  host: string;
  ok: boolean;
  failures: OuterHostConformanceFailure[];
}

function fail(host: string, check: string, message: string): OuterHostConformanceFailure {
  return { host, check, message };
}

const FORBIDDEN_ADAPTER_FIELDS = [
  "adapterId",
  "adapter_id",
  "provider",
  "model",
  "effort",
  "roles",
  "providerAuthClass",
  "provider_auth_class",
] as const;

function requireCapability(
  host: string,
  area: OuterHostCapabilityArea,
  cap: OuterHostCapability | undefined | null,
  failures: OuterHostConformanceFailure[],
): void {
  if (!cap || typeof cap !== "object") {
    failures.push(fail(host, "required-capability", `missing required capability area "${area}"`));
    return;
  }
  if (
    cap.support !== "supported" &&
    cap.support !== "limited" &&
    cap.support !== "unsupported"
  ) {
    failures.push(
      fail(host, "support-level", `${area}: invalid support level ${JSON.stringify(cap.support)}`),
    );
  }
  if (typeof cap.how !== "string" || !cap.how.trim()) {
    failures.push(fail(host, "how", `${area}: missing non-empty how`));
  }
  if (cap.support !== "supported") {
    if (typeof cap.fallback !== "string" || !cap.fallback.trim()) {
      failures.push(
        fail(
          host,
          "fallback",
          `${area}: support is ${cap.support} but fallback is missing or empty`,
        ),
      );
    }
  }
}

/**
 * Structural + semantic completeness checks (no I/O).
 */
export function checkOuterHostConformance(manifest: OuterHostManifest): OuterHostConformanceReport {
  const failures: OuterHostConformanceFailure[] = [];
  const host = typeof manifest?.id === "string" ? manifest.id : "(unnamed)";

  if (!manifest || typeof manifest !== "object") {
    return {
      host,
      ok: false,
      failures: [fail(host, "structure", "manifest is not an object")],
    };
  }

  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    failures.push(fail(host, "id", "missing non-empty id"));
  }
  if (typeof manifest.displayName !== "string" || !manifest.displayName.trim()) {
    failures.push(fail(host, "displayName", "missing non-empty displayName"));
  }
  if (manifest.manifestVersion !== OUTER_HOST_MANIFEST_VERSION) {
    failures.push(
      fail(
        host,
        "manifestVersion",
        `expected manifestVersion ${OUTER_HOST_MANIFEST_VERSION}, got ${String(manifest.manifestVersion)}`,
      ),
    );
  }
  if (manifest.origin !== "builtin" && manifest.origin !== "extension") {
    failures.push(fail(host, "origin", `origin must be builtin|extension, got ${String(manifest.origin)}`));
  }

  // Identity independence: no stage-adapter treatment fields on the lifecycle manifest.
  const asRecord = manifest as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_ADAPTER_FIELDS) {
    if (key in asRecord && asRecord[key] !== undefined) {
      failures.push(
        fail(
          host,
          "identity-independence",
          `manifest must not carry stage-adapter field "${key}" (outer-host identity is independent)`,
        ),
      );
    }
  }

  // Lifecycle observation capabilities use OuterHostCapability (how + fallback).
  const observationAreas = [
    "early_run_handoff",
    "event_follow",
    "reattach",
    "wait_cancel",
    "material_progress_notify",
    "terminal_cleanup",
    "terminal_summary",
  ] as const;
  for (const area of observationAreas) {
    const cap = (manifest as unknown as Record<string, OuterHostCapability | undefined>)[area];
    requireCapability(host, area, cap, failures);
  }

  // Install profile (mode/paths — not a free-form how string).
  const install = manifest.install;
  if (!install || typeof install !== "object") {
    failures.push(fail(host, "required-capability", 'missing required capability area "install"'));
  } else {
    if (
      install.support !== "supported" &&
      install.support !== "limited" &&
      install.support !== "unsupported"
    ) {
      failures.push(
        fail(host, "support-level", `install: invalid support level ${JSON.stringify(install.support)}`),
      );
    }
    if (install.support === "unsupported") {
      if (typeof install.fallback !== "string" || !install.fallback.trim()) {
        failures.push(
          fail(host, "fallback", "install: support is unsupported but fallback is missing or empty"),
        );
      }
    } else {
      if (!install.mode || install.mode === "none") {
        failures.push(
          fail(host, "install.mode", "install support is not unsupported but mode is none/missing"),
        );
      }
      if (!install.userOwnedExclusion || !String(install.userOwnedExclusion).trim()) {
        failures.push(
          fail(
            host,
            "install.userOwnedExclusion",
            "install supported/limited requires userOwnedExclusion text",
          ),
        );
      }
      if (!install.managedArtifacts || typeof install.managedArtifacts !== "object") {
        failures.push(
          fail(host, "install.managedArtifacts", "install supported requires managedArtifacts"),
        );
      } else {
        if (typeof install.managedArtifacts.skillTree !== "boolean") {
          failures.push(
            fail(host, "install.managedArtifacts.skillTree", "skillTree must be boolean"),
          );
        }
        if (!install.managedArtifacts.commandsKind) {
          failures.push(
            fail(host, "install.managedArtifacts.commandsKind", "commandsKind is required"),
          );
        }
      }
      if (!install.basePath || !Array.isArray(install.basePath.defaultHomeSegments)) {
        failures.push(
          fail(host, "install.basePath", "basePath.defaultHomeSegments is required"),
        );
      }
      if (typeof install.postInstall !== "string" || !install.postInstall.trim()) {
        failures.push(fail(host, "install.postInstall", "postInstall hint is required when install is supported"));
      }
    }
  }

  // Invocation surface.
  const invocation = manifest.invocation;
  if (!invocation || typeof invocation !== "object") {
    failures.push(
      fail(host, "required-capability", 'missing required capability area "invocation"'),
    );
  } else {
    if (
      invocation.support !== "supported" &&
      invocation.support !== "limited" &&
      invocation.support !== "unsupported"
    ) {
      failures.push(
        fail(
          host,
          "support-level",
          `invocation: invalid support level ${JSON.stringify(invocation.support)}`,
        ),
      );
    }
    if (invocation.support === "unsupported") {
      if (typeof invocation.fallback !== "string" || !invocation.fallback.trim()) {
        failures.push(
          fail(
            host,
            "fallback",
            "invocation: support is unsupported but fallback is missing or empty",
          ),
        );
      }
    } else {
      if (typeof invocation.commandSurface !== "string" || !invocation.commandSurface.trim()) {
        failures.push(
          fail(host, "invocation.commandSurface", "commandSurface is required when invocation is supported"),
        );
      }
      if (typeof invocation.skillPathHint !== "string" || !invocation.skillPathHint.trim()) {
        failures.push(
          fail(host, "invocation.skillPathHint", "skillPathHint is required when invocation is supported"),
        );
      }
      // Typed discovery probe (#784) — machine-consumed; free-text discoveryProbe
      // is documentation only.
      const disc = invocation.discovery;
      if (!disc || typeof disc !== "object") {
        failures.push(
          fail(
            host,
            "invocation.discovery",
            "discovery probe spec is required when invocation is supported",
          ),
        );
      } else if (
        disc.kind !== "which" &&
        disc.kind !== "skill_path" &&
        disc.kind !== "which_or_skill_path"
      ) {
        failures.push(
          fail(
            host,
            "invocation.discovery.kind",
            `invalid discovery.kind ${JSON.stringify(disc.kind)} (expected which|skill_path|which_or_skill_path)`,
          ),
        );
      }
    }
  }

  // Wait/cancel contract invariants.
  if (manifest.wait_cancel) {
    if (manifest.wait_cancel.classification !== "non_terminal") {
      failures.push(
        fail(
          host,
          "wait_cancel.classification",
          "wait_cancel.classification must be non_terminal (cancelled wait is never terminal)",
        ),
      );
    }
    if (manifest.wait_cancel.recovery !== "reattach_or_portable_follow") {
      failures.push(
        fail(
          host,
          "wait_cancel.recovery",
          "wait_cancel.recovery must be reattach_or_portable_follow",
        ),
      );
    }
  }

  // Material notify: portable baseline must appear in fallback when not fully tool-backed.
  const notify = manifest.material_progress_notify;
  if (notify) {
    if (!notify.mapping || typeof notify.mapping.surface !== "string") {
      failures.push(
        fail(host, "material_progress_notify.mapping", "mapping.surface is required"),
      );
    }
    if (
      notify.support !== "supported" ||
      notify.mapping?.surface === "stdout_only" ||
      notify.mapping?.surface === "none"
    ) {
      const fb = `${notify.fallback ?? ""} ${notify.how ?? ""}`;
      if (!/events\.jsonl|stdout|material-filter|portable/i.test(fb)) {
        failures.push(
          fail(
            host,
            "material_progress_notify.fallback",
            `fallback/how must name portable observation (${PORTABLE_OBSERVATION_BASELINE})`,
          ),
        );
      }
    }
  }

  return { host, ok: failures.length === 0, failures };
}

/** Throw on first failure with host id + missing field named. */
export function assertOuterHostConformance(manifest: OuterHostManifest): void {
  const report = checkOuterHostConformance(manifest);
  if (!report.ok) {
    const first = report.failures[0];
    throw new Error(
      `Outer host "${report.host}" failed conformance (${first.check}): ${first.message}`,
    );
  }
}

/** Run the kit over a list of manifests (e.g. all registered hosts). */
export function runOuterHostConformanceKit(
  manifests: readonly OuterHostManifest[],
): OuterHostConformanceReport[] {
  return manifests.map((m) => checkOuterHostConformance(m));
}
