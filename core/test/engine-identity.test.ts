// Engine identity (#450): fingerprint purity, the pinned-identity resolver,
// and the injectable drift probe used at stage boundaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEngineDriftTransition,
  probeEngineIdentity,
  resolvePinnedEngineIdentity,
  templatesFingerprint,
  type EngineIdentity,
} from "../scripts/engine-identity.ts";

function id(overrides: Partial<EngineIdentity> = {}): EngineIdentity {
  return { version: "1.0.0", root: "/opt/core", templates_fingerprint: "fp-a", ...overrides };
}

test("templatesFingerprint is content-sensitive", () => {
  const a = templatesFingerprint({ fix: "hello", planning: "world" });
  const b = templatesFingerprint({ fix: "hello!!", planning: "world" });
  assert.notEqual(a, b);
});

test("templatesFingerprint is enumeration-order-independent", () => {
  const a = templatesFingerprint({ fix: "one", planning: "two", review: "three" });
  const b = templatesFingerprint({ review: "three", fix: "one", planning: "two" });
  assert.equal(a, b);
});

test("templatesFingerprint is stable across repeated computation", () => {
  const snapshot = { fix: "one", planning: "two" };
  assert.equal(templatesFingerprint(snapshot), templatesFingerprint(snapshot));
});

test("templatesFingerprint distinguishes an identical-content-different-name snapshot", () => {
  const a = templatesFingerprint({ fix: "same" });
  const b = templatesFingerprint({ other: "same" });
  assert.notEqual(a, b);
});

test("resolvePinnedEngineIdentity returns version/root/templates_fingerprint from the real install", () => {
  const identity = resolvePinnedEngineIdentity();
  assert.ok(identity, "package.json in this checkout should resolve a version");
  assert.equal(typeof identity.version, "string");
  assert.ok(identity.version.length > 0);
  assert.equal(typeof identity.root, "string");
  assert.equal(typeof identity.templates_fingerprint, "string");
  assert.equal(identity.templates_fingerprint.length, 64); // sha256 hex
});

test("probeEngineIdentity uses the injected deps and performs no other I/O", () => {
  let versionCalls = 0;
  let templateCalls = 0;
  const identity = probeEngineIdentity({
    readVersion: () => {
      versionCalls++;
      return "9.9.9";
    },
    readTemplatesFromDisk: () => {
      templateCalls++;
      return { fix: "fake content" };
    },
  });
  assert.equal(versionCalls, 1);
  assert.equal(templateCalls, 1);
  assert.ok(identity);
  assert.equal(identity.version, "9.9.9");
  assert.equal(identity.templates_fingerprint, templatesFingerprint({ fix: "fake content" }));
});

test("probeEngineIdentity returns null when the version cannot be resolved", () => {
  const identity = probeEngineIdentity({
    readVersion: () => null,
    readTemplatesFromDisk: () => ({ fix: "x" }),
  });
  assert.equal(identity, null);
});

test("probeEngineIdentity returns null (never throws) when a dep throws", () => {
  const identity = probeEngineIdentity({
    readVersion: () => {
      throw new Error("engine files unreadable");
    },
    readTemplatesFromDisk: () => ({ fix: "x" }),
  });
  assert.equal(identity, null);
});

test("probeEngineIdentity returns null when the template read throws", () => {
  const identity = probeEngineIdentity({
    readVersion: () => "1.0.0",
    readTemplatesFromDisk: () => {
      throw new Error("prompts dir unreadable");
    },
  });
  assert.equal(identity, null);
});

// ---------------------------------------------------------------------------
// isEngineDriftTransition — pure decision used at each stage boundary
// ---------------------------------------------------------------------------

test("isEngineDriftTransition: identical identity is not a transition", () => {
  assert.equal(isEngineDriftTransition(id(), id()), false);
});

test("isEngineDriftTransition: a version change is a transition", () => {
  assert.equal(isEngineDriftTransition(id({ version: "1.0.0" }), id({ version: "1.0.1" })), true);
});

test("isEngineDriftTransition: a content-only fingerprint change (same version) is still a transition", () => {
  assert.equal(
    isEngineDriftTransition(id({ version: "1.0.0", templates_fingerprint: "fp-a" }), id({ version: "1.0.0", templates_fingerprint: "fp-b" })),
    true,
  );
});

test("isEngineDriftTransition: repeated boundaries after a transition report no further transition (one event, not per-boundary)", () => {
  const pinned = id({ version: "1.0.0", templates_fingerprint: "fp-a" });
  const updated = id({ version: "1.0.1", templates_fingerprint: "fp-b" });

  // Boundary 1: engine changed since pinning.
  let lastObserved = pinned;
  assert.equal(isEngineDriftTransition(lastObserved, updated), true);
  lastObserved = updated; // orchestrator updates last-observed after emitting the event

  // Boundaries 2 and 3: engine unchanged since the transition — no new event.
  assert.equal(isEngineDriftTransition(lastObserved, updated), false);
  assert.equal(isEngineDriftTransition(lastObserved, updated), false);
});
