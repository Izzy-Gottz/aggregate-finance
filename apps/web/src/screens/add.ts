// Add anything: cash or a receipt (a typed write with undo), a file upload (drag and drop), and the email-in addresses.
// Aggregate has no AI inside: CSV, OFX and camt.053 import right away; PDFs and photos wait as unread documents for your AI (MASTER §5).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { InboundSettings, UploadResult } from '../api/types.ts'
import { useApp, isManager, isReviewer } from '../app/context.ts'
import { HttpError } from '../api/http.ts'
import { isPublicDemo } from '../lib/demo.ts'
import { fmt, parseAmount } from '../lib/money.ts'
import { ago } from '../lib/time.ts'
import { Button, CopyButton, Field, LinkButton, Row, Rows, Section, Segmented, Tile } from '../ui/components.ts'
import { Drawer } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

function useCompanyChoice() {
  const app = useApp()
  const options = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  const [chosen, setEntityId] = useState(app.scope && options.some((o) => o.id === app.scope) ? app.scope : '')
  const entityId = chosen && options.some((o) => o.id === chosen) ? chosen : (options[0]?.id ?? '')
  const select = html`<${Field} label="Company">
    <select class="input" value=${entityId} onChange=${(e: Event) => setEntityId((e.target as HTMLSelectElement).value)}>
      ${options.map((o) => html`<option value=${o.id}>${o.name}</option>`)}
    </select>
  </${Field}>`
  return { entityId, select, options }
}

/** Filled in by ⌘K ("$500 cash") just before it opens Add cash; read once. */
export const cashDraft: { amount: string; direction: 'in' | 'out' } = { amount: '', direction: 'in' }

