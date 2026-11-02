// Workspace: the one main page. Money · Connections · Connect your AI · Add anything (MASTER §3).
import type { ConnectionSummary, Workspace, WorkspaceHealth } from '../api/types.ts'
import { isPublicDemo } from '../lib/demo.ts'
import { isFilling, isManager, isReviewer, isUpdating, useApp, useLoad } from '../app/context.ts'
import { grantLine, listWords } from '../lib/grant.ts'
import { fmt } from '../lib/money.ts'
import { ago } from '../lib/time.ts'
import { Button, CopyButton, PlusAction, Pluses, Row, Rows, Section, Tile, type BrandTile } from '../ui/components.ts'
import { Drawer } from '../ui/drawer.ts'
import { useEffect, useRef, useState } from 'preact/hooks'
import { WhichAccount } from './add.ts'
import { html } from '../ui/html.ts'
import { canTryDemo, DemoLink } from './demo-link.ts'

const LETTER: Record<string, string> = { stripe: 'S', quickbooks: 'Q', xero: 'X', paypal: 'P', square: 'Sq', shopify: 'Sh', mercury: 'M', brex: 'B', ramp: 'R', rippling: 'R', deel: 'D', justworks: 'J' }

const BUILT_IN = new Set(['equity', 'manual'])

/** Brand icons allowed in the app, with why and the source of each: ui/brand/README.md. Every other source keeps its letter. */
const BRANDED = new Set<BrandTile>(['carta', 'mercury', 'shopify', 'square', 'deel', 'ramp', 'simplefin'])

/** `plaidMark`: Plaid's own mark, for the row that offers Plaid. A connected bank is the bank, not Plaid, so it keeps the bank icon. */
export function SourceTile({ connectorKey, plaidMark }: { connectorKey: string; plaidMark?: boolean }) {
  if (connectorKey === 'plaid') return plaidMark ? html`<${Tile} brand="plaid" />` : html`<${Tile} icon="bank" />`
  if (connectorKey === 'files') return html`<${Tile} icon="file" />`
  if (BRANDED.has(connectorKey as BrandTile)) return html`<${Tile} brand=${connectorKey as BrandTile} />`
  return html`<${Tile} letter=${LETTER[connectorKey] ?? connectorKey[0]?.toUpperCase()} />`
}

export function connectionLine(c: ConnectionSummary, now: number): { text: string; tone?: 'red' | 'amber' } {
  switch (c.status) {
    case 'needs_reauth':
      return { text: 'Reconnect needed', tone: 'red' }
    case 'error':
      return { text: c.message ?? 'Not syncing', tone: 'red' }
    case 'syncing':
      return { text: 'syncing…' }
    case 'paused':
      return { text: 'paused' }
    default:
      return { text: `synced ${ago(c.lastSyncAt, now)}` }
  }
}

