import type { DownloadMode } from '../../../../shared/download-contracts'
import type { ArrTagKey } from '../../../../shared/settings'
import { useEffect, useState, useId, ReactNode } from 'react'
import type { ConfigDraft } from '../../config-services'
import Icon from '../Icons'
import BrandLogo, { BrandName } from '../BrandLogo'
import { useToast } from '../Toast'
import { buttonBase, control, cx } from '../../styles'

export type StringField =
  | 'sonarr_url'
  | 'sonarr_key'
  | 'radarr_url'
  | 'radarr_key'
  | 'sonarr_category'
  | 'radarr_category'
  | 'qbittorrent_url'
  | 'qbittorrent_user'
  | 'qbittorrent_pass'
  | 'sabnzbd_url'
  | 'sabnzbd_key'
  | 'sabnzbd_sonarr_category'
  | 'sabnzbd_radarr_category'
  | 'animetosho_url'
  | 'amenzb_url'
  | 'amenzb_key'
  | 'prowlarr_url'
  | 'prowlarr_key'
  | 'webhook'
  | ArrTagKey
export interface FieldProps {
  name: StringField
  type: string
  label: string
  hint?: string
  placeholder?: string
  required?: boolean
  configured?: boolean
  onClear?: () => void
  form: ConfigDraft
  set: (name: StringField, value: string) => void
}
export type ConnectionState = { phase: 'idle' | 'testing' | 'success' | 'error'; message?: string }
export type StatusTone = 'good' | 'bad' | 'busy' | 'muted' | 'dim'
export interface ServiceStatus {
  word: string
  tone: StatusTone
}
export const downloadModes: [DownloadMode, string][] = [
  ['torrent_only', 'Torrents only (qBittorrent)'],
  ['usenet_only', 'Usenet only (SABnzbd)'],
  ['choose', 'Choose per release'],
]
export const subheading = 'm-0 text-base font-bold'