export function AddCashView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { entityId, select, options } = useCompanyChoice()
  const [direction, setDirection] = useState<'in' | 'out'>(cashDraft.direction)
  const [paidBy, setPaidBy] = useState<'company' | 'me'>('company')
  const [amount, setAmount] = useState(() => {
    const a = cashDraft.amount
    cashDraft.amount = ''
    cashDraft.direction = 'in'
    return a
  })
  const [who, setWho] = useState('')
  const [date, setDate] = useState(() => new Date(app.now()).toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const currency = options.find((o) => o.id === entityId)?.currency ?? 'USD'

  const submit = async (e: Event) => {
    e.preventDefault()
    setErr('')
    const m = parseAmount(amount, currency)
    if (!entityId) return setErr('Add a company first.')
    if (!m || m.minor <= 0) return setErr('Enter an amount, like 1,200 or 64.20.')
    setBusy(true)
    try {
      const r = await app.api.addCash({ entityId, direction, amount: m, date, counterparty: who.trim(), paidBy: direction === 'out' ? paidBy : 'company', ...(note.trim() ? { note: note.trim() } : {}) })
      if (r.status === 'rejected') return setErr(r.message ?? 'That couldn’t be added.')
      const company = options.find((o) => o.id === entityId)?.name ?? ''
      const text = `${direction === 'in' ? 'Added' : 'Recorded'} ${fmt(m)} ${direction === 'in' ? 'to' : 'for'} ${company}${r.status === 'pending_review' ? ', waiting for review' : ''}.`
      const id = r.recordId
      app.toast({ text, ...(id ? { undo: async () => (await app.api.undo(id), app.toast({ text: 'Undone.' }), app.reload()) } : {}) })
      await app.reload()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return html`<${Drawer} title="Add cash or a receipt" sub="For money that never touches a connected account." onClose=${onClose} onBack=${onBack}>
    <form onSubmit=${submit} style="margin-top:20px" novalidate>
      <${Segmented} label="Money in or out" value=${direction} onChange=${setDirection} options=${[{ value: 'in', label: 'Money in' }, { value: 'out', label: 'Money out' }]} />
      <${Field} label="Amount"><input class="input tn" inputmode="decimal" value=${amount} onInput=${(e: Event) => setAmount((e.target as HTMLInputElement).value)} placeholder="1,200" required /></${Field}>
      <${Field} label=${direction === 'in' ? 'From' : 'Paid to'}><input class="input" value=${who} onInput=${(e: Event) => setWho((e.target as HTMLInputElement).value)} placeholder=${direction === 'in' ? 'Lee’s Deli' : 'Designer'} /></${Field}>
      ${select}
      ${direction === 'out'
        ? html`<div class="field"><span aria-hidden="true">Whose money paid</span>
            <${Segmented} label="Whose money paid" value=${paidBy} onChange=${setPaidBy} options=${[{ value: 'company', label: 'The company’s cash' }, { value: 'me', label: 'I paid personally' }]} />
          </div>
          ${paidBy === 'me' ? html`<p class="sub" style="margin-top:8px">The company will owe you this. It shows under Whose money.</p>` : null}`
        : null}
      <${Field} label="Date"><input class="input" type="date" value=${date} onInput=${(e: Event) => setDate((e.target as HTMLInputElement).value)} /></${Field}>
      <${Field} label="Note (optional)"><input class="input" value=${note} onInput=${(e: Event) => setNote((e.target as HTMLInputElement).value)} /></${Field}>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit" disabled=${busy}>Add</${Button}><button type="button" class="link" onClick=${() => app.push({ kind: 'add', what: 'upload' })}>Have a photo or PDF? Upload it</button></div>
      <p class="meta" style="margin-top:24px">If you deposit this cash later, the bank deposit is matched to it, not counted twice.</p>
    </form>
  </${Drawer}>`
}

export function UploadView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { entityId, select } = useCompanyChoice()
  const [over, setOver] = useState(false)
  const [results, setResults] = useState<UploadResult[]>([])
  const [errs, setErrs] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  // The same kinds and limit the server takes (apps/server documents.ts, packages/files).
  const OK = /\.(pdf|jpe?g|png|heic|webp|csv|ofx|qfx|qbo|xml)$/i

  const send = async (files: FileList | File[] | null) => {
    // One line per file that didn't make it, each naming its file, so a batch never hides an error.
    const failed: string[] = []
    for (const f of [...(files ?? [])]) {
      if (!OK.test(f.name)) {
        failed.push(`${f.name} isn’t a file Aggregate takes. Use a PDF, a photo (JPG, PNG, HEIC), or a CSV, OFX, QFX, QBO or camt.053 XML statement.`)
        continue
      }
      if (f.size > 8 * 1024 * 1024) {
        failed.push(`${f.name} is too large (8 MB max). Split it, or download a shorter date range.`)
        continue
      }
      try {
        const r = await app.api.upload(entityId, f)
        setResults((xs) => [r, ...xs])
      } catch (e) {
        failed.push(`${f.name}: ${e instanceof Error ? e.message : 'didn’t upload. Try again.'}`)
      }
    }
    setErrs(failed)
    app.reload()
  }

  return html`<${Drawer} title="Upload a file" sub="Statements, receipts, bills, invoices, payroll reports, SAFEs." onClose=${onClose} onBack=${onBack}>
    ${select}
    <div
      class=${'drop' + (over ? ' over' : '')}
      style="margin-top:20px"
      onDragOver=${(e: DragEvent) => (e.preventDefault(), setOver(true))}
      onDragLeave=${() => setOver(false)}
      onDrop=${(e: DragEvent) => (e.preventDefault(), setOver(false), send(e.dataTransfer?.files ?? null))}
    >
      <p>Drop files here</p>
      <p style="margin-top:12px"><${Button} quiet onClick=${() => input.current?.click()}>Choose files</${Button}></p>
      <input ref=${input} type="file" class="sr" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.webp,.csv,.ofx,.qfx,.qbo,.xml" onChange=${(e: Event) => send((e.target as HTMLInputElement).files)} aria-label="Choose files to upload" tabindex="-1" />
    </div>
    ${errs.length ? html`<div role="alert">${errs.map((t) => html`<p class="err">${t}</p>`)}</div>` : null}
    ${results.length
      ? html`<${Rows} label="Uploaded">${results.map((r) =>
          r.state === 'needs_account'
            ? html`<${WhichAccount} result=${r} onDone=${(u: UploadResult) => (setResults((xs) => xs.map((x) => (x.documentId === u.documentId ? u : x))), app.reload())} onDeleted=${() => setResults((xs) => xs.filter((x) => x.documentId !== r.documentId))} />`
            : r.state === 'needs_mapping' && r.question
              ? html`<${MapColumns} result=${r} onDone=${(u: UploadResult) => (setResults((xs) => xs.map((x) => (x.documentId === u.documentId ? u : x))), app.reload())} onDeleted=${() => setResults((xs) => xs.filter((x) => x.documentId !== r.documentId))} />`
              : html`<${Row} icon=${html`<${Tile} icon="file" />`} name=${r.name} line=${r.message} />`,
        )}</${Rows}>`
      : html`<p class="meta" style="margin-top:16px">CSV and bank files import right away. PDFs and photos wait for your AI to read them: ask it to “read my new documents in Aggregate”.</p>`}
  </${Drawer}>`
}

export function EmailInView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const ws = app.ws
  // No addresses on this server (a saved link): nothing to show here, so go to adding a file instead of an empty drawer.
  const none = !!ws && ws.inbound.length === 0
  useEffect(() => {
    if (none) app.open({ kind: 'add', what: 'upload' })
  }, [none])
  if (!ws || none) return null
  return html`<${Drawer} title="Email it in" sub="Forward bills and receipts. Each company has its own address." onClose=${onClose} onBack=${onBack}>
    <${Section} compact title="Addresses" sub="Anything sent here waits as an unread document for your AI">
      <${Rows}>
        ${ws.inbound.map((i) => html`<${Row} name=${ws.entities.find((e) => e.id === i.entityId)?.name ?? ''} line=${html`<span class="mono">${i.address}</span>`} right=${html`<${CopyButton} text=${i.address} what=${'address for ' + (ws.entities.find((e) => e.id === i.entityId)?.name ?? '')} />`} />`)}
      </${Rows}>
    </${Section}>
    ${ws.inbound.map((i) => html`<${Senders} key=${i.entityId} entityId=${i.entityId} name=${ws.entities.find((e) => e.id === i.entityId)?.name ?? ''} />`)}
  </${Drawer}>`
}

