import { describe, expect, it } from 'vitest'

import { en, type MessageKey } from '../browser/webview/i18n/messages/en'
import { zh } from '../browser/webview/i18n/messages/zh'
import { es } from '../browser/webview/i18n/messages/es'
import { fr } from '../browser/webview/i18n/messages/fr'
import { de } from '../browser/webview/i18n/messages/de'
import { ja } from '../browser/webview/i18n/messages/ja'
import { ko } from '../browser/webview/i18n/messages/ko'

// Terminology guard for the webview i18n catalogs: one English term is rendered by one word in each target
// language, everywhere (the machine-checkable subset of G-1's word map; change a ruling in both places).
// `expect`: every English value using the term carries the ruled rendering (`exempt` keys stay untranslated);
// `forbid`: a rendering that must appear nowhere in that locale.

const CATALOGS = { zh, es, fr, de, ja, ko } as const
type Locale = keyof typeof CATALOGS

type Rule = {
  /** The English term the ruling governs — used in failure messages. */
  term: string
  /** Matches the English values that use the term. */
  en: RegExp
  /** Required rendering, per locale. */
  expect?: Partial<Record<Locale, RegExp>>
  /** Rendering that must not appear anywhere in that locale. */
  forbid?: Partial<Record<Locale, RegExp>>
  /** English keys where the term is a proper noun / identifier / example. */
  exempt?: MessageKey[]
}

