import { latestAssessment } from './ledger-lookups'
import type { ReportActionReceipt, ReportAssessment, ReportDiagnostic, ReportEvidence, ReportSnapshot, ReportUnverified } from './report-store'

export interface PresentedDiagnostic {
  diagnostic: ReportDiagnostic
  evidence: ReportEvidence[]
  assessment?: ReportAssessment
  actions: ReportActionReceipt[]
}
export interface ReviewReportProjection {
  run: ReportSnapshot['run']
  report: PresentedDiagnostic[]
  /** Refused candidates for people to check; not findings, never repaired or published. */
  unverified: ReportUnverified[]
  actions: ReportActionReceipt[]
  coverage: ReportSnapshot['coverage']
  verifications: ReportSnapshot['verifications']
  structured: boolean
  summary: 'complete-empty' | 'partial-empty' | 'findings' | 'unstructured'
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
export function projectReviewReport(snapshot: ReportSnapshot): ReviewReportProjection {
  const report = snapshot.retainedIds.map(id => {
    const diagnostic = snapshot.diagnostics.find(item => item.id === id)
    if (!diagnostic) throw new Error('invalid-report-reference')
    return {
      diagnostic,
      evidence: snapshot.evidence.filter(item => item.diagnosticId === id),
      assessment: latestAssessment(snapshot, id),
      actions: snapshot.actions.filter(item => item.diagnosticIds.includes(id)),
    }
  })
  const complete = snapshot.coverage.complete && !['partial', 'cancelled', 'failed'].includes(snapshot.run.progress.status)
  const summary = !snapshot.structured ? 'unstructured' : report.length ? 'findings' : complete ? 'complete-empty' : 'partial-empty'
  return freeze(structuredClone({ run: snapshot.run, report, unverified: snapshot.unverified ?? [], actions: snapshot.actions,
    coverage: { ...snapshot.coverage, complete }, verifications: snapshot.verifications ?? [], structured: snapshot.structured, summary }))
}
export function presentReviewJson(snapshot: ReportSnapshot): string {
  return JSON.stringify(projectReviewReport(snapshot))
}
// Contract: labels and status text are supplied by the caller's locale catalog.
export interface ReviewTerminalLabels {
  summary: (kind: ReviewReportProjection['summary'], count: number) => string
  status: (run: ReportSnapshot['run']) => string
  classification: (diagnostic: ReportDiagnostic) => string
  assessment: (assessment: ReportAssessment) => string
  action: (action: ReportActionReceipt) => string
  verification?: (verification: ReportSnapshot['verifications'][number]) => string
  omitted: (count: number) => string
  limitations: (limitations: string[]) => string
  scenario: (text: string) => string
}
export function presentReviewTerminal(snapshot: ReportSnapshot, labels: ReviewTerminalLabels): string {
  const view = projectReviewReport(snapshot)
  const lines = [labels.status(view.run), labels.summary(view.summary, view.report.length)]
  view.report.forEach((entry, index) => {
    const { diagnostic: d } = entry
    const location = `${d.anchor.path}${d.anchor.span ? `:${d.anchor.span.start}${d.anchor.span.end !== d.anchor.span.start ? `-${d.anchor.span.end}` : ''}` : ''}`
    lines.push(`${index + 1}. ${labels.classification(d)} ${d.claim.title}`, location,
      d.claim.explanation, labels.scenario(d.claim.trigger))
    if (entry.assessment) lines.push(labels.assessment(entry.assessment))
    for (const evidence of entry.evidence) lines.push(evidence.excerpt, evidence.reason)
  })
  for (const action of view.actions) lines.push(labels.action(action))
  if (labels.verification) for (const verification of view.verifications) lines.push(labels.verification(verification))
  if (view.run.progress.omittedByLimit) lines.push(labels.omitted(view.run.progress.omittedByLimit))
  if (view.coverage.limitations.length) lines.push(labels.limitations(view.coverage.limitations))
  return lines.join('\n')
}
