/**
 * Contract: `buildInstallScript` returns the PowerShell program that verifies
 * and runs a downloaded mini_installer (F-30). The program always writes
 * `{ code, detail, pv }` as JSON to `resultPath`. `code` is `exited` (installer
 * ran; `detail` is its exit code), `busy` (another runtime holds the install
 * lock), `signature_invalid`, `version_mismatch`, `not_user_install` or
 * `script_error`. `pv` is the per-user install's registered version after the
 * run, or ''.
 *
 * Security: the installer runs only with an Authenticode status of Valid and
 * a version resource equal to the manifest's. No signer subject is pinned, so
 * any publicly trusted signature passes; the trade-off is recorded in F-30.
 * The program text carries no double quotes, so the host's command-line
 * quoting cannot alter it.
 */

export type InstallScriptInput = {
  installerPath: string
  version: string
  resultPath: string
}

export type InstallResult = {
  code: string
  detail: string
  pv: string
}

/** PowerShell single-quoted literal. */
function literal(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

export function buildInstallScript(input: InstallScriptInput): string {
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$installer = ${literal(input.installerPath)}`,
    `$version = ${literal(input.version)}`,
    `$resultPath = ${literal(input.resultPath)}`,
    String.raw`$key = 'HKCU:\Software\Velloc'`,
    `function Invoke-VellocUpdate {`,
    `  $sig = Get-AuthenticodeSignature -LiteralPath $installer`,
    `  if ($sig.Status -ne 'Valid') { return @{ code = 'signature_invalid'; detail = [string]$sig.Status } }`,
    `  $fileVersion = (Get-Item -LiteralPath $installer).VersionInfo.ProductVersion`,
    `  if ($fileVersion -ne $version) { return @{ code = 'version_mismatch'; detail = [string]$fileVersion } }`,
    `  if ($null -eq (Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue)) { return @{ code = 'not_user_install'; detail = '' } }`,
    // setup.exe rolls the install back while this value is present (G-3).
    `  Remove-ItemProperty -Path $key -Name CleanInstallRequiredForVersionBelow -ErrorAction SilentlyContinue`,
    `  $process = Start-Process -FilePath $installer -ArgumentList '--do-not-launch-chrome' -Wait -PassThru`,
    `  return @{ code = 'exited'; detail = [string]$process.ExitCode }`,
    `}`,
    String.raw`$mutex = New-Object System.Threading.Mutex($false, 'Local\VellocAppUpdate')`,
    `$owned = $false`,
    `try {`,
    `  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }`,
    `  if ($owned) { $out = Invoke-VellocUpdate } else { $out = @{ code = 'busy'; detail = '' } }`,
    `} catch {`,
    `  $out = @{ code = 'script_error'; detail = $_.Exception.Message }`,
    `} finally {`,
    `  if ($owned) { $mutex.ReleaseMutex() }`,
    `}`,
    `$installed = Get-ItemProperty -Path $key -Name pv -ErrorAction SilentlyContinue`,
    `$out.pv = if ($installed) { [string]$installed.pv } else { '' }`,
    `[System.IO.File]::WriteAllText($resultPath, ($out | ConvertTo-Json -Compress))`,
  ]
  return lines.join('\n')
}

/** The program's result file, or null when it is not that shape. */
export function readInstallResult(text: string): InstallResult | null {
  let value: unknown
  try {
    value = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.code !== 'string') return null
  return {
    code: v.code,
    detail: typeof v.detail === 'string' ? v.detail : String(v.detail ?? ''),
    pv: typeof v.pv === 'string' ? v.pv : '',
  }
}
