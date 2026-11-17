/**
 * `/plugins validate <folder>`: the static check of a mod folder, for the person
 * (F-25). The same validator as the `ModValidate` tool; this renders its report as
 * slash-command parts. Event names, calls and paths stay literal, and so do the
 * loader's and the compiler's reasons, which carry no catalog entry.
 */

import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import type { ModValidateReport, ModValidateLevel } from '../mods/modValidate'
import type { MessageKey } from '../browser/webview/i18n/messages/en'
import { relativeRuntimePath } from '../utils/runtimePaths'
import { BLOCK, key, text, title } from './systemMessageParts'

const LEVEL_KEYS: Record<ModValidateLevel, MessageKey> = {
  refused: 'slash.out.modValidate.level.refused',
  error: 'slash.out.modValidate.level.error',
  warning: 'slash.out.modValidate.level.warning',
  note: 'slash.out.modValidate.level.note',
}

export const code = (value: string): string => `\`${value.replace(/`/g, "'")}\``

/** The report as the person reads it. */
export function modValidateReportParts(report: ModValidateReport): SystemMessagePart[] {
  const where = (file: string | undefined, line?: number): string => {
    if (!file) return ''
    const shown = file === report.folder || !file.startsWith(report.folder) ? file : relativeRuntimePath(report.folder, file).replace(/\\/g, '/')
    return line !== undefined ? `${shown}:${line}` : shown
  }
  const count = (level: ModValidateLevel) => report.findings.filter(finding => finding.level === level).length
  const parts: SystemMessagePart[] = [
    ...title(
      report.plugin
        ? key('slash.out.modValidate.title', { name: report.plugin, folder: report.folder })
        : key('slash.out.modValidate.titleFolder', { folder: report.folder }),
    ),
    text(BLOCK),
    report.ok
      ? key('slash.out.modValidate.passed')
      : key('slash.out.modValidate.failed', { refused: count('refused'), errors: count('error') }),
  ]
  const list = (heading: MessageKey, items: readonly string[]): void => {
    if (items.length === 0) return
    parts.push(text(BLOCK), key(heading), text(`\n- ${items.join('\n- ')}`))
  }
  for (const module of report.modules) {
    parts.push(
      text(`${BLOCK}#### `),
      key(module.kind === 'provider' ? 'slash.out.modValidate.providerModule' : 'slash.out.modValidate.hooksModule'),
      text(` ${code(where(module.path))}`),
    )
    if (module.hooks.length === 0) {
      parts.push(text(BLOCK), key('slash.out.modValidate.noHooks'))
    } else {
      parts.push(text(BLOCK), key('slash.out.modValidate.hooks'))
      for (const hook of module.hooks) {
        parts.push(text(`\n- ${code(hook.event)} ${where(hook.file, hook.line)}`))
        if (hook.form === 'generator') parts.push(text(' · '), key('slash.out.modValidate.markGenerator'))
        if (hook.guards) parts.push(text(' · '), key('slash.out.modValidate.markGuard'))
        if (hook.hasCatch) parts.push(text(' · '), key('slash.out.modValidate.markCatch'))
      }
    }
    list('slash.out.modValidate.calls', module.calls.map(call => code(`$.${call}`)))
    list('slash.out.modValidate.engineAdds', module.engineCreate.flatMap(step => step.adds.map(noun => code(`$.${noun}`))))
    list('slash.out.modValidate.stateReads', (module.state?.reads ?? []).map(name => code(`${name.plugin}/${name.key}`)))
    list('slash.out.modValidate.stateWrites', (module.state?.writes ?? []).map(name => code(`${name.plugin}/${name.key}`)))
  }
  parts.push(text(BLOCK))
  if (report.findings.length === 0) {
    parts.push(key('slash.out.modValidate.noFindings'))
    return parts
  }
  parts.push(key('slash.out.modValidate.findings'))
  for (const finding of report.findings) {
    const at = where(finding.file, finding.line)
    parts.push(
      text('\n- '),
      key(LEVEL_KEYS[finding.level]),
      text(`${at ? ` ${code(at)}` : ''}: `),
      finding.detail ? key(finding.detail.key, finding.detail.params) : text(finding.message),
    )
  }
  return parts
}
