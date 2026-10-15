import type { ContentBlockParam } from '../runtime/RuntimeTypes'
import {
  splitCommandWord,
  type BrowserSlashCommand,
  type HiddenBrowserSlashCommand,
} from '../input/slashCommandCatalog'

/**
 * Whether a submit prompt is a slash command: true when its text starts
 * with `/` (leading whitespace ignored). A slash command is never injected
 * into a running turn — it waits for the next turn. Shared by the worker
 * (authoritative routing) and the page (whether to show a pending bubble).
 */
export function isSlashCommandPrompt(
  prompt: string | Array<ContentBlockParam>,
): boolean {
  if (typeof prompt === 'string') return prompt.trimStart().startsWith('/')
  const firstText = prompt.find(
    block =>
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string',
  ) as { text: string } | undefined
  return firstText ? firstText.text.trimStart().startsWith('/') : false
}

/**
 * Whether a built-in may run while the session is halted on the user. `false`
 * = it rewrites what the open question hangs on (transcript or permission
 * mode). Every built-in is listed, so a new command must decide.
 */
const HALT_SAFE_BUILTINS: Record<BrowserSlashCommand | HiddenBrowserSlashCommand, boolean> = {
  help: true,
  tabs: true,
  context: true,
  clear: false,
  model: true,
  compact: false,
  // Saves a setting; the transcript and any open question are untouched.
  autocompact: true,
  status: true,
  plan: false,
  'exit-plan': false,
  plugins: true,
  plugin: true,
  marketplace: true,
  mcp: true,
  rename: true,
  cost: true,
  agents: true,
  skills: true,
  hooks: true,
  permissions: true,
  debug: true,
}

/**
 * A built-in slash command that may run under a halt: never starts a model turn
 * and leaves the state the open question hangs on alone (`HALT_SAFE_BUILTINS`).
 * Plain-string prompts only; a `/<skill>` or unknown name is held.
 */
export function isHaltSafeSlashCommandPrompt(
  prompt: string | Array<ContentBlockParam>,
): boolean {
  if (typeof prompt !== 'string' || !isSlashCommandPrompt(prompt)) return false
  const { command } = splitCommandWord(prompt)
  return Object.prototype.hasOwnProperty.call(HALT_SAFE_BUILTINS, command)
    ? HALT_SAFE_BUILTINS[command as keyof typeof HALT_SAFE_BUILTINS]
    : false
}
