import { describe, expect, it } from 'vitest'
import {
  evaluatePermissionRules,
  evaluateRuleGate,
  withoutBlockedAgents,
  permissionRuleValueMatchesTool,
  suggestAllowRule,
  findShadowedRules,
  approvalPromptText,
} from '../permissions/ruleEngine'
import { applyPermissionRulesBySource } from '../permissions/seedPermissionContext'
import {
  extractFilePath,
  pathMatchesRule,
} from '../permissions/filePathRuleMatching'
import { SPAWN_TOOL_ID } from '../toolkit/builtin/subagentLaunch'
import { DEFAULT_WORKER_AGENT } from '../agents/builtInAgents'

const readOnlyTool = (name: string) => ({ name, readsOnly: () => true })
const writeTool = (name: string) => ({ name, readsOnly: () => false })

describe('permissionRuleValueMatchesTool', () => {
  it('tool-wide rule matches any call to that tool', () => {
    expect(permissionRuleValueMatchesTool({ toolName: 'WebFetch' }, 'WebFetch', {})).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'WebFetch' }, 'Bash', {})).toBe(false)
  })
  it('Bash content rule matches the command field', () => {
    const rule = { toolName: 'Bash', ruleContent: 'git push:*' }
    expect(permissionRuleValueMatchesTool(rule, 'Bash', { command: 'git push origin' })).toBe(true)
    expect(permissionRuleValueMatchesTool(rule, 'Bash', { command: 'git pull' })).toBe(false)
  })
  it('MCP server-level rule matches all tools from the server', () => {
    expect(permissionRuleValueMatchesTool({ toolName: 'mcp__docs' }, 'mcp__docs__search', {})).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'mcp__docs__*' }, 'mcp__docs__read', {})).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'mcp__docs' }, 'mcp__other__x', {})).toBe(false)
  })
  it('file-tool content rules match the file_path arg (closes the silent no-op)', () => {
    // Previously these returned false (silently ignored) — a deny rule on a
    // path did nothing. Now they match.
    expect(permissionRuleValueMatchesTool({ toolName: 'Read', ruleContent: './src/**' }, 'Read', { file_path: './src/a.ts' })).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'Read', ruleContent: 'src/**' }, 'Read', { file_path: 'src/b/c.ts' })).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'Read', ruleContent: 'secrets' }, 'Read', { file_path: 'secrets/api_key.txt' })).toBe(true)
    expect(permissionRuleValueMatchesTool({ toolName: 'Read', ruleContent: 'src/**' }, 'Read', { file_path: 'lib/x.ts' })).toBe(false)
    // NotebookEdit uses notebook_path.
    expect(permissionRuleValueMatchesTool({ toolName: 'NotebookEdit', ruleContent: 'nb/**' }, 'NotebookEdit', { notebook_path: 'nb/x.ipynb' })).toBe(true)
  })
})

describe('evaluatePermissionRules (deny > ask > allow > passthrough)', () => {
  it('deny wins over ask and allow', () => {
    const d = evaluatePermissionRules({
      toolName: 'Bash', input: { command: 'rm -rf /' },
      ruleLists: { deny: ['Bash(rm:*)'], ask: ['Bash'], allow: ['Bash'] },
    })
    expect(d.behavior).toBe('deny')
  })
  it('ask overrides a matching allow (the whole-tool ask rule is checked before the whole-tool allow rule)', () => {
    const d = evaluatePermissionRules({
      toolName: 'Write', input: { file_path: '/p/x.ts' },
      ruleLists: { deny: [], ask: ['Write'], allow: ['Write'] },
    })
    expect(d.behavior).toBe('ask')
  })
  it('empty rule lists → passthrough', () => {
    expect(evaluatePermissionRules({ toolName: 'Bash', input: {} }).behavior).toBe('passthrough')
  })
})

