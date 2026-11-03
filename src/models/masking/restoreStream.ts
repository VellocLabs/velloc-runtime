/**
 * Contract: Inbound half of model egress masking (F-39): puts each alias in a
 * decoded response stream back to the text it stands for. Deltas are restored
 * per channel (the text, the reasoning, each tool call's argument text). A
 * channel's tail that could still grow into an alias is held back until the
 * next delta of that channel, and flushed before any event of another channel,
 * at a terminal event, and by `flush()`. Whole strings (tool names, a tool
 * call's `input`, an error message) are restored in place. Event order is
 * preserved.
 */
import type { DriverStreamEvent } from '../drivers/driverTypes'
import type { CompiledMasking } from './maskingRules'

export type RestoreWhere = 'text' | 'reasoning' | 'tool_args' | 'tool_name' | 'error'

type Channel = { key: string; flushEvent: (text: string) => DriverStreamEvent }

export type RestoreFilter = {
  apply(events: readonly DriverStreamEvent[]): DriverStreamEvent[]
  /** Releases every held tail. */
  flush(): DriverStreamEvent[]
}

export function createRestoreFilter(
  masking: CompiledMasking,
  onHit: (where: RestoreWhere, rule: number) => void,
): RestoreFilter {
  const held = new Map<string, { channel: Channel; text: string }>()

  const restoreWhole = (value: string, where: RestoreWhere): string =>
    masking.restoreText(value, hit => onHit(where, hit.rule))

  const restoreDeep = (value: unknown): unknown => {
    if (typeof value === 'string') return restoreWhole(value, 'tool_args')
    if (Array.isArray(value)) return value.map(restoreDeep)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = restoreDeep(item)
      return out
    }
    return value
  }

  const flushExcept = (keep: string | undefined, out: DriverStreamEvent[]): void => {
    for (const [key, entry] of held) {
      if (key === keep) continue
      held.delete(key)
      const where: RestoreWhere = key === 'text' ? 'text' : key === 'reasoning' ? 'reasoning' : 'tool_args'
      if (entry.text) out.push(entry.channel.flushEvent(restoreWhole(entry.text, where)))
    }
  }

  const onDelta = (
    channel: Channel,
    where: RestoreWhere,
    delta: string,
    out: DriverStreamEvent[],
  ): string => {
    flushExcept(channel.key, out)
    const pending = held.get(channel.key)?.text ?? ''
    const restored = masking.restorePartial(pending + delta, hit => onHit(where, hit.rule))
    if (restored.held) held.set(channel.key, { channel, text: restored.held })
    else held.delete(channel.key)
    return restored.text
  }

  const textChannel: Channel = { key: 'text', flushEvent: text => ({ type: 'text_delta', text }) }
  const reasoningChannel: Channel = { key: 'reasoning', flushEvent: text => ({ type: 'reasoning_delta', text }) }
  const toolChannel = (id: string | undefined): Channel => ({
    key: `tool:${id ?? ''}`,
    flushEvent: text => ({ type: 'tool_call_delta', ...(id !== undefined ? { id } : {}), argsTextDelta: text }),
  })

  return {
    apply(events) {
      if (events.length === 0) return events as DriverStreamEvent[]
      const out: DriverStreamEvent[] = []
      for (const event of events) {
        switch (event.type) {
          case 'text_delta': {
            const text = onDelta(textChannel, 'text', event.text, out)
            if (text) out.push({ ...event, text })
            break
          }
          case 'reasoning_delta': {
            const text = onDelta(reasoningChannel, 'reasoning', event.text, out)
            if (text) out.push({ ...event, text })
            break
          }
          case 'tool_call_delta': {
            const next: DriverStreamEvent = { ...event }
            if (event.name !== undefined) next.name = restoreWhole(event.name, 'tool_name')
            if (event.argsTextDelta !== undefined) {
              const args = onDelta(toolChannel(event.id), 'tool_args', event.argsTextDelta, out)
              if (args) next.argsTextDelta = args
              else delete next.argsTextDelta
            } else {
              flushExcept(undefined, out)
            }
            if (next.argsTextDelta !== undefined || next.name !== undefined) out.push(next)
            break
          }
          case 'tool_call_start': {
            flushExcept(undefined, out)
            out.push(event.name !== undefined ? { ...event, name: restoreWhole(event.name, 'tool_name') } : event)
            break
          }
          case 'tool_call': {
            flushExcept(undefined, out)
            const next: DriverStreamEvent = { ...event }
            if (event.name !== undefined) next.name = restoreWhole(event.name, 'tool_name')
            if (event.input !== undefined) next.input = restoreDeep(event.input)
            out.push(next)
            break
          }
          case 'error': {
            flushExcept(undefined, out)
            out.push({ ...event, message: restoreWhole(event.message, 'error') })
            break
          }
          default: {
            flushExcept(undefined, out)
            out.push(event)
          }
        }
      }
      return out
    },
    flush() {
      const out: DriverStreamEvent[] = []
      flushExcept(undefined, out)
      return out
    },
  }
}
