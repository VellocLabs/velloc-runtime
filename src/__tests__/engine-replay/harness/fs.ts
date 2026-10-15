import { unconfiguredFs, type RuntimeFs, type RuntimeFsEntry, type RuntimeFsStat } from '../../../utils/fs/runtimeFs'
import { TraceRecorder } from './trace'

/** A file store in memory: enough for a tool that saves and reads a file
 *  (the plan file) and for the instruction-file loaders. `files` seeds it.
 *  Every write is recorded when a recorder is given. */
export function memoryFs(recorder?: TraceRecorder, files: Record<string, string> = {}): RuntimeFs {
  const store = new Map<string, string>(Object.entries(files))
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const isDir = (path: string) => {
    const prefix = path.endsWith('/') ? path : `${path}/`
    return [...store.keys()].some(key => key.startsWith(prefix))
  }
  const stat = (path: string): RuntimeFsStat =>
    ({
      size: store.get(path)?.length ?? 0,
      isFile: () => store.has(path),
      isDirectory: () => !store.has(path) && isDir(path),
      isSymbolicLink: () => false,
    }) as RuntimeFsStat
  return {
    ...unconfiguredFs,
    async stat(path: string): Promise<RuntimeFsStat> {
      if (!store.has(path) && !isDir(path)) throw missing()
      return stat(path)
    },
    existsSync: (path: string) => store.has(path) || isDir(path),
    async mkdir(): Promise<void> {},
    async readFile(path: string): Promise<string> {
      const content = store.get(path)
      if (content === undefined) throw missing()
      return content
    },
    async readdir(path: string): Promise<RuntimeFsEntry[]> {
      const prefix = path.endsWith('/') ? path : `${path}/`
      const names = new Set<string>()
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]!)
      }
      if (names.size === 0) throw missing()
      return [...names].sort().map(name => {
        const s = stat(`${prefix}${name}`)
        return { name, isFile: s.isFile, isDirectory: s.isDirectory, isSymbolicLink: () => false }
      })
    },
    async writeFile(path: string, data: string | Uint8Array): Promise<void> {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      store.set(path, text)
      recorder?.trace.notes.push({ fsWrite: path, content: text })
    },
  } as RuntimeFs
}
