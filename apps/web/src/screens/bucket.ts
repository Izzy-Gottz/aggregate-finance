// Bucket view (inside the company drawer): money set aside, fields (+ add field), schedule, rules, payments, provenance + undo.
import { useState } from 'preact/hooks'
import type { BucketDetail, BucketField, FieldType, SetAside, SetAsideInput } from '../api/types.ts'
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
    <${SetAsideSection} b=${b} reload=${reload} />

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

/** "$4,000 of $10,000 by Dec 2026 · on pace". */
export function goalLine(held: SetAside['held'], g: NonNullable<SetAside['goal']>): string {
  const by = g.by ? ` by ${new Date(`${g.by}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}` : ''
  const pace = g.onPace === undefined ? '' : g.onPace ? ' · on pace' : ' · behind'
  return `${fmt(held)} of ${fmt(g.target)}${by}${pace}`
}

/** Money held for this bucket: what's held and where, a goal, and one quiet way to set or remove it. */
function SetAsideSection({ b, reload }: { b: BucketDetail; reload: () => void }) {
  const app = useApp()
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState('')
  const s = b.setAside
  if (!b.canSetAside) return null
  const save = async (setAside: SetAsideInput | null) => {
    await app.api.updateBucket(b.id, { setAside })
    setEditing(false)
    reload()
    await app.reload()
  }
  const remove = async () => {
    setErr('')
    await save(null).catch((e: unknown) => setErr(e instanceof Error ? e.message : 'That didn’t work. Try again.'))
  }
  const form = html`<${SetAsideForm} b=${b} onSave=${save} onCancel=${() => setEditing(false)} />`
  if (!s) return html`<div style="margin-top:16px">${editing ? form : html`<${PlusAction} onClick=${() => setEditing(true)}>Set money aside</${PlusAction}>`}</div>`
  return html`<${Section} compact title="Set aside" sub=${s.countsInCash ? 'Still counted in cash' : 'Not counted in cash'}>
    <${Rows}>${s.perAccount.map((p) => html`<${Row} name=${p.accountName} right=${html`<span class="value">${fmt(p.held)}</span>`} />`)}</${Rows}>
    ${s.goal ? html`<p class="sub" style="margin-top:12px">${goalLine(s.held, s.goal)}</p>` : null}
    ${s.note ? html`<p class="meta" style="margin-top:8px">${s.note}</p>` : null}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    ${editing
      ? form
      : html`<div class="links" style="margin-top:12px"><${LinkButton} onClick=${() => setEditing(true)}>Change</${LinkButton}><${LinkButton} onClick=${remove}>Stop setting aside</${LinkButton}></div>`}
  </${Section}>`
}

type How = 'amount' | 'percent' | 'percentOfInflows'

/** One account, one way of setting aside. More than that is for the AI; saving replaces what's set aside now. */
function SetAsideForm({ b, onSave, onCancel }: { b: BucketDetail; onSave: (s: SetAsideInput) => Promise<void>; onCancel: () => void }) {
  const app = useApp()
  const { data: co } = useLoad(() => app.api.company(b.entityId), [b.entityId])
  // Only money you hold: nothing can be set aside from a card or a loan.
  const accounts = (co?.accounts ?? []).filter((a) => a.kind !== 'card' && a.kind !== 'loan')
  // Change starts from what's set now: saving replaces it, so anything left blank here would be lost.
  const now = b.setAside
  const [picked, setPicked] = useState(now?.perAccount[0]?.accountId ?? '')
  const [how, setHow] = useState<How>('amount')
  const [value, setValue] = useState('')
  const [apart, setApart] = useState(now ? !now.countsInCash : false)
  const [goal, setGoal] = useState(now?.goal ? fmt(now.goal.target) : '')
  const [by, setBy] = useState(now?.goal?.by ?? '')
  const [note, setNote] = useState(now?.note ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const account = accounts.find((a) => a.id === picked) ?? accounts[0]
  const base = co?.entity.currency ?? 'USD'
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!account) return
    setErr('')
    const n = Number(value.replace('%', '').trim())
    const amount = how === 'amount' ? parseAmount(value, account.balance?.currency ?? base) : null
    if (how === 'amount' ? !amount : !value.trim() || !Number.isFinite(n) || n <= 0 || n > 100) return setErr(how === 'amount' ? 'That amount isn’t a number.' : 'Give a percent from 1 to 100.')
    const target = goal.trim() ? parseAmount(goal, base) : null
    if (goal.trim() && !target) return setErr('That goal isn’t a number.')
    setBusy(true)
    try {
      await onSave({
        allocations: [{ accountId: account.id, ...(amount ? { amount } : { [how]: n }) }],
        countsInCash: !apart,
        ...(target ? { goal: { amount: target, ...(by ? { by } : {}) } } : now?.goal ? { goal: null } : {}),
        ...(note.trim() ? { note: note.trim() } : now?.note ? { note: null } : {}),
      })
    } catch (x) {
      setBusy(false)
      setErr(x instanceof Error && x.message ? x.message : 'That didn’t save. Try again.')
    }
  }
  if (co && !accounts.length) return html`<p class="sub" style="margin-top:12px">Connect an account here first. <${LinkButton} onClick=${onCancel}>Cancel</${LinkButton}></p>`
  return html`<form onSubmit=${submit} novalidate style="margin-top:12px">
    ${now ? html`<p class="sub">${now.perAccount.length > 1 ? `This replaces what’s set aside in all ${now.perAccount.length} accounts.` : 'This replaces what’s set aside now.'}</p>` : null}
    <label class="field"><span>From</span>
      <select class="input" value=${account?.id ?? ''} onChange=${(e: Event) => setPicked((e.target as HTMLSelectElement).value)}>
        ${accounts.map((a) => html`<option value=${a.id}>${a.name}</option>`)}
      </select></label>
    <label class="field"><span>How much</span>
      <select class="input" value=${how} onChange=${(e: Event) => setHow((e.target as HTMLSelectElement).value as How)}>
        <option value="amount">An amount</option><option value="percent">A percent of the balance</option><option value="percentOfInflows">A percent of new deposits</option>
      </select></label>
    <label class="field"><span>${how === 'amount' ? 'Amount' : 'Percent'}</span><input class="input" inputmode="decimal" value=${value} onInput=${(e: Event) => setValue((e.target as HTMLInputElement).value)} placeholder=${how === 'amount' ? '$5,000' : '25'} /></label>
    <label class="field"><span>Goal (optional)</span><input class="input" inputmode="decimal" value=${goal} onInput=${(e: Event) => setGoal((e.target as HTMLInputElement).value)} placeholder="$10,000" /></label>
    ${goal.trim() ? html`<label class="field"><span>By (optional)</span><input class="input" type="date" value=${by} onInput=${(e: Event) => setBy((e.target as HTMLInputElement).value)} /></label>` : null}
    <label class="field"><span>Note (optional)</span><input class="input" maxlength="500" value=${note} onInput=${(e: Event) => setNote((e.target as HTMLInputElement).value)} /></label>
    <label class="sub" style="display:flex;gap:8px;align-items:center;margin-top:12px;min-height:44px"><input type="checkbox" checked=${apart} onChange=${(e: Event) => setApart((e.target as HTMLInputElement).checked)} /> Don’t count in cash</label>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="formrow"><${Button} type="submit" disabled=${busy || !account}>${busy ? 'Saving…' : 'Save'}</${Button}><${LinkButton} onClick=${onCancel}>Cancel</${LinkButton}></div>
  </form>`
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
