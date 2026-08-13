// Public surface for production-outcome linkage (#576).

export * from "./schema.ts";
export * from "./store.ts";
export * from "./linkage.ts";
export * from "./adapters.ts";
export {
  OUTCOMES_HELP,
  runOutcomesCli,
  runOutcomesIngest,
  runOutcomesList,
  realOutcomesCliDeps,
  loadRunIdentityIndex,
  type OutcomesCliOpts,
  type OutcomesCliDeps,
} from "./cli.ts";
export { collectOutcomeScoreboardSection, type OutcomeScoreboardSection } from "./scoreboard-section.ts";
