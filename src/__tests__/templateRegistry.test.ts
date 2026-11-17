// Validates the per-session agent-template bundle: Vite `import.meta.glob`
// loads `src/template/**/*.md`, the chat manifest parses (frontmatter +
// `## prompt`/`## begin` skeletons with `!holder` / `$dynamic` classification),
// and holders resolve by name and profile. What the bundled templates' prose
// says is checked in templatePromptProse.test.ts.

import { afterEach, describe, expect, it } from 'vitest'
import {
  __resetPluginTypesForTest,
  __setTemplateChannelForTest,
  __templateBundleForTest,
  applyTemplateToolAllowlist,
  getHolderProse,
  getLauncherCatalog,
  getLauncherMeta,
  getTemplate,
  getTemplateIcon,
  getTemplateTitle,
  getWelcome,
  hasTemplate,
  registerPluginType,
  resolveDeferrableSkills,
  templateAllowsInlineShell,
  templateAllowsMcp,
  templateMcpScope,
  templateWantsFileSnapshots,
  templateWantsWorkspaceDiffTool,
  templateWriteToolName,
} from '../prompting/templateRegistry'
import {
  buildRegistry,
  parseLauncherCatalog,
  parseManifest,
  parseWelcome,
} from '../prompting/templateParsing'
import type { ThreadLauncher } from '../browser/webview/threadLaunchers'
import {
  DEFAULT_LAUNCHER,
  filterLaunchers,
} from '../browser/webview/threadLaunchers'
import { allBundledTools } from '../toolkit/toolRegistry'
import { loadSystemPromptHolders } from '../prompting/systemPromptLoader'
import type { ToolContract, ToolContractList } from '../toolkit/toolContract'
import { expandGroups, TOOL_GROUPS } from '../toolkit/builtin/toolGroups'
import { CLI_AGENT_IDS } from '../terminal/cliAgents'

// intro / tone_and_style / final_reminder moved into agent/includes/ (as
// agent_*). The SHARED holders are the cross-type prose: delivering_work
// (the context-management / delivering-work / corrections guidance, carried
// by code + safe_code + agent), autonomy and pronouns. `thinking_mode` is
// gone (F-19): no prompt tells the model it "has extended
// reasoning available".
const SHARED_HOLDER_NAMES = [
  'system',
  'tool_call_parallelism',
  'executing_with_care',
  'delivering_work',
  'autonomy',
  'pronouns',
]

describe('templateRegistry — bundling', () => {
  it('bundles the chat template and all shared holders from src/template', () => {
    const bundle = __templateBundleForTest()
    expect(bundle.templateTypes).toEqual(
      expect.arrayContaining(['chat', 'agent', 'code', 'safe_code']),
    )
    for (const name of SHARED_HOLDER_NAMES) {
      expect(bundle.sharedHolderNames).toContain(name)
    }
  })

  it('per-type holder names are `<type>_`-prefixed → globally unique (no registry collision)', () => {
    // The C++ PromptHolderRegistry is keyed by (holder, provider, locale) with
    // NO type axis. To guarantee a per-type holder can never collide with a
    // shared (or another type's) holder — nor be shadowed by a shared
    // override — every per-type holder is named `<type>_<...>`. This guard
    // enforces that convention so the latent collision can't be reintroduced
    // (e.g. by re-adding a bare `code/includes/intro.md`). The only file
    // suffix is the `-lean` prompt-profile variant (`promptProfile.ts`).
    const PROFILE_SUFFIX = /-lean$/
    const bundle = __templateBundleForTest()
    const sharedBases = new Set(
      bundle.sharedHolderNames.map(n => n.replace(PROFILE_SUFFIX, '')),
    )
    for (const [type, names] of Object.entries(bundle.typeHolderNames)) {
      for (const name of names) {
        const base = name.replace(PROFILE_SUFFIX, '')
        expect(
          base.startsWith(`${type}_`),
          `per-type holder "${name}" (type "${type}") must be prefixed "${type}_"`,
        ).toBe(true)
        expect(
          sharedBases.has(base),
          `per-type holder "${base}" collides with a shared holder name`,
        ).toBe(false)
      }
    }
  })
})