export function WorkspacePage() {
  const app = useApp()
  const ws = app.ws
  if (!ws) return html`<${Skeleton} />`
  const now = app.now()
  const inScope = (names: string[]) => !app.scope || names.includes(ws.entities.find((e) => e.id === app.scope)?.name ?? '')
  const entities = ws.entities.filter((e) => !app.scope || e.id === app.scope)
  // Built-in sources (the cap table, cash added by hand) aren't connections to manage or sync.
  const connections = ws.connections.filter((c) => !BUILT_IN.has(c.connectorKey) && (inScope(c.entityNames) || c.entityNames.length === 0))
  const inbound = ws.inbound.filter((i) => !app.scope || i.entityId === app.scope)
  // One suggestion, never the whole catalog (that's behind "+ Add a connection"): a bank first, then the server's pick.
  const hasBank = ws.connections.some((c) => c.connectorKey === 'plaid' || c.connectorKey === 'simplefin')
  const offered = useOffered()
  const limited = isReviewer(app)
  const filling = isFilling(ws)
  // A brand-new workspace (a company named, nothing connected, no cash anywhere): one plain line, not a cash warning
  // per company and "All reconciled" about nothing.
  const nothingYet = !ws.me.demo && ws.connections.length === 0 && !ws.entities.some((e) => e.cash)
  const suggestion = ws.me.demo ? null : !hasBank ? ('bank' as const) : (ws.suggested.find((x) => x.key !== 'plaid' && x.key !== 'files') ?? null)
  const bank = bankWay(offered)

  return html`<div class="column">
    ${ws.me.demo ? html`<${DemoFilling} />` : null}

    <${Section} title="Money" sub=${app.scope ? 'Cash in this company' : entities.some((e) => e.kind === 'company') ? 'Cash in each company' : 'Your cash'}>
      ${filling
        ? html`<p class="sub" role="status">${ws.me.demoQueue ? demoLine(ws.me.demoQueue) : 'Filling the demo with a year of made-up activity. This takes a few minutes, then everything appears at once.'}</p>`
        : html`<${Rows} label="Companies">
            ${entities.map((e) => {
              // Nothing in this company yet (no cash, and no connection covers it): "no data yet", not a cash warning, even
              // when another company already has data.
              const empty = !e.cash && !ws.connections.some((c) => c.entityNames.includes(e.name))
              const shown = e.hidden ? 'private' : e.cash ? fmt(e.cash) : !empty && e.cashCaveat?.state === 'unknown' ? 'unknown' : 'no data yet'
              const updating = isUpdating(ws, e.name)
              // Investments (holdings at market value): a quiet second figure under cash, never part of it.
              const inv = !e.hidden && e.investments?.length ? `Investments ${e.investments.map((m) => fmt(m)).join(' · ')}` : null
              // Personal: the owner sees it, nobody else does (they get "private"). Say so, quietly.
              const line = [updating ? 'updating…' : null, e.kind === 'personal' && !e.hidden ? (isPublicDemo(app) ? 'made-up, like the rest' : 'only you see this') : null, !e.hidden && e.cashCaveat && !empty ? e.cashCaveat.reason : null].filter(Boolean).join(' · ')
              return html`<${Row}
                name=${e.name}
                line=${line || undefined}
                right=${inv
                  ? html`<span class="values"><span class=${'value' + (!e.cash ? ' grey' : '')}>${shown}</span><span class="value-sub">${inv}</span></span>`
                  : html`<span class=${'value' + (e.hidden || !e.cash ? ' grey' : '')}>${shown}</span>`}
                onClick=${() => app.open({ kind: 'company', id: e.id })}
                label=${`${e.name}, ${shown}${inv ? `, ${inv}` : ''}${updating ? ', updating' : ''}. Open details`}
              />`
            })}
          </${Rows}>`}
      ${entities.length === 0 && !filling ? html`<p class="empty">Add your first company to see its cash here.</p>` : null}
      ${!app.scope && canTryDemo(app) ? html`<${DemoLink} />` : null}
      ${nothingYet && entities.length ? html`<p class="sub" style="margin-top:12px">Nothing connected yet.</p>` : null}
      ${!app.scope && ws.health && !filling && !nothingYet ? html`<${HealthLine} health=${ws.health} />` : null}
      ${filling ? null : html`<${WaitingStatements} />`}
      ${limited || !isManager(app) || entities.length ? null : html`<${PlusAction} onClick=${() => app.open({ kind: 'company-new' })}>Add a company</${PlusAction}>`}
    </${Section}>

    <${Section} title="Connections" sub="Where your money lives">
      <${Rows} label="Connections" wrap>
        ${connections.map((c) => {
          const l = connectionLine(c, now)
          const others = c.entityNames.filter((n) => !c.name.includes(n))
          const where = others.length ? ` · ${others.join(', ')}` : ''
          return html`<${Row}
            icon=${html`<${SourceTile} connectorKey=${c.connectorKey} />`}
            name=${c.name + where}
            right=${c.status === 'needs_reauth' ? html`<span class="red">${l.text}</span>` : c.needsCompany ? html`<span class="amber">Choose a company</span>` : html`<span class="grey">${l.text}</span>`}
            onClick=${() => app.open({ kind: 'connection', id: c.id })}
          />`
        })}
      </${Rows}>
      ${suggestion && suggestion !== 'bank'
        ? // A suggestion, not a connection: a quiet line under the list, so it never reads as one that's broken.
          html`<p class="meta" style="margin-top:12px">Suggested · <button type="button" class="link" onClick=${() => app.open({ kind: 'connect', key: suggestion.key })}>${suggestion.name}${suggestion.provides.length ? ` for ${listWords(suggestion.provides.slice(0, 3))}` : ''}. Connect →</button></p>`
        : null}
      ${limited ? null : html`<${PlusAction} onClick=${() => app.open({ kind: 'connect' })}>Add a connection</${PlusAction}>`}
    </${Section}>

    <${AiSection} ws=${ws} now=${now} />

    <${Section} title="Add anything" sub="Cash, paper bills, receipts">
      <${Rows} label="Ways to add">
        ${inbound.slice(0, 1).map(
          (i) => html`<${Row} icon=${html`<${Tile} icon="mail" />`} name=${html`<span class="mono" style="font-size:14px">${i.address}</span>`} line=${`Email bills and receipts to ${ws.entities.find((e) => e.id === i.entityId)?.name ?? 'this company'}`} right=${html`<${CopyButton} text=${i.address} what="email address" />`} />`,
        )}
      </${Rows}>
      <${Pluses}>
        <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'cash' })}>Add cash or a receipt</${PlusAction}>
        <${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'upload' })}>Upload a file</${PlusAction}>
        ${inbound.length && !limited ? html`<${PlusAction} onClick=${() => app.open({ kind: 'add', what: 'email' })}>${inbound.length > 1 ? 'Other email addresses, and who can send' : 'Who can email it'}</${PlusAction}>` : null}
      </${Pluses}>
    </${Section}>
  </div>`
}