describe('evaluateRuleGate (full precedence + mode)', () => {
  it('CRITICAL: empty rules + default mode → passthrough (no behavior change)', () => {
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'x' }, undefined).behavior).toBe('passthrough')
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'x' }, { mode: 'default', ruleLists: { allow: [], deny: [], ask: [] } }).behavior).toBe('passthrough')
  })
  it('deny is immune to bypass mode', () => {
    const d = evaluateRuleGate(writeTool('Bash'), { command: 'rm -rf /' }, {
      mode: 'bypassPermissions', ruleLists: { deny: ['Bash(rm:*)'], allow: [], ask: [] },
    })
    expect(d.behavior).toBe('deny')
  })
  it('bypassPermissions allows a non-denied tool', () => {
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'ls' }, { mode: 'bypassPermissions', ruleLists: { allow: [], deny: [], ask: [] } }).behavior).toBe('allow')
  })
  it('acceptEdits auto-allows edit + read-only tools, but not arbitrary Bash', () => {
    expect(evaluateRuleGate(writeTool('Write'), {}, { mode: 'acceptEdits', ruleLists: { allow: [], deny: [], ask: [] } }).behavior).toBe('allow')
    expect(evaluateRuleGate(readOnlyTool('Read'), {}, { mode: 'acceptEdits', ruleLists: { allow: [], deny: [], ask: [] } }).behavior).toBe('allow')
    // Bash isn't an edit/read-only tool → consults rules → passthrough.
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'rm x' }, { mode: 'acceptEdits', ruleLists: { allow: [], deny: [], ask: [] } }).behavior).toBe('passthrough')
  })
  it('allow rule → allow; ask rule → ask', () => {
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'npm test' }, { mode: 'default', ruleLists: { allow: ['Bash(npm:*)'], deny: [], ask: [] } }).behavior).toBe('allow')
    expect(evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, { mode: 'default', ruleLists: { allow: [], deny: [], ask: ['Bash(git push:*)'] } }).behavior).toBe('ask')
  })
  it('an ask rule OUT-RANKS a matching allow rule', () => {
    // The whole-tool ask rule is checked before the whole-tool allow rule:
    // an explicit "always ask about this tool" is a user-configured
    // safeguard that an allow rule must not silently retire. The ask prompt's
    // "Allow once"/"Always allow" still let the CURRENT call through — they
    // resolve the suspended call in place, not by re-issuing it.
    expect(
      evaluateRuleGate(writeTool('Write'), { file_path: '/p/x.ts' }, {
        mode: 'default',
        ruleLists: { allow: ['Write'], deny: [], ask: ['Write'] },
      }).behavior,
    ).toBe('ask')
    // Matches the file-tool pipeline, which already orders ask (step 2) before
    // allow (step 4) — the two engines must not disagree.
    expect(
      evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, {
        mode: 'default',
        ruleLists: { allow: ['Bash'], deny: [], ask: ['Bash(git push:*)'] },
      }).behavior,
    ).toBe('ask')
  })

  // An ask rule is evaluated BEFORE the bypass/acceptEdits
  // allows, so it SURVIVES bypass — like a deny rule, an ask rule is a safeguard
  // bypass must not skip.
  it('ask rule survives bypass + acceptEdits', () => {
    expect(
      evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, {
        mode: 'bypassPermissions',
        ruleLists: { allow: [], deny: [], ask: ['Bash(git push:*)'] },
      }).behavior,
    ).toBe('ask')
    expect(
      evaluateRuleGate(writeTool('Write'), {}, {
        mode: 'acceptEdits',
        ruleLists: { allow: [], deny: [], ask: ['Write'] },
      }).behavior,
    ).toBe('ask')
  })

  // dontAsk suppresses prompts into denials — a would-be ask
  // becomes deny; explicit allow/deny rules are unaffected.
  it('dontAsk: ask rule → deny; allow still allows; deny still denies', () => {
    expect(
      evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, {
        mode: 'dontAsk',
        ruleLists: { allow: [], deny: [], ask: ['Bash(git push:*)'] },
      }).behavior,
    ).toBe('deny')
    expect(
      evaluateRuleGate(writeTool('Bash'), { command: 'npm test' }, {
        mode: 'dontAsk',
        ruleLists: { allow: ['Bash(npm:*)'], deny: [], ask: [] },
      }).behavior,
    ).toBe('allow')
    expect(
      evaluateRuleGate(writeTool('Bash'), { command: 'rm -rf /' }, {
        mode: 'dontAsk',
        ruleLists: { allow: [], deny: ['Bash(rm:*)'], ask: [] },
      }).behavior,
    ).toBe('deny')
  })
})

