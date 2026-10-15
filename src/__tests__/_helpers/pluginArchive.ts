/**
 * Test fixtures for the plugin install pipeline: a `.tar.gz` built in memory,
 * a provider mod's manifest, and a fetch fake that serves URLs from a table.
 */

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(text).slice(0, length))
  return out
}

function octal(n: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(n.toString(8).padStart(length - 1, '0') + '\0'))
  return out
}

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(512)
  block.set(field(name, 100), 0)
  block.set(octal(0o644, 8), 100)
  block.set(octal(0, 8), 108)
  block.set(octal(0, 8), 116)
  block.set(octal(size, 12), 124)
  block.set(octal(0, 12), 136)
  for (let i = 148; i < 156; i++) block[i] = 0x20
  block[156] = 0x30
  block.set(field('ustar', 6), 257)
  block.set(field('00', 2), 263)
  let sum = 0
  for (let i = 0; i < 512; i++) sum += block[i]!
  block.set(octal(sum, 8), 148)
  return block
}

export type ArchiveFile = { name: string; content: string | Uint8Array }

export function buildTar(files: readonly ArchiveFile[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const file of files) {
    const data = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
    parts.push(header(file.name, data.byteLength))
    const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512)
    padded.set(data)
    parts.push(padded)
  }
  parts.push(new Uint8Array(1024))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  const stream = new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  return new Uint8Array(await new Response(source.pipeThrough(stream)).arrayBuffer())
}

export async function archive(files: readonly ArchiveFile[], wrapper?: string): Promise<Uint8Array> {
  return gzip(buildTar(wrapper ? files.map(f => ({ ...f, name: `${wrapper}/${f.name}` })) : files))
}

/** One provider of a plugin manifest; `over` replaces fields. */
export function providerJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerApi: 1,
    displayName: { en: 'Acme' },
    defaultBaseUrl: 'https://api.acme.test/v1',
    domains: ['api.acme.test'],
    format: 'openai-chat',
    credentials: { methods: ['apiKey'] },
    module: './providers/main.js',
    ...over,
  }
}

export type PluginFixture = {
  name?: string
  version: string
  providers?: Record<string, Record<string, unknown>>
  /** Extra top-level keys of plugin.json. */
  manifest?: Record<string, unknown>
  files?: ArchiveFile[]
  wrapper?: string
}

/** A plugin archive: `.claude-plugin/plugin.json` plus the provider module. */
export function pluginArchive(fixture: PluginFixture): Promise<Uint8Array> {
  const manifest = {
    name: fixture.name ?? 'acme',
    version: fixture.version,
    providers: fixture.providers ?? { main: providerJson() },
    ...fixture.manifest,
  }
  return archive(
    [
      { name: '.claude-plugin/plugin.json', content: JSON.stringify(manifest) },
      { name: 'providers/main.js', content: `export default function register() {} // ${fixture.version}\n` },
      ...(fixture.files ?? []),
    ],
    fixture.wrapper,
  )
}

export type Served = { body: string | Uint8Array; status?: number; headers?: Record<string, string>; url?: string }

/** A fetch fake that answers from a mutable table keyed by exact URL; records the calls. */
export function servedFetch(table: Map<string, Served>): typeof fetch & { calls: string[] } {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const hit = table.get(url)
    if (!hit) return new Response('not found', { status: 404 })
    const response = new Response(hit.body as BodyInit, { status: hit.status ?? 200, headers: hit.headers })
    Object.defineProperty(response, 'url', { value: hit.url ?? url })
    return response
  }) as typeof fetch & { calls: string[] }
  impl.calls = calls
  return impl
}
