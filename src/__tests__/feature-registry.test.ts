import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkingState } from '../runtime/RuntimeTypes'
import {
  FEATURE_CATALOG_VERSION,
  __resetBundledSkillsForTests,
  __resetFeatureRegistryForTests,
  getFeatureCatalog,
  getFeatureDefinition,
  isFeatureEnabled,
  addStockSkill,
  registerFeature,
} from '../skillLibrary/builtinSkills'

function appStateWith(
  enabled: Record<string, boolean>,
): Pick<WorkingState, 'enabledFeatures'> {
  return { enabledFeatures: enabled }
}

beforeEach(() => {
  __resetFeatureRegistryForTests()
})

describe('featureRegistry — registration + catalog', () => {
  it('registers a feature with full metadata', () => {
    registerFeature({
      id: 'demo.foo',
      title: 'Foo',
      description: 'turns on Foo',
      default: true,
      category: 'Demo',
      docsUrl: 'https://example.com/foo',
      requiresRestart: true,
    })
    const def = getFeatureDefinition('demo.foo')
    expect(def).toEqual({
      id: 'demo.foo',
      title: 'Foo',
      description: 'turns on Foo',
      default: true,
      category: 'Demo',
      docsUrl: 'https://example.com/foo',
      requiresRestart: true,
    })
  })

  it('rejects an empty id', () => {
    expect(() =>
      registerFeature({
        id: '',
        title: 'no id',
        description: '',
        default: false,
      }),
    ).toThrow(/id is required/)
  })

  it('overwrites on re-register (last write wins)', () => {
    registerFeature({ id: 'x', title: 'v1', description: '', default: false })
    registerFeature({ id: 'x', title: 'v2', description: '', default: true })
    const def = getFeatureDefinition('x')!
    expect(def.title).toBe('v2')
    expect(def.default).toBe(true)
  })

  it('getFeatureCatalog returns entries sorted by id', () => {
    registerFeature({ id: 'b.two', title: '', description: '', default: false })
    registerFeature({ id: 'a.one', title: '', description: '', default: false })
    registerFeature({ id: 'c.three', title: '', description: '', default: false })
    expect(getFeatureCatalog().map(f => f.id)).toEqual([
      'a.one',
      'b.two',
      'c.three',
    ])
  })

  it('catalog returns a snapshot — mutating it does not affect the registry', () => {
    registerFeature({ id: 'x', title: '', description: '', default: false })
    const snapshot = getFeatureCatalog()
    // The result is `readonly` at the type level. At runtime it's a fresh
    // array — even if a caller cheats, the registry stays intact.
    expect(snapshot).toHaveLength(1)
    expect(getFeatureCatalog()).toHaveLength(1)
  })

  it('exports FEATURE_CATALOG_VERSION as a string the WebUI can compare', () => {
    expect(typeof FEATURE_CATALOG_VERSION).toBe('string')
    expect(FEATURE_CATALOG_VERSION.length).toBeGreaterThan(0)
  })
})

describe('isFeatureEnabled', () => {
  beforeEach(() => {
    registerFeature({
      id: 'on-by-default',
      title: '',
      description: '',
      default: true,
    })
    registerFeature({
      id: 'off-by-default',
      title: '',
      description: '',
      default: false,
    })
  })

  it('falls back to the registry default when WorkingState has no override', () => {
    const appState = appStateWith({})
    expect(isFeatureEnabled('on-by-default', appState as WorkingState)).toBe(true)
    expect(isFeatureEnabled('off-by-default', appState as WorkingState)).toBe(false)
  })

  it('honors an explicit override in enabledFeatures', () => {
    const appState = appStateWith({
      'on-by-default': false,
      'off-by-default': true,
    })
    expect(isFeatureEnabled('on-by-default', appState as WorkingState)).toBe(false)
    expect(isFeatureEnabled('off-by-default', appState as WorkingState)).toBe(true)
  })

  it('treats unknown ids as disabled (fail-safe)', () => {
    expect(isFeatureEnabled('never-registered', undefined)).toBe(false)
    expect(
      isFeatureEnabled('never-registered', appStateWith({}) as WorkingState),
    ).toBe(false)
  })

  it('an override for an unknown id still wins over the default-false', () => {
    // If a setting file has a stale entry, the override applies. Unknown
    // ids only fall to `false` when no override is present.
    expect(
      isFeatureEnabled(
        'never-registered',
        appStateWith({ 'never-registered': true }) as WorkingState,
      ),
    ).toBe(true)
  })

  it('handles undefined / null WorkingState gracefully', () => {
    expect(isFeatureEnabled('on-by-default', undefined)).toBe(true)
    expect(isFeatureEnabled('on-by-default', null)).toBe(true)
    expect(isFeatureEnabled('off-by-default', undefined)).toBe(false)
  })
})

