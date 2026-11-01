// Equity (S6), inside the company drawer: the cap table at a glance, and behind small "+"s, recording events, modeling
// the next round, an exit waterfall, and import/export. Modeling runs in the browser on the same math as the server.
import { convertMinor, exponent, fmtPrice, modelRound, waterfall, type EquityDetail, type RoundResult, type WaterfallResult } from '@agfn/equity/math'
import type { Money } from '@agfn/contracts'
import { useRef, useState } from 'preact/hooks'
import type { EquityWritePayloadInput } from '../api/types.ts'
import { useApp, useLoad } from '../app/context.ts'
import { fmt, parseAmount } from '../lib/money.ts'
import { shortDate } from '../lib/time.ts'
import { Button, Field, LinkButton, PlusAction, Pluses, Row, Rows, Section, Segmented, Tile } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

type P = { id: string; onClose: () => void; onBack: (() => void) | null }

const n = (x: number) => x.toLocaleString('en-US')
/** The server's percent as it comes (2 places, as get_cap_table gives it); no rounding of our own. */
const pct = (x: number) => `${x}%`
/** What-ifs are modelled here from what you type (same @agfn/equity math as the server); they need rounding to show. */
const whatIfPct = (x: number) => (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + '%'

function useEquity(id: string) {
  const app = useApp()
  // Re-read whenever the Workspace reloads (an Undo from a toast does that), so an open cap table never shows a stale state.
  const r = useLoad(() => app.api.equity(id), [id, app.ws])
  const name = app.ws?.entities.find((e) => e.id === id)?.name ?? 'Company'
  return { ...r, name }
}

/** "≈ $550,000" when an amount isn't in the company's currency and there's a rate; "" otherwise. */
function inHome(d: EquityDetail, m: Money): string {
  const h = d.home
  if (!h || m.currency === h.currency) return ''
  const r = h.rates[m.currency]
  return r ? `≈ ${fmt({ minor: Math.round(convertMinor(m.minor, m.currency, h.currency, r)), currency: h.currency })}` : `no ${m.currency} rate yet`
}

export function EquityView({ id, onClose, onBack }: P) {
  const app = useApp()
  const { data: d, error, reload, name } = useEquity(id)
  const file = useRef<HTMLInputElement>(null)
  if (error) return html`<${LoadFailed} title="Couldn’t open the cap table" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} backLabel=${name} />`
  if (!d) return html`<${Drawer} title="Loading…" onClose=${onClose} onBack=${onBack} backLabel=${name} />`

  const doImport = async (f: File | undefined) => {
    if (!f) return
    try {
      const r = await app.api.importEquity(id, f)
      reload()
      app.reload()
      const writeId = r.writeId
      app.toast({
        text: r.added ? `Imported ${n(r.added)} ${r.added === 1 ? 'item' : 'items'}.${r.notes.length ? ' ' + r.notes[0] : ''}` : (r.notes[0] ?? 'Nothing new in that file.'),
        // The whole import is one write, so one Undo takes all of it back.
        ...(writeId ? { undo: async () => (await app.api.undo(writeId), app.toast({ text: 'Import undone.' }), app.reload()) } : {}),
      })
    } catch (e) {
      app.toast({ text: e instanceof Error ? e.message : 'That file couldn’t be read.' })
    }
  }
  const v409 = d.valuations[d.valuations.length - 1]
  // More than one currency on the table: show totals in the company's own.
  const mixed = !!d.home && (d.convertibles.some((c) => c.amount.currency !== d.home!.currency) || d.home.missing.length > 0)
  const empty = d.fullyDiluted.total === 0 && !d.convertibles.length

  return html`<${Drawer}
    title="Cap table"
    sub=${empty ? `${name} has no cap table yet.` : `${n(d.fullyDiluted.total)} shares fully diluted${v409 ? ` · 409A ${fmtPrice(v409.pricePerShare)} (${shortDate(v409.date, true)})` : ''}`}
    onClose=${onClose}
    onBack=${onBack}
    backLabel=${name}
  >
    ${empty
      ? html`<p class="sub" style="margin-top:16px">Import from Carta or Pulley, or record the first issuance. Your AI can add to it too: “Record a $250k SAFE from Kite at an $8M cap.”</p>`
      : null}

    ${d.holders.length
      ? html`<${Section} compact title="Who owns what" sub="Fully diluted: shares, options and the unissued pool">
          <${Rows} label="Holders">${d.holders.map((h) => html`<${Row} name=${h.name} line=${[h.role, h.line].filter(Boolean).join(' · ')} right=${html`<span class="value">${pct(h.pct)}</span>`} />`)}</${Rows}>
        </${Section}>`
      : null}

    ${d.convertibles.length
      ? html`<${Section} compact title="SAFEs and notes" sub=${mixed ? (d.home?.safesAndNotes ? `Not shares yet · ${fmt(d.home.safesAndNotes)} in all, in ${d.home.currency}` : `Not shares yet · no total until there’s a rate for ${d.home?.missing.join(', ')}`) : 'Not shares yet; they convert at the next priced round'}>
          <${Rows}>${d.convertibles.map((c) => html`<${Row} name=${c.holder} line=${[`${c.kind === 'SAFE' ? 'SAFE' : 'Note'} · ${c.line} · ${shortDate(c.date, true)}${c.accrued.minor ? ` · ${fmt(c.accrued)} interest so far` : ''}`, inHome(d, c.amount)].filter(Boolean).join(' · ')} right=${html`<span class="value">${fmt(c.amount)}</span>`} />`)}</${Rows}>
          <${PlusAction} onClick=${() => app.push({ kind: 'equity-round', id })}>Model the next round</${PlusAction}>
        </${Section}>`
      : null}

    ${d.pool || d.grants.length
      ? html`<${Section} compact title="Option pool" sub=${d.pool ? `${n(d.pool.size)} reserved · ${n(d.pool.used)} granted (options and RSUs) · ${n(d.pool.available)} available` : 'Grants outside a pool'}>
          <${Rows}>${d.grants.map((g) => html`<${Row} name=${g.holder} line=${`${g.type} · ${g.line}`} right=${html`<span class="value">${n(g.outstanding)}</span>`} />`)}</${Rows}>
        </${Section}>`
      : null}

    ${d.warrants.length
      ? html`<${Section} compact title="Warrants" sub="Rights to buy shares at a set price, counted fully diluted until they expire">
          <${Rows} label="Warrants">${d.warrants.map((w) => html`<${Row} name=${w.holder} line=${[w.line, w.exercisePrice ? inHome(d, w.exercisePrice) : ''].filter(Boolean).join(' · ')} right=${html`<span class=${'value' + (w.live ? '' : ' sub')}>${n(w.outstanding)}</span>`} />`)}</${Rows}>
        </${Section}>`
      : null}

    ${d.classes.length
      ? html`<${Section} compact title="Share classes" sub="What each class is, and what it’s owed in a sale">
          <${Rows}>${d.classes.map((c) => html`<${Row} name=${c.name} line=${c.line} />`)}</${Rows}>
        </${Section}>`
      : null}

    ${d.valuations.length
      ? html`<${Section} compact title="409A" sub="Fair market value of common, for option strikes">
          <${Rows}>${[...d.valuations].reverse().map((v) => html`<${Row} name=${shortDate(v.date, true)} line=${v.provider ?? ''} right=${html`<span class="value">${fmtPrice(v.pricePerShare)}</span>`} />`)}</${Rows}>
        </${Section}>`
      : null}

    ${d.warnings.length
      ? html`<${Section} compact title="Anything odd" sub="Found while adding it up">
          <${Rows}>${d.warnings.map((w) => html`<${Row} icon=${html`<${Tile} icon="alert" />`} name=${html`<span class="amber">${w}</span>`} />`)}</${Rows}>
        </${Section}>`
      : null}

    <div style="margin-top:32px">
      <${Pluses}>
        <${PlusAction} onClick=${() => app.push({ kind: 'equity-add', id })}>Record something</${PlusAction}>
        ${!empty ? html`<${PlusAction} onClick=${() => app.push({ kind: 'equity-exit', id })}>What if we sell?</${PlusAction}>` : null}
        ${!empty && !d.convertibles.length ? html`<${PlusAction} onClick=${() => app.push({ kind: 'equity-round', id })}>Model a round</${PlusAction}>` : null}
        <${PlusAction} onClick=${() => file.current?.click()}>Import from Pulley, Carta or Mantle</${PlusAction}>
      </${Pluses}>
      <p class="meta" style="margin-top:8px"><a class="link" href="/docs/guides/import-pulley-carta" target="_blank" rel="noopener">How to export from Pulley, Carta or Mantle ↗</a></p>
      <input ref=${file} type="file" class="sr" accept=".xlsx,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/json,text/csv" tabindex="-1" aria-label="Choose a cap table file" onChange=${(e: Event) => doImport((e.target as HTMLInputElement).files?.[0])} />
      ${!empty ? html`<p class="links" style="margin-top:8px"><a class="link" href=${app.api.ocfExportUrl(id)} download=${`${name} cap table (OCF).json`}>Export Open Cap Format</a></p>` : null}
    </div>
  </${Drawer}>`
}

// ---------- Record something ----------

/** What the form offers. RSUs and warrants are grants of their own type (grantType) on the same write. */
type FormKind = EquityWritePayloadInput['kind'] | 'rsu' | 'warrant'
const KINDS: Array<{ value: FormKind; label: string }> = [
  { value: 'issuance', label: 'Shares' },
  { value: 'safe', label: 'SAFE' },
  { value: 'convertible_note', label: 'Note' },
  { value: 'option_grant', label: 'Options' },
  { value: 'rsu', label: 'RSUs' },
  { value: 'warrant', label: 'Warrant' },
  { value: 'exercise', label: 'Exercise' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'cancellation', label: 'Cancel' },
]
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'ILS', 'JPY', 'SGD', 'INR']