describe('file-path rule matching', () => {
  it('matches exact, directory-prefix, * (single-segment), and ** (cross-segment)', () => {
    expect(pathMatchesRule('src/a.ts', 'src/a.ts')).toBe(true) // exact
    expect(pathMatchesRule('src', 'src/a/b.ts')).toBe(true) // dir prefix
    expect(pathMatchesRule('src/**', 'src/a/b.ts')).toBe(true) // ** crosses /
    expect(pathMatchesRule('*.env', '.env')).toBe(true) // * single segment
    expect(pathMatchesRule('*.env', 'config/.env')).toBe(false) // * doesn't cross /
    expect(pathMatchesRule('src/**', 'lib/x.ts')).toBe(false)
  })
  it('normalizes Windows backslashes and leading ./', () => {
    expect(pathMatchesRule('src\\**', 'src/a.ts')).toBe(true)
    expect(pathMatchesRule('./src/a.ts', 'src/a.ts')).toBe(true)
    expect(pathMatchesRule('src/a.ts', '.\\src\\a.ts')).toBe(true)
  })
  it('extractFilePath reads file_path / notebook_path / path', () => {
    expect(extractFilePath({ file_path: 'a.ts' })).toBe('a.ts')
    expect(extractFilePath({ notebook_path: 'x.ipynb' })).toBe('x.ipynb')
    expect(extractFilePath({ path: 'p' })).toBe('p')
    expect(extractFilePath({ command: 'ls' })).toBeUndefined()
  })
})

describe('evaluateRuleGate — file-path deny now denies (regression for the silent no-op)', () => {
  it('a deny:[Read(secrets/**)] rule denies a matching read instead of passing through', () => {
    const decision = evaluateRuleGate(readOnlyTool('Read'), { file_path: 'secrets/api_key.txt' }, {
      mode: 'default',
      ruleLists: { allow: [], deny: ['Read(secrets/**)'], ask: [] },
    })
    expect(decision.behavior).toBe('deny')
    // A non-matching read is unaffected (passthrough).
    expect(evaluateRuleGate(readOnlyTool('Read'), { file_path: 'src/a.ts' }, {
      mode: 'default',
      ruleLists: { allow: [], deny: ['Read(secrets/**)'], ask: [] },
    }).behavior).toBe('passthrough')
  })
})

