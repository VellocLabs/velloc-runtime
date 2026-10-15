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
 * word only).
 */
export function needsCompiler(path: string, source: string): boolean {
  const extension = extensionOf(path)
  if (extension !== '.js' && extension !== '.mjs') return true
  return (
    /^[ \t]*import(?:[ \t]*['"{*]|[ \t]+[\w$])/m.test(source) ||
    /^[ \t]*export[ \t][^;\n]*\bfrom\b/m.test(source) ||
    /\bimport[ \t]*\(/.test(source)
  )
}