export function EquityAddView({ id, onClose, onBack }: P) {
  const app = useApp()
  const { data: detail } = useEquity(id)
  const home = detail?.home?.currency ?? 'USD'
  const [kind, setKind] = useState<FormKind>('safe')
  // Exercise and cancel: of what (options, RSUs or a warrant).
  const [of, setOf] = useState<'option' | 'rsu' | 'warrant'>('option')
  const today = new Date(app.now()).toISOString().slice(0, 10)
  // Switching what happened starts the form over (keeping the date and currency), so a value never lands on the wrong holder.
  const [f, setF] = useState<Record<string, string>>({ date: today, months: '48', cliff: '12' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: string) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })
  const input = (k: string, label: string, placeholder = '', mode: 'text' | 'decimal' | 'numeric' = 'text') =>
    html`<${Field} label=${label}><input class="input tn" inputmode=${mode} value=${f[k] ?? ''} onInput=${set(k)} placeholder=${placeholder} /></${Field}>`
  const cur = f.cur || home
  const money = (k: string) => (f[k]?.trim() ? parseAmount(f[k]!, cur) : null)
  const price = (k: string) => {
    const v = f[k]?.replace(/[^\d.]/g, '')
    if (!v) return null
    const x = Number(v)
    return Number.isFinite(x) && x >= 0 ? { minor: Math.round(x * 10 ** exponent(cur) * 10_000) / 10_000, currency: cur } : null
  }

  const submit = async (e: Event) => {
    e.preventDefault()
    setErr('')
    const shares = f.shares ? Number(f.shares.replace(/,/g, '')) : null
    if (f.shares && (!Number.isInteger(shares) || shares! <= 0)) return setErr('Shares must be a whole number.')
    if (f.amount && !money('amount')) return setErr('That amount isn’t a number.')
    const grant = kind === 'rsu' || kind === 'warrant'
    const grantType = kind === 'rsu' ? 'rsu' : kind === 'warrant' ? 'warrant' : (kind === 'exercise' || kind === 'cancellation') && of !== 'option' ? of : null
    const payload: EquityWritePayloadInput = {
      kind: grant ? 'option_grant' : (kind as EquityWritePayloadInput['kind']),
      ...(grantType ? { grantType } : {}),
      ...(kind === 'warrant' && f.expires ? { expirationDate: f.expires } : {}),
      ...(kind === 'exercise' && of === 'warrant' && f.net === 'yes' ? { netExercise: true, fairValuePerShare: price('fv') } : {}),
      ...(kind === 'exercise' && of === 'rsu' && f.withheld ? { withheldShares: Number(f.withheld.replace(/,/g, '')) } : {}),
      date: f.date ?? '',
      stakeholder: (f.who ?? '').trim(),
      shares,
      shareClass: f.cls?.trim() || null,
      amount: money('amount'),
      pricePerShare: price('price'),
      valuationCap: money('cap'),
      discountPct: f.discount ? Number(f.discount.replace('%', '')) : null,
      interestPct: f.interest ? Number(f.interest.replace('%', '')) : null,
      vesting: (kind === 'option_grant' || kind === 'rsu' || kind === 'issuance') && (f.vest ?? (kind === 'issuance' ? 'no' : 'yes')) === 'yes' ? { start: f.vstart || f.date || '', months: Number(f.months || 48), cliffMonths: Number(f.cliff || 0) } : null,
      toStakeholder: f.to?.trim() || null,
    }
    setBusy(true)
    try {
      const r = await app.api.recordEquity(id, payload)
      const recordId = r.recordId
      if (r.status === 'pending_review') app.toast({ text: 'Waiting for review. It’s in Review until someone approves it.' })
      else
        app.toast({
          text: r.summary + (r.possibleDuplicates.length ? ' This looks like something already recorded; check it.' : ''),
          ...(recordId ? { undo: async () => (await app.api.undo(recordId), app.toast({ text: 'Undone.' }), app.reload()) } : {}),
        })
      await app.reload()
      onBack ? onBack() : onClose()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That couldn’t be recorded.')
    } finally {
      setBusy(false)
    }
  }

  const who = kind === 'safe' || kind === 'convertible_note' ? 'Investor' : kind === 'warrant' ? 'Holder' : kind === 'transfer' ? 'From' : 'Who'
  const usesMoney = kind === 'issuance' || kind === 'safe' || kind === 'convertible_note' || kind === 'option_grant' || kind === 'warrant' || (kind === 'exercise' && of === 'warrant' && f.net === 'yes')
  const vests = kind === 'option_grant' || kind === 'rsu' || kind === 'issuance'
  return html`<${Drawer} title="Record something" sub="Changes the cap table right away, with undo. Money paid in also shows up in the books." onClose=${onClose} onBack=${onBack} backLabel="Cap table">
    <form onSubmit=${submit} novalidate style="margin-top:20px">
      <div><${Segmented} wrap label="What happened" value=${kind} onChange=${(v: FormKind) => (setKind(v), setErr(''), setF({ date: f.date ?? today, months: '48', cliff: '12', ...(f.cur ? { cur: f.cur } : {}) }))} options=${KINDS} /></div>
      ${kind === 'exercise' || kind === 'cancellation' ? html`<div class="field"><span aria-hidden="true">Of</span><${Segmented} label="Of what" value=${of} onChange=${setOf} options=${[{ value: 'option', label: 'Options' }, { value: 'rsu', label: kind === 'exercise' ? 'RSUs (release)' : 'RSUs' }, { value: 'warrant', label: 'Warrant' }]} /></div>` : null}
      ${input('who', who, kind === 'safe' ? 'Kite Ventures' : kind === 'warrant' ? 'Harbor Bank' : 'Dana Ruiz')}
      ${usesMoney ? html`<${Field} label="Currency"><select class="input" value=${cur} onChange=${(e: Event) => setF({ ...f, cur: (e.target as HTMLSelectElement).value })}>${[...new Set([home, ...CURRENCIES])].map((c) => html`<option value=${c}>${c}</option>`)}</select></${Field}>` : null}
      ${kind === 'transfer' ? input('to', 'To', 'Dana Ruiz 2026 Trust') : null}
      ${kind === 'safe' || kind === 'convertible_note' ? html`${input('amount', 'Amount', '250,000', 'decimal')}${input('cap', 'Valuation cap (optional)', '8,000,000', 'decimal')}${input('discount', 'Discount % (optional)', '20', 'decimal')}${kind === 'convertible_note' ? input('interest', 'Interest % a year', '8', 'decimal') : null}` : null}
      ${kind !== 'safe' && kind !== 'convertible_note' ? input('shares', kind === 'option_grant' ? 'Options' : kind === 'rsu' ? 'RSUs' : kind === 'exercise' && of === 'rsu' ? 'RSUs to release' : 'Shares', '100,000', 'numeric') : null}
      ${kind === 'issuance' || kind === 'warrant' || kind === 'transfer' || (kind === 'cancellation' && of === 'option') ? input('cls', kind === 'warrant' ? 'For shares of (optional)' : 'Share class (optional)', kind === 'warrant' ? 'Series A Preferred' : 'Common') : null}
      ${kind === 'issuance' ? input('price', 'Price per share (optional)', '0.0001', 'decimal') : null}
      ${kind === 'option_grant' || kind === 'warrant' ? input('price', 'Exercise price', kind === 'warrant' ? '1.20' : '0.21', 'decimal') : null}
      ${kind === 'warrant' ? html`${input('amount', 'Paid for the warrant (optional)', '0', 'decimal')}<${Field} label="Expires (optional)"><input class="input" type="date" value=${f.expires ?? ''} onInput=${set('expires')} /></${Field}>` : null}
      ${kind === 'exercise' && of === 'rsu' ? input('withheld', 'Kept back for tax (optional)', '0', 'numeric') : null}
      ${kind === 'exercise' && of === 'warrant'
        ? html`<div class="field"><span aria-hidden="true">Paid</span><${Segmented} label="Paid" value=${f.net ?? 'no'} onChange=${(v: string) => setF({ ...f, net: v })} options=${[{ value: 'no', label: 'In cash' }, { value: 'yes', label: 'Cashless' }]} /></div>
          ${f.net === 'yes' ? input('fv', 'Fair value per share (blank: the latest 409A)', '2.00', 'decimal') : null}`
        : null}
      ${vests
        ? html`<div class="field"><span aria-hidden="true">Vesting</span><${Segmented} label="Vesting" value=${f.vest ?? (kind === 'issuance' ? 'no' : 'yes')} onChange=${(v: string) => setF({ ...f, vest: v })} options=${[{ value: 'yes', label: 'Vests' }, { value: 'no', label: 'Fully vested' }]} /></div>
          ${(f.vest ?? (kind === 'issuance' ? 'no' : 'yes')) === 'yes' ? html`<div class="formrow" style="margin-top:0">${input('vstart', 'Starts', f.date ?? '')}${input('months', 'Months', '48', 'numeric')}${input('cliff', 'Cliff months', '12', 'numeric')}</div>` : null}`
        : null}
      <${Field} label="Date"><input class="input" type="date" value=${f.date} onInput=${set('date')} /></${Field}>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit" disabled=${busy}>Record</${Button}></div>
    </form>
  </${Drawer}>`
}

