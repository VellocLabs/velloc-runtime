import { Buffer } from 'node:buffer'
import { afterEach, beforeEach } from 'vitest'
import { clearConversationStore } from '../sessions/sessionStore'
import { resetProcessFs } from '../utils/fs/runtimeFs'
import { getRoutineSchedulerSingleton } from '../routines/runtimeSingletons'
import { en } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { de } from '../browser/webview/i18n/messages/de'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'
import { setCatalog } from '../browser/webview/i18n/translate'

// Catalogs are FETCHED at runtime (see i18n/translate.ts — they ship as
// content-hashed JSON assets, not JS imports), but tests call
// `createTranslate(locale)` synchronously and assert real translated text.
// Install all seven up front so every `t()` in the suite resolves exactly
// what the browser would, with no per-test fetch arrangement.
//
// Importing them HERE is fine and is the point: a test file is not the app
// bundle, so this cannot put the catalogs back into the shipped JS graph.
setCatalog('en', en)
setCatalog('zh', zh)
setCatalog('es', es)
setCatalog('fr', fr)
setCatalog('de', de)
setCatalog('ja', ja)
setCatalog('ko', ko)

if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (value: string) =>
    Buffer.from(value, 'base64').toString('binary')
}

if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (value: string) =>
    Buffer.from(value, 'binary').toString('base64')
}

// The routine runtime's 30s RoutineScheduler interval has no teardown; stop it around every test so it cannot leak
// across files (`beforeEach` also catches one started by an unawaited `bootRoutineRuntimeOnce()`).
function stopLeakedRoutineScheduler(): void {
  getRoutineSchedulerSingleton()?.stop()
}

beforeEach(stopLeakedRoutineScheduler)

afterEach(() => {
  stopLeakedRoutineScheduler()
  clearConversationStore()
  resetProcessFs()
})
