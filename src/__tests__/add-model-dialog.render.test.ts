// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { AddModelDialog, deriveModelDisplayName } from '../browser/webview/settings/sections/AddModelDialog'
import type { CustomModelDef } from '../settings/settingsTypes'
import { findConfiguredModel } from '../config/nexusModelConfig/findConfiguredModel'
import { installBuiltinCatalogFigures } from './_helpers/builtinCatalogFigures'
import { resetCatalogFigures } from '../config/nexusModelConfig/catalogFigures'

// Built-in rows read the context window / output cap / image input they
// leave unset from the model catalog: install the runtime's figures, as
// after its first catalog read (catalog/builtinCatalogFill.ts). Installed
// at load: rows below are read while the suite is collected.
installBuiltinCatalogFigures()
afterAll(resetCatalogFigures)

/**
 * Capability seeding in the per-model editor: `capabilities` absent (a "Discover models" import) gets the
 * hand-added defaults; present but all false is mirrored exactly, which needs the dialog to write explicit booleans.
 */

afterEach(() => {
  cleanup()
})

function renderDialog(editingModel: CustomModelDef | null) {
  const onSubmit = vi.fn()
  render(
    createElement(AddModelDialog, {
      open: true,
      onOpenChange: () => {},
      editingModel,
      existingModelIds: editingModel ? [editingModel.modelId] : [],
      onSubmit,
    }),
  )
  return { onSubmit }
}

function checkbox(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement
}

describe('AddModelDialog capabilities', () => {
  it('seeds a discovered model (no capabilities) with the same defaults as a new model', () => {
    renderDialog({ modelId: 'abc-coder-v2', incomplete: true })
    expect(checkbox('Tool calling').checked).toBe(true)
    expect(checkbox('Structured output').checked).toBe(true)
    expect(checkbox('Reasoning').checked).toBe(false)
    expect(checkbox('Vision input').checked).toBe(false)
    expect(checkbox('Image generation').checked).toBe(false)
  })

  it('mirrors an explicit all-false capability set instead of re-applying defaults', () => {
    renderDialog({
      modelId: 'abc-coder-v2',
      contextWindow: 1000,
      maxOutputTokens: 500,
      capabilities: {
        toolCalling: false,
        reasoning: false,
        vision: false,
        imageGeneration: false,
        structuredOutput: false,
      },
    })
    expect(checkbox('Tool calling').checked).toBe(false)
    expect(checkbox('Structured output').checked).toBe(false)
  })

  it('writes every capability as an explicit boolean so a false survives a reload', () => {
    const { onSubmit } = renderDialog({
      modelId: 'abc-coder-v2',
      contextWindow: 1000,
      maxOutputTokens: 500,
      capabilities: { toolCalling: true, structuredOutput: true },
    })
    fireEvent.click(checkbox('Tool calling'))
    fireEvent.click(checkbox('Structured output'))
    fireEvent.click(screen.getByTestId('add-model-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].capabilities).toEqual({
      toolCalling: false,
      reasoning: false,
      vision: false,
      imageGeneration: false,
      structuredOutput: false,
    })
  })

  it('completes a discovered model with the defaults it was shown', () => {
    const { onSubmit } = renderDialog({ modelId: 'abc-coder-v2', incomplete: true })
    fireEvent.change(screen.getByTestId('add-model-context'), {
      target: { value: '131072' },
    })
    fireEvent.change(screen.getByTestId('add-model-max-output'), {
      target: { value: '32768' },
    })
    fireEvent.click(screen.getByTestId('add-model-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      modelId: 'abc-coder-v2',
      contextWindow: 131072,
      maxOutputTokens: 32768,
      capabilities: {
        toolCalling: true,
        reasoning: false,
        vision: false,
        imageGeneration: false,
        structuredOutput: true,
      },
    })
    // The `incomplete` marker is not carried forward — the model is complete.
    expect('incomplete' in onSubmit.mock.calls[0][0]).toBe(false)
  })
})

describe('deriveModelDisplayName', () => {
  it('capitalizes dashed segments and drops a trailing date', () => {
    expect(deriveModelDisplayName('xxx-yyy-2026-05-27')).toBe('Xxx Yyy')
  })

  it('keeps version suffixes, drops only bare-number date segments', () => {
    expect(deriveModelDisplayName('abc-coder-v2')).toBe('Abc Coder V2')
    expect(deriveModelDisplayName('my_model')).toBe('My Model')
  })

  it('returns an empty string when nothing usable remains', () => {
    expect(deriveModelDisplayName('')).toBe('')
    expect(deriveModelDisplayName('2026-05-27')).toBe('')
  })
})