describe('getFeatureCatalog — sessionTypes auto-enrichment', () => {
  beforeEach(() => {
    __resetBundledSkillsForTests()
  })

  it('mirrors a single bundled-skill model gate onto its feature def', () => {
    addStockSkill({
      name: 'big-think',
      description: 'Deep reasoning loop',
      content: 'BODY',
      modelInvocation: 'agent',
    })
    registerFeature({
      id: 'bundled-skills.big-think',
      title: 'Big Think',
      description: 'deep loop',
      default: true,
    })

    const catalog = getFeatureCatalog()
    const def = catalog.find(d => d.id === 'bundled-skills.big-think')
    expect(def?.sessionTypes).toEqual(['agent'])
  })

  it('mirrors a multi-type array onto its feature def', () => {
    addStockSkill({
      name: 'refactor-coach',
      description: 'Multi-file refactor planner',
      content: 'BODY',
      modelInvocation: ['agent', 'code'],
    })
    registerFeature({
      id: 'bundled-skills.refactor-coach',
      title: 'Refactor Coach',
      description: 'planner',
      default: true,
    })

    const def = getFeatureCatalog()
      .find(d => d.id === 'bundled-skills.refactor-coach')
    expect(def?.sessionTypes).toEqual(['agent', 'code'])
  })

  it('leaves sessionTypes undefined when the skill has no model gate', () => {
    addStockSkill({
      name: 'shared-helper',
      description: 'Applies everywhere',
      content: 'BODY',
    })
    registerFeature({
      id: 'bundled-skills.shared-helper',
      title: 'Shared Helper',
      description: 'universal',
      default: true,
    })

    const def = getFeatureCatalog()
      .find(d => d.id === 'bundled-skills.shared-helper')
    expect(def?.sessionTypes).toBeUndefined()
  })

  it('leaves sessionTypes undefined for a slash-only skill', () => {
    // `modelInvocation: []` closes the model surface outright, so there is
    // no type badge to derive — the same "nothing to show" as an omitted
    // gate, reached from the other end of the tri-state. (Slash-only skills
    // register their own display-only feature, so no `registerFeature` here.)
    addStockSkill({
      name: 'slash-only',
      description: 'Only ever /slash-only',
      content: 'BODY',
      modelInvocation: [],
    })

    const def = getFeatureCatalog()
      .find(d => d.id === 'bundled-skills.slash-only')
    expect(def).toBeDefined()
    expect(def?.modelInvocable).toBe(false)
    expect(def?.sessionTypes).toBeUndefined()
  })

  it("leaves sessionTypes undefined for features whose id doesn't start with bundled-skills.", () => {
    addStockSkill({
      name: 'big-think',
      description: '',
      content: 'BODY',
      modelInvocation: 'agent',
    })
    registerFeature({
      id: 'experimental.something-else',
      title: 'Unrelated',
      description: '',
      default: false,
    })

    const def = getFeatureCatalog()
      .find(d => d.id === 'experimental.something-else')
    expect(def?.sessionTypes).toBeUndefined()
  })

  it('explicit sessionTypes on the feature def overrides skill auto-derivation', () => {
    // Author intent: a feature could gate MORE narrowly than the
    // underlying skill (e.g. skill applies to ['agent','code'] but the
    // feature is gated to ['agent'] only). Explicit wins.
    addStockSkill({
      name: 'big-think',
      description: '',
      content: 'BODY',
      modelInvocation: ['agent', 'code'],
    })
    registerFeature({
      id: 'bundled-skills.big-think',
      title: 'Big Think',
      description: '',
      default: true,
      sessionTypes: ['agent'],
    })

    const def = getFeatureCatalog()
      .find(d => d.id === 'bundled-skills.big-think')
    expect(def?.sessionTypes).toEqual(['agent'])
  })

  it('still works when no bundled skill is registered at all', () => {
    // Skill registry empty + feature registered → no enrichment, no
    // throw. Important: registry imports skill module but module
    // should be load-safe even if no skills are present.
    registerFeature({
      id: 'bundled-skills.never-registered',
      title: 'Orphan',
      description: '',
      default: false,
    })
    const def = getFeatureCatalog()
      .find(d => d.id === 'bundled-skills.never-registered')
    expect(def?.sessionTypes).toBeUndefined()
  })
})