// ---------- Model a round ----------

export function EquityRoundView({ id, onClose, onBack }: P) {
  const app = useApp()
  const { data: d } = useEquity(id)
  const [f, setF] = useState({ pre: '20,000,000', money: '5,000,000', pool: '10' })
  const set = (k: keyof typeof f) => (e: Event) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })
  let r: RoundResult | null = null
  let err = ''
  if (d) {
    const pre = parseAmount(f.pre, d.home?.currency ?? 'USD')
    const inv = parseAmount(f.money, d.home?.currency ?? 'USD')
    if (!pre || pre.minor <= 0 || !inv) err = 'Enter a valuation and an amount.'
    else {
      try {
        r = modelRound(d.state, { date: new Date(app.now()).toISOString().slice(0, 10), preMoney: pre, investment: inv, ...(f.pool.trim() ? { poolTargetPct: Number(f.pool) } : {}), investorName: 'New investors', ...(d.home ? { rates: d.home.rates } : {}) })
      } catch (e) {
        err = e instanceof Error ? e.message : 'Those numbers don’t work.'
      }
    }
  }
  return html`<${Drawer} title="Model the next round" sub="Nothing is saved. SAFEs and notes convert, the pool is topped up, new money comes in." onClose=${onClose} onBack=${onBack} backLabel="Cap table">
    <div class="formrow">
      <label class="field" style="flex:1;min-width:140px;margin:0"><span>Pre-money valuation</span><input class="input tn" inputmode="decimal" value=${f.pre} onInput=${set('pre')} /></label>
      <label class="field" style="flex:1;min-width:120px;margin:0"><span>New money</span><input class="input tn" inputmode="decimal" value=${f.money} onInput=${set('money')} /></label>
      <label class="field" style="width:110px;margin:0"><span>Pool after %</span><input class="input tn" inputmode="decimal" value=${f.pool} onInput=${set('pool')} /></label>
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    ${r
      ? html`<div aria-live="polite">
          <p class="big" style="margin-top:28px">${fmtPrice(r.pricePerShare)}</p>
          <p class="sub">a share · ${fmt(r.postMoney)} post-money · ${n(r.postMoneyFullyDiluted)} shares after</p>
          ${r.conversions.length
            ? html`<${Section} compact title="SAFEs and notes convert" sub="Each at the lowest of its cap price, discount price or the round price">
                <${Rows}>${r.conversions.map((c) => html`<${Row} name=${c.holder} line=${`${fmt(c.convertingAmount)} at ${fmtPrice(c.pricePerShare)} (${c.basis === 'cap' ? 'cap' : c.basis === 'discount' ? 'discount' : 'round price'})`} right=${html`<span class="value">${n(c.shares)}</span>`} />`)}</${Rows}>
              </${Section}>`
            : null}
          <${Section} compact title="After the round" sub=${r.poolIncrease ? `Pool grows by ${n(r.poolIncrease)} shares before the new money` : 'Fully diluted'}>
            <${Rows}>${r.table.map((t) => html`<${Row} name=${t.name} line=${{ existing: 'today', converted: 'from SAFE or note', new: 'new money', pool: 'unissued' }[t.kind]} right=${html`<span class="value">${whatIfPct(t.pct)}</span>`} />`)}</${Rows}>
          </${Section}>
          ${r.warnings.map((w) => html`<p class="sub amber" style="margin-top:12px">${w}</p>`)}
        </div>`
      : null}
  </${Drawer}>`
}

