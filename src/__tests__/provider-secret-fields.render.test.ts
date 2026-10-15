// @vitest-environment happy-dom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ProviderSecretFields } from '../browser/webview/settings/sections/ProviderSecretFields'
import { providerSecretFields } from '../models/drivers/driverRegistry'
import { hasUnsavedEdits } from '../glic/unsavedEditsGate'

/**
 * The settings page's optional credentials beyond the API key — OpenRouter's
 * management key, which reads the ACCOUNT balance (a key's own limit is only a
 * spending cap). Saved explicitly; the value never comes back, only whether
 * one is stored. The page wiring (`saveSecret` → providers.upsert → forced
 * usage refresh) is covered end to end by the e2e suite.
 */

afterEach(cleanup)

function renderFields(storedNames: string[], onSave = vi.fn(async () => {})) {
  render(createElement(ProviderSecretFields, {
    fields: providerSecretFields('openrouter'),
    storedNames,
    onSave,
  }))
  return onSave
}

describe('ProviderSecretFields', () => {
  it('saves a typed management key (trimmed) and clears the field', async () => {
    const onSave = renderFields([])
    expect(screen.getByTestId('models-secret-management_key').textContent).toContain('Management key (optional)')
    expect(screen.queryByTestId('models-secret-management_key-saved')).toBeNull()
    expect(screen.queryByTestId('models-secret-management_key-remove')).toBeNull()
    const save = screen.getByTestId('models-secret-management_key-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const input = screen.getByTestId('models-secret-management_key-input') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: '  sk-or-mgmt  ' } })
    fireEvent.click(save)
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('management_key', 'sk-or-mgmt'))
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('a stored key shows Saved and can be removed with ""', async () => {
    const onSave = renderFields(['management_key'])
    expect(screen.getByTestId('models-secret-management_key-saved').textContent).toContain('Saved')
    fireEvent.click(screen.getByTestId('models-secret-management_key-remove'))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('management_key', ''))
  })

  it('a rejected save says so and keeps the typed value, with no unhandled rejection', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('providers_handler_error')
    })
    renderFields([], onSave)
    const input = screen.getByTestId('models-secret-management_key-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'sk-or-mgmt' } })
    fireEvent.click(screen.getByTestId('models-secret-management_key-save'))
    const error = await screen.findByTestId('models-secret-management_key-error')
    expect(error.textContent).toBe("Couldn't save the key. Try again.")
    expect(input.value).toBe('sk-or-mgmt')
    // Not busy any more: the user can retry.
    expect((screen.getByTestId('models-secret-management_key-save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('holds the updater reload gate while a typed key is unsaved', async () => {
    renderFields([])
    const input = screen.getByTestId('models-secret-management_key-input') as HTMLInputElement
    expect(hasUnsavedEdits()).toBe(false)
    fireEvent.change(input, { target: { value: 'sk-or-mgmt' } })
    expect(hasUnsavedEdits()).toBe(true)
    fireEvent.click(screen.getByTestId('models-secret-management_key-save'))
    await waitFor(() => expect(hasUnsavedEdits()).toBe(false))
  })
})
