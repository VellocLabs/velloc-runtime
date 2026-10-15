/**
 * The provider table both team skills open with, read from settings.json at
 * invocation time. Security: only ids, display names, trust and enabled model
 * ids; no API keys or base URLs (the body reaches the lead's provider).
 */
import type { ToolCallContext } from '../../toolkit/toolCallContext'
import { surveyProviderCatalog } from '../../team/providerCatalog'
import type { ProviderTrust } from '../../settings/providerTrust'

export type ProviderRow = {
  id: string
  displayName: string
  trust: ProviderTrust
  models: string[]
  /**
   * True when `models` is the picker's list rather than a subset the user
   * curated. Delegation may still name one of them; it only means the user
   * expressed no preference, so omitting the model is equally correct.
   */
  modelsAreHostDefaults: boolean
}

export type ProviderSurvey = {
  rows: ProviderRow[]
  /** The provider the LEAD session itself runs on, when known. */
  leadProviderId?: string
  leadTrust?: ProviderTrust
  /** True when at least one configured provider is marked untrusted. */
  hasUntrusted: boolean
}

/**
 * Describe every configured provider: a narrower projection of
 * `surveyProviderCatalog`, the one survey behind the `TeamProviders` tool too.
 */
export async function surveyProviders(
  context: ToolCallContext,
): Promise<ProviderSurvey> {
  const catalog = await surveyProviderCatalog(context)
  const rows: ProviderRow[] = catalog.providers.map(p => ({
    id: p.id,
    displayName: p.displayName,
    trust: p.trust,
    models: p.models.map(m => m.modelId),
    modelsAreHostDefaults: p.modelsSource === 'host',
  }))
  return {
    rows,
    ...(catalog.leadProviderId ? { leadProviderId: catalog.leadProviderId } : {}),
    ...(catalog.leadTrust ? { leadTrust: catalog.leadTrust } : {}),
    hasUntrusted: catalog.hasUntrusted,
  }
}

/** The survey as a markdown table the model can quote back to the user. */
export function renderProviderTable(survey: ProviderSurvey): string {
  if (survey.rows.length === 0) {
    return 'No providers are configured. Ask the user to add one in Settings → Models.'
  }
  const lines = [
    '| Provider | Name | Trust | Models |',
    '| --- | --- | --- | --- |',
    ...survey.rows.map(
      r =>
        `| \`${r.id}\` | ${r.displayName} | ${r.trust} | ${
          r.models.length > 0
            ? // The distinction the lead needs when it picks one: a curated
              // subset is the user's preference, while a host list is only
              // what the picker offers for that provider — so omitting
              // `child_model` and taking the provider default is equally
              // correct.
              `${r.models.join(', ')}${
                r.modelsAreHostDefaults
                  ? ' (not curated — the provider default is equally correct)'
                  : ''
              }`
            : '(no enabled models — not usable; ask the user to set it up in Settings → Models)'
        } |`,
    ),
  ]
  if (survey.leadProviderId) {
    lines.push(
      '',
      `This session (the lead) runs on \`${survey.leadProviderId}\` — ${survey.leadTrust ?? 'trusted'}.`,
    )
  }
  return lines.join('\n')
}

/**
 * The one refusal both skills share: a lead on an untrusted provider must not
 * delegate at all. It would be reviewing a diff on behalf of a user while
 * itself running on the relay the whole arrangement exists to contain, and
 * everything it read to review with would be uploaded there.
 */
export function leadIsUntrustedNotice(survey: ProviderSurvey): string | null {
  if (survey.leadTrust !== 'untrusted') return null
  return [
    'STOP. This session — the team lead — is itself running on a provider the user marked UNTRUSTED.',
    'Do not spawn teammates and do not delegate. Tell the user that a team lead must run on a trusted',
    'provider, name the provider this session is on, and stop there.',
  ].join('\n')
}
