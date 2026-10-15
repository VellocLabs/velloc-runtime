import { describe, expect, it } from 'vitest'
import {
  mintTaskHandle,
  kindLetterOf,
  taskKindFromId,
} from '../backgroundTasks/taskId'

describe('taskId — kind-prefixed task ids', () => {
  it('maps each kind to its 1-char prefix', () => {
    expect(kindLetterOf('local_agent')).toBe('a')
    expect(kindLetterOf('local_bash')).toBe('b')
    expect(kindLetterOf('local_fork')).toBe('f')
    expect(kindLetterOf('local_fast')).toBe('c')
    expect(kindLetterOf('local_routine')).toBe('r')
  })

  it('generates a prefix + 8 base36 chars', () => {
    for (const kind of [
      'local_agent',
      'local_bash',
      'local_fork',
      'local_fast',
      'local_routine',
    ] as const) {
      const id = mintTaskHandle(kind)
      expect(id).toHaveLength(9)
      expect(id[0]).toBe(kindLetterOf(kind))
      // Prefix encodes the kind; the rest is the case-insensitive-safe alphabet.
      expect(id.slice(1)).toMatch(/^[0-9a-z]{8}$/)
    }
  })

  it('recovers the kind from the id prefix (round-trip)', () => {
    expect(taskKindFromId(mintTaskHandle('local_agent'))).toBe('local_agent')
    expect(taskKindFromId(mintTaskHandle('local_bash'))).toBe('local_bash')
    expect(taskKindFromId(mintTaskHandle('local_fork'))).toBe('local_fork')
    expect(taskKindFromId(mintTaskHandle('local_fast'))).toBe('local_fast')
    expect(taskKindFromId(mintTaskHandle('local_routine'))).toBe('local_routine')
    expect(mintTaskHandle('local_supershell')).toMatch(/^h[0-9a-z]{8}$/)
    expect(taskKindFromId(mintTaskHandle('local_supershell'))).toBe('local_supershell')
  })

  it('returns null for an id whose prefix matches no known kind', () => {
    // `taskKindFromId` is prefix-only — meant for OUR minted ids, not native
    // ids. `subagent-…` (prefix `s`) and an unknown prefix resolve to null.
    expect(taskKindFromId('subagent-explore_ab12')).toBeNull()
    expect(taskKindFromId('x9y8z7w6')).toBeNull()
    expect(taskKindFromId('')).toBeNull()
    // NOTE the legacy shell native id `bg_…` starts with `b`, so it collides
    // with the `local_bash` prefix — a coincidence, harmless because native ids
    // are never passed here in the unified registry (documents the limitation).
    expect(taskKindFromId('bg_1234')).toBe('local_bash')
  })

  it('is collision-resistant across many mints', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 5000; i++) ids.add(mintTaskHandle('local_agent'))
    expect(ids.size).toBe(5000)
  })
})
