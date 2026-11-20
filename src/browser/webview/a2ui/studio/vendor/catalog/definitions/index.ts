import { chartDefinitions } from "./charts";
import { contentDefinitions } from "./content";
import { dataDefinitions } from "./data";
import { domainDefinitions } from "./domain";
import { feedbackDefinitions } from "./feedback";
import { inputDefinitions } from "./inputs";
import { layoutDefinitions } from "./layout";

export const definitions = {
  ...layoutDefinitions,
  ...contentDefinitions,
  ...dataDefinitions,
  ...chartDefinitions,
  ...inputDefinitions,
  ...feedbackDefinitions,
  ...domainDefinitions,
};

export type Definitions = typeof definitions;
export type ComponentName = keyof Definitions;
