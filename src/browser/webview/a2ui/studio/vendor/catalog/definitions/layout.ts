import { z } from "zod/v3";
import { child, childList, def } from "./shared";

/**
 * Column, Row, Grid, Card, Tabs, Divider and Carousel come from the Gen UI 2.0
 * standard catalog (`standardUI`); these are the layouts it does not have.
 */

export const layoutDefinitions = {
  Section: def(
    "Layout",
    "Titled group with eyebrow, title, description, and children.",
    z.object({
      eyebrow: z.string().optional(),
      title: z.string(),
      description: z.string().optional(),
      children: childList(),
    }),
  ),
  StickyBar: def(
    "Layout",
    "A bar that stays in view while the page scrolls, for what must stay reachable on a long page: unsaved changes with Save and Discard, a filter row. Put it directly in the root Column or in a Tabs child, never in a Card or a Row: it stays only while its parent is on screen. A top bar goes first in that parent; a bottom bar goes last, after the content it sits below. At most one per edge.",
    z.object({
      children: childList(),
      edge: z
        .enum(["top", "bottom"])
        .describe("The edge of the page it stays at. Default: top.")
        .optional(),
    }),
  ),
  Accordion: def(
    "Layout",
    "Collapsible items (FAQs, details, per-file notes); each has a title and either text or a child id.",
    z.object({
      items: z.array(
        z.object({
          title: z.string(),
          text: z.string().optional(),
          child: child().optional(),
        }),
      ),
      multiple: z.boolean().optional(),
    }),
  ),
};
