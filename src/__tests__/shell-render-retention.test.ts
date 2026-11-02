import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../browser/webview/MultiSessionShell.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('shell.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const shell = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'MultiSessionShell')!
const names = new Set(['subAgentRowsSeenRef', 'subAgentRowsForSession', 'handleConfirmDeleteProject'])
const declarations: string[] = []
function collect(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && names.has(node.name.getText(file))) {
    declarations.push(`const ${node.getText(file)};`)
  }
  ts.forEachChild(node, collect)
}
collect(shell)
const factories = file.statements.filter(node => ts.isFunctionDeclaration(node) && (
  node.name?.text === 'createShellSubAgentRowsForSession' || node.name?.text === 'createShellHandleConfirmDeleteProject'
)).map(node => node.getText(file)).join('\n')

function runProduction(minify: boolean) {
  const program = `
    import React, { useCallback, useMemo, useRef } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Window } from 'happy-dom';
    const window = new Window();
    globalThis.window = window;
    globalThis.document = window.document;
    const normalizeProjectPath = path => path.toLowerCase();
    const removed = [];
    const removeProject = path => removed.push(path);
    const deleted = [];
    const handleDeleteThread = id => deleted.push(id);
    const setProjectDeleteTarget = () => {};
    const filterSubAgentRowsBySession = (rows, id) => rows.filter(row => row.sessionId === id);
    const subAgentsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    ${factories}
    let current;
    function Shell({ sessions, subAgentRows, payload, activeSessionId }) {
      ${declarations.join('\n')}
      const renderThread = () => ({ payload, rows: subAgentRowsForSession, remove: handleConfirmDeleteProject });
      current = { rows: subAgentRowsForSession, remove: handleConfirmDeleteProject, renderThread };
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const refs = [];
    let sessions = [{sessionId:'active', projectRoot:'D:/project'}, {sessionId:'other', projectRoot:'d:/project'}];
    let rows = [{sessionId:'active', value:0}];
    let previous, stableRows = true, stableDelete = true, freshRows = true;
    for (let i = 0; i < 1000; i++) {
      if (i % 2 === 0) rows = [{sessionId:'active', value:i}];
      else sessions = sessions.map(session => ({...session}));
      const payload = { iteration:i, data:new Array(100).fill(i) };
      refs.push(new WeakRef(payload));
      flushSync(() => root.render(React.createElement(Shell, {sessions, subAgentRows:rows, payload, activeSessionId:'active'})));
      if (previous) {
        if (i % 2) stableRows &&= previous.rows === current.rows;
        else stableDelete &&= previous.remove === current.remove;
      }
      freshRows &&= current.rows('active')[0].value === i - i % 2;
      previous = current;
    }
    current.remove('D:/project');
    await new Promise(resolve => setTimeout(resolve, 20));
    for (let i = 0; i < 4; i++) { global.gc(); await new Promise(resolve => setImmediate(resolve)); }
    console.log(JSON.stringify({alive:refs.filter(ref=>ref.deref()).length, latest:current.renderThread().payload.iteration, stableRows, stableDelete, freshRows, deleted, removed}));
    root.unmount();
    process.exit(0);
  `
  const compiled = ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const executable = minify ? transformSync(compiled, { minify: true, format: 'esm', target: 'es2022' }).code : compiled
  return JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', executable], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 30_000,
  }).trim())
}

describe('shell callback lifetime', () => {
  it.each([false, true])('releases obsolete render payloads while preserving memo identity and action semantics (minified: %s)', minify => {
    const result = runProduction(minify)
    expect(result.alive).toBeLessThanOrEqual(10)
    expect(result).toMatchObject({ latest: 999, stableRows: true, stableDelete: true, freshRows: true,
      deleted: ['other', 'active'], removed: ['D:/project'] })
  })

  it('initializes every local factory input before reading it', () => {
    const positions = new Map<string, number>()
    function bindings(node: ts.Node) {
      if (ts.isVariableDeclaration(node)) {
        function bind(name: ts.Node) {
          if (ts.isIdentifier(name)) positions.set(name.text, node.end)
          else ts.forEachChild(name, bind)
        }
        bind(node.name)
      }
      ts.forEachChild(node, bindings)
    }
    bindings(shell)
    const late: string[] = []
    function inputs(node: ts.Node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text.startsWith('createShell')) {
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && (positions.get(arg.text) ?? 0) > node.pos) late.push(arg.text)
        }
      }
      ts.forEachChild(node, inputs)
    }
    inputs(shell)
    expect(late).toEqual([])
  })

  it('creates memoized callbacks outside the shell render scope', () => {
    const violations: number[] = []
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'useCallback') {
        violations.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
      }
      ts.forEachChild(node, visit)
    }
    visit(shell)
    expect(violations).toEqual([])
  })
})