describe('applyPermissionRulesBySource (per-source loading)', () => {
  const baseCtx = {
    mode: 'default',
    extraWorkspaceRoots: new Map(),
    allowRuleBook: {},
    denyRuleBook: {},
    askRuleBook: {},
  }

  it('populates by-source maps AND the merged flat ruleLists', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { allow: ['Bash(npm:*)'], deny: [], ask: [] } },
      { source: 'projectSettings', permissions: { allow: ['Read'], deny: ['Bash(rm:*)'], ask: [] } },
    ])
    // By-source maps preserve origin.
    expect(result.allowRuleBook).toEqual({
      userSettings: ['Bash(npm:*)'],
      projectSettings: ['Read'],
    })
    expect(result.denyRuleBook).toEqual({ projectSettings: ['Bash(rm:*)'] })
    // Merged flat lists are the union (for backwards compat / session rules).
    expect(result.ruleLists?.allow).toEqual(['Bash(npm:*)', 'Read'])
    expect(result.ruleLists?.deny).toEqual(['Bash(rm:*)'])
  })

  it('dedupes merged lists but keeps per-source entries distinct', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { allow: ['Read'], deny: [], ask: [] } },
      { source: 'projectSettings', permissions: { allow: ['Read'], deny: [], ask: [] } },
    ])
    // Both sources keep their own copy.
    expect(result.allowRuleBook?.userSettings).toEqual(['Read'])
    expect(result.allowRuleBook?.projectSettings).toEqual(['Read'])
    // Merged list dedupes.
    expect(result.ruleLists?.allow).toEqual(['Read'])
  })

  it('adopts defaultMode from the last source that sets it', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { defaultMode: 'acceptEdits' } },
      { source: 'projectSettings', permissions: { defaultMode: 'plan' } },
    ])
    expect(result.mode).toBe('plan')
  })

  it('skips sources with no permissions block', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: undefined },
      { source: 'projectSettings', permissions: { allow: ['Read'], deny: [], ask: [] } },
    ])
    expect(result.allowRuleBook).toEqual({ projectSettings: ['Read'] })
  })

  // Settings-declared working
  // directories are seeded into the context at boot. This is the read-back
  // half of the ask banner's "Allow this folder" — that button PERSISTS the
  // directory to `permissions.additionalDirectories`, so without this seeding
  // the grant evaporated on the next launch and the write re-prompted.
  it('seeds additionalWorkingDirectories from additionalDirectories', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { additionalDirectories: ['D:/shared'] } },
      { source: 'localSettings', permissions: { additionalDirectories: ['D:/other'] } },
    ])
    expect([...result.extraWorkspaceRoots!.keys()]).toEqual([
      'D:/shared',
      'D:/other',
    ])
    // Origin is recorded per directory: each grant is attributed to its source.
    expect(result.extraWorkspaceRoots!.get('D:/other')).toEqual({
      path: 'D:/other',
      source: 'localSettings',
    })
  })

  it('a runtime grant already in the map keeps its own source attribution', () => {
    const seeded = {
      ...baseCtx,
      extraWorkspaceRoots: new Map([
        ['D:/shared', { path: 'D:/shared', source: 'session' }],
      ]),
    }
    const result = applyPermissionRulesBySource(seeded, [
      { source: 'userSettings', permissions: { additionalDirectories: ['D:/shared'] } },
    ])
    expect(result.extraWorkspaceRoots!.get('D:/shared')?.source).toBe(
      'session',
    )
  })

  // The settings killswitch makes
  // bypassPermissions unenterable — including as a `defaultMode`.
  it('disableBypassPermissionsMode marks bypass disabled', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'projectSettings', permissions: { disableBypassPermissionsMode: 'disable' } },
    ])
    expect(result.bypassPermissionsModeDisabled).toBe(true)
  })

  it('a defaultMode of bypassPermissions degrades to default under the killswitch', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { defaultMode: 'bypassPermissions' } },
      { source: 'projectSettings', permissions: { disableBypassPermissionsMode: 'disable' } },
    ])
    expect(result.mode).toBe('default')
    expect(result.bypassPermissionsModeDisabled).toBe(true)
  })

  it('without the killswitch a bypass defaultMode is kept', () => {
    const result = applyPermissionRulesBySource(baseCtx, [
      { source: 'userSettings', permissions: { defaultMode: 'bypassPermissions' } },
    ])
    expect(result.mode).toBe('bypassPermissions')
    expect(result.bypassPermissionsModeDisabled).toBeUndefined()
  })
})