function AiSection({ ws, now }: { ws: Workspace; now: number }) {
  const app = useApp()
  // "Last used" goes stale while an AI works and this page sits open: check the newest activity every 30 seconds
  // (one small call) and refresh only when there's a new one.
  const lastSeen = useRef<string | null>(null)
  useEffect(() => {
    if (!ws.ais.length || ws.me.demo) return
    // What's newest as the page loads is already in the list; only later activity refreshes it.
    void app.api.latestActivity().then((a) => (lastSeen.current ??= a?.id ?? ''), () => {})
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible' || lastSeen.current === null) return
      const a = await app.api.latestActivity().catch(() => null)
      if (!a || a.id === lastSeen.current) return
      lastSeen.current = a.id
      void app.reload()
    }, 30_000)
    return () => clearInterval(t)
  }, [ws.ais.length, ws.me.demo])
  // The no-sign-up demo: its own link, which needs no sign-in (the usual one asks for an account first).
  const demoLink = isPublicDemo(app) ? app.me?.demoMcpUrl : undefined
  const link = demoLink ?? ws.me.mcpUrl
  return html`<${Section} title="Connect your AI" sub=${demoLink ? 'Paste this link into Claude, ChatGPT or any assistant. The demo books, no sign-in.' : 'Paste this link into Claude, ChatGPT or any assistant'}>
    <${Rows} label="Your AI link and connected AIs">
      <${Row} name=${html`<span class="mono" style="font-size:14px">${link}</span>`} right=${html`<${CopyButton} text=${link} what="AI link" />`} />
      ${ws.aiPaused ? html`<${Row} icon=${html`<${Tile} icon="pause" />`} name="All AI access is paused" line="Nothing can read or add until you resume" right=${html`<${Button} quiet onClick=${async () => (await app.api.pauseAll(false), app.reload())}>Resume</${Button}>`} />` : null}
      ${ws.ais.map(
        (a) => html`<${Row}
          name=${a.client === a.personName ? a.client : `${a.client} · ${a.personName}`}
          line=${`${grantLine(a.shape, ws.entities)} · ${a.paused ? 'paused' : a.lastUsedAt ? ago(a.lastUsedAt, now) : 'not used yet'}`}
          onClick=${() => app.open({ kind: 'ai', id: a.grantId })}
        />`,
      )}
    </${Rows}>
    <${PlusAction} onClick=${() => app.open({ kind: 'connect-ai' })}>Connect another AI</${PlusAction}>
  </${Section}>`
}

