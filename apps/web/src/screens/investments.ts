// Investments: one company's (or Personal's) portfolio. Totals, then each position with its cost, value and multiple;
// open one to mark it, write it off or record its exit. "Add an investment" for a new one. Figures come from the
// server (lib/investments.ts has the arithmetic the demo uses); nothing here is advice.
import { useState } from 'preact/hooks'
import { useApp, useLoad } from '../app/context.ts'
import { SECURITY, moicText, type InvestmentInput, type InvestmentTotals, type InvestmentView, type SecurityType } from '../lib/investments.ts'
import { fmt, parseTyped } from '../lib/money.ts'
import { shortDate } from '../lib/time.ts'
import { Button, Field, LinkButton, PlusAction, Row, Rows, Section, Segmented } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

const KINDS: Array<{ value: SecurityType; label: string }> = (['safe', 'convertible_note', 'preferred_stock', 'common_stock'] as const).map((k) => ({ value: k, label: SECURITY[k] }))
const STATUS = { active: '', exited: 'Exited', written_off: 'Written off' } as const
const ORDER = { active: 0, exited: 1, written_off: 2 } as const
const today = () => new Date().toISOString().slice(0, 10)

type Form = { kind: 'add' } | { kind: 'mark' | 'write_off' | 'exit' | 'convert'; p: InvestmentView }

/** The server's totals for one currency, shown as they come (core's investmentTotals; get_investments says the same). */
function TotalsRows({ t, label }: { t: InvestmentTotals; label: string }) {
  return html`<${Rows} label=${label}>
      <${Row} name="Invested" right=${html`<span class="value">${fmt(t.invested)}</span>`} />
      <${Row} name="Value" line="Latest marks, else cost" right=${html`<span class="value">${fmt(t.value)}</span>`} />
      <${Row} name="Distributed" line="Distributions and exit proceeds" right=${html`<span class="value">${fmt(t.distributed)}</span>`} />
      ${t.writtenOff.minor ? html`<${Row} name="Written off" right=${html`<span class="value grey">${fmt(t.writtenOff)}</span>`} />` : null}
      <${Row} name="Multiple" line=${'(Value + distributed) ÷ invested' + (t.moicExcludes ? ` · excludes ${t.moicExcludes} in-kind ${t.moicExcludes === 1 ? 'exit' : 'exits'}` : '')} right=${html`<span class="value">${moicText(t.moic)}</span>`} />
    </${Rows}>`
}

/** Held for review (review mode on): it isn't on the page until someone approves it, so say that, not "Marked." */
const said = (r: { status?: string }, ok: string) => (r.status === 'pending_review' ? 'Waiting for review. It shows here once it’s approved.' : ok)

