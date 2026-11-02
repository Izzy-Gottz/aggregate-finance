// Company drawer: header (cash, runway, as-of), then sections that exist only when they have data (MASTER §3).
// Every number opens "How this is worked out": the formula, accounts counted and left out, and the rows behind it.
import { useEffect, useRef, useState } from 'preact/hooks'
import { isPublicDemo } from '../lib/demo.ts'
import { canShare, ShareLink } from './share.ts'
import type { Money } from '@agfn/contracts'
import type { CompanyDetail, Explained, HoldingRow, TxnRow, UnreadDocument } from '../api/types.ts'
import { isFilling, isManager, isOwnerHere, isReviewer, useApp, useLoad } from '../app/context.ts'
import { canDeleteFiles, DeleteFile } from './add.ts'
import { fmt } from '../lib/money.ts'
import { termsLine } from '../lib/terms.ts'
import { ago, dueWords, shortDate } from '../lib/time.ts'
import { Button, LinkButton, PlusAction, Pluses, Row, Rows, Section, Sparkline, Tile } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'
import type { IconName } from '../ui/icons.ts'

const ACCOUNT_ICON: Record<string, IconName> = { bank: 'bank', card: 'card', payments: 'cash', cash: 'cash', loan: 'bank', investment: 'bank', crypto: 'key' }

