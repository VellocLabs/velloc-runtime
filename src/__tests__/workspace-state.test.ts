import { describe, expect, it } from 'vitest'
import {
  EMPTY_WORKSPACE_STATE,
  normalizeProjectPath,
  sanitizeWorkspaceState,
  withProjectAdded,
  withProjectRemoved,
} from '../utils/workspaceState'

describe('workspace project identity', () => {
  it('normalizes Windows separators and drive case, preserving directory case', () => {
    expect(normalizeProjectPath(' d:/Work/repo/ ')).toBe('D:\\Work\\repo')
    expect(normalizeProjectPath('D:\\Work\\repo\\')).toBe('D:\\Work\\repo')
    expect(normalizeProjectPath('/Repo/')).not.toBe(normalizeProjectPath('/repo/'))
    expect(normalizeProjectPath('/repo\\')).toBe('/repo\\')
  })

  it('retains POSIX, drive, and UNC roots as usable paths', () => {
    expect(normalizeProjectPath('/')).toBe('/')
    expect(normalizeProjectPath('d:/')).toBe('D:\\')
    expect(normalizeProjectPath('D:\\')).toBe('D:\\')
    expect(normalizeProjectPath('//server/share/')).toBe('\\\\server\\share\\')
    expect(normalizeProjectPath('\\\\server\\share')).toBe('\\\\server\\share\\')
    expect(normalizeProjectPath('D:')).not.toBe(normalizeProjectPath('D:/'))
    expect(normalizeProjectPath('   ')).toBe('')
  })

  it('sanitizes duplicate cached Windows projects with the same identity', () => {
    const state = sanitizeWorkspaceState({ projects: [
      { path: 'D:\\project\\velloc', addedAt: 2 },
      { path: 'd:/project/velloc/', addedAt: 1 },
    ] })
    expect(state.projects).toEqual([{ path: 'D:\\project\\velloc', addedAt: 2 }])
  })

  it('refreshes and removes a project using either Windows separator spelling', () => {
    const first = withProjectAdded(EMPTY_WORKSPACE_STATE, 'D:\\project\\velloc', 1)
    const refreshed = withProjectAdded(first, 'd:/project/velloc/', 2)
    expect(refreshed.projects).toEqual([{ path: 'D:\\project\\velloc', addedAt: 2 }])
    expect(withProjectRemoved(refreshed, 'd:/project/velloc').projects).toEqual([])
  })
})
