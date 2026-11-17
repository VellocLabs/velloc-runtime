// Writes src/mods/modApiShapes.generated.ts: the type declarations a mod's
// hooks see (event inputs and results, `ui.render` props, the chain's
// vocabulary), copied from the Velloc sources the table in
// src/mods/modEventShapes.ts names, with every type they reach. Run
// `npm run mods:api-shapes` after changing one of them;
// mod-api-declaration.test.ts fails while the checked-in file is stale.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { isMainModule } from './lib/isMainModule.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SHAPES_SOURCE = path.join(repoRoot, 'src', 'mods', 'modEventShapes.ts')
export const SHAPES_OUTPUT = path.join(repoRoot, 'src', 'mods', 'modApiShapes.generated.ts')

/** The names the declaration starts from; everything they reach follows. */
const ROOTS: ReadonlyArray<{ file: string; name: string }> = [
  { file: 'modEventShapes.ts', name: 'ModEventShapes' },
  { file: 'modEventShapes.ts', name: 'ModRenderProps' },
  { file: 'modEventShapes.ts', name: 'ModRenderFrame' },
  { file: 'modTypes.ts', name: 'Origin' },
  { file: 'modTypes.ts', name: 'TraceEntry' },
  { file: 'modTypes.ts', name: 'NextBudget' },
  { file: 'modTypes.ts', name: 'HookFailure' },
  { file: 'modTypes.ts', name: 'TargetTier' },
]

type Emitted = { name: string; file: string; text: string }

/** The declarations' text, sorted by name, each one `export`ed. Throws when
 *  two different declarations reached share a name. */
export function generateModApiShapes(): string {
  const program = ts.createProgram([SHAPES_SOURCE], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
  })
  const checker = program.getTypeChecker()
  const srcRoot = path.join(repoRoot, 'src').replace(/\\/g, '/').toLowerCase()
  const isOwnSource = (file: ts.SourceFile): boolean =>
    file.fileName.replace(/\\/g, '/').toLowerCase().startsWith(`${srcRoot}/`)

  const emitted = new Map<string, Emitted>()
  const queue: ts.Declaration[] = []

  const rootFile = (name: string): ts.SourceFile => {
    const file = program.getSourceFile(path.join(repoRoot, 'src', 'mods', name))
    if (!file) throw new Error(`gen_mod_api_shapes: ${name} is not in the program`)
    return file
  }
  for (const root of ROOTS) {
    const file = rootFile(root.file)
    const declaration = file.statements.find(
      (statement): statement is ts.TypeAliasDeclaration | ts.InterfaceDeclaration =>
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        statement.name.text === root.name,
    )
    if (!declaration) throw new Error(`gen_mod_api_shapes: ${root.file} declares no ${root.name}`)
    queue.push(declaration)
  }

  const record = (name: string, file: ts.SourceFile, text: string): boolean => {
    const where = path.relative(repoRoot, file.fileName).replace(/\\/g, '/')
    const prior = emitted.get(name)
    if (prior) {
      if (prior.file !== where) {
        throw new Error(`gen_mod_api_shapes: ${name} is declared in both ${prior.file} and ${where}`)
      }
      return false
    }
    emitted.set(name, { name, file: where, text })
    return true
  }

  const resolve = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol

  const visitReference = (node: ts.EntityName): void => {
    const symbol = resolve(checker.getSymbolAtLocation(node))
    if (!symbol || symbol.flags & ts.SymbolFlags.TypeParameter) return
    for (const declaration of symbol.declarations ?? []) {
      const file = declaration.getSourceFile()
      if (!isOwnSource(file)) continue
      if (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
        queue.push(declaration)
      } else if (ts.isClassDeclaration(declaration) || ts.isEnumDeclaration(declaration)) {
        record(symbol.name, file, `export type ${symbol.name} = unknown`)
      }
    }
  }

  /** Each `typeof X` beneath `node`, which the API module has no value for. */
  const queriesOf = (node: ts.Node, out: ts.TypeQueryNode[] = []): ts.TypeQueryNode[] => {
    if (ts.isTypeQueryNode(node)) out.push(node)
    else ts.forEachChild(node, child => void queriesOf(child, out))
    return out
  }

  const walk = (node: ts.Node): void => {
    if (ts.isTypeQueryNode(node)) return
    if (ts.isTypeReferenceNode(node)) visitReference(node.typeName)
    else if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) visitReference(node.expression)
    ts.forEachChild(node, walk)
  }

  while (queue.length > 0) {
    const declaration = queue.shift() as ts.TypeAliasDeclaration | ts.InterfaceDeclaration
    const file = declaration.getSourceFile()
    const start = declaration.getStart(file)
    let body = declaration.getText(file)
    // A `typeof X` is written as the type X has.
    for (const query of queriesOf(declaration).reverse()) {
      const type = checker.getTypeAtLocation(query)
      const text = checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
      body = `${body.slice(0, query.getStart(file) - start)}(${text})${body.slice(query.getEnd() - start)}`
    }
    body = body.replace(/^export\s+/, '')
    if (!record(declaration.name.text, file, `export ${stripComments(body)}`)) continue
    walk(declaration)
  }

  return [...emitted.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => entry.text)
    .join('\n')
}

/** `text` without its comments: the declaration states shapes, not prose. */
function stripComments(text: string): string {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  const file = ts.createSourceFile('decl.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  return file.statements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, file)).join('\n')
}

/** The checked-in module's full text for `shapes`. */
export function shapesModuleText(shapes: string): string {
  return [
    '// Generated by scripts/gen_mod_api_shapes.ts from src/mods/modEventShapes.ts. Do not edit.',
    `export const MOD_API_SHAPES = ${JSON.stringify(shapes)}`,
    '',
  ].join('\n')
}

if (isMainModule(import.meta.url)) {
  const next = shapesModuleText(generateModApiShapes())
  let prior = ''
  try {
    prior = readFileSync(SHAPES_OUTPUT, 'utf8')
  } catch {
    prior = ''
  }
  if (prior === next) {
    console.log(`${path.relative(repoRoot, SHAPES_OUTPUT)} is current`)
  } else {
    writeFileSync(SHAPES_OUTPUT, next)
    console.log(`wrote ${path.relative(repoRoot, SHAPES_OUTPUT)}`)
  }
}