// `Agent(<agentType>)` scopes a rule to ONE sub-agent. Before this
// the rule parsed but matched nothing, so `deny: ["Agent(Explore)"]` was a
// silent no-op.
describe('Agent(<subagent_type>) rules', () => {
  // Pin the literals the engine hardcodes against their real definitions.
  it('uses the same tool name + default agent type as the tool layer', () => {
    expect(SPAWN_TOOL_ID).toBe('Agent')
    expect(DEFAULT_WORKER_AGENT.name).toBe('general-purpose')
  })

  const agentTool = writeTool(SPAWN_TOOL_ID)

  it('denies only the named sub-agent', () => {
    const ctx = {
      mode: 'default',
      ruleLists: { allow: [], deny: ['Agent(Explore)'], ask: [] },
    }
    expect(
      evaluateRuleGate(agentTool, { subagent_type: 'Explore' }, ctx).behavior,
    ).toBe('deny')
    expect(
      evaluateRuleGate(agentTool, { subagent_type: 'Plan' }, ctx).behavior,
    ).toBe('passthrough')
  })

  it('an omitted subagent_type is the general-purpose agent', () => {
    expect(
      evaluateRuleGate(agentTool, {}, {
        mode: 'default',
        ruleLists: { allow: [], deny: ['Agent(general-purpose)'], ask: [] },
      }).behavior,
    ).toBe('deny')
    expect(
      evaluateRuleGate(agentTool, {}, {
        mode: 'default',
        ruleLists: { allow: [], deny: ['Agent(Explore)'], ask: [] },
      }).behavior,
    ).toBe('passthrough')
  })

  it('a whole-tool Agent rule still matches every spawn', () => {
    expect(
      evaluateRuleGate(agentTool, { subagent_type: 'Explore' }, {
        mode: 'default',
        ruleLists: { allow: [], deny: ['Agent'], ask: [] },
      }).behavior,
    ).toBe('deny')
  })

  it('withoutBlockedAgents hides denied agents from the listing', () => {
    const agents = [
      { name: 'Explore' },
      { name: 'Plan' },
      { name: 'general-purpose' },
    ]
    expect(
      withoutBlockedAgents(agents, {
        ruleLists: { deny: ['Agent(Explore)'] },
      }).map(a => a.name),
    ).toEqual(['Plan', 'general-purpose'])
    // Per-source deny rules count too.
    expect(
      withoutBlockedAgents(agents, {
        denyRuleBook: { projectSettings: ['Agent(Plan)'] },
      }).map(a => a.name),
    ).toEqual(['Explore', 'general-purpose'])
    // A whole-tool deny is the gate's business, not the listing's.
    expect(
      withoutBlockedAgents(agents, { ruleLists: { deny: ['Agent'] } }).map(
        a => a.name,
      ),
    ).toEqual(['Explore', 'Plan', 'general-purpose'])
    // No rules → unchanged.
    expect(withoutBlockedAgents(agents, undefined)).toEqual(agents)
  })

  it('an ask rule on one agent prompts for it and not the others', () => {
    const ctx = {
      mode: 'default',
      ruleLists: { allow: [], deny: [], ask: ['Agent(Plan)'] },
    }
    expect(
      evaluateRuleGate(agentTool, { subagent_type: 'Plan' }, ctx).behavior,
    ).toBe('ask')
    expect(
      evaluateRuleGate(agentTool, { subagent_type: 'Explore' }, ctx).behavior,
    ).toBe('passthrough')
  })
})

describe('evaluateRuleGate — multi-source attribution', () => {
  it('attributes a matched rule to its source (highest-precedence first)', () => {
    // Precedence: userSettings → projectSettings → localSettings → …
    // userSettings is checked first, so it wins when both have the same rule.
    const decision = evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, {
      mode: 'default',
      ruleLists: { allow: [], deny: ['Bash(git push)'], ask: [] },
      denyRuleBook: {
        userSettings: ['Bash(git push)'],
        localSettings: ['Bash(git push)'],
      },
    })
    expect(decision.behavior).toBe('deny')
    expect(decision.ruleSource).toBe('userSettings')
  })

  it('allow attribution reports the source', () => {
    const decision = evaluateRuleGate(writeTool('Bash'), { command: 'npm test' }, {
      mode: 'default',
      ruleLists: { allow: ['Bash(npm:*)'], deny: [], ask: [] },
      allowRuleBook: { projectSettings: ['Bash(npm:*)'] },
    })
    expect(decision.behavior).toBe('allow')
    expect(decision.ruleSource).toBe('projectSettings')
  })

  it('falls back to merged ruleLists when by-source maps are absent', () => {
    const decision = evaluateRuleGate(writeTool('Bash'), { command: 'git push' }, {
      mode: 'default',
      ruleLists: { allow: [], deny: ['Bash(git push)'], ask: [] },
    })
    expect(decision.behavior).toBe('deny')
    expect(decision.ruleSource).toBeUndefined()
  })

  it('deny from any source wins over allow from a higher source (behavior precedence)', () => {
    // Even though allow is in a high-precedence source, a deny anywhere blocks.
    const decision = evaluateRuleGate(writeTool('Bash'), { command: 'rm -rf /' }, {
      mode: 'default',
      ruleLists: { allow: ['Bash(rm:*)'], deny: ['Bash(rm -rf:*)'], ask: [] },
      allowRuleBook: { policySettings: ['Bash(rm:*)'] },
      denyRuleBook: { session: ['Bash(rm -rf:*)'] },
    })
    expect(decision.behavior).toBe('deny')
  })
})