export function CompanyView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  // Re-read whenever the Workspace reloads (every change does that), so the drawer never shows a stale state.
  const { data: c, error, reload } = useLoad(() => app.api.company(id), [id, app.ws])
  if (error) return html`<${LoadFailed} title="Couldn’t open this company" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!c) {
    // The workspace already knows the name and cash: show them while the details load.
    const e = app.ws?.entities.find((x) => x.id === id)
    return html`<${Drawer} title=${e?.name ?? 'Loading…'} onClose=${onClose} onBack=${onBack}>
      ${e?.cash && !e.hidden && !isFilling(app.ws) ? html`<p class="big num" style="margin-top:16px">${fmt(e.cash)}</p>` : null}
      <p class="sub" aria-busy="true" style="margin-top:8px">Loading accounts and activity…</p>
    </${Drawer}>`
  }
  if (isFilling(app.ws)) return html`<${Drawer} title=${c.entity.name} sub="Filling the demo…" onClose=${onClose} onBack=${onBack} />`
  const now = app.now()
  const runway = runwayWords(c.runway)
  const sub = [runway, `as of ${ago(c.asOf, now)}`].filter(Boolean).join(' · ')
  return html`<${Drawer}
    title=${c.entity.name}
    onClose=${onClose}
    onBack=${onBack}
    aside=${html`<${Sparkline} points=${c.trend} label=${`${c.entity.name} cash over the last 12 months`} />`}
  >
    <${Header} c=${c} sub=${sub} />
    ${c.entity.kind === 'company' && isManager(app) && !isPublicDemo(app) && !isReviewer(app) ? html`<${CompanySettings} c=${c} />` : null}
    ${c.entity.kind === 'company' && isOwnerHere(app) && !isPublicDemo(app) && !isReviewer(app) ? html`<${DeleteCompany} c=${c} onClose=${onClose} />` : null}
    <${CompanySections} c=${c} />
    ${c.entity.kind === 'company' && canShare(app) ? html`<div class="links" style="margin-top:32px"><${ShareLink} entityId=${c.entity.id} kind="roast" label="Roast these books" /><${ShareLink} entityId=${c.entity.id} kind="hype" label="Hype these books" />${app.me?.badges ? html`<${ShareLink} entityId=${c.entity.id} kind="badge" label="Get a verified badge" />` : null}</div>` : null}
  </${Drawer}>`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The company's name and the month its year starts, edited in place (owners and admins; PATCH /api/preferences). */
function CompanySettings({ c }: { c: CompanyDetail }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(c.entity.name)
  const [month, setMonth] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  // Opening puts focus on Name; closing (Save or Cancel) puts it back on the link that opened it.
  const wrap = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>('input')?.focus()
    else if (wasOpen.current) wrap.current?.querySelector<HTMLElement>('button')?.focus()
    wasOpen.current = open
  }, [open])
  const start = async () => {
    setErr('')
    setName(c.entity.name)
    setOpen(true)
    const p = await app.api.preferences().catch(() => null)
    setMonth(p?.companies.find((x) => x.id === c.entity.id)?.fiscalYearStartMonth ?? 1)
  }
  const save = async (e: Event) => {
    e.preventDefault()
    const clean = name.replace(/\s+/g, ' ').trim()
    if (!clean) return setErr('A company needs a name.')
    if (saving || month === null) return
    setSaving(true)
    setErr('')
    try {
      const p = await app.api.preferences()
      await app.api.updatePreferences({ companies: p.companies.map((x) => (x.id === c.entity.id ? { ...x, name: clean, fiscalYearStartMonth: month } : x)) })
    } catch (x) {
      setSaving(false)
      return setErr(x instanceof Error && x.message ? x.message : 'That didn’t save. Try again.')
    }
    setSaving(false)
    setOpen(false)
    app.toast({ text: 'Saved.' })
    await app.reload()
  }
  if (!open) return html`<div ref=${wrap}><${PlusAction} onClick=${start}>Rename company</${PlusAction}></div>`
  return html`<div ref=${wrap}><form onSubmit=${save} novalidate style="margin-top:24px">
    <label class="field"><span>Name</span><input class="input" value=${name} maxLength=${80} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} /></label>
    <label class="field"><span>Year starts</span>
      <select class="input" value=${month ?? ''} disabled=${month === null} onChange=${(e: Event) => setMonth(Number((e.target as HTMLSelectElement).value))}>
        ${month === null ? html`<option value="">Loading…</option>` : MONTHS.map((m, i) => html`<option value=${i + 1}>${m}</option>`)}
      </select></label>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="formrow"><${Button} type="submit" disabled=${saving || month === null}>${saving ? 'Saving…' : 'Save'}</${Button}><${LinkButton} onClick=${() => setOpen(false)}>Cancel</${LinkButton}></div>
  </form></div>`
}

/** Owners delete a company. When the server says it can't go yet (a live connection), the reason shows instead of a confirm. */
function DeleteCompany({ c, onClose }: { c: CompanyDetail; onClose: () => void }) {
  const app = useApp()
  const [confirm, setConfirm] = useState(false)
  const [err, setErr] = useState('')
  // The link that opened the confirm is gone while it shows: focus goes to Cancel, and back to that link after Cancel,
  // never lost to the page.
  const box = useRef<HTMLSpanElement>(null)
  const row = useRef<HTMLDivElement>(null)
  const was = useRef(false)
  useEffect(() => {
    if (confirm) box.current?.querySelector<HTMLElement>('button:last-of-type')?.focus()
    else if (was.current) row.current?.querySelector<HTMLElement>('button')?.focus()
    was.current = confirm
  }, [confirm])
  // The server's reason when it can't go yet; null means it can.
  const blocked = typeof c.deleteBlocked === 'string' ? c.deleteBlocked : null
  const empty = c.deleteBlocked === null
  const remove = async () => {
    try {
      await app.api.deleteCompany(c.entity.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work. Try again.')
      return
    }
    app.toast({ text: `${c.entity.name} is deleted.` })
    await app.reload()
    // The switcher must not stay on a company that's gone: back to All companies. Otherwise just close this drawer.
    if (app.scope === c.entity.id) {
      app.setScope(null)
      app.go({ page: 'workspace', step: 0, stack: [] })
    } else onClose()
  }
  return html`<div class="links" style="margin-top:8px" ref=${row}>
    ${confirm && blocked
      ? html`<span class="sub" role="alert" ref=${box}>${c.entity.name} can’t be deleted yet. ${blocked}
          <${LinkButton} onClick=${() => setConfirm(false)}>Cancel</${LinkButton}></span>`
      : confirm
      ? html`<span class="sub" role="alert" ref=${box}>Delete ${c.entity.name}?${empty ? ' Nothing connects to it or counts in it any more.' : ''}
          <${LinkButton} danger onClick=${remove}>Delete</${LinkButton}> · <${LinkButton} onClick=${() => (setConfirm(false), setErr(''))}>Cancel</${LinkButton}></span>
          ${err ? html`<p class="err" role="alert">${err}</p>` : null}`
      : html`<${LinkButton} danger onClick=${() => setConfirm(true)}>Delete company</${LinkButton}>`}
  </div>`
}

function Header({ c, sub }: { c: CompanyDetail; sub: string }) {
  const app = useApp()
  if (!c.cash) return html`<p class="sub dsub">No money connected yet.</p>`
  const a = c.cash.answer
  // unknown: no number, and why; stale: the number, with a quiet note on what's old.
  const shown = a.state === 'unknown' || !a.value ? 'Unknown' : fmt(a.value as { minor: number; currency: string })
  const caveat = a.state === 'unknown' || a.state === 'stale' ? (a.unknownReason ?? (a.state === 'stale' ? 'Some balances are out of date.' : 'Not enough data for a total.')) : null
  return html`<div style="margin-top:16px">
    <button type="button" class=${'big num' + (shown === 'Unknown' ? ' grey' : '')} onClick=${() => app.push({ kind: 'explain', id: c.entity.id, metric: 'cash' })} aria-label=${`Cash ${shown}. How this is worked out`}>
      ${shown}
    </button>
    ${caveat ? html`<p class="sub amber">${caveat}</p>` : null}
    ${c.entity.setAside ? html`<p class="sub">Available ${fmt(c.entity.setAside.available)} · ${fmt(c.entity.setAside.held)} set aside</p>` : null}
    ${c.entity.kind === 'personal' && !c.entity.hidden ? html`<p class="sub">${isPublicDemo(app) ? 'Made-up, like the rest of the demo.' : 'Only you see this.'}</p>` : null}
    <${MrrLine} c=${c} />
    <p class="sub">
      ${c.runway ? html`<button type="button" class="link" style="font-size:inherit" onClick=${() => app.push({ kind: 'explain', id: c.entity.id, metric: 'runway' })}>${sub.split(' · ')[0]}</button>${' · ' + sub.split(' · ').slice(1).join(' · ')}` : sub}
    </p>
  </div>`
}

export function CompanySections({ c }: { c: CompanyDetail }) {
  const app = useApp()
  const now = app.now()
  const id = c.entity.id
  const empty = !c.accounts.length && !c.owedToYou && !c.bills && !c.buckets.length && !c.payroll && !c.equity && !c.whoseMoney.length && !c.odd.length && !c.hasTransactions && !c.holdings?.length
  const personal = c.entity.kind === 'personal'
  return html`
    ${empty
      ? html`<${Section} compact title="Nothing here yet" sub=${personal ? 'Connect a bank or brokerage, or add cash by hand. Only you see it.' : 'Connect a bank or Stripe for this company, or add cash and receipts by hand.'}>
          <${Pluses}>
            <${PlusAction} onClick=${() => app.open({ kind: 'connect' })}>Connect money</${PlusAction}>
            <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'cash' })}>Add cash or a receipt</${PlusAction}>
          </${Pluses}>
        </${Section}>`
      : null}

    ${c.accounts.length
      ? html`<${Section} compact title="Cash & accounts" sub=${personal ? 'Every account you hold' : 'Every account in this company'}>
          <${Rows}>
            ${c.accounts.map(
              (a) => html`<${Row}
                icon=${html`<${Tile} icon=${ACCOUNT_ICON[a.kind] ?? 'bank'} />`}
                name=${`${accountName(a)}${a.mask ? ' ··' + a.mask : ''}`}
                line=${[termsLine(a.terms), a.addedBy ? `added by ${a.addedBy}` : null, a.stale ? html`<span class="amber">as of ${ago(a.asOf, now)}</span>` : `synced ${ago(a.asOf, now)}`].filter(Boolean).map((x, i) => (i ? html` · ${x}` : x))}
                right=${a.balance ? html`<span class="value">${fmt(a.balance)}</span>` : html`<span class="value grey">unknown</span>`}
              />`,
            )}
          </${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'cash' })}>Add cash or a receipt</${PlusAction}>
        </${Section}>`
      : null}

    ${c.holdings?.length
      ? html`<${Section} compact title="Holdings" sub=${holdingsLine(c.holdings.length, c.holdingsTotal ?? [])}>
          <${Rows}>
            ${c.holdings.map((h) => html`<${Row} name=${h.name} line=${[h.detail, sharesWords(h), h.account].filter(Boolean).join(' · ')} right=${html`<span class="value">${fmt(h.value)}</span>`} />`)}
          </${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'connect', key: 'plaid' })}>Connect another brokerage</${PlusAction}>
        </${Section}>`
      : null}

    ${c.owedToYou
      ? html`<${Section} compact title="Owed to you" sub=${`${fmt(c.owedToYou.total)} open · ${fmt(c.owedToYou.overdue)} overdue`}>
          <${Aging} aging=${c.owedToYou.aging} />
          <${Rows}>
            ${c.owedToYou.invoices.map((i) => {
              const due = dueWords(i.dueDate, now)
              return html`<${Row}
                name=${i.counterparty}
                line=${html`${i.number ? i.number + ' · ' : ''}<span class=${due.tone === 'grey' ? '' : due.tone}>${due.text}</span> · ${i.source}`}
                right=${html`<span class="value">${fmt(i.open)}</span>`}
              />`
            })}
          </${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'upload' })}>Add an invoice</${PlusAction}>
        </${Section}>`
      : null}

    ${c.bills
      ? html`<${Section} compact title="Bills & you owe soon" sub=${`${fmt(c.bills.dueSoon)} due in the next 30 days · ${c.bills.breakdown ? `${fmt(c.bills.breakdown.openBills)} in open bills, ${fmt(c.bills.breakdown.recurring)} in recurring charges and minimums` : 'every open bill below'}`}>
          <${Rows}>
            ${c.bills.rows.map((b) => {
              const due = dueWords(b.dueDate, now)
              return html`<${Row} name=${b.name} line=${html`<span class=${due.tone === 'grey' ? '' : due.tone}>${due.text}</span> · ${b.detail}`} right=${html`<span class="value">${fmt(b.amount)}</span>`} />`
            })}
          </${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'upload' })}>Add a bill</${PlusAction}>
        </${Section}>`
      : null}

    ${c.buckets.length
      ? html`<${Section} compact title="Buckets" sub=${personal ? 'Stakes in companies, loans, anything you or your AI track' : 'Rent, loans, anything you or your AI track'}>
          <${Rows}>
            ${c.buckets.map(
              (b) => html`<${Row} icon=${html`<${Tile} icon="bucket" />`} name=${b.name} line=${html`${b.line}${b.status === 'missed' ? html` · <span class="red">missed a payment</span>` : ''}`} onClick=${() => app.push({ kind: 'bucket', id: b.id })} />`,
            )}
          </${Rows}>
          ${personal
            ? html`<${Pluses}>
                <${PlusAction} onClick=${() => app.push({ kind: 'stake-add', id })}>Add a stake in a company</${PlusAction}>
                <${PlusAction} onClick=${() => app.toast({ text: 'Ask your AI: “Make a bucket for …”. It appears here right away.' })}>Add a bucket</${PlusAction}>
              </${Pluses}>`
            : html`<${PlusAction} onClick=${() => app.toast({ text: 'Ask your AI: “Make a bucket for …”. It appears here right away.' })}>Add a bucket</${PlusAction}>`}
        </${Section}>`
      : null}

    ${c.payroll
      ? html`<${Section} compact title=${`Payroll · ${monthLong(c.payroll.lastMonth.month)}`} sub=${`${c.payroll.lastMonth.amount ? fmt(c.payroll.lastMonth.amount) : 'Not known yet'} · ${c.payroll.headcount.employees} people, ${c.payroll.headcount.contractors} contractors`}>
          <${Rows}>
            ${c.payroll.nextRun ? html`<${Row} name="Next payroll" line=${`${shortDate(c.payroll.nextRun.date)} · ${c.payroll.nextRun.provider}`} right=${html`<span class="value">${fmt(c.payroll.nextRun.amount)}</span>`} />` : null}
            ${c.payroll.runs.map((r) => html`<${Row} name=${shortDate(r.date)} line=${`${r.provider} · ${fmt(r.net)} net`} right=${html`<span class="value">${fmt(r.gross)} <span class="grey">gross</span></span>`} />`)}
          </${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'upload' })}>Upload a payroll report</${PlusAction}>
        </${Section}>`
      : null}

    ${c.equity
      ? html`<${Section} compact title="Equity" sub=${`${c.equity.fullyDilutedShares.toLocaleString('en-US')} shares, fully diluted`}>
          <${Rows}>
            ${c.equity.holders.map((h) => html`<${Row} name=${h.name} line=${h.role} right=${html`<span class="value">${h.percent}%</span>`} />`)}
            ${c.equity.convertibles.length
              ? html`<${Row} name=${`${c.equity.convertibles.length} ${c.equity.convertibles.length === 1 ? 'SAFE or note' : 'SAFEs and notes'}`} line=${convertiblesLine(c.equity.convertibles)} />`
              : null}
            <${Row} icon=${html`<${Tile} icon="person" />`} name="Cap table" line="Holders, SAFEs, options, 409A, what-ifs" onClick=${() => app.push({ kind: 'equity', id })} />
          </${Rows}>
          <${PlusAction} onClick=${() => app.push({ kind: 'equity-add', id })}>Record a SAFE, shares or a grant</${PlusAction}>
        </${Section}>`
      : null}

    ${app.me?.investments && !c.entity.hidden
      ? html`<${Section} compact title="Investments"><${Rows}><${Row} name="Portfolio" line="What you put in, what it’s worth, what came back" onClick=${() => app.push({ kind: 'investments', id })} /></${Rows}></${Section}>`
      : null}

    ${c.hasTransactions ? html`<${TransactionsSection} entityId=${id} personal=${personal} />` : null}

    ${personal && !c.buckets.length && !c.entity.hidden
      ? html`<div style="margin-top:40px"><${PlusAction} onClick=${() => app.push({ kind: 'stake-add', id })}>Add a stake in a company</${PlusAction}></div>`
      : null}

    ${!c.equity && c.entity.kind === 'company' && !empty
      ? html`<div style="margin-top:40px"><${PlusAction} onClick=${() => app.push({ kind: 'equity', id })}>Add a cap table</${PlusAction}></div>`
      : null}

    ${c.whoseMoney.length
      ? html`<${Section} compact title="Whose money" sub="Who owes whom, between you and your companies">
          <${Rows}>${c.whoseMoney.map((w) => html`<${Row} name=${w.label} line=${w.detail} right=${html`<span class="value">${fmt(w.amount)}</span>`} />`)}</${Rows}>
          <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'cash' })}>I paid for something personally</${PlusAction}>
        </${Section}>`
      : null}

    <${WaitingToBeRead} entityId=${id} />
    ${c.odd.length
      ? html`<${Section} compact title="Anything odd" sub="Worth a look">
          <${Rows}>${c.odd.map((o) => html`<${Row} icon=${html`<${Tile} icon="alert" />`} name=${html`<span class=${o.tone === 'grey' ? '' : o.tone}>${o.label}</span>`} line=${o.detail} onClick=${o.recordIds?.length && c.hasTransactions ? () => app.push({ kind: 'txns', id: c.entity.id }) : undefined} label=${`${o.label}. ${o.detail}. See transactions`} />`)}</${Rows}>
        </${Section}>`
      : null}
    <${BooksClosed} c=${c} />
  `
}

/** The runway words in the drawer's header, in the same states the AI tools use (get_overview: "not burning"). */
function runwayWords(r: CompanyDetail['runway']): string | null {
  if (!r) return null
  if (r.state === 'not_burning') return 'not burning'
  if (r.state === 'not_enough_history') return 'runway: not enough history yet'
  if (r.months != null) return `${r.months} months runway`
  return r.state === 'unknown' ? 'runway unknown' : null
}

/** "$750,000 not yet converted", one amount per currency (never added across currencies; no conversion here). */
function convertiblesLine(cs: Array<{ amount: Money }>): string {
  const by = new Map<string, number>()
  for (const s of cs) by.set(s.amount.currency, (by.get(s.amount.currency) ?? 0) + s.amount.minor)
  return [...by].map(([currency, minor]) => fmt({ minor, currency })).join(' + ') + ' not yet converted'
}

/** "42.5 shares"; nothing for the brokerage's cash (its quantity is just its value). */
function sharesWords(h: HoldingRow): string | null {
  const q = Number(h.quantity)
  if (!Number.isFinite(q) || Math.round(q * 100) === h.value.minor) return null
  return `${q.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${q === 1 ? 'share' : 'shares'}`
}

/** "$12,400 + €3,000 in 4 positions": the server's total per currency, shown as it comes (no sums here). */
function holdingsLine(count: number, totals: Money[]): string {
  const value = totals.map((m) => fmt(m)).join(' + ')
  return `${value ? value + ' in ' : ''}${count === 1 ? 'one position' : `${count} positions`}`
}

function Aging({ aging }: { aging: Array<{ label: string; amount: { minor: number; currency: string } }> }) {
  const total = aging.reduce((a, x) => a + Math.max(0, x.amount.minor), 0) || 1
  const shown = aging.filter((a) => a.amount.minor > 0)
  return html`<div style="margin:8px 0 4px">
    <div class="bar" role="img" aria-label=${'Aging: ' + shown.map((a) => `${a.label} ${fmt(a.amount)}`).join(', ')}>
      ${aging.map((a) => (a.amount.minor > 0 ? html`<span style=${{ flex: a.amount.minor / total }}></span>` : html`<span style="flex:0"></span>`))}
    </div>
    <p class="meta" style="margin-top:6px">${shown.map((a) => `${a.label} ${fmt(a.amount)}`).join(' · ')}</p>
  </div>`
}

function TransactionsSection({ entityId, personal }: { entityId: string; personal: boolean }) {
  const app = useApp()
  const [q, setQ] = useState('')
  const { data } = useLoad(() => app.api.searchTransactions(entityId, q), [entityId, q])
  const rows = (data ?? []).slice(0, 8)
  return html`<${Section} compact title="Transactions" sub=${personal ? 'Search all of it' : 'Search everything in this company'}>
    <label class="sr" for=${'q-' + entityId}>Search transactions</label>
    <input id=${'q-' + entityId} class="input" type="search" placeholder="Search, e.g. AWS or 1,200" value=${q} onInput=${(e: Event) => setQ((e.target as HTMLInputElement).value)} style="margin:8px 0 4px" />
    <${Rows} label="Transactions">${rows.map((t) => html`<${TxnRowView} t=${t} />`)}</${Rows}>
    ${data && !data.length ? html`<p class="empty">Nothing called “${q}”. Try a shorter word.</p>` : null}
    ${data && data.length > rows.length ? html`<${PlusAction} onClick=${() => app.push({ kind: 'txns', id: entityId })}>${`See all ${data.length}`}</${PlusAction}>` : null}
  </${Section}>`
}

export function TxnRowView({ t }: { t: TxnRow }) {
  return html`<${Row}
    name=${t.description}
    line=${`${shortDate(t.date)} · ${t.account} · ${t.detail}`}
    right=${html`<span class=${'value' + (t.kind === 'transfer' ? ' grey' : '')}>${t.kind === 'transfer' ? '↔ ' + fmt({ ...t.amount, minor: Math.abs(t.amount.minor) }, { cents: true }) : fmt(t.amount, { cents: true, signed: true })}</span>`}
  />`
}

export function TxnsView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data } = useLoad(() => app.api.searchTransactions(id, ''), [id])
  const name = app.ws?.entities.find((e) => e.id === id)?.name ?? ''
  return html`<${Drawer} title="Transactions" sub=${name} onClose=${onClose} onBack=${onBack}>
    <${Rows} label="All transactions">${(data ?? []).map((t) => html`<${TxnRowView} t=${t} />`)}</${Rows}>
  </${Drawer}>`
}

export function ExplainView({ id, metric, onClose, onBack }: { id: string; metric: 'cash' | 'runway'; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: c } = useLoad(() => app.api.company(id), [id])
  const ex: Explained | null | undefined = metric === 'cash' ? c?.cash : c?.runway?.explained
  if (!c || !ex) return html`<${Drawer} title="How this is worked out" onClose=${onClose} onBack=${onBack} backLabel=${c?.entity.name ?? 'Back'} />`
  const a = ex.answer
  const value = a.state === 'unknown' ? 'Unknown' : a.state === 'not_burning' ? 'Not burning' : a.state === 'not_enough_history' ? 'Not enough history yet' : typeof a.value === 'number' ? `${a.value} months` : a.value ? fmt(a.value) : '–'
  const now = app.now()
  return html`<${Drawer} title=${value} sub=${`${ex.label} · as of ${ago(a.asOf, now)} · ${a.basis} basis`} onClose=${onClose} onBack=${onBack} backLabel=${c.entity.name}>
    ${(a.state === 'unknown' || a.state === 'stale') && a.unknownReason ? html`<p class="sub amber" style="margin-top:12px">${a.unknownReason}</p>` : null}
    <${Section} compact title="How this is worked out" sub=${a.formula}>
      <${Rows} label="Rows behind this number">
        ${ex.rows.map((r) => html`<${Row} name=${r.label} line=${r.detail} right=${html`<span class="value">${fmt(r.amount, { cents: false })}</span>`} />`)}
      </${Rows}>
    </${Section}>
    ${a.excludedAccounts.length
      ? html`<${Section} compact title="Left out" sub="Not counted in this number">
          <${Rows}>${a.excludedAccounts.map((x) => html`<${Row} name=${((a) => (a ? `${a.institution} ${a.name}` : x.id))(c.accounts.find((ac) => ac.id === x.id))} line=${x.reason} />`)}</${Rows}>
        </${Section}>`
      : null}
    <p class="meta" style="margin-top:24px">
      ${[
        a.agentEntriesIncluded ? `Includes ${a.agentEntriesIncluded} ${a.agentEntriesIncluded === 1 ? 'entry' : 'entries'} added by an AI.` : null,
        a.pendingReviewCount ? `${a.pendingReviewCount} waiting in Review, not counted yet.` : null,
        a.staleSources.length ? `${a.staleSources.length} source is out of date.` : 'Every source is up to date.',
        'Your AI gets this exact number and formula.',
      ]
        .filter(Boolean)
        .join(' ')}
    </p>
    ${c.entity.kind === 'company' && canShare(app) && a.state !== 'unknown' ? html`<div class="links"><${ShareLink} entityId=${c.entity.id} kind=${metric === 'runway' ? 'runway' : 'cash_trend'} /></div>` : null}
  </${Drawer}>`
}

const VIA: Record<UnreadDocument['arrivedVia'], string> = { email: 'emailed in', upload: 'uploaded', agent: 'added by an AI', import: 'imported' }

/** Documents nobody's AI has read yet; only when there are some. */
function WaitingToBeRead({ entityId }: { entityId: string }) {
  const app = useApp()
  const { data, reload } = useLoad(() => (isPublicDemo(app) ? Promise.resolve([] as UnreadDocument[]) : app.api.unreadDocuments().catch(() => [] as UnreadDocument[])), [entityId])
  const canDelete = canDeleteFiles(app)
  const docs = (data ?? []).filter((d) => d.entityId === entityId)
  if (!docs.length) return null
  const now = app.now()
  return html`<${Section} compact title="Waiting to be read" sub="Ask your AI: “Read my new documents in Aggregate.”">
    <${Rows}>${docs.slice(0, 10).map(
      (d) => html`<${Row}
        icon=${html`<${Tile} icon="file" />`}
        name=${d.name}
        line=${canDelete ? html`${VIA[d.arrivedVia] ?? d.arrivedVia} · ${ago(d.createdAt, now)} · <${DeleteFile} id=${d.documentId} name=${d.name} onDeleted=${reload} />` : `${VIA[d.arrivedVia] ?? d.arrivedVia} · ${ago(d.createdAt, now)}`}
        right=${html`<a class="link" href=${app.api.documentFileUrl(d.documentId)} target="_blank" rel="noopener">Open</a>`}
      />`,
    )}</${Rows}>
  </${Section}>`
}

/** "Books closed through Aug 31": quiet, and only for companies with a lock or someone who can set one. */
function BooksClosed({ c }: { c: CompanyDetail }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const lastMonthEnd = (() => {
    const d = new Date(app.now())
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10)
  })()
  const [through, setThrough] = useState(lastMonthEnd)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const lock = c.periodLock
  if (!lock && !c.canClosePeriod) return null
  const done = async (r: { recordId?: string; summary: string }, text: string) => {
    setOpen(false)
    await app.reload()
    app.toast({ text, ...(r.recordId ? { undo: async () => (await app.api.undo(r.recordId!), app.toast({ text: 'Undone.' }), app.reload()) } : {}) })
  }
  const close = async (e: Event) => {
    e.preventDefault()
    setErr('')
    if (!through || through >= new Date(app.now()).toISOString().slice(0, 10)) return setErr('Close a day before today.')
    try {
      await done(await app.api.closePeriod(c.entity.id, through, note.trim() || undefined), `Books closed through ${shortDate(through, true)}.`)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t save.')
    }
  }
  const reopen = async () => {
    try {
      await done(await app.api.reopenPeriod(c.entity.id), 'Books reopened.')
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t save.')
    }
  }
  return html`<div class="booksclosed">
    ${lock ? html`<p class="sub">Books closed through ${shortDate(lock.through, true)}${lock.note ? ` · ${lock.note}` : ''}</p>` : null}
    ${c.canClosePeriod && !open
      ? html`<div class="links">${lock ? html`<${LinkButton} onClick=${() => (setThrough(lock.through > lastMonthEnd ? lock.through : lastMonthEnd), setOpen(true))}>Move the close date</${LinkButton}><${LinkButton} onClick=${reopen}>Reopen</${LinkButton}>` : html`<${PlusAction} onClick=${() => setOpen(true)}>Close the books</${PlusAction}>`}</div>`
      : null}
    ${open
      ? html`<form onSubmit=${close} novalidate style="margin-top:12px">
          <p class="sub">Changes to a closed period post on the next open day, so closed months stay as reported.</p>
          <div class="formrow" style="margin-top:12px;align-items:center">
            <label class="sub" for="close-through">Closed through</label>
            <input id="close-through" class="input" type="date" style="width:auto" value=${through} onInput=${(e: Event) => setThrough((e.target as HTMLInputElement).value)} />
          </div>
          <label class="sr" for="close-note">Note (optional)</label>
          <input id="close-note" class="input" style="margin-top:8px" placeholder="Note (optional), e.g. Q3 filed" value=${note} onInput=${(e: Event) => setNote((e.target as HTMLInputElement).value)} />
          ${err ? html`<p class="err" role="alert">${err}</p>` : null}
          <div class="formrow" style="margin-top:12px"><${Button} type="submit">Close the books</${Button}><${LinkButton} onClick=${() => (setOpen(false), setErr(''))}>Cancel</${LinkButton}></div>
        </form>`
      : err ? html`<p class="err" role="alert">${err}</p>` : null}
  </div>`
}

/** "September": the period payroll_cost counts, named in full. */
const monthLong = (ym: string) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
const monthName = (ym: string, year = false) => new Date(ym + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
const pct = (x: number) => `${Number((x * 100).toFixed(1))}%`

/** One quiet line for companies with subscriptions: "MRR $19,000 · +$4,000 net new in Sep · 2.5% churn". */
function MrrLine({ c }: { c: CompanyDetail }) {
  const app = useApp()
  const m = c.mrr
  if (!m) return null
  // Nothing moved: say so plainly instead of "+$0 net new · 0% churn".
  const still = m.netNew?.value?.minor === 0 && m.churn?.value === 0
  const net = still ? 'No change this month' : m.netNew?.value ? `${m.netNew.value.minor >= 0 ? '+' : '−'}${fmt({ ...m.netNew.value, minor: Math.abs(m.netNew.value.minor) })} net new in ${monthName(m.month)}` : m.netNew?.reason ?? null
  const churn = still ? null : typeof m.churn?.value === 'number' ? `${pct(m.churn.value)} churn` : m.churn?.reason && m.churn.reason !== m.netNew?.reason ? m.churn.reason : null
  const text = [`MRR ${fmt(m.value)}`, net, churn].filter(Boolean).join(' · ')
  return html`<p class="sub" style="margin-top:4px"><button type="button" class="link" style="font-size:inherit" onClick=${() => app.push({ kind: 'mrr', id: c.entity.id })}>${text}</button></p>`
}

/** Month by month: where recurring revenue came from and where it went. Newest first. */
export function MrrView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: c } = useLoad(() => app.api.company(id), [id])
  const { data: months, error, reload } = useLoad(() => app.api.mrrMovements(id, 12), [id])
  const name = c?.entity.name ?? 'Back'
  if (error) return html`<${LoadFailed} title="Recurring revenue" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} backLabel=${name} />`
  if (!months) return html`<${Drawer} title="Recurring revenue" onClose=${onClose} onBack=${onBack} backLabel=${name} />`
  const signed = (label: string, m: Money, sign: '+' | '−') => (m.minor ? `${sign}${fmt(m)} ${label}` : null)
  return html`<${Drawer} title="Recurring revenue" sub=${c?.mrr ? `MRR ${fmt(c.mrr.value)} now` : 'Month by month'} onClose=${onClose} onBack=${onBack} backLabel=${name}>
    ${months.length
      ? html`<${Section} compact title="Month by month" sub="Start, what came in and went out, end">
          <${Rows}>${[...months].reverse().map(
            (m) => html`<${Row}
              name=${monthName(m.month, true)}
              line=${[
                `from ${fmt(m.start)}`,
                signed('new', m.new, '+'),
                signed('expansion', m.expansion, '+'),
                signed('back', m.reactivation, '+'),
                signed('downgrades', m.contraction, '−'),
                signed('churned', m.churn, '−'),
                m.revenueChurnRate != null ? `${pct(m.revenueChurnRate)} churn` : null,
                `${m.customersEnd} customers`,
              ]
                .filter(Boolean)
                .join(' · ')}
              right=${html`<span class="value">${fmt(m.end)}</span>`}
            />`,
          )}</${Rows}>
        </${Section}>`
      : html`<p class="empty">No months to show yet.</p>`}
  </${Drawer}>`
}

/** "Chase Personal Checking", but never "Demo Brokerage Brokerage": skip the bank's name when either already holds the other. */
function accountName(a: { kind: string; name: string; institution?: string | null }): string {
  const inst = a.institution?.trim()
  if (a.kind === 'cash' || !inst) return a.name
  const n = a.name.toLowerCase()
  const i = inst.toLowerCase()
  if (n.startsWith(i)) return a.name
  if (i.endsWith(n)) return inst
  return `${inst} ${a.name}`
}
