/**
 * The test kit's module as `tsc` sees it (F-25): declared beside the API in
 * the types folder, so a plugin's `*.test.ts` files type-check with the rest.
 * Mirrors `kitRuntime.js`.
 */

const KIT_TYPES = `export type TestBody = () => void | Promise<void>
export function test(name: string, body: TestBody): void
export function it(name: string, body: TestBody): void
export function describe(name: string, body: () => void): void

export interface Matchers {
  toBe(want: unknown): void
  toEqual(want: unknown): void
  toMatchObject(want: unknown): void
  toContain(want: unknown): void
  toMatch(pattern: RegExp | string): void
  toHaveLength(length: number): void
  toBeTruthy(): void
  toBeFalsy(): void
  toBeUndefined(): void
  toBeDefined(): void
  /** Awaits a function's (or a promise's) throw; a pattern tests its message. */
  toThrow(pattern?: RegExp | string): Promise<void>
}
export function expect(actual: unknown): Matchers & { readonly not: Matchers }

export type MockFn<A extends unknown[] = any[], R = any> = ((...args: A) => R) & { readonly calls: A[] }
export const mock: { fn<A extends unknown[] = any[], R = any>(impl?: (...args: A) => R): MockFn<A, R> }

/** One '$' call the plugin made; calls("store.get") filters by noun and method. */
export type RecordedCall = { noun: string; method: string; args: unknown[] }

export type DrawingQuery = string | { type?: string; key?: string; role?: string; text?: string }
export type DrawingNode = { type: string; props?: Record<string, unknown>; children?: unknown[] }

/** A drawing on the desktop surface. Each action settles its handler and redraws before it returns. */
export interface Drawing {
  text(): string
  find(query: DrawingQuery): DrawingNode
  findAll(query: DrawingQuery): DrawingNode[]
  press(query: DrawingQuery): Promise<unknown>
  select(query: DrawingQuery, value: string): Promise<unknown>
  input(query: DrawingQuery, value: string): Promise<unknown>
  submit(query: DrawingQuery, value: string): Promise<unknown>
  redraw(): Promise<unknown>
}

export type PluginSetup = {
  name?: string
  options?: Record<string, unknown>
  store?: Record<string, unknown>
  /** Initial '$.state' values, keyed 'plugin/key' or 'plugin/key/id'. */
  state?: Record<string, unknown>
  env?: Record<string, string>
  messages?: unknown[]
  now?: number
  locale?: string
}

export interface PluginUnderTest {
  readonly name: string
  /** Runs the event's chain: the plugin's hooks, the test's own, then 'below' (default: hands 'e' back). */
  fire(event: string, e: Record<string, unknown>, below?: (e: any) => unknown): Promise<any>
  /** A hook below the plugin's, standing in for the engine. */
  on(pattern: string, matcherOrHook: unknown, hook?: unknown): { catch(handler: unknown): void }
  calls(which?: string): RecordedCall[]
  /** Answers '$.<noun>.<method>' with a value, or with a function of its arguments. */
  stub(which: string, answer: unknown): void
  readonly store: Map<string, unknown>
  stateOf(ref: { plugin: string; key: string; id?: string }): unknown
  readonly env: Record<string, string>
  readonly clock: { now(): number; advance(ms: number): Promise<void> }
  /** Draws a 'ui.render' component; only the desktop surface is drawn. */
  mount(surface: 'desktop', component: string, props?: Record<string, unknown>, options?: { requestId?: string }): Promise<Drawing>
}

export function loadPlugin(register: (on: any, options: any) => unknown, setup?: PluginSetup): PluginUnderTest`

const indent = (text: string): string =>
  text
    .split('\n')
    .map(line => (line === '' ? line : `  ${line}`))
    .join('\n')

/** `declare module "<kit>" { … }` for the types folder. */
export function kitModuleDeclaration(kitSpecifier: string): string {
  return [`declare module ${JSON.stringify(kitSpecifier)} {`, indent(KIT_TYPES), '}'].join('\n')
}
