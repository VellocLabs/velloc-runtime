import { describe, expect, it } from 'vitest'
import { compareVersions, parseUpdateManifest, parseVersion, shouldInstall } from '../../appUpdate/updateManifest'

const URL_OK = 'https://github.com/AgentXLab/velloc-bootstrap/releases/download/velloc-v1.149.2.5/mini_installer.exe'

describe('update manifest', () => {
  it('parses four dotted integers and orders them field by field', () => {
    expect(parseVersion('1.149.2.5')).toEqual([1, 149, 2, 5])
    expect(parseVersion('1.149.2')).toBeNull()
    expect(parseVersion('1.149.2.x')).toBeNull()
    expect(parseVersion('1.149.2.70000')).toBeNull()
    expect(compareVersions(parseVersion('1.149.10.0')!, parseVersion('1.149.9.9')!)).toBeGreaterThan(0)
    expect(compareVersions(parseVersion('1.149.2.5')!, parseVersion('1.149.2.5')!)).toBe(0)
  })

  it('accepts version + url, with min_version optional', () => {
    expect(parseUpdateManifest({ version: '1.149.2.5', url: URL_OK })).toEqual({ version: '1.149.2.5', url: URL_OK })
    expect(parseUpdateManifest({ version: '1.149.2.5', url: URL_OK, min_version: '1.149.2.3' })).toEqual({
      version: '1.149.2.5',
      url: URL_OK,
      minVersion: '1.149.2.3',
    })
  })

  it('refuses a bad version, a non-https url, and a min_version above version', () => {
    expect(parseUpdateManifest({ version: 'latest', url: URL_OK })).toEqual({ error: 'manifest version is invalid' })
    expect(parseUpdateManifest({ version: '1.149.2.5', url: 'http://example.com/a.exe' })).toEqual({
      error: 'manifest url must be https',
    })
    expect(parseUpdateManifest({ version: '1.149.2.5', url: URL_OK, min_version: '1.149.2.6' })).toEqual({
      error: 'manifest min_version is above version',
    })
    expect(parseUpdateManifest({ version: '1.149.2.5', url: URL_OK, min_version: 7 })).toEqual({
      error: 'manifest min_version is invalid',
    })
    expect(parseUpdateManifest([])).toEqual({ error: 'manifest is not an object' })
  })

  it('without min_version every older client installs; at or above version none does', () => {
    const manifest = { version: '1.149.2.5', url: URL_OK }
    expect(shouldInstall('1.149.2.4', manifest)).toBe(true)
    expect(shouldInstall('1.149.2.5', manifest)).toBe(false)
    expect(shouldInstall('1.149.2.6', manifest)).toBe(false)
  })

  it('with min_version only clients below the threshold install', () => {
    const manifest = { version: '1.149.2.5', url: URL_OK, minVersion: '1.149.2.3' }
    expect(shouldInstall('1.149.2.2', manifest)).toBe(true)
    expect(shouldInstall('1.149.2.3', manifest)).toBe(false)
    expect(shouldInstall('1.149.2.4', manifest)).toBe(false)
  })

  it('an unreadable own version never installs', () => {
    expect(shouldInstall('dev', { version: '1.149.2.5', url: URL_OK })).toBe(false)
  })
})
