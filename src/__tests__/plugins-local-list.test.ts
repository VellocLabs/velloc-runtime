/**
 * `plugins/listLocal` — the directory plugins on disk for Settings → Plugins
 * & Mods, root by root: the user root, then each sidebar project's. Read off
 * the folders and each root's `enabled-plugins.json`, so a plugin switched
 * off (which no session loads, so `mods/state` never names it) keeps its row
 * and its switch.
 */
import { describe, expect, it } from 'vitest'

import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { pluginsHandlers } from '../browser/bridge/adapter/pluginsBridgeAdapter'
import { WORKSPACE_STATE_FILE } from '../browser/runtimeHub/workspaceCapability'
import { LEGACY_WEBUI_CAPABILITIES } from '../browser/runtimeHub/legacyWebUiCapabilities'
import { listLocalPlugins } from '../pluginHost/localPluginList'
import { pluginLocaleCandidates } from '../pluginHost/pluginLocaleText'
import { makeMemFs } from './_helpers/memFs'

const HOME = '/home/u'
const USER_ROOT = `${HOME}/${RUNTIME_DIR_NAME}/plugins`
const PROJECT = '/work/velloc'
const PROJECT_ROOT = `${PROJECT}/${RUNTIME_DIR_NAME}/plugins`

async function seeded() {
  const fs = makeMemFs()
  // User root: a mod, a plain plugin, and the marketplace pipeline's folders.
  await fs.writeFile(`${USER_ROOT}/my-mod/.claude-plugin/plugin.json`, '{"name":"my-mod","version":"0.1.0","description":"Tags."}')
  await fs.writeFile(`${USER_ROOT}/my-mod/hooks/hooks.json`, JSON.stringify({ modules: ['./register.js'] }))
  await fs.writeFile(`${USER_ROOT}/my-mod/hooks/register.js`, 'export default () => {}')
  await fs.writeFile(`${USER_ROOT}/plain/.claude-plugin/plugin.json`, '{"name":"plain"}')
  await fs.writeFile(`${USER_ROOT}/cache/mkt/x/1.0/.claude-plugin/plugin.json`, '{"name":"x"}')
  await fs.writeFile(`${USER_ROOT}/marketplaces/mkt/.claude-plugin/marketplace.json`, '{}')
  await fs.writeFile(`${USER_ROOT}/installed_plugins.json`, '{}')
  await fs.writeFile(`${HOME}/${RUNTIME_DIR_NAME}/enabled-plugins.json`, JSON.stringify({ enabledPlugins: ['my-mod', 'shared'] }))
  // Project root: a folder named apart from its manifest, and one the USER
  // file enables (the allowlist is the union of the two files).
  await fs.writeFile(`${PROJECT_ROOT}/compact-on-idle/.claude-plugin/plugin.json`, '{"name":"idle-compact"}')
  await fs.writeFile(`${PROJECT_ROOT}/compact-on-idle/hooks/hooks.json`, JSON.stringify({ modules: ['./idle.js'] }))
  await fs.writeFile(`${PROJECT_ROOT}/compact-on-idle/hooks/idle.js`, 'export default () => {}')
  await fs.writeFile(`${PROJECT_ROOT}/shared/.claude-plugin/plugin.json`, '{"name":"shared"}')
  await fs.writeFile(`${PROJECT_ROOT}/no-manifest/README.md`, 'x')
  await fs.writeFile(`${PROJECT}/${RUNTIME_DIR_NAME}/enabled-plugins.json`, JSON.stringify({ enabledPlugins: ['compact-on-idle'] }))
  return fs
}

describe('listLocalPlugins', () => {
  it('lists the user root, then each project, by folder, with what the loader would enable there', async () => {
    const fs = await seeded()
    expect(await listLocalPlugins({ homeDir: HOME, projects: [PROJECT], fs })).toEqual([
      {
        plugins: [
          {
            folder: 'my-mod',
            path: `${USER_ROOT}/my-mod`,
            name: 'my-mod',
            version: '0.1.0',
            description: 'Tags.',
            isMod: true,
            enabled: true,
            isNew: false,
          },
          { folder: 'plain', path: `${USER_ROOT}/plain`, name: 'plain', isMod: false, enabled: false, isNew: true },
        ],
      },
      {
        project: PROJECT,
        plugins: [
          {
            folder: 'compact-on-idle',
            path: `${PROJECT_ROOT}/compact-on-idle`,
            name: 'idle-compact',
            isMod: true,
            enabled: true,
            isNew: false,
          },
          { folder: 'no-manifest', path: `${PROJECT_ROOT}/no-manifest`, name: 'no-manifest', isMod: false, enabled: false, isNew: true },
          { folder: 'shared', path: `${PROJECT_ROOT}/shared`, name: 'shared', isMod: false, enabled: true, isNew: false },
        ],
      },
    ])
  })

  // New = found on disk and never switched either way: a folder the person
  // turned off is a decision, not news.
  it('a folder switched off in either file is not new; one never switched is', async () => {
    const fs = await seeded()
    await fs.writeFile(
      `${HOME}/${RUNTIME_DIR_NAME}/enabled-plugins.json`,
      JSON.stringify({ enabledPlugins: ['my-mod', 'shared'], disabledPlugins: ['plain'] }),
    )
    await fs.writeFile(
      `${PROJECT}/${RUNTIME_DIR_NAME}/enabled-plugins.json`,
      JSON.stringify({ enabledPlugins: ['compact-on-idle'], disabledPlugins: ['no-manifest'] }),
    )
    const roots = await listLocalPlugins({ homeDir: HOME, projects: [PROJECT], fs })
    expect(roots.flatMap(r => r.plugins).filter(p => p.isNew)).toEqual([])
    await fs.writeFile(`${USER_ROOT}/dropped-in/.claude-plugin/plugin.json`, '{"name":"dropped-in"}')
    const again = await listLocalPlugins({ homeDir: HOME, projects: [PROJECT], fs })
    expect(again.flatMap(r => r.plugins).filter(p => p.isNew).map(p => p.folder)).toEqual(['dropped-in'])
  })

  it('skips the home folder as a project, a repeated project, and lists a project with no plugins as empty', async () => {
    const fs = await seeded()
    const roots = await listLocalPlugins({ homeDir: HOME, projects: [HOME, PROJECT, `${PROJECT}/`, '/work/empty'], fs })
    expect(roots.map(r => [r.project, r.plugins.length])).toEqual([
      [undefined, 2],
      [PROJECT, 3],
      ['/work/empty', 0],
    ])
  })
})