describe('templateRegistry — manifest parse', () => {
  it('parses the chat frontmatter (type / deferredTools)', () => {
    expect(hasTemplate('chat')).toBe(true)
    const t = getTemplate('chat')!
    expect(t.config.type).toBe('chat')
    expect(t.config.deferredTools).toEqual(['browser', 'a2ui'])
    // `tools:` lists the EAGER groups; expand to tool names. read/edit/webfetch
    // are eager (file tools confined at the gate); no shell at all; a2ui_* defer.
    const eager = expandGroups(t.config.tools ?? [])
    expect(eager).toContain('Read') // read group
    expect(eager).toContain('WebFetch') // webfetch group
    expect(eager).toContain('Write') // edit group (now eager)
    expect(eager).not.toContain('Bash') // no shell group
    expect(eager).not.toContain('TodoWrite') // todo group excluded
    expect(eager).not.toContain('a2ui_create_surface') // deferred
    expect(eager).not.toContain('TeamCreate')
  })

  it('the three template types narrow the eager set + defer per the unified model', () => {
    const eagerOf = (type: string): Set<string> =>
      expandGroups(getTemplate(type)!.config.tools ?? [])
    const deferredOf = (type: string): string[] =>
      getTemplate(type)!.config.deferredTools ?? []
    // agent = full autonomy: edit + shell + planning + scheduling eager; browser
    // LOADED (a skill in tools:); only a2ui/agent-teams deferred.
    const agent = eagerOf('agent')
    for (const t of ['Write', 'Bash', 'EnterPlanMode', 'Agent', 'CronCreate']) {
      expect(agent, `agent should keep ${t}`).toContain(t)
    }
    expect(deferredOf('agent')).toEqual(['a2ui', 'agent-teams', 'mods'])
    // chat = read + edit (confined to memory / skills / uploads) + webfetch;
    // browser/a2ui DEFER; no shell, not even deferred.
    const chat = eagerOf('chat')
    for (const t of ['Read', 'Write', 'Edit', 'WebFetch', 'ContinueInCode']) {
      expect(chat, `chat should keep ${t}`).toContain(t)
    }
    for (const t of ['Bash', 'EnterPlanMode', 'Agent', 'CronCreate']) {
      expect(chat, `chat should exclude/defer ${t}`).not.toContain(t)
    }
    expect(deferredOf('chat')).toEqual(['browser', 'a2ui'])
    // code = dev: shell + plan + sub-agents eager, NO scheduling. Mutation is
    // `SuperEdit` ONLY — the `edit` group (Write/Edit/NotebookEdit) was dropped
    // so a coding session has a single, permission-gated write surface. The
    // `code_using_your_tools` prose must name SuperEdit and never Write/Edit.
    const code = eagerOf('code')
    for (const t of ['SuperEdit', 'Bash', 'EnterPlanMode', 'Agent', 'WebFetch']) {
      expect(code, `code should keep ${t}`).toContain(t)
    }
    for (const t of ['Write', 'Edit', 'NotebookEdit']) {
      expect(code, `code dropped the edit group, so ${t} must be absent`).not.toContain(t)
    }
    expect(code, 'code keeps schedule out of the eager set').not.toContain('CronCreate')
    expect(deferredOf('code')).toEqual(['browser', 'schedule', 'a2ui', 'agent-teams', 'mods'])
  })

  it('code defers the schedule group, so `/loop` can load CronCreate on demand', () => {
    const units = resolveDeferrableSkills([], getTemplate('code')!.config)
    const schedule = units.find((u) => u.name === 'schedule')
    expect(schedule, 'code must defer the schedule group').toBeDefined()
    expect(schedule!.defaultDeferred).toBe(true)
    expect(schedule!.sealed).toBeUndefined()
    expect(schedule!.toolNames).toEqual(
      expect.arrayContaining(['CronCreate', 'CronList', 'CronDelete']),
    )
  })

  it('safe_code registers Inspect + Modify and nothing that can run', () => {
    // SafeCode's whole definition: read the workspace, write the workspace,
    // do nothing else. Anything that could RUN something is left OUT of the
    // template entirely rather than hidden, so the boundary is decided once by
    // `applyTemplateToolAllowlist` at runtime construction instead of by the
    // per-turn deferral gate — whose registry is module-global and is replaced
    // wholesale by every other session in the same SharedWorker realm.
    const cfg = getTemplate('safe_code')!.config
    expect(cfg.tools).toEqual(['read', 'plan', 'superedit'])
    const eager = expandGroups(cfg.tools ?? [])
    // Inspect lane + plan mode…
    for (const t of ['Read', 'Glob', 'Grep', 'EnterPlanMode', 'ExitPlanMode']) {
      expect(eager, `safe_code should surface ${t}`).toContain(t)
    }
    // …Modify lane.
    expect(eager).toContain('SuperEdit')
    // Nothing that executes, reaches the network, or can bring a hidden tool
    // online. `exec` and `Skill`/`ToolSearch` are the ones this change removed:
    // exec ran commands, ToolSearch is the surface that activates deferred
    // units. `Write`/`Edit` stay out because mutation belongs to SuperEdit's
    // permission-gated workspace facade.
    for (const t of [
      'Bash',
      'PowerShell',
      'Exec',
      'WebFetch',
      'Skill',
      'ToolSearch',
      'Write',
      'Edit',
      'NotebookEdit',
      'Agent',
      'CronCreate',
    ]) {
      expect(eager, `safe_code must not surface ${t}`).not.toContain(t)
    }
    // Nothing hidden-but-present either: no deferred units, nothing sealed.
    expect(cfg.deferredTools ?? []).toEqual([])
    expect(cfg.sealedTools ?? []).toEqual([])
    expect(resolveDeferrableSkills([], cfg)).toEqual([])
  })

  it('safe_code declares noExecution; the executing types do not', () => {
    // The flag closes the one door the `tools:` allowlist cannot: MCP tools are
    // appended AFTER the allowlist, and a stdio server spawns processes.
    expect(getTemplate('safe_code')!.config.noExecution).toBe(true)
    for (const type of ['chat', 'code', 'agent']) {
      expect(
        getTemplate(type)!.config.noExecution,
        `${type} must not declare noExecution`,
      ).toBe(false)
    }
  })

  it('templateAllowsMcp: every executing type yes, safe_code no', () => {
    // MCP tools are appended past `applyTemplateToolAllowlist`, so this rule —
    // not the `tools:` list — is what keeps a stdio server (which spawns OS
    // processes) out of a non-executing session.
    expect(templateAllowsMcp(getTemplate('safe_code')!.config)).toBe(false)
    for (const type of ['chat', 'code', 'agent']) {
      expect(templateAllowsMcp(getTemplate(type)!.config), type).toBe(true)
    }
    // Absent config (a type with no manifest) keeps today's behaviour.
    expect(templateAllowsMcp(undefined)).toBe(true)
  })

  it('mcp: parses the two literals; absent is all; anything else throws', () => {
    const plugin = (fm: string) => parseManifest('acme:x', `---\ntype: acme:x\n${fm}\n---\n`).config
    expect(plugin('').mcp).toBeUndefined()
    expect(plugin('mcp: all').mcp).toBe('all')
    expect(plugin('mcp: plugin\nskills: []').mcp).toBe('plugin')
    expect(() => plugin('mcp: own\nskills: []')).toThrow(/mcp: must be "all" or "plugin"/)
    expect(() => plugin('mcp: true\nskills: []')).toThrow(/mcp: must be/)
  })

  it('mcp: plugin fails closed on every widening combination', () => {
    // A bundled type has no owning plugin to confine to.
    expect(() => parseManifest('x', '---\ntype: x\nmcp: plugin\nskills: []\n---\n')).toThrow(
      /only for a plugin's template/,
    )
    // noExecution already takes no MCP; the two together are a contradiction, not a narrowing.
    expect(() =>
      parseManifest('acme:x', '---\ntype: acme:x\nmcp: plugin\nnoExecution: true\nskills: []\n---\n'),
    ).toThrow(/cannot both be set/)
    // A skill body may carry inline shell, so the skill set must be exact.
    expect(() => parseManifest('acme:x', '---\ntype: acme:x\nmcp: plugin\n---\n')).toThrow(
      /requires an exact skills: list/,
    )
    expect(() => parseManifest('acme:x', '---\ntype: acme:x\nmcp: plugin\nskills: all\n---\n')).toThrow(
      /requires an exact skills: list/,
    )
    expect(
      parseManifest('acme:x', '---\ntype: acme:x\nmcp: plugin\nskills: [plugin:acme:setup]\n---\n').config.mcp,
    ).toBe('plugin')
  })

  it('templateMcpScope: none for noExecution, plugin for mcp: plugin, all otherwise — and the two predicates follow it', () => {
    const scoped = parseManifest('acme:x', '---\ntype: acme:x\nmcp: plugin\nskills: []\n---\n').config
    expect(templateMcpScope(getTemplate('safe_code')!.config)).toBe('none')
    expect(templateMcpScope(scoped)).toBe('plugin')
    for (const type of ['chat', 'code', 'agent']) expect(templateMcpScope(getTemplate(type)!.config), type).toBe('all')
    expect(templateMcpScope(undefined)).toBe('all')
    // The pool is open to every scope but none; inline shell only to all.
    expect(templateAllowsMcp(scoped)).toBe(true)
    expect(templateAllowsInlineShell(scoped)).toBe(false)
    expect(templateAllowsInlineShell(getTemplate('safe_code')!.config)).toBe(false)
    expect(templateAllowsInlineShell(getTemplate('code')!.config)).toBe(true)
    expect(templateAllowsInlineShell(undefined)).toBe(true)
  })

  it('no bundled type declares mcp:', () => {
    for (const type of ['chat', 'code', 'agent', 'safe_code', 'team']) {
      const tmpl = getTemplate(type)
      if (tmpl) expect(tmpl.config.mcp, type).toBeUndefined()
    }
  })

  it('launcherHidden: safe_code is launcher-hidden in index.md; every other listed type is visible', () => {
    expect(getLauncherMeta('safe_code')!.launcherHidden).toBe('both')
    // The test realm has no location ⇒ the stable channel ⇒ `index.md`, which
    // does not list `team` at all (`index-beta.md` does; see the beta suite).
    expect(getLauncherMeta('team')).toBeUndefined()
    for (const type of ['code', 'agent', 'chat']) {
      expect(getLauncherMeta(type)!.launcherHidden, type).toBeUndefined()
    }
    // Hidden ≠ absent: the type is still fully registered and creatable.
    expect(hasTemplate('safe_code')).toBe(true)
    expect(getTemplate('safe_code')).toBeDefined()
  })

  it('launcherHidden honours only both/sidebar — a bare true does NOT hide; absent ⇒ visible', () => {
    const catalog = (value: string) =>
      parseLauncherCatalog(
        `---\ntypes:\n  - type: x\n    title: X\n    launcherHidden: ${value}\n---\n`,
      )[0]!
    expect(catalog('both').launcherHidden).toBe('both')
    expect(catalog('sidebar').launcherHidden).toBe('sidebar')
    // A bare `true` is NOT a scope — only the two spellings hide.
    for (const value of ['true', '"true"', 'yes', '1', 'false', 'null']) {
      expect(catalog(value).launcherHidden, value).toBeUndefined()
    }
    expect(
      parseLauncherCatalog('---\ntypes:\n  - type: x\n---\n')[0]!.launcherHidden,
    ).toBeUndefined()
  })

  it('every type that ships a welcome.md parses it into real suggestions', () => {
    // A malformed welcome (a missing closing `---`, a YAML slip) degrades
    // SILENTLY to an empty suggestion list, and the welcome page then renders
    // nothing at all — no error anywhere. This is that regression, caught
    // once on `team` by e2e and pinned here where it costs milliseconds.
    for (const meta of getLauncherCatalog()) {
      const welcome = getWelcome(meta.type, 'en')
      if (!welcome) continue
      expect(
        welcome.suggestions.length,
        `${meta.type}/welcome.md parsed to zero suggestions`,
      ).toBeGreaterThan(0)
      for (const suggestion of welcome.suggestions) {
        expect(suggestion.title.length, `${meta.type} chip title`).toBeGreaterThan(0)
      }
    }
  })

  it('team on beta carries no launcherHidden — offered on the sidebar and the project menu alike', () => {
    // Unlike `safe_code`, `team` has no `launcherHidden` scope in the beta
    // catalog: it is offered on both surfaces there.
    __setTemplateChannelForTest('beta')
    try {
      const team = getLauncherMeta('team')!
      expect(team.launcherHidden).toBeUndefined()
      expect(team.launcherMenu).toBeUndefined()
    } finally {
      __setTemplateChannelForTest(null)
    }
  })

  it('launcherHidden scope parses — both ⇒ both; sidebar ⇒ sidebar; anything else offered', () => {
    const catalog = (value: string) =>
      parseLauncherCatalog(
        `---\ntypes:\n  - type: x\n    title: X\n    launcherHidden: ${value}\n---`,
      )[0]!
    expect(catalog('both').launcherHidden).toBe('both')
    expect(catalog('sidebar').launcherHidden).toBe('sidebar')
    for (const value of ['true', '"true"', 'false', 'yes', '0', 'null', 'menu']) {
      expect(catalog(value).launcherHidden, value).toBeUndefined()
    }
    expect(
      parseLauncherCatalog('---\ntypes:\n  - type: x\n---')[0]!.launcherHidden,
    ).toBeUndefined()
  })

  it('the retired `channels:` key is inert — it neither gates nor throws', () => {
    // Channel differences moved into their own files (`index-beta.md`), so a
    // stale `channels:` left in a local catalog must not break boot or change
    // what is offered.
    for (const value of ['beta', '[beta, stable]', 'nightly', '[]']) {
      const meta = parseLauncherCatalog(
        `---\ntypes:\n  - type: x\n    title: X\n    channels: ${value}\n---\n`,
      )[0]!
      expect(meta, value).toEqual({ type: 'x', title: 'X' })
    }
  })

  it('team IS offered in the project folder menu (beta catalog)', () => {
    // `team` is a forced-folder type, and creating from a project node binds
    // the folder AT CREATION — which is what skips the forced folder picker
    // (see MultiSessionShell.handleLaunchInProject). Marking it
    // `launcherMenu: false` therefore did not just hide a menu entry: it
    // removed the only path to a team session that does not open blocked on
    // the picker. Absent ⇒ offered.
    __setTemplateChannelForTest('beta')
    try {
      expect(getLauncherMeta('team')!.launcherMenu).toBeUndefined()
    } finally {
      __setTemplateChannelForTest(null)
    }
  })

  it('launcherMenu parses strict-false only — absent or true ⇒ undefined', () => {
    const catalog = (value: string) =>
      parseLauncherCatalog(
        `---\ntypes:\n  - type: x\n    title: X\n    launcherMenu: ${value}\n---\n`,
      )[0]!
    expect(catalog('false').launcherMenu).toBe(false)
    expect(catalog('"false"').launcherMenu).toBe(false)
    for (const value of ['true', 'yes', '0', 'null']) {
      expect(catalog(value).launcherMenu, value).toBeUndefined()
    }
    expect(
      parseLauncherCatalog('---\ntypes:\n  - type: x\n---\n')[0]!.launcherMenu,
    ).toBeUndefined()
  })

  it('filterLaunchers: launcherMenu:false only drops from the projectMenu surface', () => {
    const menuless: ThreadLauncher = {
      type: 'menuless',
      Icon: DEFAULT_LAUNCHER.Icon,
      testId: 'launcher-menuless',
      launcherMenu: false,
    }
    const hidden: ThreadLauncher = {
      type: 'hidden',
      Icon: DEFAULT_LAUNCHER.Icon,
      testId: 'launcher-hidden',
      launcherHidden: 'both',
    }
    const plain: ThreadLauncher = {
      type: 'plain',
      Icon: DEFAULT_LAUNCHER.Icon,
      testId: 'launcher-plain',
    }
    const all = [plain, menuless, hidden]
    expect(filterLaunchers(all).map(l => l.type)).toEqual(['plain', 'menuless'])
    expect(filterLaunchers(all, 'sidebar').map(l => l.type)).toEqual([
      'plain',
      'menuless',
    ])
    expect(filterLaunchers(all, 'projectMenu').map(l => l.type)).toEqual(['plain'])
    // launcherHidden:both hides on BOTH surfaces with no unhide path — the two
    // flags are independent, and nothing resurrects a hidden type.
    expect(filterLaunchers(all, 'projectMenu').map(l => l.type)).not.toContain('hidden')
  })

  it('filterLaunchers: launcherHidden:sidebar drops from the sidebar, keeps the projectMenu', () => {
    const Icon = DEFAULT_LAUNCHER.Icon
    const menuOnly: ThreadLauncher = {
      type: 'menu-only',
      Icon,
      testId: 'launcher-menu-only',
      launcherHidden: 'sidebar',
    }
    const plain: ThreadLauncher = { type: 'plain', Icon, testId: 'launcher-plain' }
    const all = [plain, menuOnly]
    // Sidebar surface: the sidebar-scoped entry is gone.
    expect(filterLaunchers(all, 'sidebar').map(l => l.type)).toEqual(['plain'])
    // Project menu surface: unaffected — the whole point of the scope.
    expect(filterLaunchers(all, 'projectMenu').map(l => l.type)).toEqual([
      'plain',
      'menu-only',
    ])
  })

  it('noExecution parses strict-true — a truthy string does not enable it', () => {
    const manifest = (value: string) =>
      parseManifest('x', `---\ntype: x\nnoExecution: ${value}\n---\n`).config
        .noExecution
    expect(manifest('true')).toBe(true)
    expect(manifest('"true"')).toBe(true)
    expect(manifest('false')).toBe(false)
    expect(manifest('yes')).toBe(false)
    expect(manifest('1')).toBe(false)
    expect(parseManifest('x', '---\ntype: x\n---\n').config.noExecution).toBe(false)
  })

  it('fileSnapshots is bound to SuperEdit: code + safe_code on, agent + chat off', () => {
    // The recorder rides with SuperEdit, not with a type or an explicit flag:
    // it is built for a session whose structured-edit surface IS SuperEdit
    // (`superedit` present, hosted `edit` absent). That is `code` (SuperEdit
    // only — no Write/Edit) and `safe_code` (which also still carries the
    // explicit `fileSnapshots: true`). `agent` has BOTH SuperEdit and hosted
    // Edit/Write, so it stays off until the recorder captures Edit/Write too
    // (the panel switches wholly to the recorder, which would otherwise hide
    // those diffs); `chat` has no SuperEdit at all.
    for (const type of ['code', 'safe_code']) {
      expect(
        templateWantsFileSnapshots(getTemplate(type)!.config),
        `${type} should record file snapshots (SuperEdit is its edit surface)`,
      ).toBe(true)
    }
    for (const type of ['chat', 'agent']) {
      expect(
        templateWantsFileSnapshots(getTemplate(type)!.config),
        `${type} must not record file snapshots`,
      ).toBe(false)
    }
    // Only safe_code carries the explicit override flag; code has no
    // `fileSnapshots:` in its frontmatter (parses to false) yet is enabled
    // purely by the SuperEdit-derived rule.
    expect(getTemplate('safe_code')!.config.fileSnapshots).toBe(true)
    expect(getTemplate('code')!.config.fileSnapshots).toBe(false)
    expect(templateWantsFileSnapshots(undefined)).toBe(false)
  })

  it('templateWantsFileSnapshots: superedit ∧ ¬edit, with the explicit override', () => {
    const cfg = (tools?: string[], fileSnapshots?: boolean) => ({
      type: 'synthetic',
      ...(tools ? { tools } : {}),
      ...(fileSnapshots !== undefined ? { fileSnapshots } : {}),
    })
    // SuperEdit is the sole structured-edit surface → on.
    expect(templateWantsFileSnapshots(cfg(['read', 'superedit']))).toBe(true)
    // Hosted Edit/Write alongside SuperEdit → off (would hide Edit/Write diffs).
    expect(templateWantsFileSnapshots(cfg(['edit', 'superedit']))).toBe(false)
    // No SuperEdit → off.
    expect(templateWantsFileSnapshots(cfg(['read', 'edit']))).toBe(false)
    // Absent `tools` ⇒ the full set (which has hosted Edit/Write) ⇒ off.
    expect(templateWantsFileSnapshots(cfg(undefined))).toBe(false)
    // The explicit flag forces it on even when hosted `edit` is present.
    expect(templateWantsFileSnapshots(cfg(['edit', 'superedit'], true))).toBe(true)
  })

  it('WorkspaceDiff tool: only shell-less snapshot types (safe_code, not code)', () => {
    // The model-facing git-diff replacement is offered only where there is no
    // shell (no `git diff`). `code` records snapshots but keeps its shell, so
    // its model tool set is unchanged; `safe_code` (no shell) gets the tool.
    expect(templateWantsWorkspaceDiffTool(getTemplate('safe_code')!.config)).toBe(true)
    for (const type of ['code', 'agent', 'chat']) {
      expect(
        templateWantsWorkspaceDiffTool(getTemplate(type)!.config),
        `${type} must not surface the WorkspaceDiff tool`,
      ).toBe(false)
    }
    expect(templateWantsWorkspaceDiffTool(undefined)).toBe(false)
  })

  it('WorkspaceDiff tool: SuperShell counts as a shell, a sealed shell alone does not', () => {
    // SuperShell's bash() steps run `git diff` like Bash does, so a SuperEdit
    // type with `supershell` eager (beta `code`: the raw `shell` group only
    // sealed) has git and gets no replacement tool. Without SuperShell a sealed
    // shell leaves the model no way to run git, so the tool stays.
    const cfg = (tools: string[], sealedTools?: string[]) => ({
      type: 'synthetic',
      tools,
      ...(sealedTools ? { sealedTools } : {}),
    })
    expect(templateWantsWorkspaceDiffTool(cfg(['read', 'supershell', 'superedit'], ['shell']))).toBe(false)
    expect(templateWantsWorkspaceDiffTool(cfg(['read', 'supershell', 'superedit']))).toBe(false)
    expect(templateWantsWorkspaceDiffTool(cfg(['read', 'shell', 'superedit']))).toBe(false)
    expect(templateWantsWorkspaceDiffTool(cfg(['read', 'superedit'], ['shell']))).toBe(true)
  })

  it('templateWriteToolName: the write tool each type actually registers', () => {
    // The memory block names this tool to the model ("write to it directly with
    // the X tool"), so it has to be one the session can call. `Write` rides the
    // `edit` group; the SuperEdit types never had it — and safe_code has no
    // shell to fall back on, so naming `Write` there left it unable to save a
    // memory at all.
    for (const type of ['agent', 'chat']) {
      expect(templateWriteToolName(getTemplate(type)!.config), type).toBe('Write')
    }
    for (const type of ['code', 'safe_code']) {
      expect(templateWriteToolName(getTemplate(type)!.config), type).toBe('SuperEdit')
    }
  })

  it('templateWriteToolName: Write wins over SuperEdit, none names nothing', () => {
    const cfg = (tools?: string[]) => ({
      type: 'synthetic',
      ...(tools ? { tools } : {}),
    })
    // Both surfaces → `Write`, the one-file-per-call tool the prose describes.
    expect(templateWriteToolName(cfg(['edit', 'superedit']))).toBe('Write')
    expect(templateWriteToolName(cfg(['read', 'superedit']))).toBe('SuperEdit')
    // Read-only: no tool to name, so the caller drops the clause rather than
    // inventing one.
    expect(templateWriteToolName(cfg(['read']))).toBeUndefined()
    // Absent `tools` ⇒ the full default set ⇒ `Write` is in it.
    expect(templateWriteToolName(cfg(undefined))).toBe('Write')
    expect(templateWriteToolName(undefined)).toBe('Write')
  })

  it('fileSnapshots parses strict-true, same spelling rules as noExecution', () => {
    const manifest = (value: string) =>
      parseManifest('x', `---\ntype: x\nfileSnapshots: ${value}\n---\n`).config
        .fileSnapshots
    expect(manifest('true')).toBe(true)
    expect(manifest('yes')).toBe(false)
    expect(manifest('1')).toBe(false)
    expect(parseManifest('x', '---\ntype: x\n---\n').config.fileSnapshots).toBe(
      false,
    )
  })

  it('resolveDeferrableSkills marks sealedTools units sealed (and deferred)', () => {
    // No shipped template uses `sealedTools` any more — safe_code dropped it
    // with `exec` — but the mechanism stays, so pin it against a synthetic
    // config rather than deleting the coverage.
    const units = resolveDeferrableSkills([], {
      type: 'synthetic',
      sealedTools: ['shell'],
    })
    const shell = units.find(u => u.name === 'shell')
    expect(shell).toBeDefined()
    expect(shell!.sealed).toBe(true)
    expect(shell!.defaultDeferred).toBe(true)
    expect(shell!.toolNames).toEqual(TOOL_GROUPS.shell)
  })

  it('safe_code uses its own single intro holder (the non-executing prompt)', () => {
    const t = getTemplate('safe_code')!
    expect(t.prompt).toEqual([
      { kind: 'holder', name: 'safe_code_intro' },
      { kind: 'holder', name: 'safe_code_using_your_tools' },
      { kind: 'holder', name: 'turn_board' },
      // UNGATED here: safe_code has no lean rendering, so a `@standard`
      // gate would drop the paragraph under a lean-profile model.
      { kind: 'holder', name: 'tool_call_parallelism' },
      { kind: 'holder', name: 'delivering_work' },
      { kind: 'holder', name: 'autonomy' }, // shared with code (shared_includes/)
      { kind: 'dynamic', name: 'environment' },
      { kind: 'dynamic', name: 'memory' },
    ])
    const intro = getHolderProse('safe_code_intro', { type: 'safe_code' })!
    expect(intro).toContain('autonomous coding agent working in SafeCode mode')
    expect(intro).toContain('inspect code and change it, without ever executing it')
    // "directly or indirectly" is load-bearing: it rules out the write-a-hook-
    // then-trigger-it route, not just a literal command.
    expect(intro).toContain('directly or indirectly')
    expect(intro).toContain('`SuperEdit`')
    // Verification-by-inspection includes reviewing your own diff — the
    // WorkspaceDiff tool is SafeCode's git-diff replacement.
    expect(intro).toContain('`WorkspaceDiff`')
    expect(intro).toContain('Read. Change. Inspect. Never execute.')
    // The old three-lane framing invited the model to treat SafeCode as an
    // execution environment. It must not come back.
    expect(intro).not.toContain('Observe. Mutate. Verify. Repeat.')
    expect(intro).not.toContain('`exec`')
  })

  it('safe_code declares an empty `## begin` (no Skill tool to invoke)', () => {
    // Declarative only: the runtime listing is built in
    // `collectSkillListingAttachments`, which already returns none because
    // `sessionHasSkillTool` is false without the `skills` group. The manifest
    // is emptied so it does not advertise a `$skill_listing` this type can
    // never produce.
    expect(getTemplate('safe_code')!.begin).toEqual([])
    // The executing types still advertise their skills.
    expect(getTemplate('code')!.begin).toEqual([
      { kind: 'dynamic', name: 'skill_listing' },
    ])
  })

  it('parses the `## prompt` skeleton in order, classifying !holder / $dynamic', () => {
    const t = getTemplate('chat')!
    // chat diverges to the conversational `chat_*` holders + a personality
    // block, and DROPS the browser-navigation-flavored final_reminder.
    expect(t.prompt).toEqual([
      { kind: 'holder', name: 'chat_intro' },
      { kind: 'holder', name: 'system' },
      { kind: 'holder', name: 'chat_answering_well' },
      { kind: 'holder', name: 'chat_using_your_tools' },
      { kind: 'holder', name: 'tool_call_parallelism', profile: 'standard' },
      { kind: 'dynamic', name: 'skill_catalogs' },
      { kind: 'dynamic', name: 'mcp_servers' },
      { kind: 'dynamic', name: 'session_guidance' },
      { kind: 'holder', name: 'chat_tone_and_style' },
      { kind: 'dynamic', name: 'environment' },
      { kind: 'dynamic', name: 'memory' },
    ])
  })

  it('parses the `## begin` skeleton', () => {
    const t = getTemplate('chat')!
    expect(t.begin).toEqual([{ kind: 'dynamic', name: 'skill_listing' }])
  })
})

