/**
 * Class sets for controls the conversation shows only on hover. On a screen
 * that cannot hover (`(hover: none)`: touch) they are always shown instead;
 * a hover-capable screen keeps its hover reveal unchanged (F-24).
 */

/** Shown and tappable without hover. */
export const SHOWN_WITHOUT_HOVER =
  "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100";

/** An overlay drawn below its row on hover takes its own line instead. */
export const IN_FLOW_WITHOUT_HOVER = "[@media(hover:none)]:relative [@media(hover:none)]:top-0";

/** A hover-only helper (e.g. a hover bridge) that has no use without hover. */
export const HIDDEN_WITHOUT_HOVER = "[@media(hover:none)]:hidden";
