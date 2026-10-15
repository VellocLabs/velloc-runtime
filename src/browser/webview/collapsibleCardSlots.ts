/**
 * The `data-slot` names of the collapsible content cards, shared by `conversationScrollLock.ts` and
 * `revealThreadMessage.ts`. Not a `-trigger` suffix match: overlay and action triggers end the same way,
 * and the reveal must never click one.
 */
export const COLLAPSIBLE_CARD_TRIGGER_SLOTS = [
  'tool-fallback-trigger',
  'tool-group-trigger',
  'tool-plan-stream-trigger',
  'todo-section-trigger',
  'plan-list-item-trigger',
  'reasoning-trigger',
] as const

export type CollapsibleCardTriggerSlot =
  (typeof COLLAPSIBLE_CARD_TRIGGER_SLOTS)[number]
