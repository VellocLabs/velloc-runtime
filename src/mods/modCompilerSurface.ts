/**
 * Mods — the compiler's SURFACE: the two facts admission needs without the
 * compiler itself (which imports TypeScript lazily and must stay out of the
 * admission chunk). See `modCompiler.ts`.
 */

/** The suffixes a hooks module and the files it imports may have — the
 *  contract's header: ".ts, .tsx, .jsx, .js, .mjs, .cjs, .mts or .cts". */
export const MOD_MODULE_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.jsx',
  '.js',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
])

export function extensionOf(path: string): string {
  const match = /(\.[A-Za-z]+)$/.exec(path)
  return match ? match[1]!.toLowerCase() : ''
}

/**
 * Whether a module's TEXT needs the compiler: anything but plain `.js` / `.mjs`, or
 * such a file that imports (checked on the text, erring loud; `import` as a whole
 * word only, whitespace and comments before its `(` or specifier included). This
 * picks the path, not the verdict: with a compiler, every module's syntax tree is
 * verified (`compileModModule`).
 */
export function needsCompiler(path: string, source: string): boolean {
  const extension = extensionOf(path)
  if (extension !== '.js' && extension !== '.mjs') return true
  return (
    /^[ \t]*import(?:\s*['"{*]|\s+[\w$])/m.test(source) ||
    /^[ \t]*export[ \t][^;\n]*\bfrom\b/m.test(source) ||
    /^[ \t]*export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\b/m.test(source) ||
    // A line comment ends only at its newline, so a run of slashes splits one way.
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*\(/.test(source)
  )
}