export function InvestmentsView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const entity = app.ws?.entities.find((e) => e.id === id)
  const currency = entity?.currency ?? 'USD'
  // Positions here can come from Carta: say so with Carta's own badge whenever this company has a Carta connection.
  const fromCarta = (app.ws?.connections ?? []).some((c) => c.connectorKey === 'carta' && (!c.entityNames.length || c.entityNames.includes(entity?.name ?? '')))
  const { data: got, error, reload } = useLoad(() => app.api.investments(id), [id])
  const [open, setOpen] = useState<string | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  if (error) return html`<${LoadFailed} title="Investments" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!got) return html`<${Drawer} title="Investments" onClose=${onClose} onBack=${onBack}><p class="sub" aria-busy="true" style="margin-top:12px">Loading…</p></${Drawer}>`
  const data = got.positions
  const positions = [...data].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.value.minor - a.value.minor)
  // Every saved event can be taken back from its toast (the write's own undo, 30 days).
  const done = (text: string, recordId?: string) => {
    setForm(null)
    reload()
    app.toast({ text, ...(recordId ? { undo: async () => (await app.api.undo(recordId), app.toast({ text: 'Undone.' }), reload()) } : {}) })
  }
  return html`<${Drawer} title="Investments" sub=${`${entity?.name ?? ''} · ${data.length} ${data.length === 1 ? 'position' : 'positions'}`} onClose=${onClose} onBack=${onBack}>
    ${data.length
      ? got.totals.map((t) => html`<${TotalsRows} t=${t} label=${got.totals.length > 1 ? `Totals in ${t.currency}` : 'Totals'} />`)
      : html`<p class="empty">No investments yet. Add the first one below.</p>`}

    ${data.length
      ? html`<${Section} compact title="Positions">
          <ul class="rows positions">
            ${positions.map((p) => {
              const on = open === p.positionId
              return html`<li>
                <button type="button" class="row noicon" aria-expanded=${on ? 'true' : 'false'} onClick=${() => (setOpen(on ? null : p.positionId), setForm(null))}>
                  <span class="txt"><span class="name">${p.issuer}</span><span class="line">${[SECURITY[p.securityType] + (p.series ? ` · ${p.series}` : ''), STATUS[p.status]].filter(Boolean).join(' · ')}</span></span>
                  <span class="right"><span class=${'value' + (p.status === 'active' ? '' : ' grey')}>${moicText(p.moic)}</span></span>
                </button>
                ${on ? html`<${Position} p=${p} form=${form} setForm=${setForm} entityId=${id} done=${done} />` : null}
              </li>`
            })}
          </ul>
          ${fromCarta ? html`<span class="powered-carta" role="img" aria-label="Powered by Carta"></span>` : null}
        </${Section}>`
      : null}

    ${form?.kind === 'add'
      ? html`<${AddForm} entityId=${id} currency=${currency} positions=${data} onCancel=${() => setForm(null)} done=${done} />`
      : html`<div style="margin-top:24px"><${PlusAction} onClick=${() => (setOpen(null), setForm({ kind: 'add' }))}>Add an investment</${PlusAction}></div>`}
  </${Drawer}>`
}

function Position({ p, form, setForm, entityId, done }: { p: InvestmentView; form: Form | null; setForm: (f: Form | null) => void; entityId: string; done: (t: string) => void }) {
  const terms = [p.valuationCap ? `${fmt(p.valuationCap)} cap` : null, p.discountPct ? `${p.discountPct}% discount` : null, p.shares ? `${p.shares.toLocaleString('en-US')} shares` : null].filter(Boolean).join(' · ')
  const valueLine = p.valueSource === 'mark' && p.markedAt ? `Marked ${shortDate(p.markedAt, true)}` : p.valueSource === 'cost' ? 'At cost (no mark yet)' : STATUS[p.status]
  const mine = form && form.kind !== 'add' && form.p.positionId === p.positionId ? form : null
  return html`<div class="position">
    <${Rows}>
      <${Row} name="Invested" line=${`Since ${shortDate(p.firstInvested, true)}${terms ? ` · ${terms}` : ''}`} right=${html`<span class="value">${fmt(p.invested)}</span>`} />
      <${Row} name="Value" line=${valueLine} right=${html`<span class="value">${fmt(p.value)}</span>`} />
      ${p.distributed.minor ? html`<${Row} name="Distributed" right=${html`<span class="value">${fmt(p.distributed)}</span>`} />` : null}
    </${Rows}>
    ${p.source && /^https:\/\//.test(p.source.url) ? html`<p class="meta" style="margin-top:8px"><a href=${p.source.url} target="_blank" rel="noopener noreferrer">Via ${p.source.name} ↗</a></p>` : null}
    ${mine
      ? html`<${EventForm} f=${mine} entityId=${entityId} onCancel=${() => setForm(null)} done=${done} />`
      : p.status === 'active'
        ? html`<div class="links">
            <${LinkButton} onClick=${() => setForm({ kind: 'mark', p })}>Mark</${LinkButton}>
            ${p.securityType === 'safe' || p.securityType === 'convertible_note' ? html`<${LinkButton} onClick=${() => setForm({ kind: 'convert', p })}>Convert</${LinkButton}>` : null}
            <${LinkButton} onClick=${() => setForm({ kind: 'exit', p })}>Record an exit</${LinkButton}>
            <${LinkButton} onClick=${() => setForm({ kind: 'write_off', p })}>Write off</${LinkButton}>
          </div>`
        : null}
  </div>`
}

/** Mark (what it's worth now), exit (sold or closed, for an amount), write-off (the cost is lost), or convert (a SAFE or
 *  note becomes shares in a priced round: the round's name and the shares received; the cost carries over). */
function EventForm({ f, entityId, onCancel, done }: { f: Exclude<Form, { kind: 'add' }>; entityId: string; onCancel: () => void; done: (t: string, recordId?: string) => void }) {
  const app = useApp()
  const cur = f.p.invested.currency
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today())
  const [source, setSource] = useState('')
  const [series, setSeries] = useState('')
  const [shares, setShares] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const words = { mark: { button: 'Save mark', amount: 'Worth now', toast: 'Marked.' }, exit: { button: 'Record exit', amount: 'Proceeds', toast: 'Exit recorded.' }, write_off: { button: 'Write it off', amount: '', toast: 'Written off.' }, convert: { button: 'Convert', amount: '', toast: 'Converted.' } }[f.kind]
  const save = async (e: Event) => {
    e.preventDefault()
    if (f.kind === 'convert') {
      const n = Number(shares.replace(/,/g, ''))
      if (!series.trim()) return setErr('Which round, e.g. Series A?')
      if (!(n > 0)) return setErr('How many shares did it convert into?')
      if (!date) return setErr('When?')
      setBusy(true)
      try {
        const r = await app.api.recordInvestment(entityId, { kind: 'convert', positionId: f.p.positionId, issuer: f.p.issuer, securityType: 'preferred_stock', series: series.trim(), shares: n, date })
        return done(said(r, `${f.p.issuer}: ${words.toast}`), r.recordId)
      } catch (x) {
        setBusy(false)
        return setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      }
    }
    // "€450,000" on a USD position is sent as EUR, and the server says it's held in USD (never re-denominated here).
    const m = f.kind === 'write_off' ? null : parseTyped(amount || '', cur)
    if (f.kind !== 'write_off' && (!m || m.minor < 0)) return setErr(f.kind === 'mark' ? 'What is the whole position worth?' : 'How much came back? (0 is fine.)')
    if (!date) return setErr('When?')
    const input: InvestmentInput = { kind: f.kind, positionId: f.p.positionId, issuer: f.p.issuer, securityType: f.p.securityType, date, ...(m ? { amount: m } : {}), ...(f.kind === 'mark' && source.trim() ? { markSource: source.trim() } : {}) }
    setBusy(true)
    try {
      const r = await app.api.recordInvestment(entityId, input)
      done(said(r, `${f.p.issuer}: ${words.toast}`), r.recordId)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setBusy(false)
    }
  }
  return html`<form onSubmit=${save} novalidate style="margin-top:12px">
    ${f.kind === 'convert'
      ? html`<p class="sub">The ${fmt(f.p.invested)} ${f.p.securityType === 'safe' ? 'SAFE' : 'note'} becomes shares. The cost carries over.</p>
          <${Field} label="Round"><input class="input" value=${series} onInput=${(e: Event) => setSeries((e.target as HTMLInputElement).value)} placeholder="Series A" /></${Field}>
          <${Field} label="Shares received"><input class="input" inputmode="numeric" value=${shares} onInput=${(e: Event) => setShares((e.target as HTMLInputElement).value)} placeholder="31,250" /></${Field}>`
      : f.kind === 'write_off' ? html`<p class="sub">The ${fmt(f.p.invested)} cost counts as lost. Its value goes to zero.</p>` : html`<${Field} label=${words.amount}><input class="input" inputmode="decimal" value=${amount} onInput=${(e: Event) => setAmount((e.target as HTMLInputElement).value)} /></${Field}>`}
    <${Field} label="Date"><input class="input" type="date" value=${date} onInput=${(e: Event) => setDate((e.target as HTMLInputElement).value)} /></${Field}>
    ${f.kind === 'mark' ? html`<${Field} label="Based on (optional)"><input class="input" value=${source} onInput=${(e: Event) => setSource((e.target as HTMLInputElement).value)} placeholder="Series A price" /></${Field}>` : null}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="formrow"><${Button} type="submit" disabled=${busy}>${words.button}</${Button}><${Button} quiet onClick=${onCancel}>Cancel</${Button}></div>
  </form>`
}

function AddForm({ entityId, currency, positions, onCancel, done }: { entityId: string; currency: string; positions: InvestmentView[]; onCancel: () => void; done: (t: string, recordId?: string) => void }) {
  const app = useApp()
  const [issuer, setIssuer] = useState('')
  const [kind, setKind] = useState<SecurityType>('safe')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(today())
  const [series, setSeries] = useState('')
  const [shares, setShares] = useState('')
  const [cap, setCap] = useState('')
  const [discount, setDiscount] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const convertible = kind === 'safe' || kind === 'convertible_note'
  const save = async (e: Event) => {
    e.preventDefault()
    if (!issuer.trim()) return setErr('Which company?')
    const m = parseTyped(amount, currency)
    if (!m || m.minor <= 0) return setErr('How much did you put in?')
    if (!date) return setErr('When?')
    const capM = convertible && cap.trim() ? parseTyped(cap, m.currency) : null
    if (convertible && cap.trim() && !capM) return setErr('The cap is an amount, like $8M.')
    const disc = convertible && discount.trim() ? Number(discount.replace('%', '')) : undefined
    if (disc !== undefined && !(disc > 0 && disc < 100)) return setErr('The discount is a percent, like 20.')
    const n = !convertible && shares.trim() ? Number(shares.replace(/,/g, '')) : undefined
    if (n !== undefined && !(n > 0)) return setErr('Shares is a number, like 40,000.')
    // The same company and security already held: a follow-on into that position, not a second one.
    const same = positions.find((p) => p.status === 'active' && p.issuer.trim().toLowerCase() === issuer.trim().toLowerCase() && p.securityType === kind)
    const input: InvestmentInput = { kind: 'invest', ...(same ? { positionId: same.positionId } : {}), issuer: same?.issuer ?? issuer.trim(), securityType: kind, date, amount: m, ...(series.trim() ? { series: series.trim() } : {}), ...(capM ? { valuationCap: capM } : {}), ...(disc !== undefined ? { discountPct: disc } : {}), ...(n !== undefined ? { shares: n } : {}) }
    setBusy(true)
    try {
      const r = await app.api.recordInvestment(entityId, input)
      done(said(r, same ? `Added ${fmt(m)} to ${same.issuer}.` : `${issuer.trim()} added.`), r.recordId)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setBusy(false)
    }
  }
  return html`<${Section} compact title="Add an investment">
    <form onSubmit=${save} novalidate>
      <${Field} label="Company"><input class="input" value=${issuer} onInput=${(e: Event) => setIssuer((e.target as HTMLInputElement).value)} placeholder="Lumen Health" /></${Field}>
      <div class="field"><span aria-hidden="true">As</span><${Segmented} label="As" value=${kind} onChange=${setKind} options=${KINDS} /></div>
      <${Field} label="Amount"><input class="input" inputmode="decimal" value=${amount} onInput=${(e: Event) => setAmount((e.target as HTMLInputElement).value)} placeholder="$25,000" /></${Field}>
      <${Field} label="Date"><input class="input" type="date" value=${date} onInput=${(e: Event) => setDate((e.target as HTMLInputElement).value)} /></${Field}>
      ${convertible
        ? html`<${Field} label="Valuation cap (optional)"><input class="input" inputmode="decimal" value=${cap} onInput=${(e: Event) => setCap((e.target as HTMLInputElement).value)} placeholder="$8,000,000" /></${Field}>
            <${Field} label="Discount % (optional)"><input class="input" inputmode="decimal" value=${discount} onInput=${(e: Event) => setDiscount((e.target as HTMLInputElement).value)} placeholder="20" /></${Field}>`
        : html`<${Field} label="Round or class (optional)"><input class="input" value=${series} onInput=${(e: Event) => setSeries((e.target as HTMLInputElement).value)} placeholder="Series A" /></${Field}>
            <${Field} label="Shares (optional)"><input class="input" inputmode="numeric" value=${shares} onInput=${(e: Event) => setShares((e.target as HTMLInputElement).value)} placeholder="40,000" /></${Field}>`}
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit" disabled=${busy}>Add</${Button}><${Button} quiet onClick=${onCancel}>Cancel</${Button}></div>
    </form>
  </${Section}>`
}
