/**
 * The first-turn folder listing (F-19): the walker's order, depth, skips and
 * cap; the collector's once-only rule; the row the model reads.
 */
import { describe, expect, it } from 'vitest'
import { FOLDER_TREE_MAX_ENTRIES, readFolderTree, type FolderTreeEntry } from '../utils/folderTree'
import { collectFolderTreeAttachments } from '../messages/contextAttachments'
import { renderFolderTreeReminder } from '../messages/renderAttachments'
import type { ToolCallContext } from '../toolkit/toolCallContext'
import type { Message } from '../runtime/RuntimeTypes'

type Tree = { [name: string]: Tree | null }

function fakeFs(tree: Tree, root: string) {
  const reads: string[] = []
  const entry = (name: string, dir: boolean, link = false): FolderTreeEntry => ({
    name,
    isDirectory: () => dir,
    isSymbolicLink: () => link,
  })
  const at = (path: string): Tree | null | undefined => {
    if (path === root) return tree
    const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '') : undefined
    if (rel === undefined) return undefined
    let node: Tree | null = tree
    for (const part of rel.split(/[\\/]/)) {
      if (!node || !(part in node)) return undefined
      node = node[part]!
    }
    return node
  }
  return {
    reads,
    fs: {
      async readdir(path: string) {
        reads.push(path)
        const node = at(path)
        if (node === undefined || node === null) throw new Error('ENOENT')
        return Object.entries(node).map(([name, child]) =>
          entry(name.replace(/^@/, ''), child !== null, name.startsWith('@')),
        )
      },
    },
  }
}

describe('readFolderTree', () => {
  it('lists folders first then files, sorted, indented by depth, three levels deep', async () => {
    const { fs, reads } = fakeFs(
      {
        'z.txt': null,
        src: { b: { deep: { deeper: null } }, 'a.ts': null },
        'README.md': null,
      },
      '/p',
    )
    const tree = await readFolderTree(fs, '/p')
    expect(tree).toEqual({
      lines: ['src/', '  b/', '    deep/', '  a.ts', 'README.md', 'z.txt'],
      truncated: false,
    })
    // `deep/` is at the depth limit: listed, not entered.
    expect(reads).toEqual(['/p', '/p/src', '/p/src/b'])
  })

  it('lists a heavy folder but does not enter it, skips symbolic links, and never lists .git', async () => {
    const { fs, reads } = fakeFs(
      { node_modules: { pkg: null }, '.git': { HEAD: null }, '@link': { x: null }, 'a.ts': null },
      'C:\\p',
    )
    const tree = await readFolderTree(fs, 'C:\\p')
    expect(tree.lines).toEqual(['node_modules/', 'a.ts'])
    expect(reads).toEqual(['C:\\p'])
  })

  it('marks a folder that holds its own .git as a repository', async () => {
    const { fs } = fakeFs(
      { '.git': { HEAD: null }, packages: { web: { '.git': { HEAD: null }, 'x.ts': null }, lib: { 'y.ts': null } } },
      '/mono',
    )
    const tree = await readFolderTree(fs, '/mono')
    expect(tree.lines).toEqual(['packages/', '  lib/', '    y.ts', '  web/ (git repository)', '    x.ts'])
  })

  it('cuts at the entry cap and says so; an unreadable folder contributes nothing', async () => {
    const many: Tree = {}
    for (let i = 0; i < FOLDER_TREE_MAX_ENTRIES + 5; i++) many[`f${String(i).padStart(3, '0')}.txt`] = null
    const { fs } = fakeFs(many, '/p')
    const tree = await readFolderTree(fs, '/p')
    expect(tree.lines).toHaveLength(FOLDER_TREE_MAX_ENTRIES)
    expect(tree.truncated).toBe(true)
    const { fs: gone } = fakeFs({}, '/elsewhere')
    expect(await readFolderTree(gone, '/missing')).toEqual({ lines: [], truncated: false })
  })

  it('asks mayEnter before listing each folder: a refused one is named, never read', async () => {
    const { fs, reads } = fakeFs({ open: { 'a.ts': null }, shut: { 'b.ts': null } }, '/p')
    const asked: string[] = []
    const tree = await readFolderTree(fs, '/p', {
      mayEnter: async folder => {
        asked.push(folder)
        return folder !== '/p/shut'
      },
    })
    expect(tree.lines).toEqual(['open/', '  a.ts', 'shut/'])
    expect(asked).toEqual(['/p', '/p/open', '/p/shut'])
    expect(reads).toEqual(['/p', '/p/open'])
    const { fs: refused, reads: none } = fakeFs({ 'a.ts': null }, '/p')
    expect(await readFolderTree(refused, '/p', { mayEnter: async () => false })).toEqual({ lines: [], truncated: false })
    expect(none).toEqual([])
  })
})

