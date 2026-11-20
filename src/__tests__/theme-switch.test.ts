/**
 * Theme switches in progress (F-25): the runtime's board of what a theme
 * switch is doing, the `theme/switch` topic that publishes it, and an
 * enable carried on by the plugin's own command.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CapabilityRegistry } from '../browser/runtimeHub/CapabilityRegistry'
import { TopicBroker } from '../browser/runtimeHub/TopicBroker'
import { registerThemeCapability } from '../browser/runtimeHub/themeCapability'
import { registerThemeSwitchTopic } from '../browser/runtimeHub/themeSwitchTopic'
import type { ConnectionInfo } from '../browser/runtimeHub/types'
import type { ThemeLookSlot } from '../mods/modThemeLooks'
import {
  THEME_SWITCH_TOPIC,
  ThemeSwitchBoard,
  enableSwitchKey,
  readThemeSwitchState,
  type ThemeSwitchState,
} from '../mods/themeSwitch'
import { BUILTIN_MARKETPLACE_KEY } from '../pluginHost/builtinMarketplace'
import { getMarketplaceManifestPath } from '../pluginHost/pluginDirs'
import { makeMemFs } from './_helpers/memFs'

afterEach(() => vi.useRealTimers())

const conn = (mode: 'observe' | 'control' | 'full' = 'full') =>
  ({ connectionId: 'c', clientId: 'c', kind: 'cli', scope: { mode, sessions: 'all' }, transport: 'message-port' }) as ConnectionInfo

describe('the theme switch board', () => {
  it('lists a switch\'s steps as they go and ends it once, settling a step still running', () => {
    const published: ThemeSwitchState[] = []
    const board = new ThemeSwitchBoard({ publish: state => published.push(state) })
    const run = board.start({ kind: 'look', plugin: 'pack', look: 'Lagoon' })
    run.record({ kind: 'turnOff', plugins: ['rival'] })
    const load = run.step({ kind: 'load', plugin: 'pack' })
    expect(board.state().switches[0]!.steps.at(-1)).toEqual({ kind: 'load', state: 'running', plugin: 'pack' })
    load.done()
    run.step({ kind: 'command', command: '/pick-look lagoon' })
    run.finish({ ok: false, reason: 'unanswered' })
    run.finish({ ok: true })
    run.record({ kind: 'turnOn', plugin: 'late' })
    expect(board.state().switches).toEqual([
      {
        id: run.id,
        subject: { kind: 'look', plugin: 'pack', look: 'Lagoon' },
        steps: [
          { kind: 'turnOff', state: 'done', plugins: ['rival'] },
          { kind: 'load', state: 'done', plugin: 'pack' },
          { kind: 'command', state: 'failed', command: '/pick-look lagoon' },
        ],
        outcome: { ok: false, reason: 'unanswered' },
      },
    ])
    // Every change was published, and what was published is a copy.
    expect(published.length).toBe(6)
    expect(published[1]!.switches[0]!.steps).toHaveLength(1)
  })

  it('a switch left open for its command is ended by it, or ends by itself when none comes', () => {
    vi.useFakeTimers()
    const board = new ThemeSwitchBoard({ publish: () => {}, joinMs: 1_000 })
    const first = board.start({ kind: 'enable', plugin: 'pack' }, enableSwitchKey('pack'))
    first.finishUnlessJoined(board.joinMs)
    const joined = board.join(enableSwitchKey('pack'))
    expect(joined?.id).toBe(first.id)
    vi.advanceTimersByTime(5_000)
    // Joined: the timer no longer ends it.
    expect(first.finished).toBe(false)
    joined!.finish({ ok: true })
    expect(board.join(enableSwitchKey('pack'))).toBeUndefined()

    const second = board.start({ kind: 'enable', plugin: 'pack' }, enableSwitchKey('pack'))
    second.finishUnlessJoined(board.joinMs)
    vi.advanceTimersByTime(1_000)
    expect(second.finished).toBe(true)
    expect(board.state().switches.at(-1)!.outcome).toEqual({ ok: true })
  })

  it('a newer switch under the same key ends the older; an ended switch leaves the list after a while', () => {
    vi.useFakeTimers()
    const board = new ThemeSwitchBoard({ publish: () => {}, keepMs: 2_000 })
    const older = board.start({ kind: 'enable', plugin: 'pack' }, enableSwitchKey('pack'))
    board.start({ kind: 'enable', plugin: 'pack' }, enableSwitchKey('pack'))
    expect(older.finished).toBe(true)
    expect(board.state().switches).toHaveLength(2)
    vi.advanceTimersByTime(2_000)
    expect(board.state().switches).toHaveLength(1)
    for (let n = 0; n < 12; n += 1) board.start({ kind: 'turnOffAll' })
    expect(board.state().switches).toHaveLength(8)
  })

  it('a reader keeps only well-formed switches and steps', () => {
    expect(readThemeSwitchState(null)).toBeNull()
    expect(readThemeSwitchState({ switches: 'x' })).toBeNull()
    expect(
      readThemeSwitchState({
        switches: [
          {
            id: 'a',
            subject: { kind: 'look', plugin: 'pack', look: 'Lagoon' },
            steps: [{ kind: 'waitTurn', state: 'done' }, { kind: 'command', state: 'running' }, { kind: 'unknown', state: 'done' }],
          },
          { id: 'b', subject: { kind: 'enable' }, steps: [] },
          { id: 'c', subject: { kind: 'turnOffAll' }, steps: [], outcome: { ok: false, reason: 'whatever' } },
          { id: 'd', subject: { kind: 'disable', plugin: 'pack' }, steps: [], outcome: { ok: false, reason: 'cancelled' } },
        ],
      }),
    ).toEqual({
      switches: [
        { id: 'a', subject: { kind: 'look', plugin: 'pack', look: 'Lagoon' }, steps: [{ kind: 'waitTurn', state: 'done' }] },
        { id: 'd', subject: { kind: 'disable', plugin: 'pack' }, steps: [], outcome: { ok: false, reason: 'cancelled' } },
      ],
    })
  })
})

describe('the theme/switch topic', () => {
  it('is an observe read: a snapshot of the board, then every change while it has a reader', async () => {
    const broker = new TopicBroker()
    const board = registerThemeSwitchTopic(broker)
    board.start({ kind: 'turnOffAll' })
    const events: ThemeSwitchState[] = []
    broker.subscribe(
      { conn: conn('observe'), send: evt => events.push((evt as unknown as { payload: ThemeSwitchState }).payload), bufferedBytes: () => 0 },
      THEME_SWITCH_TOPIC,
    )
    await expect.poll(() => events.length).toBe(1)
    expect(events[0]!.switches.map(each => each.subject)).toEqual([{ kind: 'turnOffAll' }])
    board.start({ kind: 'disable', plugin: 'pack' })
    await expect.poll(() => events.length).toBe(2)
    expect(events[1]!.switches).toHaveLength(2)
  })
})

describe('an enable carried on by the plugin\'s own command', () => {
  const HOME = '/home/enable'
  const MP = BUILTIN_MARKETPLACE_KEY

  async function rig(options: { busy?: boolean } = {}) {
    const fs = makeMemFs()
    await fs.writeFile(
      getMarketplaceManifestPath({ homeDir: HOME }, MP),
      JSON.stringify({
        name: MP,
        plugins: [
          {
            name: 'pack',
            source: { source: 'github', repo: 'someone/pack', sha: 'a'.repeat(40) },
            theme: {
              onEnable: { command: 'pick-look', args: 'lagoon' },
              looks: [{ id: 'lagoon', preview: 'previews/one.svg', use: { command: 'pick-look', args: 'lagoon' } }],
            },
          },
        ],
      }),
    )
    const slot: ThemeLookSlot = {
      commandOwner: name => (name === 'pick-look' ? { plugin: 'pack', provenance: `pack@${MP}` } : undefined),
      commandRun: async () => ({ settled: true, unanswered: false, result: {} }),
    }
    const board = new ThemeSwitchBoard({ publish: () => {}, joinMs: 60_000 })
    let turnEnds: (() => void) | undefined
    const registry = new CapabilityRegistry()
    registerThemeCapability(registry, {
      fs: () => fs,
      resolveHome: async () => HOME,
      channel: () => 'stable',
      slotOf: () => slot,
      switches: board,
      whenIdle: async (_sessionId, _signal, onWaiting) => {
        if (!options.busy) return
        onWaiting?.()
        await new Promise<void>(resolve => (turnEnds = resolve))
      },
    })
    const onEnable = () =>
      registry
        .resolve('theme', 'onEnable')!
        .handle(
          { id: '1', route: { cap: 'theme', act: 'onEnable' }, payload: { sessionId: 's1', plugin: 'pack' }, conn: conn() } as never,
          {} as never,
        )
    return { board, onEnable, endTurn: () => turnEnds?.() }
  }

  it('joins the switch the enable started: its steps follow the plugin turning on', async () => {
    const { board, onEnable } = await rig()
    const enable = board.start({ kind: 'enable', plugin: 'pack' }, enableSwitchKey('pack'))
    enable.record({ kind: 'turnOn', plugin: 'pack' })
    enable.finishUnlessJoined(board.joinMs)
    expect(await onEnable()).toEqual({ ok: true, via: 'command' })
    expect(board.state().switches).toEqual([
      {
        id: enable.id,
        subject: { kind: 'enable', plugin: 'pack' },
        steps: [
          { kind: 'turnOn', state: 'done', plugin: 'pack' },
          { kind: 'load', state: 'done', plugin: 'pack' },
          { kind: 'command', state: 'done', command: '/pick-look lagoon' },
        ],
        outcome: { ok: true },
      },
    ])
  })

  it('during a turn it waits for the turn to end before the command runs, and says so', async () => {
    const { board, onEnable, endTurn } = await rig({ busy: true })
    const answer = onEnable()
    await vi.waitFor(() =>
      expect(board.state().switches[0]).toMatchObject({
        subject: { kind: 'enable', plugin: 'pack' },
        steps: [{ kind: 'waitTurn', state: 'running' }],
      }),
    )
    endTurn()
    expect(await answer).toEqual({ ok: true, via: 'command' })
    expect(board.state().switches[0]!.steps.map(step => [step.kind, step.state])).toEqual([
      ['waitTurn', 'done'],
      ['load', 'done'],
      ['command', 'done'],
    ])
  })
})
