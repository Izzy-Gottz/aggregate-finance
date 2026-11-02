// ⌘K: find any company, connection or AI, or run any action, from anywhere. Typing an amount ("$500 cash") offers
// "Add $500 cash" first, so the palette is also a door to Add anything. No chat here: thinking happens in your AI.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { useApp, type App, isManager, isReviewer } from '../app/context.ts'
import { applyTheme } from '../app/theme.ts'
import { parseAmount, fmt } from '../lib/money.ts'
import { html } from '../ui/html.ts'
import { cashDraft } from './add.ts'
import { emailSupport, openGuide, SUPPORT_EMAIL } from '../lib/support.ts'
import { inDemo, leaveDemo } from '../lib/demo.ts'

export interface Command {
  id: string
  label: string
  group: 'Actions' | 'Companies' | 'Connections' | 'AI'
  hint?: string
  run: () => void
}

/** Subsequence match with a small bonus for word starts; 0 = no match. */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = text.toLowerCase()
  if (t.includes(q)) return 100 - t.indexOf(q) + (t.startsWith(q) ? 50 : 0)
  let i = 0
  let s = 0
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) {
      s += j === 0 || t[j - 1] === ' ' ? 3 : 1
      i++
    }
  }
  return i === q.length ? s : 0
}

export function commands(app: App, close: () => void): Command[] {
  const ws = app.ws
  if (!ws) return []
  const go = (f: () => void) => () => (close(), f())
  const list: Command[] = [
    ...(inDemo(app, isReviewer(app)) ? [{ id: 'leave-demo', group: 'Actions' as const, label: 'Leave the demo and start with your own companies', run: go(() => void leaveDemo(app)) }] : []),
    { id: 'add-cash', group: 'Actions', label: 'Add cash or a receipt', hint: 'A', run: go(() => app.open({ kind: 'add', what: 'cash' })) },
    { id: 'upload', group: 'Actions', label: 'Upload a file', run: go(() => app.open({ kind: 'add', what: 'upload' })) },
    { id: 'connect-bank', group: 'Actions', label: 'Connect a bank or card', run: go(() => app.open({ kind: 'connect', key: 'plaid' })) },
    { id: 'more', group: 'Actions', label: 'Add a connection', run: go(() => app.open({ kind: 'connect' })) },
    { id: 'copy-link', group: 'Actions', label: 'Copy AI link', run: go(() => { navigator.clipboard?.writeText(ws.me.mcpUrl).catch(() => {}); app.toast({ text: 'AI link copied.' }) }) },
    { id: 'connect-ai', group: 'Actions', label: 'Connect another AI', run: go(() => app.open({ kind: 'connect-ai' })) },
    ...(isManager(app)
      ? [
          { id: 'new-company', group: 'Actions' as const, label: 'Add a company', run: go(() => app.open({ kind: 'company-new' })) },
          { id: 'invite', group: 'Actions' as const, label: 'Invite someone', run: go(() => app.open({ kind: 'invite' })) },
        ]
      : []),
    ...(ws.inbound.length ? [{ id: 'email-in', group: 'Actions' as const, label: 'Email addresses for bills and receipts', run: go(() => app.open({ kind: 'add', what: 'email' })) }] : []),
    { id: 'pause', group: 'Actions', label: ws.aiPaused ? 'Resume all AI' : 'Pause all AI', run: go(async () => (await app.api.pauseAll(!ws.aiPaused), app.reload())) },
    { id: 'review', group: 'Actions', label: 'Go to Review', run: go(() => app.go({ page: 'review', stack: [] })) },
    { id: 'prefs', group: 'Actions', label: 'Go to Preferences', run: go(() => app.go({ page: 'preferences', stack: [] })) },
    { id: 'guide', group: 'Actions', label: 'Help: setup guide', run: go(openGuide) },
    { id: 'support', group: 'Actions', label: 'Contact support', hint: SUPPORT_EMAIL, run: go(emailSupport) },
    { id: 'dark', group: 'Actions', label: 'Dark mode', run: go(() => applyTheme('dark')) },
    { id: 'light', group: 'Actions', label: 'Light mode', run: go(() => applyTheme('light')) },
    ...ws.entities.map((e) => ({ id: 'e:' + e.id, group: 'Companies' as const, label: e.name, hint: e.hidden ? 'private' : e.cash ? fmt(e.cash) : '', run: go(() => app.open({ kind: 'company', id: e.id })) })),
    ...ws.connections.map((c) => ({ id: 'c:' + c.id, group: 'Connections' as const, label: `${c.name}${c.entityNames.length ? ' · ' + c.entityNames.join(', ') : ''}`, run: go(() => app.open({ kind: 'connection', id: c.id })) })),
    ...ws.ais.map((a) => ({ id: 'a:' + a.grantId, group: 'AI' as const, label: `${a.client} · ${a.personName}`, run: go(() => app.open({ kind: 'ai', id: a.grantId })) })),
  ]
  // Reviewer demo: leave out what the server refuses there.
  const refused = new Set(['connect-bank', 'more', 'new-company', 'invite', 'pause'])
  return isReviewer(app) ? list.filter((x) => !refused.has(x.id)) : list
}

