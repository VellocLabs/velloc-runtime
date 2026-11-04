import skill from './skill/SKILL.md?raw'
import coordinator from './prompts/coordinator.md?raw'
import angles from './prompts/angles.md?raw'
import recipes from './prompts/recipes.md?raw'
import finder from './prompts/finder.md?raw'
import verifier from './prompts/verifier.md?raw'
import sweeper from './prompts/sweeper.md?raw'
import output from './prompts/output.md?raw'
import actions from './prompts/actions.md?raw'
import verifyHandoff from './prompts/verify-handoff.md?raw'
import { TEN_ANGLES } from './recipes'
import type { ReviewAngle, ReviewCandidate, ReviewPlan } from './contracts'

export type ReviewPromptBlock = Readonly<{
  type: 'text'
  text: string
  provenance: 'trusted-task' | 'repository-material'
  source: string
}>

export interface CoordinatorInputs {
  run_summary: string
  scope_manifest: string
  trusted_guidance: string
  capability_text: string
  budget_text: string
  verification_contract: string
}

export interface FinderInputs {
  scope_manifest: string
  trusted_guidance: string
  assigned_angles: string
  review_material: string
  candidatesPerAngle?: number
}

export interface VerifierInputs {
  scope_manifest: string
  candidate: string
  review_material: string
}

export interface SweeperInputs {
  scope_manifest: string
  existing_findings: string
  review_material: string
}

export interface VerifyHandoffInputs {
  scope_manifest: string
  repair_and_validation_summary: string
}

export interface ReviewActionAuthorization {
  repair: boolean
  publication: boolean
}

export class ReviewCompositionError extends Error {
  constructor(readonly code: 'missing-input' | 'unknown-placeholder' | 'missing-section' | 'blocked-plan' | 'invalid-candidate-limit', readonly field: string) {
    super(`${code}:${field}`)
    this.name = 'ReviewCompositionError'
  }
}

function block(text: string, source: string, provenance: ReviewPromptBlock['provenance'] = 'trusted-task'): ReviewPromptBlock {
  return Object.freeze({ type: 'text', text, provenance, source })
}

function section(resource: string, name: string): string {
  const parts = resource.split(/^## /mu).slice(1)
  const found = parts.find(part => part.slice(0, part.indexOf('\n')).trim() === name)
  if (!found) throw new ReviewCompositionError('missing-section', name)
  return found.slice(found.indexOf('\n')).trim()
}

function render(template: string, name: string, values: ReadonlyMap<string, ReviewPromptBlock>): readonly ReviewPromptBlock[] {
  for (const [key, value] of values) {
    if (typeof value.text !== 'string') throw new ReviewCompositionError('missing-input', key)
  }
  const blocks: ReviewPromptBlock[] = []
  let position = 0
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/gu)) {
    const index = match.index!
    if (index > position) blocks.push(block(template.slice(position, index), name))
    const key = match[1]!
    const value = values.get(key)
    if (!value) throw new ReviewCompositionError('unknown-placeholder', key)
    blocks.push(value)
    position = index + match[0].length
  }
  if (position < template.length) blocks.push(block(template.slice(position), name))
  return Object.freeze(blocks)
}

export function getSelectedAngleText(selected: readonly ReviewAngle[]): string {
  const entries = angles.trim().split(/\n\n(?=Angle: )/u)
  return selected.map(angle => {
    const index = TEN_ANGLES.indexOf(angle)
    if (index < 0 || !entries[index]) throw new ReviewCompositionError('missing-section', angle)
    return entries[index]
  }).join('\n\n')
}

export function getSelectedRecipeText(plan: Pick<ReviewPlan, 'recipe' | 'agentMode'>): string {
  const selected = section(recipes, plan.recipe)
  return plan.agentMode === 'sequential-fallback' ? `${selected}\n\n${section(recipes, 'sequential-fallback')}` : selected
}

export function getSelectedActionText(authorization: ReviewActionAuthorization): string {
  if (!authorization.repair && !authorization.publication) return section(actions, 'review-only')
  return [authorization.repair ? section(actions, 'repair') : '', authorization.publication ? section(actions, 'publication') : ''].filter(Boolean).join('\n\n')
}