describe('suggestAllowRule (what the ask-modal "Allow" persists)', () => {
  it('suggests an exact-command rule for Bash/PowerShell + a command summary', () => {
    expect(suggestAllowRule('Bash', { command: 'npm install' })).toEqual({
      suggestedRule: 'Bash(npm install)',
      summary: 'npm install',
    })
    expect(suggestAllowRule('PowerShell', { command: 'Get-Date' }).suggestedRule).toBe(
      'PowerShell(Get-Date)',
    )
  })
  it('suggests a tool-wide rule for other tools', () => {
    expect(suggestAllowRule('Write', { file_path: '/p/a.txt' })).toEqual({
      suggestedRule: 'Write',
    })
  })
})

describe('boot seeder — single source', () => {
  const base = { mode: 'default' as const }
  it('leaves the context untouched when no source has a permissions block', () => {
    const out = applyPermissionRulesBySource(base, [
      { source: 'userSettings', permissions: undefined },
    ])
    expect(out.mode).toBe('default')
    expect(out.ruleLists).toBeUndefined()
  })
  it('seeds ruleLists + defaultMode', () => {
    const out = applyPermissionRulesBySource(base, [
      {
        source: 'userSettings',
        permissions: { deny: ['Bash(rm:*)'], allow: ['Read'], defaultMode: 'plan' },
      },
    ])
    expect(out.ruleLists).toEqual({ allow: ['Read'], deny: ['Bash(rm:*)'], ask: [] })
    expect(out.mode).toBe('plan')
  })
})