describe('templateRegistry — launcher metadata (title / icon / title-i18n)', () => {
  it('reads title / title-i18n / icon_lucide from the index.md launcher catalog', () => {
    const cases: Array<[string, string, string, string]> = [
      ['agent', 'Agent', 'launcher.agent', 'bot'],
      ['chat', 'Chat', 'launcher.chat', 'message-circle'],
      ['code', 'Code', 'launcher.code', 'code'],
      ['safe_code', 'SafeCode', 'launcher.safeCode', 'shield-check'],
    ]
    for (const [type, title, titleI18n, iconLucide] of cases) {
      const meta = getLauncherMeta(type)!
      expect(meta.title, type).toBe(title)
      expect(meta.titleI18n, type).toBe(titleI18n)
      expect(meta.iconLucide, type).toBe(iconLucide)
      // No explicit `icon:` path set → resolution falls back to the lucide name.
      expect(meta.icon, type).toBeUndefined()
    }
    // The catalog IS the ordered type list (the sidebar reads ONLY this file).
    // `code` leads since 00a0067 ("update template") — the order below is
    // index.md's, not a preference of this test.
    expect(getLauncherCatalog().map(m => m.type)).toEqual([
      'code',
      'agent',
      'chat',
      // The hidden type trails the offered ones (`launcherHidden: both`).
      // (`team` is listed in `index-beta.md` only.)
      'safe_code',
    ])
    // Launcher metadata no longer lives on the heavy `template.md` config.
    expect(
      (getTemplate('agent')!.config as unknown as Record<string, unknown>).title,
    ).toBeUndefined()
  })

  it('getTemplateTitle: resolvable i18n key → title → bare type', () => {
    // 1. title-i18n resolves → the localized string (FIRST choice).
    expect(getTemplateTitle('agent', () => 'Localized Agent')).toBe('Localized Agent')
    // 2. title-i18n has no message (translate → undefined) → the literal `title`.
    expect(getTemplateTitle('agent', () => undefined)).toBe('Agent')
    // 3. no translate fn supplied → the literal `title`.
    expect(getTemplateTitle('chat')).toBe('Chat')
    // 4. unknown type (no config) → the bare type name.
    expect(getTemplateTitle('nope')).toBe('nope')
  })

  it('getTemplateIcon: icon path > includes image > icon_lucide (lucide today)', () => {
    // No `icon:` path and no `includes/icon.*` today → the lucide-react name.
    expect(getTemplateIcon('agent')).toEqual({ kind: 'lucide', name: 'bot' })
    expect(getTemplateIcon('chat')).toEqual({ kind: 'lucide', name: 'message-circle' })
    expect(getTemplateIcon('code')).toEqual({ kind: 'lucide', name: 'code' })
    // Unknown type → no icon (the launcher keeps its own fallback).
    expect(getTemplateIcon('nope')).toBeUndefined()
  })
})