/** Files can be deleted by an owner or admin (the server refuses anyone else), never in a demo. */
export const canDeleteFiles = (app: ReturnType<typeof useApp>): boolean => isManager(app) && !isReviewer(app) && !isPublicDemo(app)

/**
 * "Delete file" for a file nothing was imported from: asks first, then says the server's sentence when it refuses
 * (an imported statement goes with its connection's data). Already gone counts as done. It's also the way out of
 * "It has files. Delete them first." when deleting a company.
 */
export function DeleteFile({ id, name, onDeleted }: { id: string; name: string; onDeleted: () => void }) {
  const app = useApp()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef<HTMLSpanElement>(null)
  const was = useRef(false)
  useEffect(() => {
    if (asking) box.current?.querySelector<HTMLElement>('span button:last-of-type')?.focus()
    else if (was.current) box.current?.querySelector<HTMLElement>('button')?.focus()
    was.current = asking
  }, [asking])
  const go = async () => {
    if (busy) return
    setBusy(true)
    setErr('')
    try {
      const r = await app.api.deleteDocument(id)
      app.toast({ text: `Deleted ${r.name || name}.` })
    } catch (e) {
      if (!(e instanceof HttpError && e.status === 404)) {
        setBusy(false)
        return setErr(e instanceof Error && e.message ? e.message : 'That didn’t work. Nothing was deleted.')
      }
    }
    onDeleted()
    // A review item that cited it is rejected by the server: the review count changes too.
    void app.reload()
  }
  return html`<span ref=${box}>${asking
    ? html`<span role="alert">Delete ${name}? This can’t be undone. <${LinkButton} danger onClick=${go}>${busy ? 'Deleting…' : 'Delete'}</${LinkButton}> · <${LinkButton} onClick=${() => (setAsking(false), setErr(''))}>Cancel</${LinkButton}></span>`
    : html`<${LinkButton} danger onClick=${() => setAsking(true)}>Delete file<span class="sr"> ${name}</span></${LinkButton}>`}${err ? html` <span class="err" role="alert">${err}</span>` : null}</span>`
}

