/**
 * The `Agent` tool's `subagent_type: "fork"` route. A fork inherits the parent's
 * exact context, so its request prefix is byte-identical (prompt cache). Kept
 * dependency-free to avoid an import cycle.
 */

/** The reserved `subagent_type` value that triggers the fork route. */
export const FORK_ROUTE_KIND = 'fork'

/** Error returned when `subagent_type: "fork"` is requested from inside a fork
 *  child (a fork already inherits the parent's full context, so a nested fork
 *  would recurse the inheritance). */
export const FORK_NESTED_ERROR =
  'Fork is not available inside a forked sub-agent. Complete your task directly using your tools.'
