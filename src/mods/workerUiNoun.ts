/**
 * `$.ui` in the mod worker (F-25): `resolve` hands render hooks their element
 * constructors; the handlers those elements hold stay in this worker under
 * `press.handle`, run on `mod.runHandle`. The other `$.ui` methods cross as calls.
 */

import type { ModRunHandleMessage } from './modWire'
import { DESKTOP_ELEMENTS, RENDER_SURFACE } from './modRender'
import type { Invocation } from './ModWorkerHost'

export type WorkerUiNounDeps = {
  /** The loaded plugin's name, read at each use (it changes on `mod.load`). */
  readonly plugin: string
  callRuntime: (invocation: Invocation | undefined, noun: string, method: string, args: unknown[]) => Promise<unknown>
  post: (message: Record<string, unknown>) => void
  deepFreeze: <T>(value: T) => T
  errorMessage: (error: unknown) => string
}

export function createWorkerUiNoun(deps: WorkerUiNounDeps): {
  handles: Map<number, { element: string; fns: Record<string, (...args: unknown[]) => unknown> }>
  makeUi: (invocation: Invocation | undefined) => unknown
  settleHandles: (invocation: Invocation, event: string, result: unknown) => void
  runHandle: (msg: ModRunHandleMessage) => Promise<void>
} {
  const { callRuntime, post, deepFreeze, errorMessage } = deps

  // `$.ui.resolve(e)`: element constructors for render hooks. Handlers stay in this
  // worker under `press.handle`, dropped when the drawing is replaced and pruned to
  // the ones the returned tree holds.

  type Handle = { element: string; fns: Record<string, (...args: unknown[]) => unknown> }
  const handles = new Map<number, Handle>()
  const createdIn = new Map<string, Set<number>>()
  let nextHandle = 0

  const keepHandle = (
    invocation: Invocation | undefined,
    element: string,
    fns: Record<string, (...args: unknown[]) => unknown>,
  ): number => {
    const id = ++nextHandle
    handles.set(id, { element, fns })
    if (invocation) {
      let set = createdIn.get(invocation.id)
      if (!set) {
        set = new Set()
        createdIn.set(invocation.id, set)
      }
      set.add(id)
    }
    return id
  }

  /** The handles a tree holds that are THIS plugin's. */
  const handlesOf = (tree: unknown): Set<number> => {
    const out = new Set<number>()
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      const record = node as { press?: unknown; children?: unknown }
      const press = record.press as { plugin?: unknown; handle?: unknown } | undefined
      if (press && typeof press === 'object' && press.plugin === deps.plugin && typeof press.handle === 'number') {
        out.add(press.handle)
      }
      if (Array.isArray(record.children)) for (const child of record.children) visit(child)
    }
    visit(tree)
    return out
  }

  /** An invocation is over: of the handles it made, keep those its `ui.render`
   *  answer holds, forget the rest. */
  const settleHandles = (invocation: Invocation, event: string, result: unknown): void => {
    const made = createdIn.get(invocation.id)
    if (!made) return
    createdIn.delete(invocation.id)
    const kept = event === 'ui.render' ? handlesOf(result) : new Set<number>()
    for (const id of made) if (!kept.has(id)) handles.delete(id)
  }

  /** JSX children as the element holds them: flat, the dropped values gone,
   *  numbers as their strings. */
  const kidsOf = (children: unknown): unknown[] =>
    [children]
      .flat(Infinity)
      .filter(child => child !== null && child !== undefined && child !== false && child !== true)
      .map(child => (typeof child === 'number' ? String(child) : child))

  const withoutChildren = (props: unknown): Record<string, unknown> => {
    const { children: _children, ...rest } = (props ?? {}) as Record<string, unknown>
    return rest
  }

  const makeElements = (invocation: Invocation | undefined): Record<string, unknown> => {
    const styled = (type: 'Box' | 'Text') => (props: unknown) => ({
      type,
      props: withoutChildren(props),
      children: kidsOf((props as { children?: unknown } | null | undefined)?.children),
    })
    const leaf = (type: string) => (props: unknown) => ({ type, props: withoutChildren(props) })
    const table: Record<string, unknown> = {
      Box: styled('Box'),
      Text: styled('Text'),
      Button: (props: unknown) => {
        const { onPress, ...rest } = withoutChildren(props) as { onPress?: unknown } & Record<string, unknown>
        if (typeof onPress !== 'function') throw new TypeError('Button: onPress is not a function')
        const kids = kidsOf((props as { children?: unknown } | null | undefined)?.children)
        const oneString = typeof rest.label !== 'string' && kids.length === 1 && typeof kids[0] === 'string'
        const label = typeof rest.label === 'string' ? rest.label : oneString ? (kids[0] as string) : undefined
        if (label === undefined && kids.length === 0) throw new TypeError('Button: a label, or children, is required')
        const key = typeof rest.key === 'string' ? rest.key : label
        const handle = keepHandle(invocation, 'Button', { default: onPress as (...args: unknown[]) => unknown })
        const drawn = oneString || kids.length === 0 ? {} : { children: kids }
        return { type: 'Button', props: { ...rest, key, label }, press: { plugin: deps.plugin, handle }, ...drawn }
      },
      Input: (props: unknown) => {
        const { onInput, onSubmit, ...rest } = withoutChildren(props) as {
          onInput?: unknown
          onSubmit?: unknown
        } & Record<string, unknown>
        if (typeof onSubmit !== 'function') throw new TypeError('Input: onSubmit is not a function')
        if (onInput !== undefined && typeof onInput !== 'function') {
          throw new TypeError('Input: onInput is not a function')
        }
        const fns: Record<string, (...args: unknown[]) => unknown> = {
          submit: onSubmit as (...args: unknown[]) => unknown,
        }
        if (typeof onInput === 'function') fns.change = onInput as (...args: unknown[]) => unknown
        const handle = keepHandle(invocation, 'Input', fns)
        return { type: 'Input', props: rest, press: { plugin: deps.plugin, handle } }
      },
      Select: (props: unknown) => {
        const { onSelect, ...rest } = withoutChildren(props) as { onSelect?: unknown } & Record<string, unknown>
        if (typeof onSelect !== 'function') throw new TypeError('Select: onSelect is not a function')
        const handle = keepHandle(invocation, 'Select', { default: onSelect as (...args: unknown[]) => unknown })
        return { type: 'Select', props: rest, press: { plugin: deps.plugin, handle } }
      },
      Svg: leaf('Svg'),
      Link: (props: unknown) => ({
        type: 'Link',
        props: withoutChildren(props),
        children: kidsOf((props as { children?: unknown } | null | undefined)?.children),
      }),
      Code: leaf('Code'),
      Progress: leaf('Progress'),
      Markdown: (props: unknown) => {
        const { onLinkPress, ...rest } = withoutChildren(props) as { onLinkPress?: unknown } & Record<string, unknown>
        if (onLinkPress === undefined) return { type: 'Markdown', props: rest }
        if (typeof onLinkPress !== 'function') throw new TypeError('Markdown: onLinkPress is not a function')
        const handle = keepHandle(invocation, 'Markdown', { default: onLinkPress as (...args: unknown[]) => unknown })
        return { type: 'Markdown', props: rest, press: { plugin: deps.plugin, handle } }
      },
    }
    for (const name of Object.keys(table)) {
      if (!(DESKTOP_ELEMENTS as readonly string[]).includes(name)) delete table[name]
    }
    return Object.freeze(table)
  }

  /** `$.ui`: `resolve` is a read served here; the rest cross as calls. */
  const makeUi = (invocation: Invocation | undefined): unknown => {
    let elements: Record<string, unknown> | undefined
    const local = {
      resolve: (e: unknown): unknown => {
        const surface = e && typeof e === 'object' ? (e as { surface?: unknown }).surface : undefined
        if (surface !== RENDER_SURFACE) {
          throw new TypeError(
            `$.ui.resolve(e): e is not this surface's ui.render argument (surface ${JSON.stringify(surface)})`,
          )
        }
        elements ??= makeElements(invocation)
        return elements
      },
    }
    return new Proxy(Object.freeze(local), {
      get: (target, method) => {
        if (typeof method !== 'string' || method === 'then') return undefined
        if (Object.prototype.hasOwnProperty.call(target, method)) {
          return target[method as keyof typeof target]
        }
        return (...args: unknown[]) => callRuntime(invocation, 'ui', method, args)
      },
    })
  }

  const runHandle = async (msg: ModRunHandleMessage): Promise<void> => {
    const held = handles.get(msg.handle)
    const fn = held?.fns[msg.which ?? 'default']
    if (!held || !fn) {
      post({
        type: 'mod.handleResult',
        runId: msg.runId,
        ok: false,
        error: { name: 'Error', message: `no such handler: ${msg.handle}${msg.which ? ` (${msg.which})` : ''}` },
      })
      return
    }
    try {
      await fn(...(msg.args ?? []).map(arg => deepFreeze(arg)))
      post({ type: 'mod.handleResult', runId: msg.runId, ok: true })
    } catch (error) {
      post({
        type: 'mod.handleResult',
        runId: msg.runId,
        ok: false,
        error: {
          name: error instanceof Error && error.name ? error.name : 'Error',
          message: `a ${held.element} handler failed: ${errorMessage(error)}`,
        },
      })
    }
  }

  return { handles, makeUi, settleHandles, runHandle }
}
