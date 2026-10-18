/**
 * The shared realm holder: set/get, change listeners that survive a throwing
 * peer, and the replace hook for the value a new one supersedes.
 */
import { describe, expect, it, vi } from 'vitest'
import { createRealmHolder } from '../utils/realmHolder'

describe('createRealmHolder', () => {
  it('holds a value and tells every listener, even after one throws', () => {
    const holder = createRealmHolder<{ id: number }>('test-holder')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const heard: Array<number | null> = []
    holder.onChanged(() => {
      throw new Error('boom')
    })
    const off = holder.onChanged(() => heard.push(holder.get()?.id ?? null))

    holder.set({ id: 1 })
    holder.set(null)
    off()
    holder.set({ id: 2 })

    expect(heard).toEqual([1, null])
    expect(holder.get()).toEqual({ id: 2 })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('hands a replaced value to onReplace, but not when the same value is set again', () => {
    const replaced: string[] = []
    const holder = createRealmHolder<string>('test-holder', { onReplace: previous => replaced.push(previous) })
    holder.set('a')
    holder.set('a')
    holder.set('b')
    holder.set(null)
    expect(replaced).toEqual(['a', 'b'])
  })
})
