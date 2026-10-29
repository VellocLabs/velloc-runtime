/**
 * How a file is opened from the Files pane or a path link (F-9), by name alone — an allow-list:
 * `text` opens in the editor, `media` (video, audio, images, PDF) in the single-web viewer window,
 * and every other file is `unsupported` and never read. Pure; shared by the runtime and the page.
 */

export type FileOpenKind = 'text' | 'media' | 'unsupported'

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  // Video.
  'mp4', 'm4v', 'mov', 'webm', 'ogv',
  // Audio.
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac',
  // Images.
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  // Documents.
  'pdf',
])

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // Prose, data and config.
  'txt', 'text', 'md', 'markdown', 'mdx', 'rst', 'adoc', 'org', 'tex', 'bib', 'log',
  'csv', 'tsv', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'ipynb', 'yaml', 'yml', 'toml',
  'ini', 'cfg', 'conf', 'properties', 'env', 'xml', 'xsd', 'xsl', 'plist', 'srt', 'vtt',
  'lock', 'patch', 'diff', 'sql', 'graphql', 'gql', 'proto', 'thrift',
  // Markup and styles.
  'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'sass', 'less', 'styl',
  // Scripts and source.
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'rb', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'java', 'kt', 'kts', 'scala',
  'groovy', 'gradle', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'inc',
  'm', 'mm', 'cs', 'fs', 'fsx', 'vb', 'swift', 'dart', 'zig', 'nim', 'ex', 'exs', 'erl',
  'hrl', 'hs', 'elm', 'clj', 'cljs', 'edn', 'ml', 'mli', 'sol', 'asm', 's',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'bat', 'cmd',
  // Build files.
  'mk', 'cmake', 'gn', 'gni', 'ninja', 'bzl', 'bazel', 'tf', 'tfvars', 'hcl', 'nix',
  'dockerfile', 'gemspec', 'podspec', 'csproj', 'vcxproj', 'sln', 'props', 'targets',
])

/** Whole names (lower case) that are text with no telling extension. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
  'makefile', 'gnumakefile', 'dockerfile', 'containerfile', 'jenkinsfile', 'vagrantfile',
  'gemfile', 'rakefile', 'procfile', 'brewfile', 'podfile', 'build', 'workspace',
  'codeowners', 'owners', 'authors', 'contributors', 'license', 'licence', 'notice',
  'copying', 'readme', 'changelog', 'version',
  '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.dockerignore', '.editorconfig',
  '.npmrc', '.nvmrc', '.yarnrc', '.prettierrc', '.eslintrc', '.babelrc', '.env',
  '.bashrc', '.zshrc', '.profile', '.clang-format', '.gn',
])

export function fileOpenKind(path: string): FileOpenKind {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (TEXT_NAMES.has(name) || name.startsWith('.env.')) return 'text'
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return 'unsupported'
  const extension = name.slice(dot + 1)
  if (MEDIA_EXTENSIONS.has(extension)) return 'media'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'unsupported'
}

/**
 * `path` (absolute, local) as a `file:` URL, each segment percent-encoded; `null` for a relative
 * path and for a network or device path (`\\host\share`, `\\?\`, `//host`), which would reach
 * another machine.
 */
export function localFileUrl(path: string): string | null {
  if (/^[\\/]{2}/.test(path)) return null
  const drive = /^([A-Za-z]):[\\/]/.exec(path)
  let segments: string[]
  let prefix: string
  if (drive) {
    prefix = `file:///${drive[1]!.toUpperCase()}:`
    segments = path.slice(3).split(/[\\/]/)
  } else if (path.startsWith('/')) {
    prefix = 'file://'
    segments = path.slice(1).split(/[\\/]/)
  } else {
    return null
  }
  const kept = segments.filter(segment => segment !== '' && segment !== '.')
  if (kept.includes('..')) return null
  return `${prefix}/${kept.map(encodeURIComponent).join('/')}`
}
