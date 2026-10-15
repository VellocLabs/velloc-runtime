import { describe, expect, it } from 'vitest'
import { buildInstallScript, readInstallResult } from '../../appUpdate/installScript'

const input = {
  installerPath: String.raw`C:\Users\o'neil\AppData\Local\Velloc\Update\1.149.2.5\mini_installer.exe`,
  version: '1.149.2.5',
  resultPath: String.raw`C:\Users\o'neil\AppData\Local\Velloc\Update\1.149.2.5\result.json`,
}

describe('install script', () => {
  const script = buildInstallScript(input)

  it('carries no double quote, so host command-line quoting cannot change it', () => {
    expect(script).not.toContain('"')
  })

  it('embeds paths as single-quoted literals with quotes doubled', () => {
    expect(script).toContain(String.raw`$installer = 'C:\Users\o''neil\AppData\Local\Velloc\Update\1.149.2.5\mini_installer.exe'`)
    expect(script).toContain(`$version = '1.149.2.5'`)
  })

  it('checks the signature status and version before it clears the gate and runs the installer', () => {
    const order = [
      'Get-AuthenticodeSignature',
      "$sig.Status -ne 'Valid'",
      'VersionInfo.ProductVersion',
      'CleanInstallRequiredForVersionBelow',
      "Start-Process -FilePath $installer -ArgumentList '--do-not-launch-chrome' -Wait",
    ].map(fragment => script.indexOf(fragment))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('serializes installs with a named lock and always writes the result', () => {
    expect(script).toContain(String.raw`'Local\VellocAppUpdate'`)
    expect(script.trimEnd().split('\n').at(-1)).toContain('WriteAllText($resultPath')
  })

  it('reads the result file, tolerating a byte-order mark', () => {
    expect(readInstallResult('\uFEFF{"code":"exited","detail":"0","pv":"1.149.2.5"}')).toEqual({
      code: 'exited',
      detail: '0',
      pv: '1.149.2.5',
    })
    expect(readInstallResult('{"code":"busy","detail":"","pv":""}')).toEqual({ code: 'busy', detail: '', pv: '' })
    expect(readInstallResult('not json')).toBeNull()
    expect(readInstallResult('{"detail":"x"}')).toBeNull()
  })
})
