import { describe, expect, it } from 'vitest'
import { isValidPattern, matches, selectsEvent } from '../mods/eventPattern'

describe('selectsEvent', () => {
  it('a name selects exactly that event', () => {
    expect(selectsEvent('tool.call', 'tool.call')).toBe(true)
    expect(selectsEvent('tool.call', 'tool.check')).toBe(false)
    expect(selectsEvent('tool.call', 'tool.call.extra')).toBe(false)
  })

  it('`*` selects every event; `ns.*` every event under the namespace', () => {
    expect(selectsEvent('*', 'tool.call')).toBe(true)
    expect(selectsEvent('*', 'classic.Stop')).toBe(true)
    expect(selectsEvent('classic.*', 'classic.Stop')).toBe(true)
    expect(selectsEvent('classic.*', 'classic.SessionEnd')).toBe(true)
    expect(selectsEvent('classic.*', 'tool.call')).toBe(false)
    // The dot is part of the namespace: `tool.*` is not a prefix match on "tool".
    expect(selectsEvent('tool.*', 'toolbox.open')).toBe(false)
  })

  it('a negation selects every event except the ones it names', () => {
    expect(selectsEvent('!tool.describe', 'tool.call')).toBe(true)
    expect(selectsEvent('!tool.describe', 'tool.describe')).toBe(false)
    expect(selectsEvent('!classic.*', 'tool.call')).toBe(true)
    expect(selectsEvent('!classic.*', 'classic.Stop')).toBe(false)
  })

  it('`!*` would select none, so it is no pattern', () => {
    expect(selectsEvent('!*', 'tool.call')).toBe(false)
    expect(isValidPattern('!*')).toBe(false)
  })

  it('a telemetry event is hooked by name: `*` and a negation do not select one', () => {
    expect(selectsEvent('*', 'telemetry.log')).toBe(false)
    expect(selectsEvent('!tool.call', 'telemetry.log')).toBe(false)
    expect(selectsEvent('telemetry.log', 'telemetry.log')).toBe(true)
    expect(selectsEvent('telemetry.*', 'telemetry.mark')).toBe(true)
  })
})

describe('isValidPattern', () => {
  it('takes names, globs and negations of either', () => {
    for (const ok of ['tool.call', 'classic.PreToolUse', '*', 'ui.*', '!tool.describe', '!classic.*']) {
      expect(isValidPattern(ok), ok).toBe(true)
    }
  })

  it('refuses anything else', () => {
    for (const bad of ['', 'tool', '.call', 'tool.', '!!tool.call', 'tool call', 42, null, undefined, {}]) {
      expect(isValidPattern(bad), String(bad)).toBe(false)
    }
  })
})

describe('matches', () => {
  it('a scalar is ===', () => {
    expect(matches('Bash', 'Bash')).toBe(true)
    expect(matches('Bash', 'bash')).toBe(false)
    expect(matches(1, 1)).toBe(true)
    expect(matches(1, '1')).toBe(false)
    expect(matches(true, true)).toBe(true)
    expect(matches(null, null)).toBe(true)
    expect(matches(null, undefined)).toBe(false)
  })

  it('a RegExp tests the value as a string', () => {
    expect(matches(/^p4 /, 'p4 sync')).toBe(true)
    expect(matches(/^p4 /, 'git p4 sync')).toBe(false)
    expect(matches(/^4/, 42)).toBe(true)
    // Not a string, a number or a boolean: never.
    expect(matches(/object/, {})).toBe(false)
    expect(matches(/null/, null)).toBe(false)
  })

  it('a global RegExp does not alternate between hit and miss', () => {
    const matcher = /p4/g
    expect([1, 2, 3, 4].map(() => matches(matcher, 'p4 sync'))).toEqual([true, true, true, true])
  })

  it('an array is any-of', () => {
    expect(matches(['Edit', 'Write'], 'Write')).toBe(true)
    expect(matches(['Edit', 'Write'], 'Bash')).toBe(false)
    expect(matches([/^mcp__/, 'Bash'], 'mcp__x__y')).toBe(true)
    expect(matches([], 'anything')).toBe(false)
  })

  it('an object is a partial of an object, at any depth', () => {
    const e = { tool: 'Bash', input: { command: 'p4 sync', timeout: 5 }, agentId: 'a1' }
    expect(matches({ tool: 'Bash' }, e)).toBe(true)
    expect(matches({ tool: 'Bash', input: { command: /^p4 / } }, e)).toBe(true)
    expect(matches({ tool: ['Edit', 'Bash'], input: { timeout: 5 } }, e)).toBe(true)
    expect(matches({ tool: 'Bash', input: { command: /^git / } }, e)).toBe(false)
    expect(matches({}, e)).toBe(true)
  })

  it('a key the value does not have never matches', () => {
    expect(matches({ missing: undefined }, { tool: 'Bash' })).toBe(false)
    expect(matches({ agentId: 'a1' }, { tool: 'Bash' })).toBe(false)
  })

  it('`{ startsWith }` never matches a string — an object is a partial of an OBJECT', () => {
    expect(matches({ command: { startsWith: 'p4' } }, { command: 'p4 sync' })).toBe(false)
    expect(matches({ length: 2 }, 'p4')).toBe(false)
    expect(matches({ 0: 'a' }, ['a'])).toBe(false)
  })

  it('never reads through the prototype chain', () => {
    expect(matches({ constructor: Object }, {})).toBe(false)
    expect(matches({ toString: Object.prototype.toString }, {})).toBe(false)
  })

  it('a matcher that is not data matches nothing', () => {
    expect(matches(() => true, 'x')).toBe(false)
    expect(matches(undefined, undefined)).toBe(false)
  })
})
