import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrowserRuntimeConfig } from '../config/BrowserRuntimeConfig'
import { loadLocalPromptCommands } from '../skillLibrary/skillDiscovery'
import {
  unconfiguredFs,
  installProcessFs,
  resetProcessFs,
  type RuntimeFs,
  type RuntimeFsStat,
} from '../utils/fs/runtimeFs'

// fs fake with `stat` so the loader can tell a file from a directory.
function makeFakeFs(files: Record<string, string>): RuntimeFs {
  const fileStat = {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as RuntimeFsStat
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      if (path in files) return fileStat
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    async readFile(path: string): Promise<string> {
      const content = files[path]
      if (content === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return content
    },
    async readdir(): Promise<never> {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  } as RuntimeFs
}

afterEach(() => resetProcessFs())

describe('loadLocalPromptCommands — plugin skill dir pointing at a file', () => {
  beforeEach(() => resetProcessFs())

  it('loads an individual .md file as a single command', async () => {
    installProcessFs(
      makeFakeFs({
        '/plugins/p/about.md': '---\ndescription: About this plugin\n---\nAbout body.\n',
      }),
    )

    const commands = await loadLocalPromptCommands({
      cwd: '/workspace',
      runtimeConfig: new BrowserRuntimeConfig({ env: {} }),
      pluginSkillDirs: [{ dirPath: '/plugins/p/about.md', pluginName: 'p' }],
    })

    // A manifest single-file entry is
    // plugin-prefixed — `p:about`, not bare `about`.
    const about = commands.find(c => c.name === 'p:about')
    expect(about, 'file-path command "p:about" should load').toBeTruthy()
    expect(about?.description).toBe('About this plugin')
    expect(about?.source).toBe('plugin')
    expect(about?.pluginName).toBe('p')
    expect(commands.find(c => c.name === 'about')).toBeUndefined()
  })
})