/** An unfamiliar CSV: one plain question at a time, with the first rows of the file so the answer is obvious. */
export function MapColumns({ result, onDone, onDeleted }: { result: UploadResult; onDone: (r: UploadResult) => void; onDeleted?: () => void }) {
  const app = useApp()
  const q = result.question!
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const answer = async (value: string) => {
    setBusy(true)
    setErr('')
    try {
      const r = await app.api.answerMapping(result.documentId, q.field, value)
      setChoice('')
      onDone({ ...result, state: r.state, message: r.message, question: r.question, accounts: r.accounts })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work. Nothing was imported.')
    } finally {
      setBusy(false)
    }
  }
  const id = 'map-' + result.documentId
  // Two choices read best as buttons; a list of columns as a menu.
  const few = q.options.length <= 2
  return html`<li class="mapq">
    <p class="name" style="margin:0">${result.name}</p>
    <p style="margin:6px 0 0"><label for=${few ? undefined : id}>${q.text}</label></p>
    <div class="preview" role="region" aria-label=${`First rows of ${result.name}`} tabindex="0">
      <table>
        <thead><tr>${q.headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
        <tbody>${q.sample.slice(0, 3).map((row) => html`<tr>${q.headers.map((_, i) => html`<td>${row[i] ?? ''}</td>`)}</tr>`)}</tbody>
      </table>
    </div>
    <div class="formrow" style="margin-top:12px">
      ${few
        ? q.options.map((o) => html`<${Button} quiet disabled=${busy} onClick=${() => answer(o.value)}>${o.label}</${Button}>`)
        : html`<select id=${id} class="input" style="height:32px;width:auto" value=${choice} onChange=${(e: Event) => setChoice((e.target as HTMLSelectElement).value)}>
              <option value="" disabled>Choose a column…</option>
              ${q.options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
            </select>
            <${Button} quiet disabled=${busy || !choice} onClick=${() => answer(choice)}>Continue</${Button}>`}
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    ${onDeleted && canDeleteFiles(app) ? html`<p class="meta" style="margin-top:8px"><${DeleteFile} id=${result.documentId} name=${result.name} onDeleted=${onDeleted} /></p>` : null}
  </li>`
}

/** A statement that could belong to more than one account: nothing is imported until the person says which. */
export function WhichAccount({ result, onDone, onDeleted }: { result: UploadResult; onDone: (r: UploadResult) => void; onDeleted?: () => void }) {
  const app = useApp()
  const accounts = result.accounts ?? []
  // No preselection: importing into the wrong account is worse than one more click.
  const [choice, setChoice] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async () => {
    setBusy(true)
    setErr('')
    try {
      const r = await app.api.chooseStatementAccount(result.documentId, choice)
      onDone({ ...result, state: r.state, message: r.message, accounts: undefined })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t work. Nothing was imported.')
    } finally {
      setBusy(false)
    }
  }
  const id = 'acct-' + result.documentId
  return html`<${Row}
    icon=${html`<${Tile} icon="file" />`}
    name=${result.name}
    line=${onDeleted && canDeleteFiles(app) ? html`<span>${err || result.message}</span> · <${DeleteFile} id=${result.documentId} name=${result.name} onDeleted=${onDeleted} />` : err || result.message}
    right=${html`<label class="sr" for=${id}>Account for ${result.name}</label>
      <select id=${id} class="input" style="height:32px;width:auto" value=${choice} onChange=${(e: Event) => setChoice((e.target as HTMLSelectElement).value)}>
        <option value="" disabled>Choose an account…</option>
        ${accounts.map((a) => html`<option value=${a.id}>${a.institution ? a.institution + ' · ' : ''}${a.name}${a.mask ? ' ··' + a.mask : ''}</option>`)}
        <option value="new">A separate statements account</option>
      </select>
      <${Button} quiet disabled=${busy || !choice} onClick=${go}>Import</${Button}>`}
  />`
}

const SENDER = /^(@?[a-z0-9.-]+\.[a-z]{2,}|[^\s@]+@[a-z0-9.-]+\.[a-z]{2,})$/

/** Who may email a company's address: its members automatically, plus extra addresses or @domains. Everyone else is refused. */
function Senders({ entityId, name }: { entityId: string; name: string }) {
  const app = useApp()
  const [cfg, setCfg] = useState<InboundSettings | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    app.api.inboundSenders(entityId).then(setCfg, () => setCfg(null))
  }, [entityId])
  if (!cfg) return null
  const extra = cfg.extra ?? cfg.allowedSenders
  const members = cfg.members ?? []
  const saveList = async (next: string[]) => {
    setErr('')
    try {
      const r = await app.api.setInboundSenders(entityId, next)
      setCfg(r)
      setText(null)
      app.toast({ text: `Saved. ${name}’s address accepts ${members.length ? 'its members' : ''}${members.length && next.length ? ' and ' : ''}${next.length ? (next.length === 1 ? next[0] : `${next.length} more senders`) : members.length ? '' : 'nobody'}.` })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save.')
    }
  }
  const save = () => {
    const next = (text ?? '').split(/[\n,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
    // Name the line that's wrong instead of a general rule.
    const bad = next.find((x) => !SENDER.test(x))
    if (bad) return setErr(`“${bad}” isn’t an email address or a domain like @acme.com.`)
    return saveList(next)
  }
  const nobody = !members.length && !extra.length
  const limited = isReviewer(app)
  // Once a refused sender is allowed (exactly, or by its @domain), its old refusal no longer needs showing.
  const allowed = (from: string) => {
    const f = from.toLowerCase()
    return extra.includes(f) || extra.some((x) => x.startsWith('@') && f.endsWith(x)) || members.some((m) => m.email.toLowerCase() === f)
  }
  const refused = (cfg.recentRefused ?? []).filter((r) => !(r.reason === 'not an allowed sender' && allowed(r.from)))
  const id = 'senders-' + entityId
  return html`<${Section} compact title=${`Who can email ${name}`} sub="Exact addresses, or a whole domain like @acme.com. Everyone else is refused.">
    ${members.length ? html`<p style="margin-top:8px">Everyone who can add documents here: ${members.map((m) => m.name || m.email).join(', ')}</p>` : null}
    ${text === null
      ? html`<p class=${nobody ? 'amber' : ''} style="margin-top:8px">${extra.length ? `Also: ${extra.join(', ')}` : nobody ? 'Nobody yet, so every email is refused.' : ''}</p>
          <div class="links" hidden=${limited}><${LinkButton} onClick=${() => setText(extra.join('\n'))}>${extra.length ? 'Change' : members.length ? 'Allow another sender' : 'Add senders'}</${LinkButton}>${nobody && app.me?.email ? html`<${LinkButton} onClick=${() => setText(app.me!.email)}>Just me (${app.me.email})</${LinkButton}>` : null}</div>`
      : html`<label class="sr" for=${id}>Senders for ${name}, one per line</label>
          <textarea id=${id} class="input mono" rows="4" style="margin-top:8px" placeholder=${'you@company.com\n@vendor.com'} value=${text} onInput=${(e: Event) => setText((e.target as HTMLTextAreaElement).value)}></textarea>
          ${err ? html`<p class="err" role="alert">${err}</p>` : null}
          <div class="formrow"><${Button} onClick=${save}>Save</${Button}><${LinkButton} onClick=${() => (setText(null), setErr(''))}>Cancel</${LinkButton}></div>`}
    ${refused.length
      ? html`<${Rows} label=${`Refused email for ${name}`}>${refused.map(
          (r) => html`<${Row}
            name=${r.from}
            line=${`Refused · ${r.reason} · ${ago(r.at, app.now())}`}
            right=${r.reason === 'not an allowed sender' && !limited ? html`<${LinkButton} onClick=${() => saveList([...extra, r.from.toLowerCase()])}>Allow</${LinkButton}>` : null}
          />`,
        )}</${Rows}>`
      : null}
  </${Section}>`
}