describe('a plugin\'s description in the page\'s language', () => {
  async function translated() {
    const fs = await seeded()
    await fs.writeFile(`${USER_ROOT}/my-mod/locales/zh.json`, JSON.stringify({ 'plugin.description': '标签。', other: 'x' }))
    await fs.writeFile(`${USER_ROOT}/my-mod/locales/pt-BR.json`, JSON.stringify({ 'plugin.description': 'Etiquetas.' }))
    await fs.writeFile(`${USER_ROOT}/my-mod/locales/de.json`, JSON.stringify({ other: 'no description here' }))
    await fs.writeFile(`${USER_ROOT}/my-mod/locales/fr.json`, '{ not json')
    // A language file for a plugin whose manifest states no description.
    await fs.writeFile(`${USER_ROOT}/plain/locales/zh.json`, JSON.stringify({ 'plugin.description': '朴素。' }))
    return fs
  }
  const describedAs = async (fs: Awaited<ReturnType<typeof seeded>>, locale?: string) => {
    const [user] = await listLocalPlugins({ homeDir: HOME, projects: [], fs, ...(locale ? { locale } : {}) })
    return Object.fromEntries(user!.plugins.map(p => [p.folder, p.description]))
  }

  it('the language file\'s plugin.description replaces the manifest\'s, region first, then language', async () => {
    const fs = await translated()
    expect(await describedAs(fs, 'zh-CN')).toEqual({ 'my-mod': '标签。', plain: '朴素。' })
    expect(await describedAs(fs, 'pt-BR')).toEqual({ 'my-mod': 'Etiquetas.', plain: undefined })
  })

  it('English, no locale, no file, no key or a broken file: the manifest\'s own', async () => {
    const fs = await translated()
    for (const locale of [undefined, 'en', 'en-GB', 'ja', 'de', 'fr']) {
      expect(await describedAs(fs, locale)).toEqual({ 'my-mod': 'Tags.', plain: undefined })
    }
  })

  it('reads only the page language\'s files, never English or a malformed tag', () => {
    expect(pluginLocaleCandidates('zh-CN')).toEqual(['zh-CN', 'zh'])
    expect(pluginLocaleCandidates('zh_TW')).toEqual(['zh-TW', 'zh'])
    expect(pluginLocaleCandidates('de')).toEqual(['de'])
    for (const tag of [undefined, '', 'en', 'en-US', '../x', 'zh/../../etc']) expect(pluginLocaleCandidates(tag)).toEqual([])
  })

  it('plugins/listLocal passes the page\'s locale through', async () => {
    const fs = await translated()
    const { roots } = await pluginsHandlers.listLocal({ locale: 'zh-CN' }, { homeDir: HOME, fs })
    expect(roots[0]!.plugins.find(p => p.folder === 'my-mod')!.description).toBe('标签。')
  })
})

describe('plugins/listLocal — the sidebar\'s projects, read on the host', () => {
  it('takes the projects from workspace-state.json; the client names no path', async () => {
    const fs = await seeded()
    await fs.writeFile(
      `${HOME}/${RUNTIME_DIR_NAME}/${WORKSPACE_STATE_FILE}`,
      JSON.stringify({ projects: [{ path: PROJECT, addedAt: 1 }] }),
    )
    const { roots } = await pluginsHandlers.listLocal({}, { homeDir: HOME, fs })
    expect(roots.map(r => r.project)).toEqual([undefined, PROJECT])
    expect(roots[1].plugins.map(p => p.folder)).toEqual(['compact-on-idle', 'no-manifest', 'shared'])
  })

  it('no sidebar file: the user root alone', async () => {
    const fs = await seeded()
    const { roots } = await pluginsHandlers.listLocal({}, { homeDir: HOME, fs })
    expect(roots).toHaveLength(1)
    expect(roots[0].project).toBeUndefined()
  })

  it('is a `manager` action: it reads paths on the host\'s disk', () => {
    expect(LEGACY_WEBUI_CAPABILITIES.plugins.listLocal).toBe('manager')
  })
})