describe('AddModelDialog display name auto-fill', () => {
  function renderAddDialog() {
    const onSubmit = vi.fn()
    render(
      createElement(AddModelDialog, {
        open: true,
        onOpenChange: () => {},
        existingModelIds: [],
        onSubmit,
      }),
    )
    return { onSubmit }
  }

  it('derives a display name as the model id is typed, until the user overrides it', () => {
    renderAddDialog()
    const idInput = screen.getByTestId('add-model-id')
    const nameInput = screen.getByTestId('add-model-display-name') as HTMLInputElement

    fireEvent.change(idInput, { target: { value: 'xxx-yyy-2026-05-27' } })
    expect(nameInput.value).toBe('Xxx Yyy')

    // Once the user edits the display name, the auto-fill stands down.
    fireEvent.change(nameInput, { target: { value: 'My Model' } })
    fireEvent.change(idInput, { target: { value: 'zzz-2026-01-01' } })
    expect(nameInput.value).toBe('My Model')
  })

  it('auto-fills on submit when the display name is left blank', () => {
    const { onSubmit } = renderAddDialog()
    fireEvent.change(screen.getByTestId('add-model-id'), {
      target: { value: 'abc-coder-v2' },
    })
    // Clear the auto-filled name to simulate a blank field.
    fireEvent.change(screen.getByTestId('add-model-display-name'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('add-model-submit'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0].displayName).toBe('Abc Coder V2')
  })

  it('keeps a manually entered display name on submit', () => {
    const { onSubmit } = renderAddDialog()
    fireEvent.change(screen.getByTestId('add-model-id'), {
      target: { value: 'abc-coder-v2' },
    })
    fireEvent.change(screen.getByTestId('add-model-display-name'), {
      target: { value: 'My Coder' },
    })
    fireEvent.click(screen.getByTestId('add-model-submit'))

    expect(onSubmit.mock.calls[0][0].displayName).toBe('My Coder')
  })

  it('pre-fills a pending (discovered) model with a derived name when it has none', () => {
    const onSubmit = vi.fn()
    render(
      createElement(AddModelDialog, {
        open: true,
        onOpenChange: () => {},
        pendingModel: { modelId: 'xxx-yyy-2026-05-27' },
        existingModelIds: [],
        onSubmit,
      }),
    )
    expect(
      (screen.getByTestId('add-model-display-name') as HTMLInputElement).value,
    ).toBe('Xxx Yyy')
  })
})

describe("AddModelDialog fills in the dialect vendor's figures", () => {
  // A relay serving `claude-opus-5-5` over the Anthropic wire serves
  // Anthropic's model: its figures come from Anthropic's catalog, editable.
  const opus = findConfiguredModel('anthropic', 'claude-opus-5-5')!

  function renderVendorDialog(props: { editingModel?: CustomModelDef; pendingModel?: CustomModelDef } = {}) {
    const onSubmit = vi.fn()
    render(
      createElement(AddModelDialog, {
        open: true,
        onOpenChange: () => {},
        existingModelIds: [],
        apiCompatibility: 'anthropic',
        onSubmit,
        ...props,
      }),
    )
    return { onSubmit }
  }
  const field = (id: string) => (screen.getByTestId(id) as HTMLInputElement).value
  const typeId = (value: string) => fireEvent.change(screen.getByTestId('add-model-id'), { target: { value } })

  it('fills context, output and capabilities as a covered id is typed, and says so', () => {
    renderVendorDialog()
    typeId('claude-opus-5-5')
    expect(field('add-model-context')).toBe(String(opus.contextWindow))
    expect(field('add-model-max-output')).toBe(String(opus.defaultMaxOutputTokens))
    expect(checkbox('Reasoning').checked).toBe(true)
    expect(checkbox('Vision input').checked).toBe(true)
    expect(screen.getByTestId('add-model-vendor-hint').textContent).toContain(opus.name!)
    // An id no vendor row covers puts the defaults back, and the hint goes.
    typeId('abc-coder-v2')
    expect(field('add-model-context')).toBe('262144')
    expect(field('add-model-max-output')).toBe('32768')
    expect(checkbox('Reasoning').checked).toBe(false)
    expect(screen.queryByTestId('add-model-vendor-hint')).toBeNull()
  })

  it('never overwrites a field the user edited', () => {
    renderVendorDialog()
    fireEvent.change(screen.getByTestId('add-model-context'), { target: { value: '500000' } })
    fireEvent.click(checkbox('Reasoning'))
    typeId('claude-opus-5-5')
    expect(field('add-model-context')).toBe('500000')
    expect(checkbox('Reasoning').checked).toBe(true)
    expect(field('add-model-max-output')).toBe(String(opus.defaultMaxOutputTokens))
  })

  it('fills a pending model and a blank discovered import, never a configured model', () => {
    renderVendorDialog({ pendingModel: { modelId: 'claude-opus-5-5', incomplete: true } })
    expect(field('add-model-context')).toBe(String(opus.contextWindow))
    cleanup()
    renderVendorDialog({ editingModel: { modelId: 'claude-opus-5-5', incomplete: true } })
    expect(field('add-model-context')).toBe(String(opus.contextWindow))
    expect(checkbox('Reasoning').checked).toBe(true)
    cleanup()
    renderVendorDialog({
      editingModel: {
        modelId: 'claude-opus-5-5', contextWindow: 100_000, maxOutputTokens: 8_000,
        capabilities: { toolCalling: true, reasoning: false },
      },
    })
    expect(field('add-model-context')).toBe('100000')
    expect(checkbox('Reasoning').checked).toBe(false)
  })

  it('without a dialect, nothing is looked up', () => {
    render(createElement(AddModelDialog, { open: true, onOpenChange: () => {}, existingModelIds: [], onSubmit: vi.fn() }))
    typeId('claude-opus-5-5')
    expect(field('add-model-context')).toBe('262144')
    expect(screen.queryByTestId('add-model-vendor-hint')).toBeNull()
  })
})
