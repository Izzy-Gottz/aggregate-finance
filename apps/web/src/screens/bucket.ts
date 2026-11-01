// Bucket view (inside the company drawer): fields (+ add field), schedule, rules, payments, provenance + undo.
import { useState } from 'preact/hooks'
import type { BucketDetail, BucketField, FieldType } from '../api/types.ts'
import { useApp, useLoad } from '../app/context.ts'
import { fmt, parseAmount } from '../lib/money.ts'
import { shortDate } from '../lib/time.ts'
import { Button, LinkButton, PlusAction, Row, Rows, Section } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

const CADENCE: Record<string, string> = { weekly: 'weekly', monthly: 'monthly', quarterly: 'every quarter', yearly: 'yearly' }
const ord = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th')

export function scheduleText(s: NonNullable<BucketDetail['schedule']>): string {
  const day = s.cadence === 'monthly' || s.cadence === 'quarterly' ? ` on the ${ord(s.dueDay)}` : ''
  return `${fmt(s.amount)} ${CADENCE[s.cadence]}${day}${s.endDate ? `, until ${shortDate(s.endDate, true)}` : ''}`
}

export function BucketView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: b, error, reload } = useLoad(() => app.api.bucket(id), [id])
  const [adding, setAdding] = useState(false)
  if (error) return html`<${LoadFailed} title="This bucket is gone" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!b) return html`<${Drawer} title="Loading…" onClose=${onClose} onBack=${onBack} />`
  const company = app.ws?.entities.find((e) => e.id === b.entityId)?.name ?? 'Back'
  const now = app.now()

  const saveFields = async (fields: BucketField[]) => {
    await app.api.updateBucket(b.id, { fields })
    reload()
  }
  const undo = async () => {
    await app.api.undo(b.id)
    app.toast({ text: `Removed the ${b.name} bucket.` })
    await app.reload()
    onBack ? onBack() : onClose()
  }

  return html`<${Drawer} title=${b.name} sub=${b.schedule ? scheduleText(b.schedule) : 'No schedule'} onClose=${onClose} onBack=${onBack} backLabel=${company}>
    <${Section} compact title="Details" sub="Your own fields">
      <dl class="dl">${b.fields.map((f) => html`<dt>${f.label}</dt><dd class=${f.type === 'money' || f.type === 'number' ? 'tn' : ''}>${f.type === 'date' ? shortDate(f.value, true) : f.value}</dd>`)}</dl>
      ${adding
        ? html`<${AddField} onCancel=${() => setAdding(false)} onSave=${async (f: BucketField) => (await saveFields([...b.fields, f]), setAdding(false))} />`
        : html`<${PlusAction} onClick=${() => setAdding(true)}>Add field</${PlusAction}>`}
    </${Section}>

    <${Section} compact title="Rule" sub="Matching payments land here by themselves">
      <${Rows}>${b.rules.map((r) => html`<${Row} name=${r.text} />`)}</${Rows}>
      ${!b.rules.length ? html`<p class="empty">No rule yet. Ask your AI: “Put payments to WeWork in Rent.”</p>` : null}
    </${Section}>

    <${Section} compact title="Payments" sub="Paid, upcoming and missed">
      <${Rows}>
        ${b.payments.map(
          (p) => html`<${Row}
            name=${shortDate(p.date, true)}
            line=${html`<span class=${p.status === 'missed' ? 'red' : p.status === 'upcoming' ? 'amber' : ''}>${p.status}</span> · ${p.detail}`}
            right=${html`<span class="value">${fmt(p.amount)}</span>`}
          />`,
        )}
      </${Rows}>
    </${Section}>

    <p class="meta" style="margin-top:32px">
      Created by ${b.createdBy.name}${b.createdBy.at ? ` · ${shortDate(b.createdBy.at, true)}` : ''}
      ${b.undoUntil && Date.parse(b.undoUntil) > now ? html` · <${LinkButton} onClick=${undo}>Undo</${LinkButton}>` : null}
    </p>
  </${Drawer}>`
}

function AddField({ onSave, onCancel }: { onSave: (f: BucketField) => void; onCancel: () => void }) {
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [type, setType] = useState<FieldType>('text')
  const [err, setErr] = useState('')
  const submit = (e: Event) => {
    e.preventDefault()
    if (!label.trim()) return setErr('Give the field a name.')
    if (type === 'money' && !parseAmount(value, 'USD')) return setErr('That amount isn’t a number.')
    onSave({ key: label.trim().toLowerCase().replace(/\W+/g, '_'), label: label.trim(), type, value: type === 'money' ? fmt(parseAmount(value, 'USD')) : value })
  }
  return html`<form onSubmit=${submit} style="margin-top:8px">
    <div class="formrow" style="margin-top:0">
      <label class="field" style="flex:1;min-width:140px;margin:0"><span>Name</span><input class="input" value=${label} onInput=${(e: Event) => setLabel((e.target as HTMLInputElement).value)} placeholder="Deposit" /></label>
      <label class="field" style="flex:1;min-width:140px;margin:0"><span>Value</span><input class="input" value=${value} onInput=${(e: Event) => setValue((e.target as HTMLInputElement).value)} placeholder=${type === 'money' ? '$5,960' : ''} /></label>
      <label class="field" style="width:120px;margin:0"><span>Kind</span>
        <select class="input" value=${type} onChange=${(e: Event) => setType((e.target as HTMLSelectElement).value as FieldType)}>
          <option value="text">Text</option><option value="money">Money</option><option value="date">Date</option><option value="number">Number</option>
        </select>
      </label>
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="formrow"><${Button} type="submit">Add</${Button}><${LinkButton} onClick=${onCancel}>Cancel</${LinkButton}></div>
  </form>`
}
