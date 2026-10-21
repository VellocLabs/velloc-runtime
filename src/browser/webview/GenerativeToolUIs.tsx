import { lazy, Suspense, useState } from 'react'
import { makeAssistantToolUI } from '@assistant-ui/react'
import {
  CalendarIcon,
  CheckCircle2Icon,
  Loader2Icon,
  MapPinIcon,
  UserIcon,
} from 'lucide-react'
import { AskUserQuestionToolUI } from './AskUserQuestionToolUI'
import { SkillToolUI } from './SkillToolUI'
import { ContinueInCodeToolUI } from './ContinueInCodeToolUI'
import { useT } from './i18n'
import {
  A2UI_CREATE_SURFACE,
  A2UI_DELETE_SURFACE,
  A2UI_UPDATE_COMPONENTS,
  A2UI_UPDATE_DATA_MODEL,
} from '@/toolkit/builtin/a2ui/a2uiToolNames'

type LocationArgs = {
  name: string
  address?: string
  lat: number
  lng: number
}

type LocationResult = {
  success: boolean
}

type DatePickerArgs = {
  prompt: string
  minDate?: string
  maxDate?: string
}

type DatePickerResult = {
  date: string
}

type ContactFormArgs = {
  prompt: string
  fields: Array<'name' | 'email' | 'phone'>
}

type ContactFormResult = {
  name?: string
  email?: string
  phone?: string
}