describe('templateRegistry — welcome page (welcome.md)', () => {
  it('parses agent/welcome.md into greeting + suggestions (title/description/prompt)', () => {
    const w = getWelcome('agent')!
    expect(w.greeting).toBe('What can I help you with?')
    expect(w.suggestions.map(s => s.title)).toEqual([
      'Organize my files',
      'Deep research',
      'Complete a web task',
      'Work with documents & data',
      'Create something',
      'Automate a recurring task',
    ])
    const first = w.suggestions[0]
    expect(first.description).toBe('Sort, rename, and organize files on my computer.')
    expect(first.prompt).toContain('Help me organize my files.')
    // `&` inside a plain YAML scalar is an ordinary character (an anchor only
    // binds at the START of a value), so the chip title survives the parse
    // intact rather than becoming an alias reference.
    expect(w.suggestions[3]!.title).toBe('Work with documents & data')
    // Every chip ships all three fields — a chip with no `prompt` silently
    // falls back to its `title` in the composer, which reads as a bug.
    for (const suggestion of w.suggestions) {
      expect(suggestion.description, `${suggestion.title} description`).toBeTruthy()
      expect(suggestion.prompt, `${suggestion.title} prompt`).toBeTruthy()
    }
  })

  it('parses code/welcome.md into the coding lifecycle starters', () => {
    const w = getWelcome('code')!
    expect(w.greeting).toBe('What can I help you build?')
    // Understand → build → fix → review → refactor → test.
    expect(w.suggestions.map(s => s.title)).toEqual([
      'Build a feature',
      'Fix a bug',
      'Understand this codebase',
      'Review code',
      'Refactor code',
      'Add or improve tests',
    ])
    expect(w.suggestions.find(s => s.title === 'Fix a bug')!.prompt)
      .toContain('identify the root cause')
  })

  it('parses chat/welcome.md into conversational starters distinct from agent', () => {
    const w = getWelcome('chat')!
    expect(w.greeting).toBe("What's on your mind?")
    expect(w.suggestions.map(s => s.title)).toEqual([
      'Ask anything',
      'Summarize something',
      'Explain a topic',
      'Compare options',
      'Write or rewrite',
      'Brainstorm ideas',
    ])
    // The three types must not compete for the same intent: chat is
    // "think with me", agent is "do work for me", code is repo work. A title
    // shared across two welcome pages means one of them is in the wrong place.
    const agentTitles = new Set(getWelcome('agent')!.suggestions.map(s => s.title))
    const codeTitles = new Set(getWelcome('code')!.suggestions.map(s => s.title))
    for (const { title } of w.suggestions) {
      expect(agentTitles.has(title), `chat/agent overlap: ${title}`).toBe(false)
      expect(codeTitles.has(title), `chat/code overlap: ${title}`).toBe(false)
    }
  })

  it('parseWelcome preserves a fill-in starter’s trailing separator verbatim', () => {
    // No bundled template ships a fill-in starter today, but the parser must
    // keep NOT trimming `prompt` — a starter ending in ": " leaves the composer
    // ready for the user to append to. Asserted on the parser directly so the
    // guarantee survives any rewording of the shipped chips.
    const w = parseWelcome(
      [
        '---',
        'suggestions:',
        '  - title: Fix a bug',
        "    prompt: 'Help me find and fix this bug: '",
        '  - title: Bare title only',
        '---',
        '',
      ].join('\n'),
    )
    expect(w.suggestions[0]!.prompt).toBe('Help me find and fix this bug: ')
    // No `prompt` → undefined, so the chip falls back to its `title`.
    expect(w.suggestions[1]!.prompt).toBeUndefined()
  })

  it('resolves welcome-<locale>.md variants (zh/es/fr/de) per type', () => {
    const LOCALES = ['zh', 'es', 'fr', 'de'] as const
    // EVERY type that ships a welcome page, not a hand-picked subset — a new
    // type with an English-only welcome is exactly the gap this pins.
    for (const type of ['agent', 'chat', 'code', 'safe_code', 'team']) {
      const en = getWelcome(type)!
      for (const locale of LOCALES) {
        const w = getWelcome(type, locale)!
        // Each locale variant ships the same number of chips, translated.
        expect(w.suggestions, `${type}/${locale} chip count`).toHaveLength(
          en.suggestions.length,
        )
        expect(w.greeting, `${type}/${locale} greeting`).not.toBe(en.greeting)
        const titles = w.suggestions.map(s => s.title)
        const enTitles = en.suggestions.map(s => s.title)
        expect(titles, `${type}/${locale} chip titles translated`).not.toEqual(enTitles)
        expect(titles, `${type}/${locale} chip titles unique within variant`).toEqual(
          [...new Set(titles)],
        )
        // ALL THREE user-visible fields are translated, not just the title.
        // `prompt` is what a chip loads into the composer for the user to read
        // and edit before sending, so an English prompt under a translated
        // title is a visible gap — this pins every locale against that.
        for (const [index, suggestion] of w.suggestions.entries()) {
          const source = en.suggestions[index]!
          expect(
            suggestion.description,
            `${type}/${locale} chip ${index} description translated`,
          ).not.toBe(source.description)
          // A slash-command prompt (`team`'s chips load `/safe-team ` into the
          // composer) is an identifier, not prose: it MUST stay verbatim,
          // trailing space included, or the command no longer resolves.
          if (source.prompt?.startsWith('/')) {
            expect(
              suggestion.prompt,
              `${type}/${locale} chip ${index} slash command verbatim`,
            ).toBe(source.prompt)
          } else {
            expect(
              suggestion.prompt,
              `${type}/${locale} chip ${index} prompt translated`,
            ).not.toBe(source.prompt)
          }
        }
      }
    }
  })

  it('getWelcome falls back to the default `welcome.md` for an unsupported locale', () => {
    // Every type ships locale variants only for zh/es/fr/de → 'ja' → default.
    for (const type of ['agent', 'chat', 'code', 'safe_code', 'team']) {
      expect(getWelcome(type, 'ja'), type).toBe(getWelcome(type, ''))
    }
    expect(getWelcome('nope')).toBeUndefined()
  })
})

