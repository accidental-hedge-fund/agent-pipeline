// Factory macro-controller enablement (#890).
//
// Default OFF. Ordinary pipeline / single / loop / merge / release paths must
// not require factory state or route through the macro-controller when disabled.

import type { PipelineConfig } from "../types.ts";

/**
 * True only when config explicitly enables the factory macro-controller.
 * Absent / undefined / false → disabled.
 */
export function isFactoryMacroEnabled(
  cfg: Pick<PipelineConfig, "factory"> | { factory?: { macro_controller?: { enabled?: boolean } } } | null | undefined,
): boolean {
  return cfg?.factory?.macro_controller?.enabled === true;
}

/**
 * Env override for dedicated factory CLI entry (explicit enablement surface).
 * PIPELINE_FACTORY_MACRO=1 forces enabled for the factory command only —
 * ordinary commands still consult config via {@link isFactoryMacroEnabled}.
 */
export function isFactoryMacroEnabledFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const v = env.PIPELINE_FACTORY_MACRO;
  return v === "1" || v === "true" || v === "yes";
}
