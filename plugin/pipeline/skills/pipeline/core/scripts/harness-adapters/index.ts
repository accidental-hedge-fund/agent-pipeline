// Adapter registry (#431 task 1.2). Single-sourced lookup table so
// `harness.ts`, `executors.ts`, and `stages/doctor.ts` never hand-roll a
// second list of adapter names.

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { grokAdapter } from "./grok.ts";
import { opencodeAdapter } from "./opencode.ts";
import { piAdapter } from "./pi.ts";
import type { HarnessAdapter } from "./types.ts";

const REGISTRY: Readonly<Record<string, HarnessAdapter>> = Object.freeze({
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
});

/** Resolve a registered adapter by name, or `null` for an unregistered name
 *  (the caller falls back to the custom reviewer-CLI path, #40). */
export function resolveAdapter(name: string): HarnessAdapter | null {
  return REGISTRY[name] ?? null;
}

/** All registered adapter names, in registration order. Used for config
 *  error messages (config.ts) and doctor's "only assigned adapters" filter. */
export function registeredAdapterNames(): string[] {
  return Object.keys(REGISTRY);
}

/** All registered adapters. Used by the runtime conformance test. */
export function allAdapters(): HarnessAdapter[] {
  return Object.values(REGISTRY);
}

export * from "./types.ts";
