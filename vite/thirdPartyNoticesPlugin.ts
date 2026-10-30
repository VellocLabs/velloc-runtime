import fs, { type Dirent } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { THIRD_PARTY_NOTICES_FILE } from '../src/branding/thirdPartyNotices'

/**
 * Emits THIRD_PARTY_NOTICES_FILE beside index.html: one entry per npm package
 * the bundle ships, with the licence and notice files that package carries.
 * Packages come from the module graph of the page build and of every worker
 * build, the files the esbuild sub-builds register as watch files, and the
 * direct `dependencies` (CSS-only imports never enter the module graph).
 * A package whose notice cannot be read fails the build.
 */

const NOTICE_FILE_NAME =
  /^(licen[cs]es?|copying|notices?|third[-_]?party[-_]?notices?(text)?)([-_][a-z0-9-]+)?(\.(txt|md|markdown|rst))?$/i
const NOTICES_DIR = fileURLToPath(new URL('./thirdPartyNotices/', import.meta.url))
const RULE = '='.repeat(72)

/** Software compiled into a package whose own files do not carry its notice. */
export type CompiledInComponent = {
  name: string
  license: string
  /** Licence text, a file name under vite/thirdPartyNotices/. */
  file: string
  /** Where its source code is available (EPL-1.0 asks for this). */
  source: string
}

/**
 * @viz-js/viz ships no licence file; its WebAssembly module is Graphviz and
 * Expat in object code form, named only in a banner comment.
 */
export const COMPILED_IN: Record<string, CompiledInComponent[]> = {
  '@viz-js/viz': [
    { name: 'Viz.js', license: 'MIT', file: 'Viz.js-LICENSE.txt', source: 'https://github.com/mdaines/viz-js' },
    { name: 'Graphviz', license: 'EPL-1.0', file: 'EPL-1.0.txt', source: 'https://gitlab.com/graphviz/graphviz' },
    { name: 'Expat', license: 'MIT', file: 'Expat-COPYING.txt', source: 'https://github.com/libexpat/libexpat' },
  ],
}

export type PackageRef = { name: string; dir: string }

/** The npm package a module id or file path lives in; null outside node_modules. */
export function packageOfModule(id: string): PackageRef | null {
  const file = (id.replace(/^\0+/, '').split('?')[0] ?? '').replace(/\\/g, '/')
  const marker = '/node_modules/'
  const at = file.lastIndexOf(marker)
  if (at < 0) return null
  const [first = '', second = ''] = file.slice(at + marker.length).split('/')
  if (!first || first.startsWith('.')) return null
  const name = first.startsWith('@') ? (second ? `${first}/${second}` : '') : first
  if (!name) return null
  return { name, dir: file.slice(0, at + marker.length) + name }
}

export type NoticeFile = { fileName: string; text: string }

export type PackageNotice = {
  name: string
  version: string
  license: string
  repository: string | null
  files: NoticeFile[]
  /** Set when `files` is empty: a listed package from the same repository whose licence files cover this one. */
  licenseFilesFrom?: string
}

function readText(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trimEnd()
}

