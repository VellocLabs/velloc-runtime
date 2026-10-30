/**
 * Pins the third-party notices file (vite/thirdPartyNoticesPlugin.ts): which packages it finds, which files it
 * copies from each, and that a real build lists the packages of the page, of a worker, and of `dependencies`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Rollup } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMPILED_IN,
  collectNotices,
  packageOfModule,
  renderNotices,
  repositoryRoot,
  thirdPartyNotices,
} from '../../vite/thirdPartyNoticesPlugin'
import { THIRD_PARTY_NOTICES_FILE } from '../branding/thirdPartyNotices'

const NOTICES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vite/thirdPartyNotices')

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'third-party-notices-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writePackage(name: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  const dir = path.join(tmp, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
  for (const [file, text] of Object.entries(files)) writeFileSync(path.join(dir, file), text)
  return dir
}

describe('packageOfModule', () => {
  it('maps a module id to its package root', () => {
    expect(packageOfModule('/w/node_modules/react/index.js')).toEqual({ name: 'react', dir: '/w/node_modules/react' })
    expect(packageOfModule('/w/node_modules/@xterm/xterm/lib/xterm.mjs')).toEqual({
      name: '@xterm/xterm',
      dir: '/w/node_modules/@xterm/xterm',
    })
  })

  it('takes the innermost node_modules, strips virtual prefixes and queries, and accepts backslashes', () => {
    expect(packageOfModule('/w/node_modules/a/node_modules/b/x.js')?.name).toBe('b')
    expect(packageOfModule('\0/w/node_modules/c/x.js?commonjs-proxy')?.name).toBe('c')
    expect(packageOfModule('D:\\w\\node_modules\\@s\\d\\x.js')).toEqual({ name: '@s/d', dir: 'D:/w/node_modules/@s/d' })
  })

  it('returns null for project files, virtual modules and tool caches', () => {
    expect(packageOfModule('/w/src/app.ts')).toBeNull()
    expect(packageOfModule('\0vite/preload-helper.js')).toBeNull()
    expect(packageOfModule('/w/node_modules/.vite/deps/react.js')).toBeNull()
    expect(packageOfModule('/w/node_modules/@scope')).toBeNull()
  })
})

describe('collectNotices', () => {
  it('reads licence and notice files only, normalised, one entry per name@version', () => {
    const a = writePackage('a', { license: 'MIT' }, {
      LICENSE: '\uFEFFCopyright A\r\nMIT text\r\n\r\n',
      'license-update.mjs': 'export {}',
      'index.js': '',
    })
    writePackage('@s/b', { license: { type: 'Apache-2.0' } }, { 'LICENSE.md': 'Apache text', NOTICE: 'B notice' })

    const notices = collectNotices([
      `${a}/index.js`,
      `${a}/lib/other.js`,
      path.join(tmp, 'node_modules', '@s', 'b', 'index.js'),
      path.join(tmp, 'src', 'app.ts'),
    ])

    expect(notices.map(n => `${n.name}@${n.version} ${n.license}`)).toEqual(['@s/b@1.0.0 Apache-2.0', 'a@1.0.0 MIT'])
    expect(notices[1]!.files).toEqual([{ fileName: 'LICENSE', text: 'Copyright A\nMIT text' }])
    expect(notices[0]!.files.map(f => f.fileName)).toEqual(['LICENSE.md', 'NOTICE'])
  })

  it('points a sub-package without a licence file at a sibling from the same repository', () => {
    writePackage('@m/core', { license: 'MIT', repository: 'git+https://github.com/m/mono.git' }, { LICENSE: 'M' })
    const sub = writePackage('@m/sub', {
      license: 'MIT',
      repository: { url: 'https://github.com/m/mono/tree/main/packages/sub' },
    })
    const lone = writePackage('lone', { license: 'MIT', repository: 'https://github.com/x/lone' })

    const notices = collectNotices([
      path.join(tmp, 'node_modules', '@m', 'core', 'i.js'),
      path.join(sub, 'i.js'),
      path.join(lone, 'i.js'),
    ])
    const byName = Object.fromEntries(notices.map(n => [n.name, n]))

    expect(byName['@m/sub']!.licenseFilesFrom).toBe('@m/core 1.0.0')
    expect(byName.lone!.licenseFilesFrom).toBeUndefined()
    expect(renderNotices(notices, {})).toContain('licence text is the one listed under @m/core 1.0.0')
  })

  it('fails loudly when a package has no manifest', () => {
    mkdirSync(path.join(tmp, 'node_modules', 'ghost'), { recursive: true })
    expect(() => collectNotices([path.join(tmp, 'node_modules', 'ghost', 'x.js')])).toThrow(/cannot read .*package\.json/)
  })
})

describe('renderNotices', () => {
  it('appends the notices of software compiled into a package, with where its source is', () => {
    writeFileSync(path.join(tmp, 'C.txt'), 'C licence\n')
    const notice = { name: 'host', version: '2.0.0', license: 'MIT', repository: null, files: [] }
    const text = renderNotices(
      [notice],
      { host: [{ name: 'C', license: 'EPL-1.0', file: 'C.txt', source: 'https://example.test/c' }] },
      tmp,
    )

    expect(text).toContain('host 2.0.0\nLicense: MIT')
    expect(text).toContain('--- C (EPL-1.0), source code: https://example.test/c ---\n\nC licence')
    expect(text).not.toContain('ships no licence file')
    expect(renderNotices([notice], {}, tmp)).toBe(renderNotices([notice], {}, tmp))
  })

  it('ships a licence text for every compiled-in component, Graphviz under EPL-1.0', () => {
    for (const component of Object.values(COMPILED_IN).flat()) {
      expect(existsSync(path.join(NOTICES_DIR, component.file)), component.file).toBe(true)
    }
    const graphviz = COMPILED_IN['@viz-js/viz']!.find(c => c.name === 'Graphviz')!
    expect(graphviz.license).toBe('EPL-1.0')
    expect(readFileSync(path.join(NOTICES_DIR, graphviz.file), 'utf8')).toMatch(/^Eclipse Public License - v 1\.0/)
  })
})

describe('repositoryRoot', () => {
  it('trims GitHub URLs to owner/repo', () => {
    expect(repositoryRoot('https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit')).toBe(
      'https://github.com/xtermjs/xterm.js',
    )
    expect(repositoryRoot('https://gitlab.com/a/b')).toBe('https://gitlab.com/a/b')
  })
})

describe('thirdPartyNotices plugin', () => {
  it('lists packages from the page graph, a worker graph and the direct dependencies', async () => {
    writePackage('dep-page', { license: 'MIT' }, { LICENSE: 'page licence', 'index.js': 'export default 1' })
    writePackage('dep-worker', { license: 'ISC' }, { LICENSE: 'worker licence', 'index.js': 'export default 2' })
    writePackage('dep-css', { license: 'MIT' }, { LICENSE: 'css licence' })
    writePackage('dep-unused-dev', { license: 'MIT' }, { LICENSE: 'dev licence', 'index.js': '' })
    writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { 'dep-css': '1.0.0' } }))
    writeFileSync(
      path.join(tmp, 'main.js'),
      "import a from 'dep-page'\nnew Worker(new URL('./w.js', import.meta.url), { type: 'module' })\nconsole.log(a)\n",
    )
    writeFileSync(path.join(tmp, 'w.js'), "import b from 'dep-worker'\nconsole.log(b)\n")

    const notices = thirdPartyNotices(tmp)
    const output = (await build({
      root: tmp,
      configFile: false,
      logLevel: 'silent',
      plugins: [notices.plugin],
      worker: { format: 'es', plugins: () => [notices.collector()] },
      build: { write: false, rollupOptions: { input: path.join(tmp, 'main.js') } },
    })) as Rollup.RollupOutput
    const asset = output.output.find(o => o.fileName === THIRD_PARTY_NOTICES_FILE)

    expect(asset?.type).toBe('asset')
    const text = String((asset as Rollup.OutputAsset).source)
    expect(text).toContain('dep-page 1.0.0\nLicense: MIT')
    expect(text).toContain('dep-worker 1.0.0\nLicense: ISC')
    expect(text).toContain('dep-css 1.0.0\nLicense: MIT')
    expect(text).not.toContain('dep-unused-dev')
  }, 60_000)
})