export function Field({ name, type, label, hint, placeholder, required, configured, onClear, form, set }: FieldProps) {
  const fieldId = useId()
  const hintId = fieldId + '-hint'
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs font-semibold text-ink">
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={configured || hint ? hintId : undefined}
        className={cx(control, 'w-full bg-canvas-soft')}
        type={type}
        name={name}
        placeholder={configured ? '••••••••  Configured' : placeholder}
        required={required}
        value={form[name] ?? ''}
        onChange={event => set(name, event.target.value)}
      />
      {configured ? (
        <div id={hintId} className="flex items-center justify-between gap-3 text-xs text-muted">
          <span className="inline-flex items-start gap-1">
            <Icon name="check" size={12} className="mt-0.5 shrink-0 text-good" />
            Stored securely; blank keeps the current value
          </span>
          {onClear && (
            <button
              className="touch-target shrink-0 cursor-pointer rounded-lg px-2 py-1 font-bold text-bad hover:bg-bad/10 hover:underline"
              type="button"
              aria-label={`Clear stored ${name.replace(/_/g, ' ')}`}
              onClick={onClear}
            >
              Clear
            </button>
          )}
        </div>
      ) : hint ? (
        <span id={hintId} className="text-xs text-muted-dim">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

interface InputFieldProps {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  name?: string
  hint?: string
  placeholder?: string
  required?: boolean
  /** A stored secret exists; the input stays empty and keeps it unless a new value is typed. */
  configured?: boolean
  onClear?: () => void
  clearLabel?: string
  inputMode?: 'decimal' | 'numeric'
  className?: string
}

/** A labelled text input with its hint, shared by every settings field. */
export function InputField({
  label,
  value,
  onChange,
  type = 'text',
  name,
  hint,
  placeholder,
  required,
  configured,
  onClear,
  clearLabel,
  inputMode,
  className,
}: InputFieldProps) {
  const fieldId = useId()
  const hintId = fieldId + '-hint'
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={fieldId} className="text-xs font-semibold text-ink">
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={configured || hint ? hintId : undefined}
        className={cx(control, 'w-full bg-canvas-soft')}
        type={type}
        name={name}
        inputMode={inputMode}
        placeholder={configured ? '••••••••  Configured' : placeholder}
        required={required}
        value={value}
        onChange={event => onChange(event.target.value)}
      />
      {configured ? (
        <div id={hintId} className="flex items-center justify-between gap-3 text-xs text-muted">
          <span className="inline-flex items-start gap-1">
            <Icon name="check" size={12} className="mt-0.5 shrink-0 text-good" />
            Stored securely; blank keeps the current value
          </span>
          {onClear && (
            <button
              className="touch-target shrink-0 cursor-pointer rounded-lg px-2 py-1 font-bold text-bad hover:bg-bad/10 hover:underline"
              type="button"
              aria-label={clearLabel || `Clear stored ${label}`}
              onClick={onClear}
            >
              Clear
            </button>
          )}
        </div>
      ) : hint ? (
        <span id={hintId} className="text-xs text-muted-dim">
          {hint}
        </span>
      ) : null}
    </div>
  )
}

const parseList = (text: string) => {
  const seen = new Set<string>()
  return text
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(item => item && !seen.has(item.toLowerCase()) && Boolean(seen.add(item.toLowerCase())))
}
const sameList = (left: string[], right: string[]) =>
  left.length === right.length && left.every((item, index) => item.toLowerCase() === right[index].toLowerCase())

interface ListFieldProps {
  label: string
  values: string[]
  onChange: (values: string[]) => void
  hint?: string
  placeholder?: string
  /** Known values offered as one-click choices. */
  suggestions?: string[]
  suggestionsLabel?: string
}

/**
 * A list of names typed with commas between them. Known names appear as toggles below,
 * so a list can be filled without typing and a name cannot be misspelled.
 */
export function ListField({
  label,
  values,
  onChange,
  hint,
  placeholder,
  suggestions = [],
  suggestionsLabel,
}: ListFieldProps) {
  const fieldId = useId()
  const hintId = fieldId + '-hint'
  // The text is kept as typed; reformatting on every keystroke would swallow the comma just entered.
  const [text, setText] = useState(values.join(', '))
  useEffect(() => {
    setText(current => (sameList(parseList(current), values) ? current : values.join(', ')))
  }, [values])
  const selected = new Set(values.map(value => value.toLowerCase()))
  const offered = suggestions.filter(
    (suggestion, index) => suggestions.findIndex(other => other.toLowerCase() === suggestion.toLowerCase()) === index,
  )
  const toggle = (name: string) =>
    onChange(
      selected.has(name.toLowerCase())
        ? values.filter(value => value.toLowerCase() !== name.toLowerCase())
        : [...values, name],
    )
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs font-semibold text-ink">
        {label}
      </label>
      <input
        id={fieldId}
        aria-describedby={hint ? hintId : undefined}
        className={cx(control, 'w-full bg-canvas-soft')}
        type="text"
        placeholder={placeholder}
        value={text}
        onChange={event => {
          setText(event.target.value)
          onChange(parseList(event.target.value))
        }}
      />
      {hint && (
        <span id={hintId} className="text-xs text-muted-dim">
          {hint}
        </span>
      )}
      {offered.length > 0 && (
        <div
          className="mt-1 flex flex-wrap gap-1.5"
          role="group"
          aria-label={suggestionsLabel || `${label}: known values`}
        >
          {offered.map(name => (
            <button
              key={name}
              type="button"
              aria-pressed={selected.has(name.toLowerCase())}
              className={cx(
                'touch-target max-w-full cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors wrap-anywhere',
                selected.has(name.toLowerCase())
                  ? 'border-accent bg-accent/14 text-ink'
                  : 'border-line bg-canvas-soft text-muted hover:border-line-strong hover:text-ink',
              )}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A flat labelled switch. The whole row is the click target, not only the 48x28 track. */
export function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  className,
}: {
  id?: string
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  className?: string
}) {
  const generatedId = useId()
  const labelId = id ? `${id}-label` : generatedId
  const hintId = labelId + '-hint'
  return (
    <label className={cx('flex min-h-11 cursor-pointer items-center justify-between gap-4', className)}>
      <span className="min-w-0">
        <span id={labelId} className="block text-sm font-bold">
          {label}
        </span>
        {hint && (
          <span id={hintId} className="mt-1 block text-xs text-muted">
            {hint}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        aria-checked={checked}
        className={cx(
          'relative h-7 w-12 shrink-0 cursor-pointer rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
        onClick={() => onChange(!checked)}
      >
        <span
          className={cx(
            'absolute top-1 left-1 size-5 rounded-full bg-white shadow transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
    </label>
  )
}

export function IntegrationCard({
  brand,
  icon,
  title,
  description,
  configured,
  disabled,
  connection,
  onTest,
  testLabel = 'Test connection',
  footerAction,
  children,
}: {
  brand?: BrandName
  icon?: ReactNode
  title: string
  description: string
  configured: boolean
  disabled?: boolean
  connection: ConnectionState
  onTest: () => void
  testLabel?: string
  /** A secondary action shown beside the connection test, such as removing the service. */
  footerAction?: ReactNode
  children: ReactNode
}) {
  const badge =
    connection.phase === 'success'
      ? ['bg-good/10 text-ink border-good/25', connection.message || 'Connected']
      : connection.phase === 'error'
        ? ['bg-bad/10 text-ink border-bad/25', 'Connection failed']
        : disabled
          ? ['bg-panel-raised text-muted border-line', 'Disabled']
          : configured
            ? ['bg-accent/10 text-ink border-accent/25', 'Configured']
            : ['bg-panel-raised text-ink border-line', 'Not configured']
  return (
    <section className="flex flex-col rounded-2xl border border-line bg-panel p-5 shadow-[0_10px_28px_rgba(0,0,0,.12)]">
      <header className="mb-5 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 max-[600px]:grid-cols-[auto_minmax(0,1fr)]">
        <span className="grid size-10 shrink-0 place-items-center text-accent-bright">
          {brand ? <BrandLogo name={brand} size={22} tile /> : icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={cx(subheading, 'wrap-anywhere')}>{title}</h3>
          <p className="mt-1 mb-0 text-xs leading-relaxed text-muted">{description}</p>
        </div>
        <span
          className={cx(
            'max-w-full rounded-full border max-[600px]:col-start-2 max-[600px]:w-fit px-2.5 py-1 text-xs font-semibold',
            badge[0],
          )}
          title={badge[1]}
        >
          {badge[1]}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-4">{children}</div>
      <div className="mt-5 border-t border-line pt-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={cx(
              buttonBase,
              'min-w-0 flex-1 justify-center border-line bg-canvas-soft text-ink hover:border-line-strong hover:text-white',
            )}
            onClick={onTest}
            disabled={connection.phase === 'testing'}
          >
            {connection.phase === 'testing' ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-muted/30 border-t-accent" />
            ) : (
              <Icon name="refresh" size={15} />
            )}{' '}
            {connection.phase === 'testing' ? 'Testing connection…' : testLabel}
          </button>
          {footerAction}
        </div>
        {connection.phase === 'error' && <p className="mt-2 mb-0 text-center text-xs text-bad">{connection.message}</p>}
      </div>
    </section>
  )
}

export function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast()
  const inputId = useId()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      toast.show(`${label} webhook URL copied`, 'success')
    } catch {
      toast.show('Could not copy automatically; select the URL and copy it manually', 'error')
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label
        htmlFor={inputId}
        className="w-24 shrink-0 truncate text-xs font-semibold text-ink max-[600px]:w-full"
        title={label}
      >
        {label}
      </label>
      <input
        id={inputId}
        readOnly
        value={value}
        onFocus={event => event.currentTarget.select()}
        className={cx(control, 'min-w-0 flex-1 bg-canvas-soft font-mono text-xs')}
      />
      <button
        type="button"
        className={cx(buttonBase, 'border-line bg-panel text-ink')}
        aria-label={`Copy ${label} webhook URL`}
        onClick={() => void copy()}
      >
        <Icon name="copy" size={15} /> Copy
      </button>
    </div>
  )
}

export function ConfigSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-5 flex gap-3">
            <div className="skeleton size-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <div className="skeleton h-4 w-1/3 rounded" />
              <div className="skeleton h-3 w-2/3 rounded" />
            </div>
          </div>
          <div className="space-y-4">
            <div className="skeleton h-14 rounded-lg" />
            <div className="skeleton h-14 rounded-lg" />
            <div className="skeleton h-10 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  )
}