/** "$500 cash for the designer" → an "Add $500 cash" command that opens Add cash with the amount filled in. */
export function quickAdd(app: App, query: string, close: () => void): Command | null {
  const m = query.match(/[$€£]?\s?(\d[\d,]*(?:\.\d{1,2})?)/)
  if (!m?.[1]) return null
  const currency = app.ws?.entities.find((e) => e.kind === 'company')?.currency ?? 'USD'
  const amount = parseAmount(m[1], currency)
  if (!amount || amount.minor <= 0) return null
  const out = /\b(paid|spent|bought|out|for)\b/i.test(query)
  return {
    id: 'quick-add',
    group: 'Actions',
    label: `Add ${fmt(amount)} cash ${out ? 'out' : 'in'}`,
    run: () => {
      close()
      cashDraft.amount = m[1]!
      cashDraft.direction = out ? 'out' : 'in'
      app.open({ kind: 'add', what: 'cash' })
    },
  }
}

export function Palette({ onClose }: { onClose: () => void }) {
  const app = useApp()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  useEffect(() => {
    input.current?.focus()
    return () => opener.current?.focus()
  }, [])

  const results = useMemo(() => {
    const all = commands(app, onClose)
      .map((c) => ({ c, s: score(q, c.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
    const quick = quickAdd(app, q, onClose)
    return (quick ? [quick, ...all] : all).slice(0, 12)
  }, [q, app.ws])
  useEffect(() => setSel(0), [q])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(results.length - 1, i + 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)))
    else if (e.key === 'Enter') (e.preventDefault(), results[sel]?.run())
    else if (e.key === 'Escape') (e.preventDefault(), onClose())
    // A modal: the search box is its only stop, so Tab stays here.
    else if (e.key === 'Tab') e.preventDefault()
  }
  let lastGroup = ''
  return html`<div>
    <div class="scrim enter" onClick=${onClose} aria-hidden="true"></div>
    <div class="palette" role="dialog" aria-modal="true" aria-label="Search and actions" onKeyDown=${onKey}>
      <input
        ref=${input}
        class="palette-input"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant=${results[sel] ? 'pc-' + results[sel]!.id : undefined}
        aria-label="Search companies, connections and actions"
        placeholder="Search, or type an amount to add it"
        value=${q}
        onInput=${(e: Event) => setQ((e.target as HTMLInputElement).value)}
      />
      <ul id="palette-list" role="listbox" class="palette-list">
        ${results.map((c, i) => {
          const head = c.group !== lastGroup ? ((lastGroup = c.group), html`<li role="presentation" class="palette-group">${c.group}</li>`) : null
          return html`${head}<li id=${'pc-' + c.id} role="option" aria-selected=${i === sel ? 'true' : 'false'} class="palette-opt" onMouseEnter=${() => setSel(i)} onClick=${() => c.run()}>
            <span>${c.label}</span>${c.hint ? html`<span class="grey tn">${c.hint}</span>` : null}
          </li>`
        })}
        ${!results.length ? html`<li class="empty" role="presentation" style="padding:12px 16px">Nothing called “${q}”. Try a shorter word.</li>` : null}
      </ul>
    </div>
  </div>`
}
