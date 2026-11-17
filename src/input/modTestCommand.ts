/**
 * `/plugins test <folder>`: a mod folder's own tests, for the person (F-25).
 * The same runner as the `ModTest` tool; this renders its report as
 * slash-command parts. Test names, failure messages and paths stay literal.
 */

import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import type { ModTestReport } from '../mods/testKit/modTestRunner'
import { relativeRuntimePath } from '../utils/runtimePaths'
import { BLOCK, key, text, title } from './systemMessageParts'

const code = (value: string): string => `\`${value.replace(/`/g, "'")}\``

/** The report as the person reads it. */
export function modTestReportParts(report: ModTestReport): SystemMessagePart[] {
  const shown = (file: string): string =>
    file.startsWith(`${report.folder}/`) ? relativeRuntimePath(report.folder, file).replace(/\\/g, '/') : file
  const parts: SystemMessagePart[] = [...title(key('slash.out.modTest.title', { folder: report.folder }))]
  if (report.files.length === 0) {
    parts.push(text(BLOCK), key('slash.out.modTest.noFiles'))
    return parts
  }
  for (const file of report.files) {
    parts.push(text(`${BLOCK}#### ${code(shown(file.file))}`))
    if (file.error !== undefined) parts.push(text('\n- ✗ '), key('slash.out.modTest.fileError', { error: file.error }))
    for (const test of file.tests) {
      if (test.ok) {
        parts.push(text(`\n- ✓ ${test.name}`))
        continue
      }
      const at = test.at ? ` ${code(`${shown(test.at.file)}:${test.at.line}`)}` : ''
      parts.push(text(`\n- ✗ ${test.name}${at}: ${test.message ?? ''}`))
    }
  }
  parts.push(
    text(BLOCK),
    report.failed === 0
      ? key('slash.out.modTest.passed', { passed: report.passed })
      : key('slash.out.modTest.failed', { passed: report.passed, failed: report.failed }),
  )
  return parts
}
