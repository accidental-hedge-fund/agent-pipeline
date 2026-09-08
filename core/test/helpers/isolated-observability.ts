/** Unit-test boundary for every ambient observability write (inbox AND context).
 * Loaded by npm test before test modules; direct-run filesystem fixtures import
 * it too. Production defaults are untouched outside this test process. Keep
 * export enabled so tests exercise accounting instead of silently dropping it.
 */
import { defaultObservabilityDeps } from "../../scripts/observability.ts";

export const observationFiles = new Map<string, string>();
export const observationWarnings: string[] = [];
export const observationHome = "/__agent_pipeline_unit_test_only__";

Object.assign(defaultObservabilityDeps, {
  home: observationHome,
  // Do not inherit an installed config, inbox override, or provider environment.
  env: { AGENT_OBSERVABILITY_ENABLED: "1" },
  read: async (file: string) => {
    const value = observationFiles.get(file);
    if (value === undefined) throw Object.assign(new Error("missing test file"), { code: "ENOENT" });
    return value;
  },
  list: async (dir: string) => [...observationFiles.keys()].filter((file) => file.startsWith(`${dir}/`)),
  write: async (file: string, data: object) => { observationFiles.set(file, JSON.stringify(data)); },
  remove: async (file: string) => { observationFiles.delete(file); },
  warn: (message: string) => { observationWarnings.push(message); },
});
