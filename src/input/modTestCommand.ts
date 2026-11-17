/**
 * `/plugins test <folder>`: a mod folder's own tests, for the person (F-25).
 * The same runner as the `ModTest` tool; this renders its report as
 * slash-command parts. Test names, failure messages and paths stay literal.
 */

import type { SystemMessagePart } from '../runtime/RuntimeTypes'
import type { ModTestFile, ModTestReport } from '../mods/testKit/modTestRunner'
import { relativeRuntimePath } from '../utils/runtimePaths'
import { code } from './modValidateCommand'
import { BLOCK, key, text, title } from './systemMessageParts'

function fileErrorPart(file: ModTestFile): SystemMessagePart {
  const detail = file.error ?? ''
  switch (file.errorKind) {
    case 'compile':
      return key('slash.out.modTest.error.compile', { error: detail })
    case 'noWorker':
      return key('slash.out.modTest.error.noWorker', { error: detail })
    case 'timeout':
      return key('slash.out.modTest.error.timeout', { ms: detail })
    case 'noResults':
      return key('slash.out.modTest.error.noResults')
    case 'unreadable':
      return key('slash.out.modTest.error.unreadable', { error: detail })
    default:
      return key('slash.out.modTest.fileError', { error: detail })
  }
}

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
    if (file.error !== undefined) parts.push(text('\n- ✗ '), fileErrorPart(file))
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
