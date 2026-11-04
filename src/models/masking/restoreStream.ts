/**
 * Contract: Inbound half of model egress masking (F-39): puts each alias in a
 * decoded response stream back to the text it stands for. Deltas are restored
 * per channel (the text, the reasoning, each tool call's argument text). A
 * channel's tail that could still grow into an alias is held back until the
 * next delta of that channel, and flushed before any event of another channel,
 * at a terminal event, and by `flush()`. Argument text is JSON, so a match is
 * put back JSON-string-escaped there. A tool call without an id gets a channel
 * of its own per `tool_call_start`. Whole strings (tool names, a tool call's
 * `input`, an error message) are restored in place. Event order is preserved.
 */
import type { DriverStreamEvent } from '../drivers/driverTypes'
import type { CompiledMasking, MaskingHit } from './maskingRules'
import { ChannelTrace, traceEntries, type ReplacementEntry } from './replacementTrace'

export type RestoreWhere = 'text' | 'reasoning' | 'tool_args' | 'tool_name' | 'error'

type Channel = { key: string; where: RestoreWhere; json: boolean; flushEvent: (text: string) => DriverStreamEvent }

export type RestoreFilter = {
  apply(events: readonly DriverStreamEvent[]): DriverStreamEvent[]
  /** Releases every held tail. */
  flush(): DriverStreamEvent[]
  /** One entry per alias put back so far, oldest first; completes the entries
   *  still waiting for text that followed. */
  entries(): ReplacementEntry[]
}

export function createRestoreFilter(masking: CompiledMasking): RestoreFilter {
  const held = new Map<string, { channel: Channel; text: string }>()
  const done: ReplacementEntry[] = []
  const traces = new Map<string, ChannelTrace>()

  const restoreWhole = (value: string, where: RestoreWhere): string => {
    const hits: MaskingHit[] = []
    const text = masking.restoreText(value, hit => hits.push(hit))
    if (hits.length > 0) traceEntries('in', where, value, text, hits, done)
    return text
  }
  const traceOf = (channel: Channel): ChannelTrace => {
    let trace = traces.get(channel.key)
    if (!trace) {
      trace = new ChannelTrace(channel.where, done)
      traces.set(channel.key, trace)
    }
    return trace
  }
  const restoreChannel = (channel: Channel, value: string, partial: boolean) => {
    const hits: MaskingHit[] = []
    const collect = (hit: MaskingHit) => hits.push(hit)
    const result = partial
      ? masking.restorePartial(value, collect, channel.json)
      : { text: masking.restoreText(value, collect, channel.json), held: '' }
    traceOf(channel).feed(value.slice(0, value.length - result.held.length), result.text, hits)
    return result
  }

  const restoreDeep = (value: unknown): unknown => {
    if (typeof value === 'string') return restoreWhole(value, 'tool_args')
    if (Array.isArray(value)) return value.map(restoreDeep)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[restoreWhole(key, 'tool_args')] = restoreDeep(item)
      }
      return out
    }
    return value
  }

  const flushExcept = (keep: string | undefined, out: DriverStreamEvent[]): void => {
    for (const [key, entry] of held) {
      if (key === keep) continue
      held.delete(key)
      if (entry.text) out.push(entry.channel.flushEvent(restoreChannel(entry.channel, entry.text, false).text))
    }
  }

  const onDelta = (channel: Channel, delta: string, out: DriverStreamEvent[]): string => {
    flushExcept(channel.key, out)
    const pending = held.get(channel.key)?.text ?? ''
    const restored = restoreChannel(channel, pending + delta, true)
    if (restored.held) held.set(channel.key, { channel, text: restored.held })
    else held.delete(channel.key)
    return restored.text
  }

  const textChannel: Channel = { key: 'text', where: 'text', json: false, flushEvent: text => ({ type: 'text_delta', text }) }
  const reasoningChannel: Channel = {
    key: 'reasoning',
    where: 'reasoning',
    json: false,
    flushEvent: text => ({ type: 'reasoning_delta', text }),
  }
  let anonymousCalls = 0
  const toolChannel = (id: string | undefined): Channel => ({
    key: id !== undefined ? `tool:id:${id}` : `tool:n:${anonymousCalls}`,
    where: 'tool_args',
    json: true,
    flushEvent: text => ({ type: 'tool_call_delta', ...(id !== undefined ? { id } : {}), argsTextDelta: text }),
  })

  return {
    apply(events) {
      if (events.length === 0) return events as DriverStreamEvent[]
      const out: DriverStreamEvent[] = []
      for (const event of events) {
        switch (event.type) {
          case 'text_delta': {
            const text = onDelta(textChannel, event.text, out)
            if (text) out.push({ ...event, text })
            break
          }
          case 'reasoning_delta': {
            const text = onDelta(reasoningChannel, event.text, out)
            if (text) out.push({ ...event, text })
            break
          }
          case 'tool_call_delta': {
            const next: DriverStreamEvent = { ...event }
            if (event.name !== undefined) next.name = restoreWhole(event.name, 'tool_name')
            if (event.argsTextDelta !== undefined) {
              const args = onDelta(toolChannel(event.id), event.argsTextDelta, out)
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
            if (event.id === undefined) anonymousCalls += 1
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
    entries() {
      for (const trace of traces.values()) trace.finish()
      return [...done].sort((a, b) => a.at - b.at)
    },
  }
}