describe('templateRegistry — plugin types (registerPluginType)', () => {
  afterEach(() => __resetPluginTypesForTest())

  it('registers a plugin type with its own holders', async () => {
    await registerPluginType('acme:research', [
      [
        'acme:research/template.md',
        '---\ntype: acme:research\ntools: [read]\n---\n\n## prompt\n!research_intro\n!agent_intro\n',
      ],
      ['acme:research/includes/research_intro.md', 'You are a researcher.'],
    ])
    const t = getTemplate('acme:research')!
    expect(t.config.tools).toEqual(['read'])
    expect(t.prompt.map(e => (e.kind === 'holder' ? e.name : e.kind))).toEqual([
      'research_intro',
      'agent_intro',
    ])
    expect(getHolderProse('research_intro', { type: 'acme:research' })).toBe('You are a researcher.')
  })

  it('a plugin type reuses a bundled holder by its globally-unique name', async () => {
    await registerPluginType('acme:research', [
      ['acme:research/template.md', '---\ntype: acme:research\n---\n\n## prompt\n!agent_intro\n'],
    ])
    const bundled = getHolderProse('agent_intro', { type: 'agent' })
    expect(bundled).toBeTruthy()
    expect(getHolderProse('agent_intro', { type: 'acme:research' })).toBe(bundled)
  })

  it("two plugins' holders never meet", async () => {
    await registerPluginType('acme:review', [
      ['acme:review/template.md', '---\ntype: acme:review\n---\n\n## prompt\n!intro\n'],
      ['acme:review/includes/intro.md', 'ACME'],
    ])
    await registerPluginType('beta:review', [
      ['beta:review/template.md', '---\ntype: beta:review\n---\n\n## prompt\n!intro\n'],
    ])
    expect(getHolderProse('intro', { type: 'acme:review' })).toBe('ACME')
    expect(getHolderProse('intro', { type: 'beta:review' })).toBeUndefined()
  })

  it('refuses a type without a plugin namespace, so no bundled type is replaced', async () => {
    const before = getTemplate('code')
    await expect(
      registerPluginType('code', [['code/template.md', '---\ntype: code\n---\n\n## prompt\nX\n']]),
    ).rejects.toThrow(/not a plugin template type/)
    expect(getTemplate('code')).toBe(before)
  })

  it('refuses a plugin type without template.md', async () => {
    await expect(
      registerPluginType('acme:variant', [['acme:variant/template-beta.md', '---\ntype: acme:variant\n---\n']]),
    ).rejects.toThrow(/has no template.md/)
    expect(hasTemplate('acme:variant')).toBe(false)
  })

  it('a holder file with any suffix other than -lean is rejected loudly (no silent orphan)', async () => {
    for (const bad of ['research_intro-standard.md', 'research_intro-strict.md']) {
      await expect(
        registerPluginType('acme:research', [
          ['acme:research/template.md', '---\ntype: acme:research\n---\n\n## prompt\n!research_intro\n'],
          [`acme:research/includes/${bad}`, 'X'],
        ]),
        bad,
      ).rejects.toThrow(/is not a variant suffix/)
    }
    await registerPluginType('acme:research', [
      ['acme:research/template.md', '---\ntype: acme:research\n---\n\n## prompt\n!research_intro\n'],
      ['acme:research/includes/research_intro.md', 'STANDARD'],
      ['acme:research/includes/research_intro-lean.md', 'LEAN'],
    ])
    expect(getHolderProse('research_intro', { type: 'acme:research' })).toBe('STANDARD')
    expect(getHolderProse('research_intro', { type: 'acme:research', profile: 'lean' })).toBe('LEAN')
  })

  it("a bundled type cannot borrow another type's holder", () => {
    expect(getHolderProse('agent_intro', { type: 'code' })).toBeUndefined()
  })

  it('catalog icons: only an SVG data URI is accepted as `icon`; no icon files', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+'
    const [mine, bare] = parseLauncherCatalog(`---\ntypes:\n  - type: mytype\n    icon: '${svg}'\n  - type: bare\n---\n`)
    expect(mine!.icon).toBe(svg)
    expect(bare!.icon).toBeUndefined()
    expect(bare!.iconLucide).toBeUndefined()
    const [http, png] = parseLauncherCatalog(
      "---\ntypes:\n  - type: httptype\n    icon: 'https://cdn.example/icon.svg'\n    icon_lucide: bot\n  - type: pngtype\n    icon: 'data:image/png;base64,AAAA'\n---\n",
    )
    expect(http!.icon).toBeUndefined()
    expect(http!.iconLucide).toBe('bot')
    expect(png!.icon).toBeUndefined()
  })
})