export function composeReviewPrompt(plan: ReviewPlan, inputs: CoordinatorInputs, authorization: ReviewActionAuthorization): readonly ReviewPromptBlock[] {
  if (plan.blocked) throw new ReviewCompositionError('blocked-plan', 'coordinator')
  const values = new Map<string, ReviewPromptBlock>([
    ['run_summary', block(inputs.run_summary, 'run-summary')],
    ['scope_manifest', block(inputs.scope_manifest, 'scope-manifest', 'repository-material')],
    ['trusted_guidance', block(inputs.trusted_guidance, 'applicable-guidance')],
    ['capability_text', block(inputs.capability_text, 'capabilities')],
    ['budget_text', block(inputs.budget_text, 'budget')],
    ['verification_contract', block(inputs.verification_contract, 'verification-contract')],
    ['recipe_text', block(getSelectedRecipeText(plan), 'selected-recipe')],
    ['selected_angles', block(getSelectedAngleText(plan.angles), 'selected-angles')],
    ['output_contract', block(section(output, plan.presentation === 'panel' ? 'panel' : 'terminal'), 'output-contract')],
    ['action_contract', block(getSelectedActionText(authorization), 'action-contract')],
  ])
  return Object.freeze([
    block(skill, 'skill'),
    block(JSON.stringify(plan), 'resolved-policy'),
    ...render(coordinator, 'coordinator', values),
  ])
}

function workerOutputContract(limit: number, perAngle: boolean): readonly ReviewPromptBlock[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) throw new ReviewCompositionError('invalid-candidate-limit', 'candidatesPerAngle')
  const candidate: ReviewCandidate = {
    location: { anchorKey: 'anchor key supplied by the scope manifest', path: 'relative/path', line: 1, endLine: 1 },
    statement: { headline: 'Concise issue title', details: 'Concrete mechanism and supporting evidence', scenario: 'Reachable trigger and incorrect behavior' },
    kind: 'correctness',
    impact: 'major',
    support: [{ path: 'relative/path', quote: 'Necessary short code or rule quotation', relevance: 'How the quotation supports the mechanism' }],
    assessment: { disposition: 'unchecked', reason: 'No independent verification has been performed' },
    angle: 'assigned review angle',
  }
  return [
    block(`Return one JSON object using the nested structure in the following example. The candidate fields described above belong inside location and statement as shown, not at the candidate root. Include support and assessment for every candidate. Use unchecked when not assessed, or plausible when evidence supports the mechanism but a triggering condition remains unconfirmed; state that uncertainty in assessment.reason. Do not claim independent verification. Retain at most ${limit} candidates ${perAngle ? 'per assigned angle' : 'in total'}. This example defines fields, not an actual finding or a quota. Return candidates=[] when there are no findings. Use only supplied anchor keys and valid locations; omit uncertain line and endLine values. Include actual covered angles and limitations. Do not add prose or Markdown fences to the JSON response.`, 'worker-output-contract'),
    block(JSON.stringify({ candidates: [candidate], coverage: { angles: [], limitations: [] } }, null, 2), 'worker-output-example'),
  ]
}

export function composeFinderPrompt(inputs: FinderInputs): readonly ReviewPromptBlock[] {
  return Object.freeze([
    ...render(finder, 'finder', new Map([
      ['scope_manifest', block(inputs.scope_manifest, 'scope-manifest', 'repository-material')],
      ['trusted_guidance', block(inputs.trusted_guidance, 'applicable-guidance')],
      ['assigned_angles', block(inputs.assigned_angles, 'assigned-angles')],
      ['review_material', block(inputs.review_material, 'review-material', 'repository-material')],
    ])),
    ...workerOutputContract(inputs.candidatesPerAngle ?? 6, true),
  ])
}

export function composeVerifierPrompt(inputs: VerifierInputs): readonly ReviewPromptBlock[] {
  return render(verifier, 'verifier', new Map([
    ['scope_manifest', block(inputs.scope_manifest, 'scope-manifest', 'repository-material')],
    ['candidate', block(inputs.candidate, 'candidate', 'repository-material')],
    ['review_material', block(inputs.review_material, 'review-material', 'repository-material')],
  ]))
}

export function composeSweeperPrompt(inputs: SweeperInputs): readonly ReviewPromptBlock[] {
  return Object.freeze([
    ...render(sweeper, 'sweeper', new Map([
      ['scope_manifest', block(inputs.scope_manifest, 'scope-manifest', 'repository-material')],
      ['existing_findings', block(inputs.existing_findings, 'existing-findings', 'repository-material')],
      ['review_material', block(inputs.review_material, 'review-material', 'repository-material')],
    ])),
    ...workerOutputContract(8, false),
  ])
}

export function composeVerifyHandoffPrompt(inputs: VerifyHandoffInputs): readonly ReviewPromptBlock[] {
  return render(verifyHandoff, 'verify-handoff', new Map([
    ['scope_manifest', block(inputs.scope_manifest, 'scope-manifest', 'repository-material')],
    ['repair_and_validation_summary', block(inputs.repair_and_validation_summary, 'repair-and-validation-summary', 'repository-material')],
  ]))
}
