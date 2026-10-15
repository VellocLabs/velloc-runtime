import { describe, expect, it } from 'vitest'
import { describePluginError } from '../pluginHost/pluginModel'

describe('plugin load issue text', () => {
  it('renders each issue kind as a single readable line', () => {
    expect(describePluginError({ type: 'generic-error', source: 's', error: 'boom' })).toBe('boom')
    expect(
      describePluginError({ type: 'path-not-found', source: 's', path: '/p/skills', component: 'skills' }),
    ).toBe('Path not found: /p/skills (skills)')
    expect(
      describePluginError({ type: 'manifest-parse-error', source: 's', manifestPath: 'm', parseError: 'bad json' }),
    ).toBe('Manifest parse error: bad json')
    expect(
      describePluginError({
        type: 'manifest-validation-error',
        source: 's',
        manifestPath: 'm',
        validationErrors: ['a', 'b'],
      }),
    ).toBe('Manifest validation failed: a, b')
    expect(
      describePluginError({
        type: 'mcp-config-invalid',
        source: 's',
        plugin: 'p',
        serverName: 'db',
        validationError: 'no url',
      }),
    ).toBe('MCP server db invalid: no url')
    expect(
      describePluginError({ type: 'hook-load-failed', source: 's', plugin: 'p', hookPath: 'h', reason: 'gone' }),
    ).toBe('Hook load failed: gone')
    expect(
      describePluginError({
        type: 'component-load-failed',
        source: 's',
        plugin: 'p',
        component: 'agents',
        path: '/p/agents',
        reason: 'denied',
      }),
    ).toBe('agents load failed from /p/agents: denied')
  })

  it('names the owner of a duplicate MCP server', () => {
    const dup = (duplicateOf: string) =>
      describePluginError({
        type: 'mcp-server-suppressed-duplicate',
        source: 's',
        plugin: 'p',
        serverName: 'git',
        duplicateOf,
      })
    expect(dup('plugin:other:git')).toBe('MCP server "git" skipped — same name as server provided by plugin "other"')
    expect(dup('plugin:')).toBe('MCP server "git" skipped — same name as server provided by plugin "?"')
    expect(dup('user')).toBe('MCP server "git" skipped — same name as already-configured "user"')
  })
})
