import { describe, expect, it } from 'vitest'
import { TaskRegistry } from '../browser/worker/TaskRegistry'

type Finished = { type: 'fork'; taskId?: string; prompt?: string; systemPrompt?: string }

/** Equal text built at run time, so each call yields a distinct string object. */
const text = (seed: string, repeat = 2000) => [seed, 'x'.repeat(repeat)].join(':')
const sharedTextSize = (registry: TaskRegistry<{ type: string }, Finished>) =>
  (registry as unknown as { sharedText: Map<string, string> }).sharedText.size

describe('TaskRegistry shared finished-record text', () => {
  it('keeps equal prompt and system prompt text once across finished records', () => {
    const registry = new TaskRegistry<{ type: string }, Finished>()
    registry.recordFinished('a', { type: 'fork', prompt: text('review'), systemPrompt: text('system') })
    registry.recordFinished('b', { type: 'fork', prompt: text('review'), systemPrompt: text('system') })
    const a = registry.getFinished('a')!
    const b = registry.getFinished('b')!
    expect(a.prompt).toBe(b.prompt)
    expect(b.prompt).toBe(text('review'))
    expect(b.systemPrompt).toBe(text('system'))
    expect(sharedTextSize(registry)).toBe(2)
  })

  it('compacting forgets text no finished record holds', () => {
    const registry = new TaskRegistry<{ type: string }, Finished>()
    registry.recordFinished('a', { type: 'fork', prompt: text('one') })
    registry.recordFinished('b', { type: 'fork', prompt: text('two') })
    registry.deleteFinished('a')
    registry.compactSharedText()
    expect(sharedTextSize(registry)).toBe(1)
    expect(registry.getFinished('b')!.prompt).toBe(text('two'))
  })

  it('stays bounded as evicted records come and go', () => {
    const registry = new TaskRegistry<{ type: string }, Finished>()
    for (let i = 0; i < 200; i++) {
      registry.recordFinished(`t${i}`, { type: 'fork', prompt: text(`p${i}`, 10) })
      registry.evictFinishedOverCap('fork', 5)
    }
    expect(registry.finishedSize).toBe(5)
    expect(sharedTextSize(registry)).toBeLessThanOrEqual(4 * 5 + 32 + 1)
  })
})
