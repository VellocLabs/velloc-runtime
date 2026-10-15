import { afterEach, describe, expect, it } from 'vitest'

import { resolveBundledSkillBody } from '../skillLibrary/builtinSkillBody'
import {
  __resetBundledSkillsForTests,
  __resetFeatureRegistryForTests,
  isBundledSkillPath,
  addStockSkill,
} from '../skillLibrary/builtinSkills'
import {
  __resetInvokedSkillsStoreForTests,
  noteSkillUse,
} from '../skillLibrary/invokedSkillsStore'

// The Skills tab's worker-side body lookup for bundled skills
// (`worker.getSkillBody`): static skills answer from the registry, dynamic
// skills from the session's invoked-body snapshot (or an explicit 'dynamic'
// marker when never invoked), unknown names stay `not_found`.

afterEach(() => {
  __resetBundledSkillsForTests()
  __resetFeatureRegistryForTests()
  __resetInvokedSkillsStoreForTests()
})

describe('resolveBundledSkillBody', () => {
  it('answers a static bundled skill from the registry content', () => {
    addStockSkill({
      name: 'commit-helper',
      description: 'Commits things',
      content: '# Commit helper\n\nDo the thing with $ARGUMENTS.',
    })
    expect(resolveBundledSkillBody('commit-helper', 's1')).toEqual({
      kind: 'static',
      body: '# Commit helper\n\nDo the thing with $ARGUMENTS.',
    })
  })

  it('answers a dynamic skill with the session-scoped last-invoked body', () => {
    addStockSkill({
      name: 'debug',
      description: 'Tails logs',
      dynamicContent: async () => 'live',
    })
    noteSkillUse('s1', 'debug', 'bundled:debug', 'tail output A')
    // A later invocation replaces the body (most-recent wins in the store).
    noteSkillUse('s1', 'debug', 'bundled:debug', 'tail output B')
    const result = resolveBundledSkillBody('debug', 's1')
    expect(result.kind).toBe('invoked')
    if (result.kind === 'invoked') {
      expect(result.body).toBe('tail output B')
      expect(typeof result.invokedAt).toBe('number')
    }
  })

  it('does NOT leak another session\'s invoked body (dynamic → notice)', () => {
    addStockSkill({
      name: 'debug',
      description: 'Tails logs',
      dynamicContent: async () => 'live',
    })
    noteSkillUse('other-session', 'debug', 'bundled:debug', 'their logs')
    expect(resolveBundledSkillBody('debug', 's1')).toEqual({ kind: 'dynamic' })
  })

  it('ignores a subagent-scoped invocation (main-session view only)', () => {
    addStockSkill({
      name: 'debug',
      description: 'Tails logs',
      dynamicContent: async () => 'live',
    })
    noteSkillUse('s1', 'debug', 'bundled:debug', 'fork body', 'agent-1')
    expect(resolveBundledSkillBody('debug', 's1')).toEqual({ kind: 'dynamic' })
  })

  it('reports a never-invoked dynamic skill as dynamic, not an error', () => {
    addStockSkill({
      name: 'debug',
      description: 'Tails logs',
      dynamicContent: async () => 'live',
    })
    expect(resolveBundledSkillBody('debug', 's1')).toEqual({ kind: 'dynamic' })
  })

  it('reports an unknown name as not_found (incl. non-bundled skills)', () => {
    expect(resolveBundledSkillBody('user-skill', 's1')).toEqual({
      kind: 'not_found',
    })
  })

  it('an empty sessionId cannot match any invoked entry (init-failed path)', () => {
    addStockSkill({
      name: 'debug',
      description: 'Tails logs',
      dynamicContent: async () => 'live',
    })
    noteSkillUse('s1', 'debug', 'bundled:debug', 'body')
    expect(resolveBundledSkillBody('debug', '')).toEqual({ kind: 'dynamic' })
  })
})

describe('isBundledSkillPath', () => {
  it('matches only the synthetic bundled prefix', () => {
    expect(isBundledSkillPath('bundled:debug')).toBe(true)
    expect(isBundledSkillPath('/home/u/.velloc/skills/x/SKILL.md')).toBe(false)
    expect(isBundledSkillPath('C:\\skills\\bundled\\SKILL.md')).toBe(false)
  })
})
