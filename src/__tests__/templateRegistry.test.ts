// Validates the per-session agent-template bundle: Vite `import.meta.glob`
// loads `src/template/**/*.md`, the chat manifest parses (frontmatter +
// `## prompt`/`## begin` skeletons with `!holder` / `$dynamic` classification),
// and shared-holder prose is retrievable by name.

import { afterEach, describe, expect, it } from 'vitest'
import type { PromptProfile } from '../prompting/promptProfile'
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
import { BROWSER_SYSTEM_PROMPT_CATALOG } from '../toolkit/builtin/glic/browserSkillCatalog'
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
    expect(deferredOf('agent')).toEqual(['a2ui', 'agent-teams'])
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
    expect(deferredOf('code')).toEqual(['browser', 'schedule', 'a2ui', 'agent-teams'])
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

  it('no bundled type ships a beta manifest: beta serves every template.md as-is', () => {
    // The code/template-beta.md SuperShell trial was retired (SuperShell itself
    // stays registered-capable for any manifest that lists `supershell`), so
    // every bundled type — code included — resolves to the SAME manifest on
    // both channels. Adding a bundled template-beta.md again is deliberate:
    // update this test, and add its -beta goldens and e2e cases.
    __setTemplateChannelForTest('beta')
    // A CLI session type (`kind: terminal`, F-34) has no manifest on either channel.
    const types = getLauncherCatalog()
      .filter(m => m.kind !== 'terminal')
      .map(m => m.type)
    expect(types).toContain('code')
    const beta = new Map(types.map(t => [t, getTemplate(t)]))
    __setTemplateChannelForTest('stable')
    for (const type of types) {
      expect(beta.get(type), `${type} on beta`).toBeDefined()
      expect(beta.get(type), `${type} has a bundled beta manifest`).toBe(getTemplate(type))
    }
    // code on beta is stable's: the raw shell eager, no SuperShell, stable's
    // tool block.
    const code = beta.get('code')!
    const eager = expandGroups(code.config.tools ?? [])
    expect(eager).toContain('Bash')
    expect(eager).not.toContain('SuperShell')
    expect(code.config.sealedTools ?? []).toEqual([])
    const holders = code.prompt.filter(e => e.kind === 'holder').map(e => e.name)
    expect(holders).toContain('code_using_your_tools')
    expect(holders).not.toContain('code_supershell_tools')
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

describe('templateRegistry — holder prose', () => {
  it('returns trimmed holder prose (with inline placeholders intact)', () => {
    // The two inline placeholders: {{AGENT_NAME}} in agent_intro,
    // {{system-prompt-tools}} in the doing-tasks block.
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('{{AGENT_NAME}}')
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain(
      '{{system-prompt-tools}}',
    )
    // The FINAL REMINDER line is the tail of agent's voice holder (it always
    // sat directly after it) — no holder of its own.
    expect(getHolderProse('agent_tone_and_style', { type: 'agent' })).toMatch(
      /\nFINAL REMINDER:[^\n]*$/,
    )
    expect(getHolderProse('agent_final_reminder', { type: 'agent' })).toBeUndefined()
    // Trimmed: no trailing newline that would double the `\n\n` join.
    expect(getHolderProse('agent_tone_and_style', { type: 'agent' })).not.toMatch(/\n$/)
    // delivering_work (code + safe_code + agent) stays SHARED; the retired
    // thinking_mode resolves to nothing anywhere.
    expect(getHolderProse('delivering_work')).toBeTruthy()
    expect(getHolderProse('thinking_mode')).toBeUndefined()
    expect(getHolderProse('thinking_mode', { type: 'agent' })).toBeUndefined()
  })

  it('every type owns its `# Tools` block as per-type prose', () => {
    // The block used to be host-rendered: the loader swapped `!using_your_tools`
    // for `{ h: 'using-your-tools', args }` and the C++ renderer composed it from
    // `tool-catalog-frame.json`, gating sub-sections on the visible tool set.
    // That shared block could not tell the truth for every type — it told
    // `code` and `safe_code` to "use Edit/Write for file changes" and to
    // "reserve Bash/PowerShell", none of which those types register. Each type
    // now carries its own prose instead, so this asserts the block exists per
    // type and names only tools that type actually has.
    for (const type of ['agent', 'chat', 'code', 'safe_code']) {
      const prose = getHolderProse(`${type}_using_your_tools`, { type })
      expect(prose, `${type} must define its own using-your-tools block`).toBeTruthy()
      expect(prose).toContain('# Tools')
    }
    // The bare name is nobody's holder any more — no shared file, and the
    // loader no longer intercepts it.
    expect(getHolderProse('using_your_tools')).toBeUndefined()

    const proseOf = (type: string): string =>
      getHolderProse(`${type}_using_your_tools`, { type })!
    const eagerOf = (type: string): Set<string> =>
      expandGroups(getTemplate(type)!.config.tools ?? [])

    // The bug the migration fixes: a type with no `edit` group must not be told
    // to use Write/Edit, and a type with no `shell` group must not be told to
    // reserve Bash/PowerShell.
    for (const type of ['code', 'safe_code']) {
      const prose = proseOf(type)
      expect(eagerOf(type), `${type} has no edit group`).not.toContain('Write')
      expect(prose, `${type} must not advertise Write`).not.toMatch(/\bWrite\b/)
      expect(prose, `${type} must not advertise Edit`).not.toMatch(/\bEdit\b/)
      expect(prose, `${type} mutates via SuperEdit`).toContain('SuperEdit')
    }
    // safe_code has no shell, no Skill and no TodoWrite — none may be named.
    const safeCode = proseOf('safe_code')
    for (const absent of ['Bash', 'PowerShell', 'TodoWrite', 'Skill']) {
      expect(safeCode, `safe_code must not name ${absent}`).not.toContain(absent)
    }
    // NO type inlines the browser catalog. It is activation-gated prose — `chat`
    // and `code` defer the browser skill, so the section must appear only after
    // Skill('browser') — which static template text cannot express. It lives on
    // the JS skill-catalog seam instead (toolkit/builtin/glic/browserSkillCatalog.ts,
    // emitted via `$skill_catalogs`), so a copy sitting in a template would be
    // a second, ungated source of the same 89 lines.
    for (const type of ['agent', 'chat', 'code', 'safe_code']) {
      expect(
        proseOf(type),
        `${type} must not inline the browser catalog`,
      ).not.toContain('## Browser tools')
    }
    // Only the types that actually register TodoWrite / Skill may name them.
    for (const type of ['agent', 'code']) {
      expect(proseOf(type), `${type} has TodoWrite`).toContain('TodoWrite')
    }
    expect(proseOf('chat'), 'chat has no todo group').not.toContain('TodoWrite')
    // chat defers `shell`, so its prose must not lean on a shell that is absent
    // at cold start (it must not describe a tool the model cannot see).
    for (const absent of ['Bash', 'PowerShell']) {
      expect(proseOf('chat'), `chat defers shell — no ${absent}`).not.toContain(absent)
    }
  })
})

describe('code template — coding prompt skeleton and holders', () => {
  // The `code` type's coding prompt comes from per-type holder overrides in
  // src/template/code/includes/*.md. These assertions fail if the overrides
  // are missing (getHolderProse would fall back to the shared
  // browser-flavored holders) or if the skeleton's section order drifts.

  it('skeleton: static sections first, no final_reminder', () => {
    expect(getTemplate('code')!.prompt).toEqual([
      // Type-specific holders carry a `code_` prefix (globally-unique registry
      // name → no collision/shadowing with the shared holders).
      { kind: 'holder', name: 'code_intro' },
      // The shared harness block: `# How this session works` / `# Harness`.
      { kind: 'holder', name: 'system' },
      // The lean profile has no `# Approach to tasks` — gated to standard.
      { kind: 'holder', name: 'code_doing_tasks', profile: 'standard' },
      // Shared caution. Standard: `# Acting carefully` right
      // after `# Approach to tasks`. Lean: the one-paragraph version, further down
      // (after `!pronouns`) — the same holder, listed once per profile.
      { kind: 'holder', name: 'executing_with_care', profile: 'standard' },
      { kind: 'holder', name: 'code_using_your_tools' },
      // Shared, and `@standard` only: the lean `# Harness` block already
      // says independent tool calls can run in parallel.
      { kind: 'holder', name: 'tool_call_parallelism', profile: 'standard' },
      { kind: 'holder', name: 'code_tone_and_style' },
      // Shared they/them paragraph (was the tail of code_tone_and_style).
      { kind: 'holder', name: 'pronouns' },
      { kind: 'holder', name: 'executing_with_care', profile: 'lean' },
      { kind: 'holder', name: 'delivering_work' },
      // The autonomy block, carried for EVERY provider — shared with
      // safe_code — plus code's own run-a-command paragraph.
      { kind: 'holder', name: 'autonomy' },
      { kind: 'holder', name: 'code_autonomy' },
      { kind: 'dynamic', name: 'skill_catalogs' },
      { kind: 'dynamic', name: 'mcp_servers' },
      { kind: 'dynamic', name: 'session_guidance' },
      { kind: 'dynamic', name: 'environment' },
      { kind: 'dynamic', name: 'memory' },
    ])
    // The code prompt has no final_reminder section.
    const names = getTemplate('code')!.prompt.map(e =>
      'name' in e ? e.name : e.text,
    )
    expect(names).not.toContain('final_reminder')
  })

  it('type-specific holders carry the coding prose, not the shared browser prose', () => {
    const code = (name: string): string => getHolderProse(name, { type: 'code' })!

    // The coding sections now span three holders: `code_intro` (identity
    // + cyber-risk + the URL rule), the SHARED `system`, and
    // `code_doing_tasks` (`# Approach to tasks` + `# Acting carefully`).
    // Together they carry every coding section and none of the browser prose.
    const intro = code('code_intro')
    // intro section: software-engineering framing; nexus branding retained.
    expect(intro).toContain('software engineering work')
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).not.toContain('browser agent running inside')
    // The sections moved OUT of the intro holder.
    expect(intro).not.toContain('# How this session works')
    expect(intro).not.toContain('# Approach to tasks')
    // system section (SHARED): the CommonMark and hooks bullets. The browser
    // credential bullet is NOT shared semantics — it stays with `agent`.
    const system = code('system')
    expect(system).toMatch(/^# How this session works\n/)
    expect(system).toContain('it is rendered as CommonMark')
    expect(system).toContain('Users can set up hooks')
    expect(system).not.toContain('Never carry sensitive data')
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain(
      'Never carry sensitive data',
    )
    // Velloc's guest renders output in a sans font (styles/globals.css), not
    // monospace, and this block now fronts `chat` too.
    expect(system).not.toContain('monospace')
    // doing_tasks section: coding guidance; no browser placeholder / obstacles.
    const doing = code('code_doing_tasks')
    expect(doing).toMatch(/^# Approach to tasks\n/)
    expect(doing).toContain('OWASP top 10')
    expect(doing).not.toContain('cookie banners')
    expect(doing).not.toContain('{{system-prompt-tools}}')
    // doing_tasks also carries exploratory-question brevity, the
    // UI-verification rule, and the reworked git-safety prose.
    expect(doing).toContain('For exploratory questions')
    expect(doing).toContain('For UI or front-end changes, start the dev server')
    // The git-safety prose lives with the caution section, now shared.
    expect(code('executing_with_care')).toContain(
      'run `git status` before any command that could discard uncommitted work',
    )

    // `code_tone_and_style` = tone_and_style + output_efficiency: coding
    // phrasing, not tab-centric.
    const style = code('code_tone_and_style')
    expect(style).toContain('Your responses should be short and to the point')
    expect(style).not.toContain('background-tab')
    // `# Text output` replaced `# Brevity`.
    expect(style).toContain('# Writing for the user (not tool calls)')
    expect(style).not.toContain('# Brevity')
    expect(style).not.toContain('multiple tabs')
  })

  it('code and agent own DISTINCT, prefixed intros — no bare shared `intro`, no cross-leak', () => {
    // The browser-flavored prose now lives in agent_intro (moved out of
    // shared_includes/); the coding prose in code_intro. Distinct globally-
    // unique names → the type-blind C++ registry can't confuse them.
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain(
      '{{system-prompt-tools}}',
    )
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('browser agent running inside')
    expect(getHolderProse('agent_doing_tasks', { type: 'agent' })).toContain('cookie banners')
    expect(getHolderProse('code_intro', { type: 'code' })).toContain('software engineering work')
    // No bare shared `intro` remains, under any type.
    expect(getHolderProse('intro')).toBeUndefined()
    expect(getHolderProse('intro', { type: 'chat' })).toBeUndefined()
    expect(getHolderProse('intro', { type: 'code' })).toBeUndefined()
    // A type can't borrow another type's prefixed holder.
    expect(getHolderProse('agent_intro', { type: 'code' })).toBeUndefined()
    expect(getHolderProse('code_intro', { type: 'agent' })).toBeUndefined()
  })
})

describe('code template — prompt profiles (lean vs standard)', () => {
  // The code prompt has two PROFILES: the LEAN `# Harness` prompt, rendered
  // only for catalog rows that declare `promptProfile: 'lean'`, and the
  // STANDARD sections for everything else. `code_*-lean.md` = lean, the base
  // files = standard. The loader passes the per-turn `promptProfile`, so
  // `getHolderProse` with `profile: 'lean'` must pick the variant and
  // `'standard'` (or no profile) must fall back to the base file.
  const base = (name: string, profile?: PromptProfile): string | undefined =>
    getHolderProse(name, profile ? { type: 'code', profile } : { type: 'code' })

  it('standard (or no profile): the static sections', () => {
    for (const profile of [undefined, 'standard'] as const) {
      // The static sections span three holders since the `# How this session works` block
      // became shared: intro (identity) → `system` → `code_doing_tasks`.
      expect(base('code_intro', profile), `profile=${profile}`).not.toContain('# ')
      expect(base('system', profile)).toContain('# How this session works')
      expect(base('system', profile)).not.toContain('# Harness')
      const doing = base('code_doing_tasks', profile)!
      expect(doing).toContain('# Approach to tasks')
      // The caution is its own SHARED holder, carrying the union of the
      // examples `code` and `agent` used to list separately.
      expect(doing).not.toContain('# Acting carefully')
      const care = base('executing_with_care', profile)!
      expect(care).toMatch(/^# Acting carefully\n/)
      expect(care).toContain('measure twice, cut once')
      expect(care).toContain('Submitting a form that makes a payment')
      const tools = base('code_using_your_tools', profile)!
      expect(tools).toContain('over Bash or PowerShell when one fits')
      expect(tools).toContain('SuperEdit')
      expect(tools).toContain('Plan and track work with TodoWrite')
      // The parallel-tool-call paragraph is SHARED — one file, four types.
      expect(tools).not.toContain('You can make several tool calls in one response')
      expect(base('tool_call_parallelism', profile)).toContain(
        'You can make several tool calls in one response',
      )
      // The `/<skill-name>` bullet moved to the `# Subagents and skills` section.
      expect(tools).not.toContain('/<skill-name>')
      const style = base('code_tone_and_style', profile)!
      expect(style).toContain('# Style')
      expect(style).toContain('# Writing for the user (not tool calls)')
      expect(style).not.toContain('use they/them') // → shared `pronouns`
      expect(style).not.toMatch(/^# Writing for the user$/m)
      expect(base('pronouns', profile)).toContain('use they/them')
      // The autonomy block is profile-INDEPENDENT: Velloc carries it for
      // every model.
      expect(base('autonomy', profile)).toContain('Before you end a turn, reread your final paragraph')
      expect(base('code_autonomy', profile)).toContain('Before a command that changes system state')
    }
  })

  it('the beta tool block names SuperShell, never the sealed Bash/PowerShell', () => {
    // `code_supershell_tools` is the tool block for a code manifest that seals
    // the raw shell and lists `supershell` in place of `code_using_your_tools`
    // (no bundled manifest names it today — the beta trial was retired, the
    // prose kept). It must send the model to SuperShell and never promise a
    // direct Bash/PowerShell tool the sealed group hides.
    for (const profile of [undefined, 'standard', 'lean'] as const) {
      const prose = getHolderProse('code_supershell_tools', { type: 'code', profile })!
      expect(prose).toBeTruthy()
      expect(prose).toContain('# Tools')
      expect(prose).toContain('SuperShell')
      expect(prose).toContain('there is no separate Bash or PowerShell tool')
      expect(prose).toContain('SuperEdit')
    }
    // Standard carries the full guidance; lean drops the lead-in line.
    const std = getHolderProse('code_supershell_tools', { type: 'code', profile: 'standard' })!
    expect(std).toContain('over SuperShell when one fits')
    expect(std).toContain('Plan and track work with TodoWrite')
    const lean = getHolderProse('code_supershell_tools', { type: 'code', profile: 'lean' })!
    expect(lean).not.toContain('Prefer dedicated tools over SuperShell')
    expect(lean).not.toContain('TodoWrite')
  })

  it('a holder with no -lean file renders its base prose under the lean profile too', () => {
    // Only three code holders carry a `-lean.md`; every other holder must
    // fall back to its base file rather than vanish from the lean prompt.
    expect(base('code_autonomy', 'lean')).toBe(base('code_autonomy', 'standard'))
    expect(getHolderProse('delivering_work', { type: 'code', profile: 'lean' })).toBe(
      getHolderProse('delivering_work', { type: 'code' }),
    )
  })

  it('safe_code shares the autonomy block and skips the run-a-command paragraph; agent merges its two new rules', () => {
    // One SHARED `autonomy` holder (shared_includes/) for code + safe_code;
    // the run-a-command paragraph is code's own `code_autonomy` tail.
    const safe = getHolderProse('autonomy', { type: 'safe_code' })!
    expect(safe).toContain('You are working unattended')
    expect(safe).toContain('Before you end a turn, reread your final paragraph')
    expect(safe).toContain('A long context or session is no reason to stop')
    // SafeCode never runs a command — that paragraph would contradict its boundary.
    expect(safe).not.toContain('Before a command that changes system state')
    expect(getHolderProse('safe_code_autonomy', { type: 'safe_code' })).toBeUndefined()
    expect(getHolderProse('code_autonomy', { type: 'safe_code' })).toBeUndefined()
    const code = getHolderProse('code_autonomy', { type: 'code' })!
    expect(code).toContain('Before a command that changes system state')
    expect(code).not.toContain('You are working unattended')
    // Skeleton: right after delivering_work, same slot as `code`; safe_code
    // ends its holders there.
    const names = getTemplate('safe_code')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names.indexOf('autonomy')).toBe(names.indexOf('delivering_work') + 1)
    expect(names).not.toContain('code_autonomy')
    // agent keeps its own `# Autonomy` holder (browser-flavored) and gains only
    // its two new rules — not the "user is not watching" paragraph,
    // which is wrong for a browser session that must pause on login walls.
    const agent = getHolderProse('agent_autonomy', { type: 'agent' })!
    expect(agent).toContain('Before you end a turn, reread your final paragraph')
    expect(agent).toContain('your assessment is the deliverable')
    expect(agent).not.toContain('The user is not watching in real time')
    expect(getHolderProse('agent_autonomy', { type: 'code' })).toBeUndefined()
  })

  it('lean: Harness + Communicating with the user + action caution + autonomy', () => {
    const intro = base('code_intro', 'lean')!
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).toContain('Help with authorized security testing')
    // The lean intro carries no section of its own …
    expect(intro).not.toContain('# ')
    // … `# Harness` is the SHARED system holder's lean rendering, and every
    // type that references `!system` gets it.
    const harness = base('system', 'lean')!
    expect(harness).toMatch(/^# Harness\n/)
    expect(harness).toContain('Mid-conversation system turns')
    expect(harness).not.toContain('# How this session works')
    expect(base('system', 'standard')).toMatch(/^# How this session works\n/)
    // The lean profile has no `# Approach to tasks`: the holder is gated to standard.
    expect(
      getTemplate('code')!.prompt.find(
        e => e.kind === 'holder' && e.name === 'code_doing_tasks',
      ),
    ).toEqual({ kind: 'holder', name: 'code_doing_tasks', profile: 'standard' })
    // Lean has no tool block; only the Nexus SuperEdit bullet is kept.
    const tools = base('code_using_your_tools', 'lean')!
    expect(tools).toContain('SuperEdit')
    expect(tools).not.toContain('Prefer dedicated tools over Bash')
    expect(tools).not.toContain('TodoWrite')
    const style = base('code_tone_and_style', 'lean')!
    expect(style).toContain('# Writing for the user')
    expect(style).toContain('Open with the outcome')
    expect(style).not.toContain('use they/them') // → shared `pronouns`
    expect(style).not.toContain('Report results truthfully') // → lean-only caution
    expect(style).not.toContain('# Style')
    expect(style).not.toContain('# Writing for the user (not tool calls)')
    expect(base('pronouns', 'lean')).toContain('use they/them')
    const care = base('executing_with_care', 'lean')!
    expect(care).toContain('Before an action that is hard to undo or that others will see, get confirmation')
    expect(care).toContain('Report results as they are')
    // The lean rendering is the short paragraph, not the standard section.
    expect(care).not.toContain('# Acting carefully')
    const autonomy = base('autonomy', 'lean')!
    expect(autonomy).toContain('You are working unattended')
    expect(autonomy).toContain('Before you end a turn, reread your final paragraph')
    expect(autonomy).toContain('A long context or session is no reason to stop')
  })

  it('the autonomy holders sit right after delivering_work in the skeleton', () => {
    const names = getTemplate('code')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names.indexOf('autonomy')).toBe(names.indexOf('delivering_work') + 1)
    expect(names.indexOf('code_autonomy')).toBe(names.indexOf('autonomy') + 1)
  })

  it('agent: the tool block is the short form + the Nexus lines', () => {
    const tools = getHolderProse('agent_using_your_tools', { type: 'agent' })!
    expect(tools).toContain('Prefer the dedicated tools (Read, Edit, Write, Glob, Grep) over Bash or PowerShell when one fits')
    expect(tools).toContain('Read a file with the Read tool before you edit or overwrite it')
    expect(tools).toContain('Edit and Write each change one file per call')
    // `agent` never registers the `superedit` group, so its tool block must not
    // send the model to a tool the session cannot call. This block used to say
    // "use SuperEdit instead"; keep that regression pinned here, where the
    // agent tool block is pinned.
    expect(tools).not.toContain('SuperEdit')
    expect(tools).toContain('Plan and track work with TodoWrite')
    expect(tools).not.toContain('Do NOT use the Bash or PowerShell tool')
    // The browser one-call-per-turn rule is NOT in the prompt body any more:
    // it follows the browser CAPABILITY, in the skill catalog, so `code` and
    // `chat` get it when they activate the skill. No type inlines
    // it, and `agent` no longer carries a holder for it.
    expect(tools).not.toContain('browser tool per assistant turn')
    expect(getHolderProse('agent_browser_tool_calls', { type: 'agent' })).toBeUndefined()
    const names = getTemplate('agent')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).not.toContain('agent_browser_tool_calls')
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain('One browser tool call per turn')
    expect(BROWSER_SYSTEM_PROMPT_CATALOG).toContain(
      'Combining one browser tool with a non-browser tool',
    )
    expect(tools).not.toContain('/<skill-name>')
  })
})

describe('shared delivering_work holder — persistence guidance', () => {
  // The static block closes with three sections: `# Long conversations`
  // ("you don't need to wrap up early"), `# Delivering work` ("finish the
  // whole task … report completion only when fully done") and `# Correcting yourself`.
  // Without them a session does one short step and hands back. The prose is a
  // SHARED holder (shared_includes/delivering_work.md) so the three
  // task-running types carry one identical persistence contract.

  it('resolves as SHARED prose under every type, carrying the three sections', () => {
    for (const type of [undefined, 'code', 'safe_code', 'agent', 'chat']) {
      const prose = getHolderProse('delivering_work', type ? { type } : {})!
      expect(prose, `type=${type}`).toBeTruthy()
      expect(prose).toContain('# Long conversations')
      expect(prose).toContain('There is no need to wrap up early or hand off halfway')
      expect(prose).toContain('Once you know enough to act, act.')
      expect(prose).toContain('# Delivering work')
      expect(prose).toContain('Finish all of it, not just the easy parts')
      expect(prose).toContain('call it done only when it is')
      expect(prose).toContain('# Correcting yourself')
      // Trimmed: no trailing newline that would double the join.
      expect(prose).not.toMatch(/\n$/)
    }
  })

  it('code, safe_code and agent carry it in the static block; chat does not', () => {
    const names = (type: string): string[] =>
      getTemplate(type)!.prompt.map(e => ('name' in e ? e.name : e.text))
    // code: after the tone block (+ pronouns + the LEAN caution slot — the
    // last of the two `executing_with_care` lines), ahead of $skill_catalogs.
    expect(names('code').indexOf('delivering_work')).toBe(
      names('code').lastIndexOf('executing_with_care') + 1,
    )
    expect(names('code').indexOf('delivering_work')).toBeLessThan(
      names('code').indexOf('skill_catalogs'),
    )
    // safe_code: after its tool block (+ the shared parallelism paragraph),
    // ahead of $environment.
    expect(names('safe_code').indexOf('delivering_work')).toBe(
      names('safe_code').indexOf('tool_call_parallelism') + 1,
    )
    // agent: right after agent_autonomy, which it reinforces.
    expect(names('agent').indexOf('delivering_work')).toBe(
      names('agent').indexOf('agent_autonomy') + 1,
    )
    // chat is the conversational type — no task-persistence contract.
    expect(names('chat')).not.toContain('delivering_work')
  })
})

describe('chat + agent templates — per-type prose divergence', () => {
  // chat adopts a warm CONVERSATIONAL voice (gpt5-style); agent keeps the
  // shared browser-agent voice and ADDS an autonomy emphasis (chatgpt-agent-
  // style). Both use globally-unique `<type>_*` holder names so the type-blind
  // C++ registry can't confuse them with the shared holders.

  it('chat: chat_intro is a conversational assistant, not the browser/coding agent', () => {
    const intro = getHolderProse('chat_intro', { type: 'chat' })!
    expect(intro).toContain('{{AGENT_NAME}}')
    expect(intro).toContain('conversational assistant')
    // Not the shared browser intro, nor the code intro.
    expect(intro).not.toContain('browser agent running inside')
    expect(intro).not.toContain('software engineering')
    // Light type: no agent tool-list placeholder folded in.
    expect(intro).not.toContain('{{system-prompt-tools}}')
  })

  it('chat: personality forbids hedging closers; tone is conversational, not terse', () => {
    // `# Personality` is the head of chat's voice holder.
    const style = getHolderProse('chat_tone_and_style', { type: 'chat' })!
    expect(style).toContain('# Personality')
    expect(style).toContain('Would you like me to') // names the closer it bans
    expect(getHolderProse('chat_personality', { type: 'chat' })).toBeUndefined()
    expect(style).toContain('# Style')
    expect(style).toContain('# Brevity')
    // NOT the agent's terse "1-2 lines" status-report framing.
    expect(style).not.toContain('1-2 lines')
  })

  it('chat skeleton uses the chat_* holders and drops final_reminder', () => {
    const names = getTemplate('chat')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).toContain('chat_intro')
    expect(names).toContain('chat_tone_and_style')
    expect(names).not.toContain('chat_personality')
    expect(names).not.toContain('final_reminder')
    // chat uses chat_intro — no bare `intro` in its skeleton.
    expect(names).not.toContain('intro')
  })

  it('agent: browser intro (agent_intro) + agent_autonomy inserted right after it', () => {
    const names = getTemplate('agent')!.prompt.map(e => ('name' in e ? e.name : e.text))
    expect(names).toContain('agent_intro') // browser-agent intro (moved from shared)
    expect(names).toContain('agent_autonomy')
    // intro → shared system → doing_tasks → autonomy (whose "executing
    // actions with care" back-reference resolves to agent_doing_tasks).
    expect(names.indexOf('system')).toBe(names.indexOf('agent_intro') + 1)
    expect(names.indexOf('agent_doing_tasks')).toBe(names.indexOf('system') + 1)
    // The shared caution sits between them: agent's autonomy block
    // back-references "the executing actions with care rules above".
    expect(names.indexOf('executing_with_care')).toBe(names.indexOf('agent_doing_tasks') + 1)
    expect(names.indexOf('agent_autonomy')).toBe(names.indexOf('executing_with_care') + 1)
    // Autonomy prose carries the chatgpt-agent emphasis + the care back-ref
    // (which resolves to the section folded into agent_intro above it).
    const autonomy = getHolderProse('agent_autonomy', { type: 'agent' })!
    expect(autonomy).toContain('Autonomy')
    expect(autonomy).toMatch(/get as far as you can/i)
    expect(autonomy).toContain('"Acting carefully" above')
    // agent_intro carries the browser-agent prose.
    expect(getHolderProse('agent_intro', { type: 'agent' })).toContain('browser agent running inside')
  })

  it('per-type prose is scoped to its type (distinct names, no cross-leak)', () => {
    // chat_* holders register only under type 'chat'; resolving under another
    // type (or with no type) finds no shared fallback → undefined.
    expect(getHolderProse('chat_intro', { type: 'agent' })).toBeUndefined()
    expect(getHolderProse('agent_autonomy', { type: 'chat' })).toBeUndefined()
    expect(getHolderProse('chat_tone_and_style')).toBeUndefined()
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
    // either be named in its `tools:` (eager-visible) OR belong to a skill in
    // `deferredTools` (loads implicitly, hidden until activated) — else the
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
    const agentExempt = new Set(['Exec', 'SuperEdit', 'SuperShell', 'ContinueInCode'])
    for (const tool of allBundledTools('default')) {
      if (agentExempt.has(tool.name)) continue
      const isDeferredSkillTool =
        typeof tool.skill === 'string' && deferred.has(tool.skill)
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