function rig(options: {
  tree?: Tree
  agentId?: string
  messages?: Message[]
  read?: true
  folder?: string
  untrusted?: { realpath: (path: string) => string }
}) {
  const folder = options.folder ?? '/repo'
  let appState: Record<string, unknown> = { attachmentState: options.read ? { folderTreeRead: true } : {} }
  const { fs: plain, reads } = fakeFs(options.tree ?? {}, folder)
  const untrusted = options.untrusted
  const fs = untrusted ? { ...plain, realpath: async (path: string) => untrusted.realpath(path) } : plain
  const context = {
    options: {
      sessionId: 's1',
      projectRoot: folder,
      cwd: folder,
      fsOperations: fs,
      ...(untrusted ? { untrustedReadRoot: folder } : {}),
    },
    agentId: options.agentId,
    messages: options.messages ?? [],
    readAppState: () => appState,
    writeAppState: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => {
      appState = update(appState)
    },
  } as unknown as ToolCallContext
  return { context, reads, recorded: () => (appState.attachmentState as { folderTreeRead?: true }).folderTreeRead }
}

const treeRow = (): Message =>
  ({ type: 'attachment', attachment: { type: 'folder_tree', lines: ['a'], truncated: false } }) as unknown as Message

describe('collectFolderTreeAttachments', () => {
  it('on the first turn: one row with the listing, and the read recorded', async () => {
    const r = rig({ tree: { src: { 'a.ts': null }, 'README.md': null } })
    expect(await collectFolderTreeAttachments(r.context)).toEqual([
      { type: 'folder_tree', lines: ['src/', '  a.ts', 'README.md'], truncated: false },
    ])
    expect(r.recorded()).toBe(true)
  })

  it('a listing that does not finish in time: no row, and not tried again', async () => {
    const r = rig({ tree: { 'a.ts': null } })
    ;(r.context.options as { fsOperations: unknown }).fsOperations = { readdir: () => new Promise<never>(() => {}) }
    expect(await collectFolderTreeAttachments(r.context, { timeoutMs: 20 })).toEqual([])
    expect(r.recorded()).toBe(true)
  })

  it('an empty folder: no row, the read still recorded', async () => {
    const r = rig({ tree: {} })
    expect(await collectFolderTreeAttachments(r.context)).toEqual([])
    expect(r.recorded()).toBe(true)
  })

  it('once only: a recorded read, or a row in the transcript, means no second listing', async () => {
    const recorded = rig({ read: true, tree: { 'a.ts': null } })
    expect(await collectFolderTreeAttachments(recorded.context)).toEqual([])
    expect(recorded.reads).toHaveLength(0)
    const reloaded = rig({ messages: [treeRow()], tree: { 'a.ts': null } })
    expect(await collectFolderTreeAttachments(reloaded.context)).toEqual([])
    expect(reloaded.reads).toHaveLength(0)
    expect(reloaded.recorded()).toBe(true)
  })

  it('a sub-agent, or the shared sandbox workspace, lists nothing', async () => {
    const sub = rig({ agentId: 'a1', tree: { 'a.ts': null } })
    expect(await collectFolderTreeAttachments(sub.context)).toEqual([])
    expect(sub.reads).toHaveLength(0)
    const sandbox = rig({ folder: '/home/me/.velloc/shared-workspace/chat', tree: { 'a.ts': null } })
    expect(await collectFolderTreeAttachments(sandbox.context)).toEqual([])
    expect(sandbox.reads).toHaveLength(0)
    expect(sandbox.recorded()).toBeUndefined()
  })

  it('on an untrusted provider: a folder that resolves out of the root (a junction) is named, not entered', async () => {
    // A junction reads as a plain folder; only its resolved path shows it leaves.
    const r = rig({
      tree: { src: { 'a.ts': null }, linked: { 'outside-secret.txt': null } },
      untrusted: { realpath: path => (path.startsWith('/repo/linked') ? `/elsewhere${path.slice('/repo/linked'.length)}` : path) },
    })
    expect(await collectFolderTreeAttachments(r.context)).toEqual([
      { type: 'folder_tree', lines: ['linked/', 'src/', '  a.ts'], truncated: false },
    ])
    expect(r.reads).toEqual(['/repo', '/repo/src'])
  })

  it('on a trusted provider the same folder is listed: the boundary is the untrusted session\'s alone', async () => {
    const r = rig({ tree: { linked: { 'b.txt': null } } })
    expect(await collectFolderTreeAttachments(r.context)).toEqual([
      { type: 'folder_tree', lines: ['linked/', '  b.txt'], truncated: false },
    ])
  })
})

describe('renderFolderTreeReminder', () => {
  it('names the listing as a one-time snapshot and marks a cut', () => {
    const text = renderFolderTreeReminder({ type: 'folder_tree', lines: ['src/', '  a.ts'], truncated: true })
    expect(text.startsWith('<system-reminder>\n')).toBe(true)
    expect(text).toContain('snapshot taken once; it does not update')
    expect(text).toContain('\nsrc/\n  a.ts\n… more entries not listed\n')
    expect(renderFolderTreeReminder({ type: 'folder_tree', lines: ['a'], truncated: false })).not.toContain('more entries')
  })
})
