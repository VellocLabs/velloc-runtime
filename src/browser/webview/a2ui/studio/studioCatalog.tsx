// The studio catalog (F-1): CopilotKit's standard components plus the vendored
// data, chart, input, feedback and domain components, as one generative UI.

import { createElement, type ComponentType } from 'react'
import { createGenerativeUI, standardUI } from '@copilotkit/react-core/v2/generative-ui'
import type { ComponentName } from './vendor/catalog/definitions'
import { ownEntries } from './vendor/catalog/entries'
import { chartRenderers } from './vendor/catalog/renderers/charts'
import { contentRenderers } from './vendor/catalog/renderers/content'
import { dataRenderers } from './vendor/catalog/renderers/data'
import { domainRenderers } from './vendor/catalog/renderers/domain'
import { feedbackRenderers } from './vendor/catalog/renderers/feedback'
import { inputRenderers } from './vendor/catalog/renderers/inputs'
import { layoutRenderers } from './vendor/catalog/renderers/layout'
import type { Renderer } from './vendor/catalog/renderers/types'
import { playgroundTheme } from './vendor/catalog/theme'

export const STUDIO_CATALOG_ID = 'https://velloc.app/a2ui/catalogs/studio/v1'

const renderers: { [K in ComponentName]: Renderer<K> } = {
  ...layoutRenderers,
  ...contentRenderers,
  ...dataRenderers,
  ...chartRenderers,
  ...inputRenderers,
  ...feedbackRenderers,
  ...domainRenderers,
}

type AnyRender = ComponentType<{ props: Record<string, unknown> }>

/**
 * A vendored renderer as an engine component: it sits in a box-less element
 * that carries its type, and the engine's `onAction` becomes the `action`
 * closure the renderer calls.
 */
function engineComponent(name: string, Render: AnyRender): ComponentType<Record<string, unknown>> {
  function Node(engineProps: Record<string, unknown>) {
    const { onAction, ...rest } = engineProps as { onAction?: (args: object) => Promise<unknown> } & Record<string, unknown>
    const props = onAction ? { ...rest, action: () => void onAction({}) } : rest
    return createElement('div', { className: 'a2-node', 'data-a2-type': name }, createElement(Render, { props }))
  }
  Node.displayName = `Studio(${name})`
  return Node
}

export const studioUI = createGenerativeUI({
  id: STUDIO_CATALOG_ID,
  extends: [standardUI],
  components: ownEntries(name => engineComponent(name, renderers[name] as unknown as AnyRender)) as never,
})

export const studioTheme = playgroundTheme