describe('templateRegistry — beta variants (index-beta.md, template-beta.md)', () => {
  afterEach(() => {
    __setTemplateChannelForTest(null)
    __resetPluginTypesForTest()
  })

  const manifest = (type: string, tools: string) =>
    `---\ntype: ${type}\ntools: [${tools}]\n---\n\n## prompt\n!agent_intro\n`

  it('buildRegistry files the -beta files apart from the plain ones', () => {
    const built = buildRegistry([
      ['index.md', '---\ntypes:\n  - type: x\n---\n'],
      ['index-beta.md', '---\ntypes:\n  - type: x\n  - type: y\n---\n'],
      ['x/template.md', manifest('x', 'read')],
      ['x/template-beta.md', manifest('x', 'read, shell')],
    ])
    expect(built.launcherCatalog.map(m => m.type)).toEqual(['x'])
    expect(built.betaLauncherCatalog?.map(m => m.type)).toEqual(['x', 'y'])
    expect(built.templates.get('x')!.config.tools).toEqual(['read'])
    expect(built.betaTemplates.get('x')!.config.tools).toEqual(['read', 'shell'])
    // `template-beta.md` is not mistaken for a welcome page or a holder.
    expect(built.welcomeByType.size).toBe(0)
    expect(built.typeHolders.size).toBe(0)
  })

  it('buildRegistry without -beta files: no beta catalog, no beta manifests', () => {
    const built = buildRegistry([
      ['index.md', '---\ntypes:\n  - type: x\n---\n'],
      ['x/template.md', manifest('x', 'read')],
    ])
    expect(built.betaLauncherCatalog).toBeNull()
    expect(built.betaTemplates.size).toBe(0)
  })

  it('the bundle ships index-beta.md: team is listed and offered on beta, absent from stable', () => {
    __setTemplateChannelForTest('stable')
    const stable = getLauncherCatalog()
    expect(stable.some(m => m.type === 'team')).toBe(false)
    __setTemplateChannelForTest('beta')
    const beta = getLauncherCatalog()
    expect(beta).not.toBe(stable)
    expect(beta.find(m => m.type === 'team')!.launcherHidden).toBeUndefined()
    expect(getTemplateTitle('team')).toBe('Team')
    expect(getTemplateIcon('team')).toEqual({ kind: 'lucide', name: 'users' })
    // Every other entry but the beta-only CLI session types is the same on both channels.
    expect(beta.filter(m => m.type !== 'team' && m.kind !== 'terminal')).toEqual(stable)
    // Not in stable's catalog ≠ not a type: the template still resolves there
    // (`?templateType=team`, an existing team session), with no catalog
    // title/icon of its own.
    __setTemplateChannelForTest('stable')
    expect(hasTemplate('team')).toBe(true)
    expect(getTemplateTitle('team')).toBe('team')
    expect(getTemplateIcon('team')).toBeUndefined()
  })

  it('the CLI session types are beta-only, kind terminal, and name their CLI (F-34)', () => {
    __setTemplateChannelForTest('beta')
    const cli = getLauncherCatalog().filter(m => m.kind === 'terminal')
    // One type per CLI the runtime runs, named `cli-<cli>`, in table order.
    expect(cli.map(m => m.cli)).toEqual([...CLI_AGENT_IDS])
    for (const m of cli) {
      expect(m.type).toBe(`cli-${m.cli}`)
      expect(m.launcherHidden).toBeUndefined()
      expect(hasTemplate(m.type)).toBe(false)
    }
    __setTemplateChannelForTest('stable')
    expect(getLauncherCatalog().some(m => m.kind === 'terminal' || m.type.startsWith('cli-'))).toBe(false)
  })

  it('getLauncherCatalog is one stable array per channel — the launcher memo keys on it', () => {
    __setTemplateChannelForTest('beta')
    expect(getLauncherCatalog()).toBe(getLauncherCatalog())
    __setTemplateChannelForTest('stable')
    expect(getLauncherCatalog()).toBe(getLauncherCatalog())
  })

  it('getTemplate prefers template-beta.md on beta and template.md on stable', async () => {
    await registerPluginType('acme:variant', [
      ['acme:variant/template.md', manifest('acme:variant', 'read')],
      ['acme:variant/template-beta.md', manifest('acme:variant', 'read, shell')],
    ])
    __setTemplateChannelForTest('stable')
    expect(getTemplate('acme:variant')!.config.tools).toEqual(['read'])
    __setTemplateChannelForTest('beta')
    expect(getTemplate('acme:variant')!.config.tools).toEqual(['read', 'shell'])
  })

  it('no bundled type ships a beta manifest; code and agent offer child sessions on both channels (F-36)', () => {
    __setTemplateChannelForTest('beta')
    // A CLI session type (`kind: terminal`, F-34) has no manifest on either channel.
    const types = getLauncherCatalog()
      .filter(m => m.kind !== 'terminal')
      .map(m => m.type)
    expect(types).toContain('code')
    expect(types).toContain('agent')
    const beta = new Map(types.map(t => [t, getTemplate(t)!]))
    __setTemplateChannelForTest('stable')
    for (const type of types) {
      expect(beta.get(type), `${type} has a bundled beta manifest`).toBe(getTemplate(type)!)
    }
    for (const type of ['code', 'agent']) {
      const stable = getTemplate(type)!
      expect(expandGroups(stable.config.tools ?? [])).toContain('SpawnSession')
      // The `child_sessions` holder follows the type's tools block and the step-list section.
      const holders = stable.prompt.filter(e => e.kind === 'holder').map(e => e.name)
      expect(holders.slice(holders.indexOf('child_sessions') - 2, holders.indexOf('child_sessions'))).toEqual([
        `${type}_using_your_tools`,
        'turn_board',
      ])
    }
    // code keeps the raw shell eager, no SuperShell.
    const eager = expandGroups(getTemplate('code')!.config.tools ?? [])
    expect(eager).toContain('Bash')
    expect(eager).not.toContain('SuperShell')
  })

  it('the child_sessions holder gates every line on a tool of the sessions group', () => {
    // Rendered only where the tool is offered: a deny rule that removes the
    // tool for a turn removes the section with it, and each proposal or
    // hand-off line goes with its own tool.
    const prose = getHolderProse('child_sessions', { type: 'code' })!
    const gates = [...expandGroups(['sessions'])].map(name => `{{IF_TOOL:${name}}}`)
    const lines = prose.split(/\r?\n/)
    for (const line of lines) {
      expect(gates.some(gate => line.startsWith(gate)), line).toBe(true)
    }
    expect(lines[0]!.startsWith('{{IF_TOOL:SpawnSession}}# Child sessions')).toBe(true)
    for (const name of ['ProposeSession', 'WithdrawProposal', 'HandOffSession']) {
      expect(prose).toContain(`{{IF_TOOL:${name}}}`)
    }
    expect(prose).toContain('# Child sessions')
    expect(prose).toContain('`SpawnSession`')
    expect(prose).toContain('`Agent`')
  })

  it('renders the child-sessions section only when SpawnSession is offered, and never as an empty part', async () => {
    __setTemplateChannelForTest('beta')
    const stub = (name: string) => ({ name }) as unknown as ToolContract
    const tools = [stub('Read'), stub('SpawnSession')] as unknown as ToolContractList
    const offered = await loadSystemPromptHolders({ tools, visibleToolNames: ['Read', 'SpawnSession'], templateType: 'code' })
    const section = offered.find(part => part.startsWith('# Child sessions'))
    expect(section).toBeDefined()
    expect(section).toContain('`SpawnSession`')
    expect(section).not.toContain('{{IF_TOOL')
    // A deny rule for the turn: the tool is in the set but not visible.
    const withheld = await loadSystemPromptHolders({ tools, visibleToolNames: ['Read'], templateType: 'code' })
    expect(withheld.some(part => part.includes('Child sessions'))).toBe(false)
    expect(withheld.some(part => part.trim() === '')).toBe(false)
    expect(withheld).toHaveLength(offered.length - 1)
  })

  it('a plugin template.md with no beta manifest replaces the beta one too', async () => {
    await registerPluginType('acme:variant', [
      ['acme:variant/template.md', manifest('acme:variant', 'read')],
      ['acme:variant/template-beta.md', manifest('acme:variant', 'read, shell')],
    ])
    await registerPluginType('acme:variant', [['acme:variant/template.md', manifest('acme:variant', 'webfetch')]])
    __setTemplateChannelForTest('beta')
    expect(getTemplate('acme:variant')!.config.tools).toEqual(['webfetch'])
  })
})

