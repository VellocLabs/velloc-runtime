/**
 * Mechanics behind the project-scoped `/plugins` command: the listing renderer
 * and install primitives (git-url normalisation, shell quoting, Bash-envelope
 * unwrapping, recursive local copy).
 */

import { RUNTIME_DIR_NAME } from '../branding/runtimeDir'
import { readShellStreams } from '../toolkit/builtin/host/resultText'
import type { ActivePlugin, PluginScan } from '../pluginHost/pluginModel'
import { describePluginError } from '../pluginHost/pluginModel'
import { processFs, type RuntimeFs } from '../utils/fs/runtimeFs'
import { dirnameRuntimePath, joinRuntimePath } from '../utils/runtimePaths'
import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import {
  bullet,
  bulletBlock,
  key,
  leadIn,
  title,
} from './systemMessageParts'

/**
 * One plugin bullet for `/plugins`. The scope trails the capability list:
 * `[commands, skills] (user)` would render as a markdown link.
 */
function formatPluginLine(plugin: ActivePlugin): string {
  const caps: string[] = []
  if (plugin.commandFolder || (plugin.commandFolders?.length ?? 0) > 0) {
    caps.push('commands')
  }
  if (plugin.skillsPath || (plugin.skillsPaths?.length ?? 0) > 0) {
    caps.push('skills')
  }
  if (plugin.agentsPath || (plugin.agentsPaths?.length ?? 0) > 0) {
    caps.push('agents')
  }
  if (plugin.hooksConfig && Object.keys(plugin.hooksConfig).length > 0) {
    caps.push('hooks')
  }
  if (plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0) {
    caps.push(`mcp(${Object.keys(plugin.mcpServers).length})`)
  }
  const version = plugin.manifest.version ? ` v${plugin.manifest.version}` : ''
  const capsText = caps.length > 0 ? ` — ${caps.join(', ')}` : ' — no components'
  // `source` looks like `user:/path` or `project:/path` — show just the scope.
  const scope = plugin.source.split(':')[0]
  return bullet(`**${plugin.name}**${version} (${scope})${capsText}`)
}

/** Human-readable `/plugins` listing: enabled, disabled, and load errors. */
export function buildPluginsListing(
  result: PluginScan | undefined,
): SystemMessagePart[] {
  if (!result || (result.enabled.length === 0 && result.disabled.length === 0)) {
    return [key('slash.out.plugins.empty', { dir: RUNTIME_DIR_NAME })]
  }
  const parts: SystemMessagePart[] = title(
    key('slash.out.plugins.header', {
      enabled: result.enabled.length,
      disabled: result.disabled.length,
    }),
  )
  if (result.enabled.length > 0) {
    parts.push(
      ...leadIn(key('slash.out.plugins.enabledHeading')),
      ...bulletBlock(result.enabled.map(formatPluginLine)),
    )
  }
  if (result.disabled.length > 0) {
    parts.push(
      ...leadIn(key('slash.out.plugins.disabledHeading')),
      ...bulletBlock(result.disabled.map(formatPluginLine)),
    )
  }
  if (result.errors.length > 0) {
    parts.push(
      ...leadIn(key('slash.out.plugins.errorsHeading')),
      ...bulletBlock(
        result.errors.map(error => bullet(describePluginError(error))),
      ),
    )
  }
  return parts
}

/** POSIX single-quote escaping for a shell argument. */
export function shArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Expand `owner/repo` shorthand to a GitHub https URL; pass full URLs through. */
export function normalizeGitUrl(url: string): string {
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    return `https://github.com/${url}.git`
  }
  return url
}

/** Derive a plugin directory name from a git URL / `owner/repo` shorthand. */
export function pluginNameFromUrl(url: string): string {
  const base = url.replace(/\.git$/i, '').replace(/[/]+$/, '')
  const segment = base.split(/[/:]/).filter(Boolean).pop() ?? 'plugin'
  return segment.replace(/[^A-Za-z0-9._-]+/g, '-') || 'plugin'
}

/** Unwrap a Bash-tool callTool envelope to `{ output, exitCode }`. */
export function readBashEnvelope(raw: unknown): {
  output: string
  exitCode: number
} {
  let obj = raw as Record<string, unknown> | undefined
  if (obj && typeof obj === 'object' && obj.data && typeof obj.data === 'object') {
    obj = obj.data as Record<string, unknown>
  }
  const streams = readShellStreams(obj)
  if (streams) {
    const output = [streams.stdout, streams.stderr].filter(Boolean).join('\n')
    return { output, exitCode: streams.exitCode }
  }
  return {
    output: typeof obj?.output === 'string'
      ? (obj.output as string)
      : typeof obj === 'string'
        ? obj
        : '',
    exitCode: typeof obj?.exit_code === 'number' ? (obj.exit_code as number) : 0,
  }
}

export async function mkdirParents(
  path: string,
  fs: RuntimeFs = processFs(),
): Promise<void> {
  const chain: string[] = []
  let cur = path
  for (;;) {
    chain.push(cur)
    const parent = dirnameRuntimePath(cur)
    if (parent === cur || parent === '.' || parent.length === 0) break
    cur = parent
  }
  for (const dir of chain.reverse()) {
    try {
      await fs.mkdir(dir)
    } catch {
      // Already exists or cannot be created. The subsequent clone/write will
      // surface any real error; this is just best-effort parent creation for the
      // bridge fs, whose mkdir is single-level.
    }
  }
}

export async function copyLocalPluginDirectory(
  sourceDir: string,
  targetDir: string,
  fs: RuntimeFs = processFs(),
): Promise<boolean> {
  try {
    await fs.stat(joinRuntimePath(sourceDir, '.claude-plugin', 'plugin.json'))
  } catch {
    return false
  }

  const copyDir = async (src: string, dst: string): Promise<boolean> => {
    await mkdirParents(dst, fs)
    let entries
    try {
      entries = await fs.readdir(src)
    } catch (error) {
      // Some bridge backends cannot enumerate host paths outside the runtime
      // workspace. Fall back to `git clone` in that case; the file:// path is a
      // real git repo and the shell tool can still read it.
      if (src === sourceDir) return false
      throw error
    }
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue
      }
      const srcPath = joinRuntimePath(src, entry.name)
      const dstPath = joinRuntimePath(dst, entry.name)
      if (entry.isDirectory()) {
        await copyDir(srcPath, dstPath)
      } else if (entry.isFile()) {
        await mkdirParents(dirnameRuntimePath(dstPath), fs)
        const content = await fs.readFile(srcPath, { encoding: 'utf-8' })
        await fs.writeFile(dstPath, content, { encoding: 'utf-8' })
      }
    }
    return true
  }

  return await copyDir(sourceDir, targetDir)
}

export function fileUrlToPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') return null
    let path = decodeURIComponent(parsed.pathname)
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1)
    }
    return path
  } catch {
    return null
  }
}