function Skeleton() {
  return html`<div class="column" aria-busy="true" aria-label="Loading">
    ${['Money', 'Connections', 'Connect your AI'].map(
      (t) => html`<${Section} title=${t} sub=${html`<span class="skeleton">loading</span>`}>
        <${Rows}>${[1, 2, 3].map(() => html`<${Row} name=${html`<span class="skeleton">Company name</span>`} right=${html`<span class="skeleton">$000,000</span>`} />`)}</${Rows}>
      </${Section}>`,
    )}
  </div>`
}

/** The grey line under Money: "All reconciled", or "N things need a look" that opens the list. */
function HealthLine({ health }: { health: WorkspaceHealth }) {
  const app = useApp()
  if (health.status === 'ok' || health.items.length === 0) return html`<p class="sub health-line">${health.line}</p>`
  return html`<button type="button" class="sub health-line link" onClick=${() => app.open({ kind: 'health' })}>${health.line}</button>`
}

const HEALTH_LABEL: Record<WorkspaceHealth['items'][number]['kind'], string> = {
  failed_check: 'Doesn’t add up',
  review: 'To review',
  in_transit: 'Not seen arriving',
  unexplained: 'Not explained yet',
  stale_source: 'Not syncing',
  missing_statement: 'Missing month',
}

export function HealthView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const h = app.ws?.health
  const name = (id: string | null) => (id ? app.ws?.entities.find((e) => e.id === id)?.name : undefined)
  const go = (i: WorkspaceHealth['items'][number]) => {
    // "Which company is this account?" is answered in its connection's drawer.
    const waiting = i.refId?.startsWith('which_company:') ? app.ws?.connections.find((c) => c.needsCompany) : undefined
    if (waiting) return app.push({ kind: 'connection', id: waiting.id })
    if (i.kind === 'review') return (onClose(), app.go({ page: 'review' }))
    if (i.kind === 'stale_source' && i.refId && app.ws?.connections.some((c) => c.id === i.refId)) return app.push({ kind: 'connection', id: i.refId })
    // An account that hasn't reported a balance (refId is the account): its company shows it as "unknown".
    if (i.kind === 'stale_source' && i.entityId) return app.push({ kind: 'company', id: i.entityId })
    // A gap in an uploaded account is filled by uploading that month's statement; a quiet synced account, in its company.
    if (i.kind === 'missing_statement') return i.text.startsWith('Statement for') ? app.push({ kind: 'add', what: 'upload' }) : i.entityId ? app.push({ kind: 'company', id: i.entityId }) : undefined
    if (i.entityId) return app.push({ kind: i.kind === 'failed_check' ? 'company' : 'txns', id: i.entityId })
  }
  return html`<${Drawer} title="Needs a look" sub=${h?.line ?? 'All reconciled'} onClose=${onClose} onBack=${onBack}>
    <${Rows} label="Things to look at" wrap>
      ${(h?.items ?? []).map((i) => {
        const where = name(i.entityId)
        const clickable = i.kind === 'review' || !!i.entityId || (i.kind === 'stale_source' && !!i.refId) || (i.kind === 'missing_statement' && i.text.startsWith('Statement for'))
        // stale_source names a connection that isn't syncing, or one account that hasn't sent a balance yet.
        const label = i.kind === 'stale_source' && i.refId && !app.ws?.connections.some((c) => c.id === i.refId) ? 'No balance yet' : HEALTH_LABEL[i.kind]
        return html`<${Row} name=${i.text} line=${where ? `${label} · ${where}` : label} onClick=${clickable ? () => go(i) : undefined} label=${i.text} />`
      })}
    </${Rows}>
  </${Drawer}>`
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`

/** Waiting for a fill slot: the honest place in line. */
export function demoLine(q: { position: number; minutes: number }): string {
  const when = `about ${q.minutes} minute${q.minutes === 1 ? '' : 's'}`
  return q.position === 1 ? `Your demo is next in line, ${when}. It fills by itself; this page updates when it's ready.` : `You're ${ordinal(q.position)} in line for a demo, ${when}. It fills by itself; this page updates when it's ready.`
}