describe('findShadowedRules (shadowed-rule detection)', () => {
  it('detects content allow shadowed by whole-tool deny', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: { userSettings: ['Bash(npm install)'] },
      denyRuleBook: { projectSettings: ['Bash'] },
      askRuleBook: {},
    })
    expect(unreachable).toHaveLength(1)
    expect(unreachable[0].ruleString).toBe('Bash(npm install)')
    expect(unreachable[0].shadowType).toBe('deny')
    expect(unreachable[0].shadowedBySource).toBe('projectSettings')
    expect(unreachable[0].fix).toContain('Remove the "Bash" deny rule')
  })

  it('detects content allow shadowed by whole-tool ask', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: { userSettings: ['Read(/etc/passwd)'] },
      denyRuleBook: {},
      askRuleBook: { localSettings: ['Read'] },
    })
    expect(unreachable).toHaveLength(1)
    expect(unreachable[0].ruleString).toBe('Read(/etc/passwd)')
    expect(unreachable[0].shadowType).toBe('ask')
    expect(unreachable[0].shadowedBySource).toBe('localSettings')
  })

  it('does NOT flag whole-tool allow (nothing shadows it)', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: { userSettings: ['Bash'] },
      denyRuleBook: { projectSettings: ['Bash'] },
      askRuleBook: {},
    })
    expect(unreachable).toHaveLength(0)
  })

  it('does NOT flag content allow when deny is also content-bearing', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: { userSettings: ['Bash(npm install)'] },
      denyRuleBook: { projectSettings: ['Bash(rm:*)'] },
      askRuleBook: {},
    })
    expect(unreachable).toHaveLength(0)
  })

  it('Bash sandbox exception: non-shared ask source does NOT shadow when sandboxAutoAllowEnabled', () => {
    const unreachable = findShadowedRules(
      {
        allowRuleBook: { userSettings: ['Bash(npm install)'] },
        denyRuleBook: {},
        askRuleBook: { userSettings: ['Bash'] }, // userSettings is NOT shared
      },
      { sandboxAutoAllowEnabled: true },
    )
    expect(unreachable).toHaveLength(0)
  })

  it('Bash sandbox exception: shared ask source DOES shadow even when sandboxAutoAllowEnabled', () => {
    const unreachable = findShadowedRules(
      {
        allowRuleBook: { userSettings: ['Bash(npm install)'] },
        denyRuleBook: {},
        askRuleBook: { projectSettings: ['Bash'] }, // projectSettings IS shared
      },
      { sandboxAutoAllowEnabled: true },
    )
    expect(unreachable).toHaveLength(1)
    expect(unreachable[0].shadowType).toBe('ask')
  })

  it('deny-shadow takes precedence over ask-shadow', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: { userSettings: ['Bash(npm install)'] },
      denyRuleBook: { projectSettings: ['Bash'] },
      askRuleBook: { localSettings: ['Bash'] },
    })
    expect(unreachable).toHaveLength(1)
    expect(unreachable[0].shadowType).toBe('deny') // deny checked first
  })

  it('multiple shadowed rules are all detected', () => {
    const unreachable = findShadowedRules({
      allowRuleBook: {
        userSettings: ['Bash(npm install)', 'Read(/etc/passwd)'],
      },
      denyRuleBook: { projectSettings: ['Bash'] },
      askRuleBook: { localSettings: ['Read'] },
    })
    expect(unreachable).toHaveLength(2)
    const bashRule = unreachable.find(r => r.ruleString === 'Bash(npm install)')
    const readRule = unreachable.find(r => r.ruleString === 'Read(/etc/passwd)')
    expect(bashRule?.shadowType).toBe('deny')
    expect(readRule?.shadowType).toBe('ask')
  })
})

describe('approvalPromptText', () => {
  it('no decision reason → generic message', () => {
    expect(approvalPromptText('Bash')).toBe(
      "The agent requested permission to use Bash, which has not been granted yet.",
    )
  })

  it('rule reason → names the rule and source', () => {
    const msg = approvalPromptText('Bash', {
      type: 'rule',
      rule: 'Bash(rm:*)',
      source: 'userSettings',
    })
    expect(msg).toContain("Bash(rm:*)")
    expect(msg).toContain('userSettings')
    expect(msg).toContain('Bash')
  })

  it('mode reason → names the mode', () => {
    const msg = approvalPromptText('Write', {
      type: 'mode',
      mode: 'plan',
    })
    expect(msg).toContain('plan')
    expect(msg).toContain('Write')
  })

  it('workingDir reason → uses the reason text', () => {
    const msg = approvalPromptText('Read', {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories.',
    })
    expect(msg).toBe('Path is outside allowed working directories.')
  })

  it('safetyCheck reason → uses the reason text', () => {
    const msg = approvalPromptText('Write', {
      type: 'safetyCheck',
      reason: 'sensitive-path',
    })
    expect(msg).toBe('sensitive-path')
  })

  it('classifier reason → classifier message', () => {
    const msg = approvalPromptText('Bash', {
      type: 'classifier',
      classifier: 'auto-mode',
      reason: 'dangerous command',
    })
    expect(msg).toContain('Classifier')
    expect(msg).toContain('Bash')
  })

  it('hook reason → hook message', () => {
    const msg = approvalPromptText('Bash', { type: 'hook', hookName: 'pre-tool' })
    expect(msg).toContain('Hook')
    expect(msg).toContain('Bash')
  })

  it('sandboxOverride reason → sandbox message', () => {
    const msg = approvalPromptText('Bash', {
      type: 'sandboxOverride',
      reason: 'excludedCommand',
    })
    expect(msg).toBe('Run outside of the sandbox.')
  })
})
