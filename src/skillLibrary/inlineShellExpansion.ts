
import type { ToolCallContext } from '../toolkit/toolCallContext'
import { createBashHookCommandRunner } from '../lifecycleHooks/hookCommandRunner'
import { isLocalAccessConfined } from '../permissions/chatLocalAccess'

export type PromptShellRunner = (
  command: string,
) => Promise<{ stdout: string; exitCode: number }>

// Fenced form: a code block opened with ```! whose body is the command.
const FENCED_SHELL_RE = /```!\s*\n?([\s\S]*?)\n?```/g

// Inline form: !`cmd`, only at line start or after whitespace.
const BACKTICK_SHELL_RE = /(?<=^|\s)!`([^`]+)`/gm

const SHELL_EXPANSION_TIMEOUT_MS = 30_000

function renderShellResult(result: { stdout: string; exitCode: number }): string {
  const trimmed = result.stdout.trim()
  if (trimmed) {
    return trimmed
  }
  if (result.exitCode !== 0) {
    return `[Error: command exited ${result.exitCode}]`
  }
  return ''
}

// Replaces each shell snippet in `text` with its output. Commands run in
// parallel; a failure becomes an inline error marker rather than throwing.
export async function expandShellSnippets(
  text: string,
  runner: PromptShellRunner,
): Promise<string> {
  let result = text

  const blockMatches = [...text.matchAll(FENCED_SHELL_RE)]
  const inlineMatches = text.includes('!`')
    ? [...text.matchAll(BACKTICK_SHELL_RE)]
    : []

  await Promise.all(
    [...blockMatches, ...inlineMatches].map(async match => {
      const command = match[1]?.trim()
      if (!command) {
        return
      }
      let output: string
      try {
        output = renderShellResult(await runner(command))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        output = `[Error: ${message}]`
      }
      result = result.replace(match[0], () => output)
    }),
  )

  return result
}

// Expands shell snippets in a skill body. Skipped in plan mode, in a chat
// session, and when no shell runner is available, leaving the body as written.
export async function expandSkillBodyShell(
  body: string,
  context: ToolCallContext,
): Promise<string> {
  if (!body.includes('!`') && !body.includes('```!')) {
    return body
  }

  if (context.readAppState().permissionRules.mode === 'plan') {
    return body
  }

  if (isLocalAccessConfined(context.options.templateType)) {
    return body
  }

  const hookRunner = createBashHookCommandRunner(context)
  if (!hookRunner) {
    return body
  }

  const runner: PromptShellRunner = command =>
    hookRunner({
      command,
      stdin: '',
      env: {},
      timeoutMs: SHELL_EXPANSION_TIMEOUT_MS,
    })

  return expandShellSnippets(body, runner)
}