/** While the demo fills, check back until it's ready. (The way out of the demo is the bar the shell shows on every screen.) */
function DemoFilling() {
  const app = useApp()
  const filling = app.ws?.me.demoReady === false
  useEffect(() => {
    if (!filling) return
    const t = setInterval(() => void app.reload(), 4000)
    return () => clearInterval(t)
  }, [filling])
  return null
}

/** Statements (uploaded or emailed in) that could belong to more than one account: one quiet line, the picker behind it. */
function WaitingStatements() {
  const app = useApp()
  const [open, setOpen] = useState(false)
  // The public demo can't read documents (read-only allowlist): don't ask.
  const { data, reload } = useLoad(() => (isPublicDemo(app) ? Promise.resolve([]) : app.api.waitingStatements().catch(() => [])), [app.ws])
  if (!data?.length) return null
  const n = data.length
  return html`<div>
    <button type="button" class="sub health-line link" aria-expanded=${open} onClick=${() => setOpen(!open)}>${n === 1 ? '1 statement needs an account' : `${n} statements need an account`}</button>
    ${open
      ? html`<${Rows} wrap label="Statements waiting for an account">${data.map(
          (w) => html`<${WhichAccount} result=${{ documentId: w.documentId, name: w.name, state: 'needs_account', message: `Which account is this for?${w.arrivedVia === 'email' ? ' (emailed in)' : ''}`, accounts: w.accounts }} onDone=${(r: { message: string }) => (app.toast({ text: `${w.name}: ${r.message}` }), reload(), app.reload())} onDeleted=${reload} />`,
        )}</${Rows}>`
      : null}
  </div>`
}

/**
 * Which connectors this server offers (GET /api/connectors), or null while it loads. Hosted leaves out Plaid until
 * its production keys are in, and Stripe without a live Stripe App key, so rows that name them follow the catalog.
 */
export function useOffered(): Set<string> | null {
  const app = useApp()
  // The public demo can't connect anything (the server answers 403): skip the request, same empty result.
  const { data } = useLoad(() => (isPublicDemo(app) ? Promise.resolve([]) : app.api.connectors().catch(() => [])), [])
  return data ? new Set(data.map((c) => c.key)) : null
}

export const PLAID_SOON = 'Bank connections via Plaid: coming soon'
/** Copy agreed with 63 (SimpleFIN Bridge's own price, 2026-10-12: $1.50 + tax a month or $15 a year, paid to them). */
export const SIMPLEFIN_LINE = 'For daily updates (SimpleFIN, $1.50/mo)'
export const STATEMENTS_LINE = 'CSV, OFX, QFX, QBO or PDF'

/** The way to bring in a bank: Plaid when offered, else SimpleFIN Bridge, else a statement. Null while loading. */
export function bankWay(offered: Set<string> | null): { key: 'plaid' | 'simplefin' | 'files'; open: (app: ReturnType<typeof useApp>) => () => void } | null {
  if (!offered) return null
  const key = offered.has('plaid') ? 'plaid' : offered.has('simplefin') ? 'simplefin' : 'files'
  return { key, open: (app) => () => (key === 'files' ? app.open({ kind: 'add', what: 'upload' }) : app.open({ kind: 'connect', key })) }
}
