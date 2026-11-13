/** Plan feedback drafts are kept per plan and dropped on demand (F-9). */
import { describe, expect, it } from 'vitest'

import {
  PLAN_FEEDBACK_DRAFTS_MAX,
  dropPlanFeedbackDraft,
  readPlanFeedbackDraft,
  writePlanFeedbackDraft,
} from '../components/assistant-ui/planFeedbackDrafts'

describe('plan feedback drafts', () => {
  it('keeps each plan its own draft', () => {
    writePlanFeedbackDraft('store-one', 'first')
    writePlanFeedbackDraft('store-two', 'second')
    expect(readPlanFeedbackDraft('store-one')).toBe('first')
    expect(readPlanFeedbackDraft('store-two')).toBe('second')
    expect(readPlanFeedbackDraft('store-unknown')).toBe('')
  })

  it('forgets a dropped or emptied draft', () => {
    writePlanFeedbackDraft('store-dropped', 'text')
    dropPlanFeedbackDraft('store-dropped')
    expect(readPlanFeedbackDraft('store-dropped')).toBe('')
    writePlanFeedbackDraft('store-emptied', 'text')
    writePlanFeedbackDraft('store-emptied', '')
    expect(readPlanFeedbackDraft('store-emptied')).toBe('')
  })

  it('evicts the oldest draft past the cap', () => {
    writePlanFeedbackDraft('store-oldest', 'old')
    for (let i = 0; i < PLAN_FEEDBACK_DRAFTS_MAX; i++) writePlanFeedbackDraft(`store-fill-${i}`, 'x')
    expect(readPlanFeedbackDraft('store-oldest')).toBe('')
    expect(readPlanFeedbackDraft(`store-fill-${PLAN_FEEDBACK_DRAFTS_MAX - 1}`)).toBe('x')
  })
})