const RULES: Rule[] = [
  {
    term: 'agent',
    en: /\bagents?\b/i,
    expect: {
      zh: /智能体/,
      es: /agente/i,
      fr: /agent/i,
      de: /Agent/i,
      ja: /エージェント/,
      ko: /에이전트/,
    },
    // "Agent Skills" is Anthropic's/OpenAI's product name; `agent`/`prompt` in
    // the hook-kind labels name a hook TYPE from the settings schema, not the
    // actor — both stay in English (word map, "Stays in English"). The
    // `/agents` listing's three scope hints name the literal `agents/`
    // directory (a fixed path component), not the actor concept.
    exempt: [
      'settings.features.installDescription',
      'settings.sessionModels.kind.hook_agent',
      'settings.sessionModels.kindDesc.hook_agent',
      'slash.out.agents.userScope',
      'slash.out.agents.projectScope',
      'slash.out.agents.pluginScope',
    ],
  },
  {
    term: 'session',
    en: /\bsessions?\b/i,
    expect: {
      zh: /会话/,
      es: /sesi[óo]n/i,
      fr: /session/i,
      de: /Sitzung/i,
      ja: /セッション/,
      ko: /세션/,
    },
  },
  {
    // Distinct from `session` above, and the pair is why this rule exists: zh
    // renders `session` 会话 and `conversation` 对话, so a value that says
    // "conversations" and renders 会话 reads as the storage container rather
    // than the exchange. The Ctrl+K search dialog names both in one panel
    // (`transcriptSearch.title` searches conversations, `.unavailable` names
    // the session storage location), which is exactly where the collision
    // shows. No `forbid` is possible here — 会话 is legitimately `session`.
    term: 'conversation',
    en: /\bconversations?\b/i,
    expect: {
      zh: /对话/,
      es: /conversaci[óo]n/i,
      fr: /conversation/i,
      de: /Unterhaltung/i,
      ja: /会話/,
      ko: /대화/,
    },
  },
  {
    term: 'provider',
    en: /\bproviders?\b/i,
    expect: {
      zh: /服务商/,
      es: /proveedor/i,
      fr: /fournisseur/i,
      de: /Anbieter/i,
      ja: /プロバイダ/,
      ko: /제공업체/,
    },
    // `{provider}` interpolates a provider's own name; the placeholder example
    // is a literal sample value.
    exempt: [
      'settings.models.signInWith',
      'settings.models.resetTitle',
      'settings.models.providerNamePlaceholder',
    ],
  },
  {
    term: 'token (LLM unit)',
    en: /\btokens?\b/i,
    expect: {
      zh: /token/i,
      es: /token/i,
      fr: /jeton/i,
      de: /Token/i,
      ja: /トークン/,
      ko: /토큰/,
    },
    // These are AUTHENTICATION tokens, a different concept with its own
    // ruling per locale (zh 令牌, not the LLM `token`).
    exempt: [
      'settings.mcp.connectFailedGeneric',
      'settings.memory.privacyNote',
      'providerIssue.credentials.summary',
    ],
  },
  {
    term: 'prompt',
    en: /\bprompts?\b/i,
    expect: {
      zh: /提示词/,
      es: /prompt/i,
      fr: /prompt/i,
      de: /Prompt/i,
      ja: /プロンプト/,
      ko: /프롬프트/,
    },
    // French officially deprecates «invite» for this sense (JORF 2024-09-06,
    // which adopts "instruction générative" and marks «invite» déconseillé);
    // the industry — including French-authored LLM products — writes "prompt",
    // which is also what de/es already do.
    forbid: { fr: /\binvites?\b/i },
    exempt: [
      'settings.sessionModels.kind.prompt_hook',
      'settings.sessionModels.kindDesc.prompt_hook',
    ],
  },
  {
    term: 'skill',
    en: /\bskills?\b/i,
    expect: {
      zh: /技能/,
      es: /skill/i,
      fr: /comp[ée]tence|Skills/i,
      de: /Skill/i,
      ja: /スキル/,
      ko: /스킬/,
    },
    exempt: ['settings.features.installDescription'],
  },
  {
    term: 'plugin',
    en: /\bplugins?\b/i,
    expect: {
      zh: /插件/,
      es: /complemento/i,
      fr: /extension/i,
      de: /Plugin/i,
      ja: /プラグイン/,
      ko: /플러그인/,
    },
    // `/plugin` and `/plugins` here are the bare (no-backtick) slash-command
    // names, and `claude-plugins-official`/`claude-plugins-community` are
    // literal marketplace identifiers — protocol, not the translatable noun.
    // `{plugin}` interpolates a plugin's own name.
    exempt: [
      'launcher.pluginTooltip',
      'topbar.pluginItemTooltip',
      'slash.out.plugin.usage.example',
      'slash.out.plugin.usage.legacyNote',
      'slash.out.plugin.unknownSubcommand',
      'slash.out.plugin.error',
      'slash.out.plugin.install.usage',
      'slash.out.plugin.uninstall.usage',
      'slash.out.plugin.enableDisable.usage',
      'slash.out.plugin.list.installHint',
      'slash.out.marketplace.usage.officialLine',
      'slash.out.marketplace.usage.communityLine',
      'slash.out.marketplace.add.installHint',
    ],
  },
  {
    term: 'memory',
    en: /\bmemor(y|ies)\b/i,
    expect: {
      zh: /记忆/,
      es: /memoria|recuerd/i,
      fr: /m[ée]moire|souvenir/i,
      de: /Gedächtnis|Erinnerung/i,
      ja: /メモリ/,
      ko: /메모리/,
    },
  },
  {
    // The Settings → Memory switch. Renamed from "memory recall" — that read
    // as the whole memory faculty, so turning it off looked like turning
    // memory off, which is not what it does (the index stays in context and
    // the model can still read a memory on demand). The `forbid` keeps the old
    // rendering from creeping back in a later translation pass; the word map in
    // G-1 carries the same ruling.
    term: 'automatic recall',
    en: /\bautomatic recall\b/i,
    expect: {
      zh: /自动召回/,
      es: /recuperación automática/i,
      fr: /rappel automatique/i,
      // German declines the adjective: "Automatischer Abruf" standalone,
      // "für automatischen Abruf" inside a phrase.
      de: /automatische[rmn]? Abruf/i,
      ja: /自動呼び出し/,
      ko: /자동 불러오기/,
    },
    forbid: {
      zh: /记忆回忆/,
      ja: /メモリの呼び出し/,
      ko: /메모리 불러오기/,
    },
  },
  {
    term: 'permission',
    en: /\bpermissions?\b/i,
    expect: {
      zh: /权限/,
      es: /permiso/i,
      fr: /autorisation/i,
      de: /Berechtigung/i,
      ja: /権限/,
      ko: /권한/,
    },
    // "Ask permissions" is the mode's short title; every locale renders it as
    // the ACTION ("always ask") rather than repeating the noun.
    // `slash.out.permissions.noRules` names the literal `permissions` key in
    // settings.json (backtick-wrapped) — a config field name, not the concept.
    exempt: ['permissionMode.title.default', 'slash.out.permissions.noRules'],
  },
  {
    term: 'reasoning',
    en: /\breasoning\b/i,
    expect: {
      zh: /推理/,
      es: /razonamiento/i,
      fr: /raisonnement/i,
      de: /Reasoning/i,
      ja: /推論/,
      ko: /추론/,
    },
    // German shipped three renderings of one term (Gedankengang /
    // Schlussfolgern / Denkleistung). The anglicism is what German-language
    // AI tooling uses, and it matches de's existing Prompt / Token / Skill /
    // Tool / Runtime habit.
    forbid: { de: /Schlussfolger|Gedankengang|Denkleistung/ },
  },
  {
    term: 'diff',
    en: /\bdiffs?\b/i,
    expect: {
      zh: /差异/,
      es: /diferencia|diff/i,
      fr: /diff[ée]rence/i,
      // German rendered `diff` as "Änderungen", which is also how it renders
      // "changes" — two distinct English terms collapsing onto one German
      // word in the same panel. "Diff" is the established German dev loanword.
      de: /Diff/,
      ja: /差分/,
      ko: /차이/,
    },
  },
  {
    // Ruled with the provider-connectivity verdicts (word map, G-1). A
    // quota is an ALLOWANCE that refills on the provider's clock — distinct
    // from the rate limit that throttles a burst — so each locale needs one
    // word for it that it does not also use for throttling.
    term: 'quota',
    en: /\bquotas?\b/i,
    expect: {
      zh: /配额/,
      es: /cuota/i,
      fr: /quota/i,
      de: /Kontingent/i,
      ja: /クォータ/,
      ko: /할당량/,
    },
  },
  {
    term: 'credentials',
    en: /\bcredentials?\b/i,
    expect: {
      zh: /凭据/,
      es: /credencial/i,
      fr: /identifiant/i,
      de: /Zugangsdaten/i,
      ja: /認証情報/,
      ko: /자격 증명/,
    },
  },
  {
    term: 'context window',
    en: /\bcontext window\b/i,
    expect: {
      zh: /上下文窗口/,
      es: /ventana de contexto/i,
      fr: /fen[êe]tre de contexte/i,
      de: /Kontextfenster/i,
      ja: /コンテキストウィンドウ/,
      ko: /컨텍스트 창/,
    },
  },
  {
    term: 'endpoint',
    en: /\bendpoints?\b/i,
    expect: {
      zh: /端点/,
      es: /endpoint/i,
      fr: /point de terminaison/i,
      de: /Endpunkt/i,
      ja: /エンドポイント/,
      ko: /엔드포인트/,
    },
  },
  {
    term: 'tier',
    en: /\btiers?\b/i,
    expect: {
      zh: /层级/,
      es: /nivel/i,
      fr: /niveau/i,
      de: /Stufe/i,
      ja: /ティア/,
      ko: /등급/,
    },
  },
  {
    term: 'marketplace',
    en: /\bmarketplaces?\b/i,
    expect: {
      zh: /市场/,
      es: /mercado/i,
      fr: /place[s]? de march[ée]/i,
      de: /Marktpl/i,
      ja: /マーケットプレイス/,
      ko: /마켓플레이스/,
    },
    // `/marketplace` is the slash-command name (and `marketplace.json` a
    // literal filename) in these — protocol, not the translatable noun. Same
    // treatment as the `endpoint` rule's exemption below.
    exempt: [
      'slash.out.marketplace.unknownSubcommand',
      'slash.out.marketplace.error',
      'slash.out.marketplace.list.footer',
      'slash.out.marketplace.add.usage',
      'slash.out.marketplace.add.fetchFailed',
      'slash.out.marketplace.add.browseHint',
      'slash.out.marketplace.remove.usage',
      'slash.out.marketplace.update.usage',
      'slash.out.marketplace.info.usage',
      'slash.out.marketplace.info.runUpdateHint',
    ],
  },
  {
    term: 'sidebar',
    en: /\bsidebar\b/i,
    expect: {
      zh: /侧边栏/,
      es: /barra lateral/i,
      fr: /barre lat[ée]rale/i,
      de: /Seitenleiste/i,
      ja: /サイドバー/,
      ko: /사이드바/,
    },
  },
  {
    // The topbar toggle for the session card stack docked in the conversation.
    term: 'session rail',
    en: /\bsession rail\b/i,
    expect: {
      zh: /会话栏/,
      es: /barra de sesión/i,
      fr: /barre de session/i,
      de: /Sitzungsleiste/i,
      ja: /セッションレール/,
      ko: /세션 레일/,
    },
  },
  {
    // The sidebar section that groups sessions by folder. Distinct from
    // `project folder` (the code-session binding dialog), which keeps its own
    // wording — so this rule is `expect`-only: 项目 / Projekt / proyecto are
    // still correct elsewhere in each catalog.
    term: 'workspace',
    en: /\bworkspaces?\b/i,
    expect: {
      zh: /工作区/,
      es: /espacio(s)? de trabajo/i,
      fr: /espace(s)? de travail/i,
      de: /Arbeitsbereich/i,
      ja: /ワークスペース/,
      ko: /워크스페이스/,
    },
  },
  {
    term: 'thinking',
    en: /\bthinking\b/i,
    expect: {
      zh: /思考/,
      es: /pens/i,
      fr: /r[ée]fl[ée]ch|r[ée]flex/i,
      de: /denk/i,
      ja: /思考/,
      // `ko` is the only locale that splits this: 사고 for the visible
      // transcript block, 생각 for the act in the running-status line (word
      // map, G-1). Both are ruled, so both are accepted — what this
      // rejects is a third word.
      ko: /사고|생각/,
    },
  },
  {
    // Unlike the rules above, this one accepts an alternation *by design*.
    // `fork` is ruled twice — the verb/adjective (ja 分岐, ko 분기, de
    // verzweigen/abgezweigt) and the noun (ja フォーク, ko 포크, de Fork,
    // es/fr the bare English "fork") — and the English side cannot tell them
    // apart: `action.fork` and `kindDesc.skill_fork` both just say "fork".
    // So this rule cannot pin WHICH ruled rendering a value uses; it pins
    // that the value uses one of them and not a fourth invention. Weaker
    // than the other rules, deliberately — see the word map (G-1).
    term: 'fork',
    en: /\bfork/i,
    expect: {
      zh: /分叉/,
      // Spanish bifurc-ar, French bifurqu-er — the stems diverge at the `c`.
      es: /bifurc|fork/i,
      fr: /bifurqu|fork/i,
      de: /verzweig|abgezweig|fork/i,
      ja: /分岐|フォーク/,
      ko: /분기|포크/,
    },
  },
]

