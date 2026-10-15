import { describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  applyPermissionUpdate,
  applyRuleEdits,
  permissionUpdateToSettingsPatch,
  type RuleEdit,
} from '../permissions/ruleUpdates'
import { ruleEditSchema } from '../permissions/ruleUpdateSchema'

type PermCtx = WorkingState['permissionRules']

function ctx(over: Partial<PermCtx> = {}): PermCtx {
  return {
    mode: 'default',
    extraWorkspaceRoots: new Map(),
    allowRuleBook: {},
    denyRuleBook: {},
    askRuleBook: {},
    ruleLists: { allow: [], deny: [], ask: [] },
    ...over,
  } as PermCtx
}

describe('applyPermissionUpdate — runtime context transform', () => {
  it('addRules appends to the right behavior list, deduped, and never mutates', () => {
    const before = ctx({ ruleLists: { allow: ['Read'], deny: [], ask: [] } })
    const after = applyPermissionUpdate(before, {
      type: 'addRules',
      behavior: 'allow',
      rules: ['Read', 'Bash(npm:*)'], // 'Read' is a dup
      destination: 'session',
    })
    expect(after.ruleLists?.allow).toEqual(['Read', 'Bash(npm:*)'])
    // purity: original untouched
    expect(before.ruleLists?.allow).toEqual(['Read'])
  })

  it('addRules deny / ask target their own lists', () => {
    const a = applyPermissionUpdate(ctx(), {
      type: 'addRules',
      behavior: 'deny',
      rules: ['Bash(rm:*)'],
      destination: 'projectSettings',
    })
    expect(a.ruleLists).toEqual({ allow: [], deny: ['Bash(rm:*)'], ask: [] })
    const b = applyPermissionUpdate(a, {
      type: 'addRules',
      behavior: 'ask',
      rules: ['Bash(git push:*)'],
      destination: 'projectSettings',
    })
    expect(b.ruleLists).toEqual({
      allow: [],
      deny: ['Bash(rm:*)'],
      ask: ['Bash(git push:*)'],
    })
  })

  it('replaceRules overwrites the behavior list (deduped)', () => {
    const before = ctx({ ruleLists: { allow: ['A', 'B'], deny: [], ask: [] } })
    const after = applyPermissionUpdate(before, {
      type: 'replaceRules',
      behavior: 'allow',
      rules: ['C', 'C', 'D'],
      destination: 'userSettings',
    })
    expect(after.ruleLists?.allow).toEqual(['C', 'D'])
  })

  it('removeRules drops the named rules only', () => {
    const before = ctx({ ruleLists: { allow: ['A', 'B', 'C'], deny: [], ask: [] } })
    const after = applyPermissionUpdate(before, {
      type: 'removeRules',
      behavior: 'allow',
      rules: ['B'],
      destination: 'localSettings',
    })
    expect(after.ruleLists?.allow).toEqual(['A', 'C'])
  })

  it('setMode swaps the mode', () => {
    expect(applyPermissionUpdate(ctx(), { type: 'setMode', mode: 'plan' }).mode).toBe('plan')
  })

  it('addDirectories / removeDirectories edit the working-dir map (deduped)', () => {
    const added = applyPermissionUpdate(ctx(), {
      type: 'addDirectories',
      directories: ['/a', '/b', '/a'],
      destination: 'projectSettings',
    })
    expect([...(added.extraWorkspaceRoots?.keys() ?? [])]).toEqual(['/a', '/b'])
    const removed = applyPermissionUpdate(added, {
      type: 'removeDirectories',
      directories: ['/a'],
      destination: 'projectSettings',
    })
    expect([...(removed.extraWorkspaceRoots?.keys() ?? [])]).toEqual(['/b'])
  })

  it('applyRuleEdits folds a sequence left-to-right', () => {
    const updates: RuleEdit[] = [
      { type: 'addRules', behavior: 'allow', rules: ['A'], destination: 'session' },
      { type: 'addRules', behavior: 'deny', rules: ['X'], destination: 'session' },
      { type: 'setMode', mode: 'acceptEdits' },
    ]
    const out = applyRuleEdits(ctx(), updates)
    expect(out.ruleLists).toEqual({ allow: ['A'], deny: ['X'], ask: [] })
    expect(out.mode).toBe('acceptEdits')
  })
})

describe('permissionUpdateToSettingsPatch — persistence mapping', () => {
  it('addRules allow merges into permissions.allow, deduped', () => {
    expect(
      permissionUpdateToSettingsPatch(
        { allow: ['Read'] },
        { type: 'addRules', behavior: 'allow', rules: ['Read', 'Bash'], destination: 'localSettings' },
      ),
    ).toEqual({ allow: ['Read', 'Bash'] })
  })

  it('removeRules deny filters permissions.deny', () => {
    expect(
      permissionUpdateToSettingsPatch(
        { deny: ['Bash(rm:*)', 'Bash(curl:*)'] },
        { type: 'removeRules', behavior: 'deny', rules: ['Bash(rm:*)'], destination: 'userSettings' },
      ),
    ).toEqual({ deny: ['Bash(curl:*)'] })
  })

  it('setMode writes permissions.defaultMode', () => {
    expect(
      permissionUpdateToSettingsPatch({}, { type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }),
    ).toEqual({ defaultMode: 'acceptEdits' })
  })

  it('directories map to permissions.additionalDirectories', () => {
    expect(
      permissionUpdateToSettingsPatch(
        { additionalDirectories: ['/a'] },
        { type: 'addDirectories', directories: ['/b'], destination: 'projectSettings' },
      ),
    ).toEqual({ additionalDirectories: ['/a', '/b'] })
  })

  it('runtime-only destinations (session / cliArg) are NOT persisted → null', () => {
    expect(
      permissionUpdateToSettingsPatch(undefined, {
        type: 'addRules',
        behavior: 'allow',
        rules: ['Read'],
        destination: 'session',
      }),
    ).toBeNull()
    expect(
      permissionUpdateToSettingsPatch(undefined, {
        type: 'setMode',
        mode: 'plan',
        destination: 'session',
      }),
    ).toBeNull()
  })
})

describe('ruleEditSchema — zod validation', () => {
  it('validates addRules update', () => {
    const result = ruleEditSchema.safeParse({
      type: 'addRules',
      rules: ['Bash(npm:*)', 'Read'],
      behavior: 'allow',
      destination: 'userSettings',
    })
    expect(result.success).toBe(true)
  })

  it('validates setMode update', () => {
    const result = ruleEditSchema.safeParse({
      type: 'setMode',
      mode: 'plan',
      destination: 'projectSettings',
    })
    expect(result.success).toBe(true)
  })

  it('validates setMode without destination', () => {
    const result = ruleEditSchema.safeParse({
      type: 'setMode',
      mode: 'default',
    })
    expect(result.success).toBe(true)
  })

  it('validates addDirectories update', () => {
    const result = ruleEditSchema.safeParse({
      type: 'addDirectories',
      directories: ['/home/user/project'],
      destination: 'localSettings',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid behavior', () => {
    const result = ruleEditSchema.safeParse({
      type: 'addRules',
      rules: ['Read'],
      behavior: 'invalid',
      destination: 'userSettings',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid destination', () => {
    const result = ruleEditSchema.safeParse({
      type: 'addRules',
      rules: ['Read'],
      behavior: 'allow',
      destination: 'invalidDest',
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing rules array', () => {
    const result = ruleEditSchema.safeParse({
      type: 'addRules',
      behavior: 'allow',
      destination: 'userSettings',
    })
    expect(result.success).toBe(false)
  })
})
