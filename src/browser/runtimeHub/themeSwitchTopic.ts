/**
 * Theme switches in progress on the runtime protocol (F-25); shapes in
 * `mods/themeSwitch.ts`. A topic only (`observe`): the board is written by
 * the runtime's own theme actions and plugin switches.
 */
import type { TopicId } from '../runtimeProtocol'
import { THEME_SWITCH_EVENT, THEME_SWITCH_TOPIC, ThemeSwitchBoard } from '../../mods/themeSwitch'
import { scopeAllows } from './CapabilityRegistry'
import type { TopicBroker } from './TopicBroker'
import type { SnapshotPage, TopicProvider } from './types'

/** A board that publishes every change on `theme/switch`, and the topic's provider. */
export function registerThemeSwitchTopic(broker: TopicBroker): ThemeSwitchBoard {
  const topic = THEME_SWITCH_TOPIC as TopicId
  const board = new ThemeSwitchBoard({
    publish: state => {
      // Nobody is reading: a later subscriber's snapshot reads afresh.
      if (broker.subscribersOf(topic).length === 0) return
      broker.publish(topic, state, { type: THEME_SWITCH_EVENT })
    },
  })
  const provider: TopicProvider = {
    matches: (id: TopicId) => id === topic,
    authorize: (_id, conn) => scopeAllows(conn.scope.mode, 'observe'),
    async *snapshot(): AsyncIterable<SnapshotPage> {
      yield { type: THEME_SWITCH_EVENT, payload: board.state() }
    },
  }
  broker.registerProvider(provider)
  return board
}