function licenseOf(manifest: Record<string, unknown>): string {
  const { license, licenses } = manifest
  if (typeof license === 'string' && license) return license
  if (license && typeof license === 'object' && typeof (license as { type?: unknown }).type === 'string') {
    return (license as { type: string }).type
  }
  if (Array.isArray(licenses)) {
    const types = licenses.map(l => (typeof l === 'string' ? l : (l as { type?: unknown })?.type))
    if (types.every(t => typeof t === 'string' && t)) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

const LICENSE_TEXT_HEADINGS: Array<[RegExp, string]> = [
  [/^(the )?mit license\b/i, 'MIT'],
  [/^isc license\b/i, 'ISC'],
  [/^apache license\s+version 2\.0\b/i, 'Apache-2.0'],
]

/** The licence a licence file's opening line names (MIT, ISC, Apache-2.0), or null. */
export function licenseFromText(text: string): string | null {
  const opening = text.trimStart().replace(/\s+/g, ' ')
  for (const [heading, id] of LICENSE_TEXT_HEADINGS) {
    if (heading.test(opening)) return id
  }
  return null
}

/** The manifest's licence; failing that, the one a shipped licence file names, marked as read from that file. */
function resolveLicense(manifest: Record<string, unknown>, files: NoticeFile[]): string {
  const declared = licenseOf(manifest)
  if (declared !== 'UNKNOWN') return declared
  for (const file of files) {
    const id = licenseFromText(file.text)
    if (id) return `${id} (from ${file.fileName}; package.json names no licence)`
  }
  return declared
}

function repositoryOf(manifest: Record<string, unknown>): string | null {
  const repo = manifest.repository
  const url = typeof repo === 'string' ? repo : (repo as { url?: unknown } | undefined)?.url
  if (typeof url !== 'string' || !url) return null
  return url.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
}

/** Reads one package's manifest and root-level licence/notice files. Throws when it has no manifest. */
export function readPackageNotice(dir: string): PackageNotice {
  const manifestPath = path.join(dir, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`third-party-notices: cannot read ${manifestPath}: ${(error as Error).message}`)
  }
  const entries: Dirent[] = fs.readdirSync(dir, { withFileTypes: true })
  const files = entries
    .filter(entry => entry.isFile() && NOTICE_FILE_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort()
    .map(fileName => ({ fileName, text: readText(path.join(dir, fileName)) }))
  return {
    name: String(manifest.name ?? path.basename(dir)),
    version: String(manifest.version ?? ''),
    license: resolveLicense(manifest, files),
    repository: repositoryOf(manifest),
    files,
  }
}

/** One notice per name@version found among `ids`, sorted by name then version. */
export function collectNotices(ids: Iterable<string>): PackageNotice[] {
  const dirs = new Set<string>()
  for (const id of ids) {
    const ref = packageOfModule(id)
    if (ref) dirs.add(ref.dir)
  }
  const notices = new Map<string, PackageNotice>()
  for (const dir of dirs) {
    const notice = readPackageNotice(dir)
    const key = `${notice.name}@${notice.version}`
    if (!notices.has(key)) notices.set(key, notice)
  }
  const sorted = [...notices.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1,
  )
  // Monorepo sub-packages often publish without the repository's licence file.
  for (const notice of sorted) {
    if (notice.files.length > 0 || !notice.repository) continue
    const root = repositoryRoot(notice.repository)
    const sibling = sorted.find(other =>
      other.files.length > 0 &&
      other.license === notice.license &&
      other.repository !== null &&
      repositoryRoot(other.repository) === root,
    )
    if (sibling) notice.licenseFilesFrom = `${sibling.name} ${sibling.version}`
  }
  return sorted
}

/** A GitHub URL trimmed to owner/repo, so `.../tree/main/packages/x` matches its monorepo. */
export function repositoryRoot(url: string): string {
  const github = /^https:\/\/github\.com\/[^/#]+\/[^/#]+/.exec(url)
  return (github ? github[0] : url).toLowerCase()
}

/** The notices file: a short header, then one section per package. Byte-stable for a given input. */
export function renderNotices(
  notices: PackageNotice[],
  compiledIn: Record<string, CompiledInComponent[]> = COMPILED_IN,
  noticesDir: string = NOTICES_DIR,
): string {
  const out = [
    'Third-party software notices',
    '',
    'This web bundle includes the third-party packages listed below. Each entry',
    'names the package and its licence, followed by the licence and notice text',
    'the package ships with.',
  ]
  for (const notice of notices) {
    out.push('', RULE, `${notice.name} ${notice.version}`.trimEnd(), `License: ${notice.license}`)
    if (notice.repository) out.push(`Repository: ${notice.repository}`)
    for (const file of notice.files) out.push('', `--- ${file.fileName} ---`, '', file.text)
    const components = compiledIn[notice.name] ?? []
    for (const component of components) {
      out.push(
        '',
        `--- ${component.name} (${component.license}), source code: ${component.source} ---`,
        '',
        readText(path.join(noticesDir, component.file)),
      )
    }
    if (notice.files.length === 0 && components.length === 0) {
      out.push(
        '',
        notice.licenseFilesFrom
          ? `This package ships no licence file; its licence text is the one listed under ${notice.licenseFilesFrom}, from the same repository.`
          : 'This package ships no licence file; its licence is the one named above.',
      )
    }
  }
  return out.join('\n') + '\n'
}

/** Names of the project's direct `dependencies`, resolved under `root`/node_modules. */
function directDependencyFiles(root: string): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  return Object.keys(manifest.dependencies ?? {}).map(name =>
    path.join(root, 'node_modules', name, 'package.json'),
  )
}

/**
 * `plugin` goes in the page build's plugins and emits the file; `collector()`
 * goes in `worker.plugins` so each worker build adds its module graph first.
 */
export function thirdPartyNotices(root: string): { plugin: Plugin; collector: () => Plugin } {
  const ids = new Set<string>()
  const collector = (): Plugin => ({
    name: 'third-party-notices-collect',
    apply: 'build',
    buildEnd() {
      for (const id of this.getModuleIds()) ids.add(id)
      for (const file of this.getWatchFiles()) ids.add(file)
    },
  })
  const plugin: Plugin = {
    ...collector(),
    name: 'third-party-notices',
    generateBundle() {
      const notices = collectNotices([...ids, ...directDependencyFiles(root)])
      this.emitFile({ type: 'asset', fileName: THIRD_PARTY_NOTICES_FILE, source: renderNotices(notices) })
    },
  }
  return { plugin, collector }
}
