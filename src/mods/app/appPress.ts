/**
 * A background module's answer to `app.press` (F-40), read into the intent
 * the pressing page carries out.
 * Security: the module names a server by its own manifest's key, and only an
 * http server of that manifest resolves to a URL; the intents are a closed
 * set, so an answer can ask the page for nothing else.
 */

import { readAppPressMenuItems, type AppPressIntent, type AppPressTrigger } from '../../browser/runtimeProtocol/modApps'

/** The budget of an `app.press` hook: the press waits on it. */
export const APP_PRESS_TIMEOUT_MS = 500

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The intent of a hook's answer, or null for no answer: the first of `open`,
 * `signIn`, `signOut`, `menu`, `handled` the answer has decides, and a value
 * of that key that is not well formed is no answer. `urls` maps the plugin's
 * http server keys to their URLs. A menu answered to a `menu` press is no
 * answer, so menus do not nest; a sign-out is one on a `menu` press alone,
 * so the person is signed out only by an item they picked.
 */
export function readAppPressAnswer(answer: unknown, trigger: AppPressTrigger, urls: ReadonlyMap<string, string>): AppPressIntent | null {
  if (!isRecord(answer)) return null
  if ('open' in answer) return answer.open === true ? { kind: 'open' } : null
  if ('signIn' in answer) {
    const url = typeof answer.signIn === 'string' ? urls.get(answer.signIn) : undefined
    if (url === undefined || (answer.then !== undefined && answer.then !== 'open')) return null
    return { kind: 'signIn', url, thenOpen: answer.then === 'open' }
  }
  if ('signOut' in answer) {
    const url = typeof answer.signOut === 'string' ? urls.get(answer.signOut) : undefined
    return url === undefined || trigger !== 'menu' ? null : { kind: 'signOut', url }
  }
  if ('menu' in answer) {
    const items = trigger === 'menu' ? null : readAppPressMenuItems(answer.menu)
    return items ? { kind: 'menu', items } : null
  }
  if ('handled' in answer) return answer.handled === true ? { kind: 'handled' } : null
  return null
}