describe('templateRegistry — the `!holder @profile` gate', () => {
  const manifest = (body: string) =>
    parseManifest('t', `---\ntype: t\n---\n\n## prompt\n${body}\n\n## begin\n`)

  it('parses `@lean` / `@standard` onto the element; no gate ⇒ both profiles', () => {
    expect(manifest('!a\n!b @lean\n!c @standard\n$d').prompt).toEqual([
      { kind: 'holder', name: 'a' },
      { kind: 'holder', name: 'b', profile: 'lean' },
      { kind: 'holder', name: 'c', profile: 'standard' },
      { kind: 'dynamic', name: 'd' },
    ])
  })

  it('rejects an unknown gate loudly instead of emitting under both profiles', () => {
    expect(() => manifest('!a @anthropic')).toThrow(/profile gate must be @lean or @standard/)
    expect(() => manifest('!a @Lean')).toThrow(/profile gate/)
  })

  it('one holder may be listed once per profile, at different positions', () => {
    const forProfile = (profile: 'lean' | 'standard') =>
      manifest('!x @standard\n!y\n!x @lean')
        .prompt.filter(e => e.kind === 'holder' && (e.profile ?? profile) === profile)
        .map(e => ('name' in e ? e.name : e.text))
    expect(forProfile('standard')).toEqual(['x', 'y'])
    expect(forProfile('lean')).toEqual(['y', 'x'])
  })

  it('parses a `=<profile>` render pin — with or without a gate', () => {
    // The pin says WHICH rendering; the gate says WHEN. Independent tokens,
    // any order.
    expect(manifest('!a =standard\n!b @lean =standard\n!c =lean @standard').prompt).toEqual([
      { kind: 'holder', name: 'a', render: 'standard' },
      { kind: 'holder', name: 'b', profile: 'lean', render: 'standard' },
      { kind: 'holder', name: 'c', profile: 'standard', render: 'lean' },
    ])
  })

  it('rejects an unknown render pin loudly instead of rendering per turn', () => {
    expect(() => manifest('!a =full')).toThrow(/render pin must be =lean or =standard/)
    expect(() => manifest('!a =Standard')).toThrow(/render pin/)
  })

  it('agent pins the shared care holder to its standard rendering', () => {
    // `agent` drives the browser: the confirm-before list must survive the
    // lean profile, and `agent_autonomy` refers back to it as "the rules
    // above". `code` keeps the lean caution instead (no pin).
    const care = (type: string) =>
      getTemplate(type)!.prompt.find(
        e => e.kind === 'holder' && e.name === 'executing_with_care',
      )
    expect(care('agent')).toEqual({
      kind: 'holder',
      name: 'executing_with_care',
      render: 'standard',
    })
    expect(care('code')).not.toHaveProperty('render')
  })
})

