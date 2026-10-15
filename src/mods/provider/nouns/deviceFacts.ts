/**
 * `$.provider.device()`: OS, CPU architecture, app version and language, as an
 * ordinary client would send. No new bridge call; `arch` is best effort (`unknown`
 * when the frozen user agent does not say).
 */

export type ProviderDeviceFacts = {
  os: string
  arch: string
  appVersion: string
  /** Absent when the runtime has none. */
  locale?: string
}

export type DeviceSource = {
  userAgent?: string
  appVersion?: string
  locale?: string
}

export function osOfUserAgent(userAgent: string): string {
  if (/Android/i.test(userAgent)) return 'android'
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios'
  if (/CrOS/i.test(userAgent)) return 'chromeos'
  if (/Windows/i.test(userAgent)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'macos'
  if (/Linux|X11/i.test(userAgent)) return 'linux'
  return 'unknown'
}

export function archOfUserAgent(userAgent: string): string {
  if (/arm64|aarch64|\bARM\b/i.test(userAgent)) return 'arm64'
  if (/x86_64|x64|Win64|amd64|WOW64/i.test(userAgent)) return 'x64'
  if (/i[3-6]86|x86/i.test(userAgent)) return 'x86'
  return 'unknown'
}

export function deviceFactsOf(source: DeviceSource): ProviderDeviceFacts {
  const userAgent = source.userAgent ?? ''
  return {
    os: osOfUserAgent(userAgent),
    arch: archOfUserAgent(userAgent),
    appVersion: source.appVersion ?? '',
    ...(source.locale ? { locale: source.locale } : {}),
  }
}