// ---------- Exit waterfall ----------

export function EquityExitView({ id, onClose, onBack }: P) {
  const { data: d } = useEquity(id)
  const [value, setValue] = useState('25,000,000')
  const [opts, setOpts] = useState<'vested' | 'all'>('vested')
  const exit = parseAmount(value, d?.home?.currency ?? 'USD')
  const r: WaterfallResult | null = d && exit && exit.minor >= 0 ? waterfall(d.state, exit, { options: opts, ...(d.home ? { rates: d.home.rates } : {}) }) : null
  return html`<${Drawer} title="What if we sell?" sub="Who gets what at a sale price, after preferences. SAFEs and notes aren’t included; model the round first." onClose=${onClose} onBack=${onBack} backLabel="Cap table">
    <div class="formrow">
      <label class="field" style="flex:1;margin:0"><span>Sale price</span><input class="input tn" inputmode="decimal" value=${value} onInput=${(e: Event) => setValue((e.target as HTMLInputElement).value)} /></label>
      <div class="field" style="margin:0"><span aria-hidden="true">Options</span><${Segmented} label="Options counted" value=${opts} onChange=${setOpts} options=${[{ value: 'vested', label: 'Vested' }, { value: 'all', label: 'All' }]} /></div>
    </div>
    ${!exit ? html`<p class="err" role="alert">Enter a sale price.</p>` : null}
    ${r
      ? r.missingRates.length
        ? html`<p class="sub" role="status" style="margin-top:20px">${r.warnings[0]}</p>`
        : html`<div aria-live="polite">
          <p class="big" style="margin-top:28px">${fmtPrice(r.commonPerShare)}</p>
          <p class="sub">per common share</p>
          <${Section} compact title="Who gets what" sub=${fmt(r.exitValue)}>
            <${Rows}>${r.holders.map((h) => html`<${Row} name=${h.name} line=${whatIfPct(h.pct)} right=${html`<span class="value">${fmt(h.amount)}</span>`} />`)}</${Rows}>
          </${Section}>
          ${r.classes.length
            ? html`<${Section} compact title="Preferred" sub="Takes its preference, or converts when that pays more">
                <${Rows}>${r.classes.map((c) => html`<${Row} name=${c.className} line=${c.converted ? 'converts to common' : `preference ${fmt({ minor: c.preference, currency: r!.exitValue.currency })}${c.participation ? ` + ${fmt({ minor: c.participation, currency: r!.exitValue.currency })} participation` : ''}`} right=${html`<span class="value">${fmt({ minor: c.total, currency: r!.exitValue.currency })}</span>`} />`)}</${Rows}>
              </${Section}>`
            : null}
          ${r.warnings.map((w) => html`<p class="sub amber" style="margin-top:12px">${w}</p>`)}
        </div>`
      : null}
  </${Drawer}>`
}

export type { EquityDetail }
export const _LinkButton = LinkButton