describe('templateRegistry — tool resolution helpers', () => {
  it('resolveDeferrableSkills: the template deferredTools is the SOLE source (groups + skills)', () => {
    // TEMPLATE-ONLY: the hosted manifest is not even consulted (no param). chat
    // lists [browser, a2ui]; a SKILL unit carries no toolNames. MCP servers
    // always defer. (Group units: next test.)
    const result = resolveDeferrableSkills(['mcp__x'], getTemplate('chat')!.config)
    expect(result.map(u => u.name)).toEqual(['browser', 'a2ui', 'mcp__x'])
    expect(result.every(u => u.defaultDeferred)).toBe(true)
    expect(result.find(u => u.name === 'browser')!.toolNames).toBeUndefined()
  })

  it('resolveDeferrableSkills: ONLY template-listed units defer (groups + skills)', () => {
    expect(
      resolveDeferrableSkills([], { type: 'x', deferredTools: ['browser', 'shell'] }),
    ).toEqual([
      { name: 'browser', defaultDeferred: true },
      { name: 'shell', defaultDeferred: true, toolNames: TOOL_GROUPS.shell },
    ])
  })

  it('resolveDeferrableSkills: no template ⇒ nothing defers (template is the sole source)', () => {
    expect(resolveDeferrableSkills([], undefined)).toEqual([])
  })

  it('applyTemplateToolAllowlist filters by name; alwaysKeep bypasses; no list = full set', () => {
    const tools: Array<{ name: string; hostedCatalog?: boolean }> = [
      { name: 'TodoWrite' },
      { name: 'BrowserClick', hostedCatalog: true },
      { name: 'Bash', hostedCatalog: true },
    ]
    // Allowlist names only TodoWrite, but hosted tools bypass via alwaysKeep.
    expect(
      applyTemplateToolAllowlist(tools, { type: 'x', tools: ['TodoWrite'] }, t => t.hostedCatalog === true),
    ).toEqual(tools)
    // Without alwaysKeep, only the named tool survives.
    expect(
      applyTemplateToolAllowlist(tools, { type: 'x', tools: ['TodoWrite'] }),
    ).toEqual([{ name: 'TodoWrite' }])
    // No allowlist (absent / empty / undefined config) ⇒ full set.
    expect(applyTemplateToolAllowlist(tools, { type: 'x' })).toEqual(tools)
    expect(applyTemplateToolAllowlist(tools, { type: 'x', tools: [] })).toEqual(tools)
    expect(applyTemplateToolAllowlist(tools, undefined)).toEqual(tools)

    // The createBrowserRuntime pattern: a deferred skill's tool loads via the
    // alwaysKeep (its `skill` ∈ deferredTools) even when `tools:` omits it —
    // so a template's `tools:` need not (and now does not) list deferred tools.
    const withSkill: Array<{ name: string; skill?: string }> = [
      { name: 'TodoWrite' },
      { name: 'a2ui_create_surface', skill: 'a2ui' },
    ]
    const deferredSkills = new Set(['a2ui'])
    expect(
      applyTemplateToolAllowlist(
        withSkill,
        { type: 'x', tools: ['TodoWrite'] },
        t => typeof t.skill === 'string' && deferredSkills.has(t.skill),
      ),
    ).toEqual(withSkill) // TodoWrite via tools:, a2ui_create_surface via the deferred-skill alwaysKeep
  })

  it('every default-preset tool is covered by the `agent` template — in `tools:` OR a deferred skill (drift guard)', () => {
    // `agent` is the FULL set (the default), so every default-preset tool must
    // either be named in its `tools:` (eager-visible) OR belong to a skill or
    // tool group in `deferredTools` (loads implicitly, hidden until activated) — else the
    // allowlist would silently drop it. `tools:` entries are GROUP names, so
    // expand them. (Browser is a deferred skill → covered by the deferredTools
    // branch.) The narrower types (chat/code) INTENTIONALLY exclude
    // groups, so the full-coverage guard targets `agent`.
    const cfg = getTemplate('agent')!.config
    const eagerTools = expandGroups(cfg.tools ?? [])
    const deferred = new Set(cfg.deferredTools ?? [])
    // Absent from `agent` on purpose: `exec` (subsumed by agent's real Bash), `SuperEdit` (agent edits through hosted
    // Write/Edit), `SuperShell` (registered only by a manifest listing `supershell`; none is bundled), and
    // `ContinueInCode` (a chat's offer to move into a Code session; meaningless elsewhere).
    // `SendMessage` is in the `sessions` group as well as the deferred `agent-teams`
    // skill: the listed group loads it from the first request (F-36).
    const agentExempt = new Set(['Exec', 'SuperEdit', 'SuperShell', 'ContinueInCode', 'SendMessage'])
    for (const tool of allBundledTools('default')) {
      if (agentExempt.has(tool.name)) continue
      const isDeferredSkillTool =
        (typeof tool.skill === 'string' && deferred.has(tool.skill)) ||
        [...deferred].some(unit => (TOOL_GROUPS as Record<string, readonly string[]>)[unit]?.includes(tool.name) === true)
      expect(
        eagerTools.has(tool.name) || isDeferredSkillTool,
        `default-preset tool "${tool.name}" is neither in agent tools: nor a deferred skill`,
      ).toBe(true)
      // New-model invariant: a deferred skill's tools are NOT listed in tools:
      // (they load from deferredTools, keeping tools: == the visible set).
      if (isDeferredSkillTool) {
        expect(
          eagerTools.has(tool.name),
          `deferred-skill tool "${tool.name}" must NOT be in tools:`,
        ).toBe(false)
      }
    }
  })
})
