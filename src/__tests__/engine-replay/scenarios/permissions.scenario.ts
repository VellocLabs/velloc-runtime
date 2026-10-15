/**
 * Permission waits and gates: an ask without a confirmation dialog halts the
 * turn on a pending entry; with the dialog it waits and resumes on the
 * answer; a headless session never asks. Plan mode refuses a mutating tool
 * and the plan exit hands the turn to the person. A path-safety ask is not
 * lifted by an extension's allow.
 */
import { expect } from 'vitest'
import { ExitPlanModeTool } from '../../../toolkit/builtin/planExit'
import type { Scenario } from '../harness/scenario'
import type { Trace } from '../harness/trace'
import { engineWorld } from '../harness/world'
import { endsWith } from './terminals.scenario'

const title = { label: 'title', querySource: 'rename_generate_name', text: 'A title' }
const asks = { name: 'Guarded', selfVerdict: { behavior: 'ask' as const, message: 'May I?' } }
const callGuarded = { label: 'calls', calls: [{ id: 'guarded-1', name: 'Guarded' }] }
const ran = (t: Trace, id: string) =>
  (t.toolCalls as Array<{ event: string; id?: string }>).some(e => e.event === 'start' && e.id === id)

export const scenarios: Scenario[] = [
  {
    name: 'ask-without-dialog-halts-on-pending-entry',
    async run() {
      const w = engineWorld({ tools: [asks], replies: [callGuarded, title] })
      await w.submit('go')
      const trace = await w.finish()
      trace.notes.push({ pendingPermissions: Object.keys((w.appState.get() as { pendingPermissions?: object }).pendingPermissions ?? {}) })
      return trace
    },
    check: t => {
      endsWith('awaiting_user_interaction')(t)
      expect(ran(t, 'guarded-1')).toBe(false)
    },
  },
  {
    name: 'queued-confirm-allow-runs-the-call',
    async run() {
      const w = engineWorld({ tools: [asks], confirm: () => 'allow', replies: [callGuarded, { label: 'done', text: 'Done.' }, title] })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      endsWith('completed')(t)
      expect(ran(t, 'guarded-1')).toBe(true)
    },
  },
  {
    name: 'queued-confirm-reject-answers-the-model',
    async run() {
      const w = engineWorld({ tools: [asks], confirm: () => 'reject', replies: [callGuarded, { label: 'done', text: 'Understood.' }, title] })
      await w.submit('go')
      return w.finish()
    },
    check: t => expect(ran(t, 'guarded-1')).toBe(false),
  },
  {
    name: 'queued-confirm-abort-stops-the-turn',
    async run() {
      const w = engineWorld({ tools: [asks], confirm: () => 'abort', replies: [callGuarded, { label: 'after', text: 'Stopped.' }, title] })
      await w.submit('go')
      return w.finish()
    },
    check: t => expect(ran(t, 'guarded-1')).toBe(false),
  },
  {
    name: 'headless-ask-is-refused-without-prompt',
    async run() {
      const w = engineWorld({
        tools: [asks],
        headless: true,
        confirm: () => 'allow',
        replies: [callGuarded, { label: 'done', text: 'Could not.' }, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      expect(ran(t, 'guarded-1')).toBe(false)
      expect((t.permissions as Array<{ step: string }>).some(p => p.step === 'confirm')).toBe(false)
    },
  },
  {
    name: 'ask-rule-routes-through-dialog',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        ruleLists: { allow: [], deny: [], ask: ['Act'] },
        confirm: () => 'allow',
        replies: [{ label: 'calls', calls: [{ id: 'act-1', name: 'Act' }] }, { label: 'done', text: 'Done.' }, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => expect((t.permissions as Array<{ step: string }>).map(p => p.step)).toContain('confirm'),
  },
  {
    name: 'deny-rule-refuses-without-asking',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Act' }],
        ruleLists: { allow: [], deny: ['Act'], ask: [] },
        confirm: () => 'allow',
        replies: [{ label: 'calls', calls: [{ id: 'act-1', name: 'Act' }] }, { label: 'done', text: 'Refused.' }, title],
      })
      await w.submit('go')
      return w.finish()
    },
    check: t => {
      expect(ran(t, 'act-1')).toBe(false)
      expect(t.permissions).toEqual([])
    },
  },
  {
    name: 'plan-mode-refuses-a-mutating-tool',
    async run() {
      const w = engineWorld({
        permissionMode: 'plan',
        tools: [{ name: 'Look', readOnly: true }, { name: 'Change' }],
        extraTools: [ExitPlanModeTool],
        replies: [
          { label: 'calls', calls: [{ id: 'look-1', name: 'Look' }, { id: 'change-1', name: 'Change' }] },
          { label: 'done', text: 'Planning only.' },
          title,
        ],
      })
      await w.submit('fix it')
      return w.finish()
    },
    check: t => {
      expect(ran(t, 'look-1')).toBe(true)
      expect(ran(t, 'change-1')).toBe(false)
    },
  },
  {
    name: 'plan-exit-hands-the-turn-to-the-person',
    async run() {
      const w = engineWorld({
        permissionMode: 'plan',
        memoryFs: true,
        extraTools: [ExitPlanModeTool],
        replies: [{ label: 'exit', calls: [{ id: 'exit-1', name: 'ExitPlanMode', args: { plan: '1. Do it.' } }] }, title],
      })
      await w.submit('plan it')
      const trace = await w.finish()
      trace.notes.push({ modeAfter: w.appState.get().permissionRules.mode })
      return trace
    },
    check: endsWith('awaiting_user_interaction'),
  },
  {
    name: 'plan-exit-approved-through-dialog-leaves-plan-mode',
    async run() {
      const w = engineWorld({
        permissionMode: 'plan',
        memoryFs: true,
        confirm: () => 'allow',
        tools: [{ name: 'Change' }],
        extraTools: [ExitPlanModeTool],
        replies: [
          { label: 'exit', calls: [{ id: 'exit-1', name: 'ExitPlanMode', args: { plan: '1. Do it.' } }] },
          { label: 'implement', calls: [{ id: 'change-1', name: 'Change' }] },
          { label: 'done', text: 'Done.' },
          title,
        ],
      })
      await w.submit('plan it')
      const trace = await w.finish()
      trace.notes.push({ modeAfter: w.appState.get().permissionRules.mode })
      return trace
    },
    check: t => expect(ran(t, 'change-1')).toBe(true),
  },
  {
    name: 'plan-exit-kept-planning-through-dialog',
    async run() {
      const w = engineWorld({
        permissionMode: 'plan',
        memoryFs: true,
        confirm: () => 'reject',
        extraTools: [ExitPlanModeTool],
        replies: [
          { label: 'exit', calls: [{ id: 'exit-1', name: 'ExitPlanMode', args: { plan: '1. Do it.' } }] },
          { label: 'more', text: 'I will keep planning.' },
          title,
        ],
      })
      await w.submit('plan it')
      const trace = await w.finish()
      trace.notes.push({ modeAfter: w.appState.get().permissionRules.mode })
      return trace
    },
    check: t => expect(t.notes.at(-1)).toEqual({ modeAfter: 'plan' }),
  },
  {
    name: 'plan-exit-outside-plan-mode-is-refused',
    async run() {
      const w = engineWorld({
        extraTools: [ExitPlanModeTool],
        replies: [
          { label: 'exit', calls: [{ id: 'exit-1', name: 'ExitPlanMode', args: { plan: '1. Do it.' } }] },
          { label: 'done', text: 'Not in plan mode.' },
          title,
        ],
      })
      await w.submit('go')
      return w.finish()
    },
    check: endsWith('completed'),
  },
  {
    name: 'path-safety-ask-not-lifted-by-extension-allow',
    async run() {
      const w = engineWorld({
        tools: [{ name: 'Write' }],
        mods: { toolCheck: () => ({ decision: 'allow', reason: 'extension says yes' }) },
        confirm: () => 'reject',
        replies: [
          { label: 'write', calls: [{ id: 'write-1', name: 'Write', args: { value: 'write-1', file_path: '/workspace/.git/config', content: 'x' } }] },
          { label: 'done', text: 'Left it alone.' },
          title,
        ],
      })
      await w.submit('edit the git config')
      return w.finish()
    },
    check: t => {
      expect(ran(t, 'write-1')).toBe(false)
      expect((t.permissions as Array<{ step: string }>).map(p => p.step)).toContain('confirm')
    },
  },
]
