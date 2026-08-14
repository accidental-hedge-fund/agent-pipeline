// Public surface for intent-lineage evidence graph (#599).

export * from "./schema.ts";
export * from "./identity.ts";
export * from "./graph.ts";
export * from "./store.ts";
export * from "./ingest.ts";
export * from "./impact.ts";
export * from "./export.ts";
export {
  LINEAGE_HELP,
  runLineageCli,
  runLineageExport,
  runLineageImpact,
  runLineagePropose,
  runLineageIngest,
  realLineageCliDeps,
  type LineageCliOpts,
  type LineageCliDeps,
  type LineageVerb,
} from "./cli.ts";
