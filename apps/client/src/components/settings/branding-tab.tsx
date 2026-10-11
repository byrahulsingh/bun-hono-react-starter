import {
  ImageIcon,
  Loader2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { z } from 'zod'

import { FormSection } from '#/components/app/form-section'
import {
  FormError,
  SubmitButton,
  TextField,
} from '#/components/auth/form-parts'
import { errorMessage } from '#/components/people/people-parts'
import { Button } from '#/components/ui/button'
import { Field, FieldError, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { toast } from '#/components/ui/toast'
import { fieldErrors } from '#/lib/api/api'
import type { AssetSlot, Branding } from '#/lib/api/settings'
import { settingsApi } from '#/lib/api/settings'
import { brandAssetUrl, setBranding } from '#/lib/branding'
import { contrast, isHexColor, textOn } from '#/lib/color'
import { formValues, useFormAction } from '#/lib/use-form-action'

const DEFAULT_NAME = 'App'
/** The built-in look's button colour (styles.css --primary), for the picker and preview. */
const DEFAULT_ACCENT = '#171717'
const MAX_BYTES = 512 * 1024
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'

const brandingSchema = z.object({
  product_name: z.string().trim().max(60, 'Use at most 60 characters'),
  accent_color: z
    .string()
    .trim()
    .refine((v) => v === '' || isHexColor(v), 'Use a colour like #2563eb'),
})

export function BrandingTab({ branding }: { branding: Branding }) {
  // The page's copy; every save returns the new branding and the whole app takes it.
  const [current, setCurrent] = useState(branding)
  const saved = (next: Branding) => {
    setCurrent(next)
    setBranding(next)
  }

  return (
    <div className="flex flex-col gap-10">
      <NameAndColour branding={current} onSaved={saved} />
      <AssetSection
        slot="logo"
        title="Logo"
        description="Shown on sign-in pages, at the top of the sidebar and in emails. A wide logo works best, about 200 × 40."
        hint="PNG, JPEG, WebP or SVG, up to 512 KB. Emails show PNG and JPEG logos; with other formats they show the product name instead."
        branding={current}
        onSaved={saved}
      />
      <AssetSection
        slot="icon"
        title="Icon"
        description="A square mark for the browser tab and the collapsed sidebar."
        hint="Square, at least 64 × 64. PNG, JPEG, WebP or SVG, up to 512 KB."
        branding={current}
        onSaved={saved}
      />
    </div>
  )
}

// ─── Name and colour ─────────────────────────────────────────────

function NameAndColour({
  branding,
  onSaved,
}: {
  branding: Branding
  onSaved: (next: Branding) => void
}) {
  const [productName, setProductName] = useState(
    branding.product_name === DEFAULT_NAME ? '' : branding.product_name,
  )
  const [colour, setColour] = useState(branding.accent_color ?? '')
  const form = useFormAction(brandingSchema, async (values) => {
    onSaved(
      await settingsApi.saveBranding({
        product_name: values.product_name || null,
        accent_color: values.accent_color.toLowerCase() || null,
      }),
    )
    toast.add({ title: 'Branding saved', type: 'success' })
  })

  const accent = isHexColor(colour) ? colour.toLowerCase() : null

  return (
    <FormSection
      title="Name and colour"
      description="What people call the product, and the colour of its buttons, links and focus outlines."
    >
      <form
        noValidate
        className="flex flex-col gap-6"
        onInput={(event) =>
          form.clearField((event.target as HTMLInputElement).name)
        }
        onSubmit={(event) => {
          event.preventDefault()
          void form.submit(formValues(event.currentTarget))
        }}
      >
        <FormError message={form.error} />
        <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
          <div className="flex max-w-md flex-col gap-4">
            <TextField
              name="product_name"
              label="Product name"
              placeholder={DEFAULT_NAME}
              value={productName}
              onChange={(event) => setProductName(event.target.value)}
              maxLength={60}
              error={form.fields.product_name}
            />
            <p className="-mt-2 text-sm text-muted-foreground">
              Shown in the browser tab, the sidebar, sign-in pages and emails,
              and as the sender name of emails. Leave empty for “{DEFAULT_NAME}
              ”.
            </p>
            <ColourField
              value={colour}
              onChange={setColour}
              error={form.fields.accent_color}
            />
          </div>
          <Preview name={productName || DEFAULT_NAME} accent={accent} />
        </div>
        <div>
          <SubmitButton pending={form.pending}>Save</SubmitButton>
        </div>
      </form>
    </FormSection>
  )
}

function ColourField({
  value,
  onChange,
  error,
}: {
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const id = useId()
  const valid = isHexColor(value)
  const warnings = valid ? contrastWarnings(value.toLowerCase()) : []

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Accent colour</FieldLabel>
      <div className="flex items-center gap-2">
        {/* The swatch picks; the text box takes a pasted brand hex code. */}
        <input
          type="color"
          aria-label="Pick a colour"
          value={valid ? value.toLowerCase() : DEFAULT_ACCENT}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-10 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <Input
          id={id}
          name="accent_color"
          value={value}
          placeholder="Default"
          onChange={(event) => onChange(event.target.value.trim())}
          aria-invalid={error ? true : undefined}
          className="max-w-36 font-mono"
          spellCheck={false}
          autoComplete="off"
        />
        {value !== '' && (
          <Button type="button" variant="ghost" onClick={() => onChange('')}>
            Use default
          </Button>
        )}
      </div>
      {error && <FieldError>{error}</FieldError>}
      {warnings.map((warning) => (
        <p
          key={warning}
          className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400"
        >
          <TriangleAlertIcon
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {warning}
        </p>
      ))}
    </Field>
  )
}

/** Readability problems with a colour, in plain words. Saving is still allowed. */
function contrastWarnings(hex: string): string[] {
  const warnings: string[] = []
  if (contrast(hex, textOn(hex)) < 4.5)
    warnings.push(
      'Text on buttons in this colour may be hard to read. A darker or brighter shade works better.',
    )
  if (contrast(hex, '#ffffff') < 3)
    warnings.push(
      'This colour is light: links and focus outlines will be hard to see on white.',
    )
  return warnings
}

/** How the unsaved name and colour will look, before saving. */
function Preview({ name, accent }: { name: string; accent: string | null }) {
  const colour = accent ?? DEFAULT_ACCENT
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Preview</span>
      <div
        className="flex flex-col gap-4 rounded-lg border bg-background p-4"
        aria-hidden="true"
      >
        <span className="truncate font-medium">{name}</span>
        <div className="flex flex-col gap-1.5">
          <div className="h-2 w-3/4 rounded-full bg-muted" />
          <div className="h-2 w-1/2 rounded-full bg-muted" />
        </div>
        <div className="flex items-center gap-3">
          <span
            className="rounded-md px-3 py-1.5 text-sm font-medium"
            style={{ background: colour, color: textOn(colour) }}
          >
            Continue
          </span>
          <span
            className="text-sm underline underline-offset-3"
            style={{ color: colour }}
          >
            A link
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Logo and icon ───────────────────────────────────────────────

/** The server's reason for refusing the file, or the general message. */
const fileError = (err: unknown) =>
  (fieldErrors(err) as { file?: string }).file ?? errorMessage(err)

function AssetSection({
  slot,
  title,
  description,
  hint,
  branding,
  onSaved,
}: {
  slot: AssetSlot
  title: string
  description: string
  hint: string
  branding: Branding
  onSaved: (next: Branding) => void
}) {
  const asset = branding[slot]
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setError(null)
    // Checked here for a quick answer; the server checks the content again.
    if (file.size > MAX_BYTES)
      return setError('Use an image of 512 KB or less.')
    if (!ACCEPT.split(',').includes(file.type))
      return setError('Use a PNG, JPEG, WebP or SVG image.')
    setBusy('upload')
    try {
      onSaved(await settingsApi.uploadAsset(slot, file))
      toast.add({ title: `${title} saved`, type: 'success' })
    } catch (err) {
      setError(fileError(err))
    } finally {
      setBusy(null)
    }
  }

  async function remove() {
    setError(null)
    setBusy('remove')
    try {
      onSaved(await settingsApi.removeAsset(slot))
      toast.add({ title: `${title} removed`, type: 'success' })
    } catch (err) {
      setError(fileError(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <FormSection title={title} description={description}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={`flex items-center justify-center rounded-lg border bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-size-[12px_12px] p-2 ${slot === 'logo' ? 'h-16 w-56' : 'size-16'}`}
          >
            {asset ? (
              <img
                src={brandAssetUrl(asset)}
                alt={`Current ${slot}`}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <ImageIcon
                className="size-5 text-muted-foreground"
                aria-label={`No ${slot} yet`}
              />
            )}
          </div>
          <div className="flex gap-2">
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              className="hidden"
              aria-label={`Upload ${slot}`}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = '' // the same file can be chosen again
                if (file) void upload(file)
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy !== null}
              onClick={() => input.current?.click()}
            >
              {busy === 'upload' ? (
                <Loader2Icon className="animate-spin" aria-hidden="true" />
              ) : (
                <UploadIcon aria-hidden="true" />
              )}
              {asset ? 'Replace' : 'Upload'}
            </Button>
            {asset && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => void remove()}
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        {error && <FieldError>{error}</FieldError>}
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </FormSection>
  )
}