export const LocationToolUI =
  makeAssistantToolUI<LocationArgs, LocationResult>({
    toolName: 'show_location',
    render: function LocationUI({ args, status }) {
      const t = useT()
      if (
        status.type === 'running' &&
        (args.lat == null || args.lng == null)
      ) {
        return (
          <div className="flex items-center gap-2 rounded-lg border p-4">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('gen.loadingLocation')}
            </span>
          </div>
        )
      }

      const { name, address, lat, lng } = args
      if (lat == null || lng == null) {
        return null
      }

      const mapSrc = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.01},${lat - 0.01},${lng + 0.01},${lat + 0.01}&layer=mapnik&marker=${lat},${lng}`

      return (
        <div className="my-2 overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <MapPinIcon className="size-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">{name}</p>
              {address ? (
                <p className="text-xs text-muted-foreground">{address}</p>
              ) : null}
            </div>
          </div>
          <iframe
            title={t('gen.mapOf', { name })}
            src={mapSrc}
            className="h-[220px] w-full border-0"
          />
        </div>
      )
    },
  })

export const DatePickerToolUI =
  makeAssistantToolUI<DatePickerArgs, DatePickerResult>({
    toolName: 'select_date',
    render: function DatePickerUI({ args, result, addResult }) {
      const t = useT()
      const [value, setValue] = useState('')
      const [submitted, setSubmitted] = useState(false)

      if (result) {
        return (
          <div className="my-2 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3">
            <CheckCircle2Icon className="size-4 text-success" />
            <span className="text-sm text-success-emphasis">
              {t('gen.selectedDate', {
                date: new Date(result.date).toLocaleDateString(),
              })}
            </span>
          </div>
        )
      }

      if (submitted) {
        return (
          <div className="my-2 flex items-center gap-2 rounded-lg border p-3">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('gen.submittingDate')}
            </span>
          </div>
        )
      }

      return (
        <div className="my-2 rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <CalendarIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{args.prompt}</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={value}
              min={args.minDate}
              max={args.maxDate}
              onChange={event => setValue(event.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={!value}
              onClick={() => {
                setSubmitted(true)
                addResult({ date: new Date(value).toISOString() })
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {t('gen.confirm')}
            </button>
          </div>
        </div>
      )
    },
  })

export const ContactFormToolUI =
  makeAssistantToolUI<ContactFormArgs, ContactFormResult>({
    toolName: 'collect_contact',
    render: function ContactFormUI({ args, result, addResult }) {
      const t = useT()
      const [form, setForm] = useState<ContactFormResult>({})
      const [submitted, setSubmitted] = useState(false)

      if (result) {
        return (
          <div className="my-2 rounded-lg border border-success/30 bg-success/10 p-3">
            <div className="mb-1 flex items-center gap-2">
              <CheckCircle2Icon className="size-4 text-success" />
              <span className="text-sm font-medium text-success-emphasis">
                {t('gen.contactCollected')}
              </span>
            </div>
            <div className="ml-6 space-y-0.5 text-xs text-success">
              {result.name ? <p>{t('gen.name')}: {result.name}</p> : null}
              {result.email ? <p>{t('gen.email')}: {result.email}</p> : null}
              {result.phone ? <p>{t('gen.phone')}: {result.phone}</p> : null}
            </div>
          </div>
        )
      }

      if (submitted) {
        return (
          <div className="my-2 flex items-center gap-2 rounded-lg border p-3">
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('gen.submittingContact')}
            </span>
          </div>
        )
      }

      const fields = args.fields ?? ['name', 'email', 'phone']
      const isValid = fields.every(field => form[field]?.trim())

      return (
        <div className="my-2 rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <UserIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">{args.prompt}</span>
          </div>
          <div className="space-y-2">
            {fields.includes('name') ? (
              <input
                type="text"
                placeholder={t('gen.name')}
                value={form.name ?? ''}
                onChange={event =>
                  setForm(previous => ({
                    ...previous,
                    name: event.target.value,
                  }))
                }
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            ) : null}
            {fields.includes('email') ? (
              <input
                type="email"
                placeholder={t('gen.email')}
                value={form.email ?? ''}
                onChange={event =>
                  setForm(previous => ({
                    ...previous,
                    email: event.target.value,
                  }))
                }
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            ) : null}
            {fields.includes('phone') ? (
              <input
                type="tel"
                placeholder={t('gen.phone')}
                value={form.phone ?? ''}
                onChange={event =>
                  setForm(previous => ({
                    ...previous,
                    phone: event.target.value,
                  }))
                }
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            ) : null}
            <button
              type="button"
              disabled={!isValid}
              onClick={() => {
                setSubmitted(true)
                addResult(form)
              }}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {t('question.submit')}
            </button>
          </div>
        </div>
      )
    },
  })

// A2UI surfaces render INLINE at their tool-call's position in the conversation
// (no side panel). For each surfaceId only the LATEST mention renders the live
// surface; earlier mentions render a "jump to latest" breadcrumb. The heavy
// renderer + font live behind this lazy import, so they never load for non-A2UI
// conversations (or for other generative tools in this same chunk).
const A2uiInlineSurface = lazy(() =>
  import('./a2ui/A2uiInlineSurface').then(m => ({ default: m.A2uiInlineSurface })),
)

function A2uiSurfaceToolRender({
  args,
  toolCallId,
}: {
  args?: { surfaceId?: string }
  toolCallId: string
}) {
  const surfaceId =
    typeof args?.surfaceId === 'string' ? args.surfaceId : undefined
  if (!surfaceId) return null
  return (
    <Suspense fallback={null}>
      <A2uiInlineSurface surfaceId={surfaceId} toolCallId={toolCallId} />
    </Suspense>
  )
}

// All four a2ui_* tool-calls render through the same inline surface, which
// decides (from its tool-call position + the shared transcript) whether to show
// the live surface, a breadcrumb, or nothing (deleted).
export const A2uiCreateSurfaceToolUI = makeAssistantToolUI<{ surfaceId?: string }, string>({
  toolName: A2UI_CREATE_SURFACE,
  render: ({ args, toolCallId }) => (
    <A2uiSurfaceToolRender args={args} toolCallId={toolCallId} />
  ),
})
export const A2uiUpdateComponentsToolUI = makeAssistantToolUI<{ surfaceId?: string }, string>({
  toolName: A2UI_UPDATE_COMPONENTS,
  render: ({ args, toolCallId }) => (
    <A2uiSurfaceToolRender args={args} toolCallId={toolCallId} />
  ),
})
export const A2uiUpdateDataModelToolUI = makeAssistantToolUI<{ surfaceId?: string }, string>({
  toolName: A2UI_UPDATE_DATA_MODEL,
  // A data patch relocates the surface to THIS position (its newest mention);
  // older positions render a "jump to latest" breadcrumb — same inline surface
  // as create / update_components.
  render: ({ args, toolCallId }) => (
    <A2uiSurfaceToolRender args={args} toolCallId={toolCallId} />
  ),
})
export const A2uiDeleteSurfaceToolUI = makeAssistantToolUI<{ surfaceId?: string }, string>({
  toolName: A2UI_DELETE_SURFACE,
  render: ({ args, toolCallId }) => (
    <A2uiSurfaceToolRender args={args} toolCallId={toolCallId} />
  ),
})

export function GenerativeToolUIs() {
  return (
    <>
      <LocationToolUI />
      <DatePickerToolUI />
      <ContactFormToolUI />
      <AskUserQuestionToolUI />
      <SkillToolUI />
      <ContinueInCodeToolUI />
      <A2uiCreateSurfaceToolUI />
      <A2uiUpdateComponentsToolUI />
      <A2uiUpdateDataModelToolUI />
      <A2uiDeleteSurfaceToolUI />
    </>
  )
}
