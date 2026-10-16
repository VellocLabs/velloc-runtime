import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every callback `AssistantUiThread` hands `<InteractiveAssistantUiThread>` that can start a turn or mutate state
 * must be gated on `readOnly`; parsed from the source, so a new ungated callback fails here.
 */

const SRC = join(__dirname, '..')
const THREAD = readFileSync(
  join(SRC, 'browser', 'webview', 'AssistantUiThread.tsx'),
  'utf8',
)

/** The JSX props block passed to <InteractiveAssistantUiThread … />. */
function interactivePropsBlock(): string {
  const start = THREAD.indexOf('<InteractiveAssistantUiThread')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = THREAD.indexOf('/>', start)
  expect(end).toBeGreaterThan(start)
  return THREAD.slice(start, end)
}

/**
 * Every prop handed to <InteractiveAssistantUiThread> whose NAME reads as a
 * mutating callback (starts a turn or writes state: `on*`, `submit*`,
 * `continue*`, `interrupt`, `set*`, `resolve*`, `clear*`, `load*`) must either
 * be gated behind `readOnly` or explicitly exempted below. Enumerating the JSX
 * rather than a hand-written list is the point: a NEW callback added without
 * the guard is absent from EXEMPT and fails here.
 */
const EXEMPT: ReadonlySet<string> = new Set([
  // Read-only by nature (loaders / navigators / openers) — they never start a
  // turn and are safe on a dead session.
  'loadToolCallDetail',
  'loadTurnDiffDetail',
  'loadProviderMissingPrompt',
  'onOpenBackgroundTasks',
  'onOpenBackgroundTasksList',
  'onOpenFileInPanel',
  'onOpenDiffInPanel',
  'onOpenSkillInPanel',
  'onSwitchThread',
  'onDeleteThread',
  'onRenameThread',
  'onNewThread',
  'openSettings',
  'onOpenPluginSettings',
  'onAdoptDefaultSelection',
  'onSelectProjectFolder',
  'onOpenProjectFolder',
  'onRevealProjectFolder',
  'onPendingQuestionsChange',
  // Which docked mod pane card is open: this page's view state, not a write.
  'onModDockFrontChange',
  // Closing the session cards' popover: this page's view state, not a write.
  'onSessionCardsPopoverClose',
])

/** Prop names the JSX passes that LOOK mutating (turn-starting / state-writing). */
function mutatingShapedProps(block: string): string[] {
  const names = new Set<string>()
  for (const m of block.matchAll(/(\w+)=\{/g)) {
    const name = m[1]!
    if (
      /^(on|submit|continue|set|resolve|clear|load)[A-Z]/.test(name) ||
      name === 'interrupt'
    ) {
      names.add(name)
    }
  }
  return [...names]
}

describe('AssistantUiThread read-only gating (shutdown tab)', () => {
  it('gates or exempts every mutating-shaped prop — including ones added later', () => {
    const block = interactivePropsBlock()
    for (const cb of mutatingShapedProps(block)) {
      if (EXEMPT.has(cb)) continue
      // Either `cb={readOnly ? undefined : cb}` or the shared disabled no-op
      // `cb={readOnly ? readOnlyNoop : cb}` — both are gated.
      const gated =
        new RegExp(`${cb}=\\{readOnly\\s\\?\\sundefined\\s:`).test(block) ||
        new RegExp(`${cb}=\\{readOnly\\s\\?\\sreadOnlyNoop\\s:`).test(block)
      expect(
        gated,
        `${cb} looks mutating and is neither readOnly-gated nor in EXEMPT`,
      ).toBe(true)
    }
  })

  it('EXEMPT contains no prop that is actually gated (no drift both ways)', () => {
    const block = interactivePropsBlock()
    for (const name of EXEMPT) {
      // An exempted prop that someone later gated should leave EXEMPT.
      const gated = new RegExp(`${name}=\\{readOnly\\s\\?`).test(block)
      expect(
        gated,
        `${name} is gated now — remove it from EXEMPT rather than listing both`,
      ).toBe(false)
    }
  })

  it('blocks composer input via the SnapshotBlocksComposerInputProvider when readOnly', () => {
    // The composer itself must be uneditable, not just the send callbacks.
    expect(
      /readOnly\s*\|\|\s*snapshotBlocksComposerInput/.test(THREAD),
      'composer input must be blocked when readOnly',
    ).toBe(true)
  })

  it('gates the provider-error retry handler behind readOnly', () => {
    // The retry path calls submitPrompt directly, so the guard must be inside
    // the handler, not only at the props boundary.
    const handlerStart = THREAD.indexOf('const handleRetryProviderApiError')
    expect(handlerStart).toBeGreaterThanOrEqual(0)
    const handlerEnd = THREAD.indexOf('const messageActionsValue', handlerStart)
    const handler = THREAD.slice(handlerStart, handlerEnd)
    expect(handler).toContain('if (readOnly) return')
  })
})