const enKeys = Object.keys(en) as MessageKey[]

/**
 * The prose of an English value, command-line syntax removed: `<provider-id>` and friends are literal syntax ruled
 * to stay English in every locale (G-1), so a word inside one is not a use of the term.
 */
const prose = (value: string): string => value.replace(/<[^>\s]+>/g, '')

describe('i18n glossary (word map)', () => {
  for (const rule of RULES) {
    const governed = enKeys.filter(
      (k) => rule.en.test(prose(en[k])) && !rule.exempt?.includes(k),
    )

    it(`"${rule.term}" governs at least one English string`, () => {
      // A ruling whose English trigger no longer matches anything is dead
      // weight — it would pass forever without checking a thing.
      expect(governed.length).toBeGreaterThan(0)
    })

    for (const [locale, want] of Object.entries(rule.expect ?? {})) {
      it(`${locale}: renders "${rule.term}" consistently`, () => {
        const catalog = CATALOGS[locale as Locale] as Record<string, string>
        const offenders = governed
          .filter((k) => !want.test(catalog[k]!))
          .map((k) => `${k}: ${catalog[k]}`)
        expect(offenders).toEqual([])
      })
    }

    for (const [locale, banned] of Object.entries(rule.forbid ?? {})) {
      it(`${locale}: never uses a rejected rendering of "${rule.term}"`, () => {
        const catalog = CATALOGS[locale as Locale] as Record<string, string>
        const offenders = enKeys
          .filter((k) => banned.test(catalog[k]!))
          .map((k) => `${k}: ${catalog[k]}`)
        expect(offenders).toEqual([])
      })
    }
  }
})
