// Connections: one connection's drawer (accounts, what it reads, sync, disconnect vs delete), the catalog behind
// "+ Add a connection", and the connect flow (provider popup → "which company is each account?").
import { EmailCode } from '../ui/email-code.ts'
import { AI_DISCLOSURE, type ConnectorDescription, type ConnectorGroup } from '@agfn/contracts'
import { useEffect, useRef, useState } from 'preact/hooks'
import { needsSetup, type Connector, type ConnectionSummary, type ConnectStart, type NewAccount } from '../api/types.ts'
import { useApp, useLoad, isManager, isReviewer } from '../app/context.ts'
import { inDemo, isPublicDemo, leaveDemo } from '../lib/demo.ts'
import { returnPath } from '../app/router.ts'
import { SUPPORT_EMAIL } from '../lib/support.ts'
import { fmt } from '../lib/money.ts'
import { termsLine } from '../lib/terms.ts'
import { ago } from '../lib/time.ts'
import { Button, CopyButton, LinkButton, PlusAction, Row, Rows, Section } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'
import { connectionLine, SourceTile } from './workspace.ts'
import { closePlaidLink, INVESTMENTS_RETRY, openPlaidLink, PlaidExitError, preloadPlaid, savePending, takePending } from '../lib/plaid.ts'
import { passkeyName } from '../lib/passkey.ts'
import { returnHere, recentlyRechecked, forgetRechecked } from '../lib/recheck.ts'
import { HttpError, OFFLINE } from '../api/http.ts'

/** Back from an OAuth bank: re-open Link with the same token and the full return URL, then ask which company. */
export function PlaidReturnView({ onClose }: { onClose: () => void }) {
  const app = useApp()
  useEffect(() => closePlaidLink, [])
  const [retrying, setRetrying] = useState(false)
  const { data, error } = useLoad(async () => {
    const p = takePending()
    let href = ''
    try {
      href = sessionStorage.getItem(PLAID_REDIRECT) ?? ''
      sessionStorage.removeItem(PLAID_REDIRECT)
    } catch {
      /* ignore */
    }
    if (!p || !href) throw new Error('This bank connection timed out. Nothing was connected.')
    const connect = p.mode !== 'reconnect'
    let state = p.state
    const ok = await openPlaidLink(p.linkToken, href, (e) => void app.api.linkEvent(e), { noAccounts: connect }).catch(async (e: unknown) => {
      // The same single investments-first retry as the connect drawer (brokerages are mostly OAuth banks). A pending
      // saved before entityId existed can't say which company, so it doesn't retry.
      if (!(connect && !p.retried && p.entityId !== undefined && e instanceof PlaidExitError && INVESTMENTS_RETRY.has(e.code ?? ''))) throw e
      setRetrying(true)
      const again = await app.api.startConnect(p.connectorKey, p.entityId, p.returnTo, { investmentsFirst: true })
      if (again.kind !== 'plaid_link') throw e
      state = again.state
      savePending({ ...p, linkToken: again.linkToken, state: again.state, retried: true })
      const r = await openPlaidLink(again.linkToken, undefined, (x) => void app.api.linkEvent(x), { noAccounts: true })
      takePending()
      return r
    })
    if (!ok) return null
    if (p.mode === 'reconnect' && p.connectionId) {
      await app.api.finishReconnect(p.connectionId, { state: p.state, ...(ok.linkSessionId ? { linkSessionId: ok.linkSessionId } : {}) })
      await app.reload()
      return 'reconnected' as const
    }
    return (await app.api.finishConnect(p.connectorKey, { state, ...ok })).accounts
  }, [])
  if (data === 'reconnected') return html`<${Drawer} title="Reconnected" sub="Your bank is sharing data again. Nothing was lost." onClose=${onClose} onBack=${null} />`
  if (data) return html`<${AssignAccounts} name="Your bank" accounts=${data} onClose=${onClose} onBack=${null} />`
  if (error) return html`<${Drawer} title="Your bank didn’t connect" sub=${html`${error === OFFLINE ? 'Aggregate couldn’t be reached. Nothing was connected.' : error} <${LinkButton} onClick=${() => app.open({ kind: 'connect' })}>Try again</${LinkButton}>`} onClose=${onClose} onBack=${null} />`
  if (data === null) return html`<${Drawer} title="Bank not connected" sub="Closed. Nothing was connected." onClose=${onClose} onBack=${null} />`
  return html`<${Drawer} title="Connecting your bank…" sub=${retrying ? 'Trying again for investment accounts…' : 'Finishing in Plaid'} onClose=${onClose} onBack=${null} />`
}
export const PLAID_REDIRECT = 'agfn.plaid.redirect'

export function ConnectionView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: c, error, reload } = useLoad(() => app.api.connection(id), [id])
  // While it syncs, check every 3 s; when it finishes, refresh the Workspace too (status, "synced …", cash).
  const status = c?.status
  const wasSyncing = useRef(false)
  useEffect(() => {
    if (status === 'syncing') {
      wasSyncing.current = true
      const t = setInterval(() => reload(), 3000)
      return () => clearInterval(t)
    }
    if (wasSyncing.current) {
      wasSyncing.current = false
      void app.reload()
    }
  }, [status])
  const [confirm, setConfirm] = useState<null | 'keep' | 'delete'>(null)
  /** What's left to do at the provider, after disconnecting. */
  const [left, setLeft] = useState<string | null>(null)
  // Disconnected, the connection may no longer load: the step above still needs its name.
  const c0 = useRef<typeof c>(null)
  // The link that opened the confirm is gone while it shows: focus goes to Cancel, and back to that link after Cancel
  // (the last two in the row: Disconnect, then Disconnect and delete its data), never lost to the page.
  const confirmBox = useRef<HTMLDivElement>(null)
  const linksBox = useRef<HTMLDivElement>(null)
  const wasConfirm = useRef<null | 'keep' | 'delete'>(null)
  useEffect(() => {
    if (confirm) confirmBox.current?.querySelector<HTMLElement>('button:last-of-type')?.focus()
    else if (wasConfirm.current) ([...(linksBox.current?.children ?? [])].filter((x) => x.tagName === 'BUTTON') as HTMLElement[]).at(wasConfirm.current === 'delete' ? -1 : -2)?.focus()
    wasConfirm.current = confirm
  }, [confirm])
  const [busy, setBusy] = useState<null | 'reconnect' | 'refresh'>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; tone?: 'red'; connect?: boolean } | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  if (left !== null) {
    const url = PROVIDER_DASHBOARD[c0.current?.connectorKey ?? '']
    return html`<${Drawer} title=${`${c0.current?.name.split(' · ')[0] ?? 'It’s'} disconnected`} onClose=${onClose} onBack=${null}>
      <p style="margin-top:16px">One more step: ${left.replace(/^In /, 'in ')}${url ? html` <a class="link" href=${url.href} target="_blank" rel="noopener noreferrer">${url.label} ↗</a>` : null}</p>
      <div class="formrow"><${Button} onClick=${onClose}>Done</${Button}></div>
    </${Drawer}>`
  }
  if (error) return html`<${LoadFailed} title="This connection is gone" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!c) return html`<${Drawer} title="Loading…" onClose=${onClose} onBack=${onBack} />`
  const now = app.now()
  const l = connectionLine(c, now)
  c0.current = c
  // "Stripe · Aggregate" → Stripe: what you're disconnecting is the provider, whatever the account there is called.
  const provider = c.name.split(' · ')[0] ?? c.name
  const disconnect = async (deleteData: boolean) => {
    const r = await app.api.disconnect(c.id, deleteData)
    // The provider's own note about what to finish on their side, said plainly (it's removed here either way).
    const warning = r && typeof r === 'object' && 'warning' in r && r.warning ? r.warning : ''
    // The server may delete the data anyway (a provider's terms require it); say what actually happened.
    const deleted = r && typeof r === 'object' && 'dataDeleted' in r && typeof r.dataDeleted === 'boolean' ? r.dataDeleted : deleteData
    await app.reload()
    // A step only they can take stays on screen until they're done with it; it can't be left to a toast.
    if (warning) return setLeft(warning)
    app.toast({ text: deleted ? `${provider} and its data are removed. Your bank isn’t affected.` : `${provider} disconnected.` })
    onClose()
  }
  // Repairs this connection in place (Plaid update mode), never a second copy of the same bank.
  const reconnect = async () => {
    setNote(null)
    setBusy('reconnect')
    try {
      const r = await app.api.reconnect(c.id, !!c.attention?.includes('new_accounts'))
      // Its own company carries over (one company per source), so the connect drawer doesn't ask or guess again.
      if (r.kind === 'connect') {
        const own = c.entityNames.length === 1 ? app.ws?.entities.find((e) => e.name === c.entityNames[0])?.id : undefined
        return app.push({ kind: 'connect', key: r.connectorKey, ...(own ? { entity: own } : {}) })
      }
      savePending({ mode: 'reconnect', connectionId: c.id, connectorKey: c.connectorKey, linkToken: r.linkToken, state: r.state, returnTo: returnPath(app.route) })
      const ok = await openPlaidLink(r.linkToken, undefined, (e) => void app.api.linkEvent(e))
      takePending()
      if (!ok) return
      await app.api.finishReconnect(c.id, { state: r.state, ...(ok.linkSessionId ? { linkSessionId: ok.linkSessionId } : {}) })
      app.toast({ text: `${c.name} is reconnected.` })
      reload()
      await app.reload()
    } catch (e) {
      if (e instanceof HttpError && e.code === 'gone') {
        setNote({ text: e.message || `${c.name} was removed at the bank. Connect it again to keep syncing.`, connect: true })
        await app.reload()
      } else setNote({ text: e instanceof Error ? e.message : 'That didn’t work.', tone: 'red' })
    } finally {
      setBusy(null)
    }
  }
  // Billed per check by Plaid: only ever on this click.
  const refresh = async () => {
    setNote(null)
    setBusy('refresh')
    try {
      const r = await app.api.refreshBalance(c.id)
      // Capped (cooldown or daily cap): nothing was billed; the server's sentence says when it can check again.
      if (r.live === false) {
        if (r.refreshedAt) setCheckedAt(r.refreshedAt)
        return setNote({ text: r.message })
      }
      setCheckedAt(r.at)
      app.toast({ text: 'Balance updated.' })
      reload()
      await app.reload()
    } catch (e) {
      const retry = e instanceof HttpError && e.code === 'cooldown' && typeof e.data.retryAt === 'string' ? new Date(e.data.retryAt) : null
      setNote({ text: retry ? `Checked a moment ago. You can refresh again at ${retry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : e instanceof Error ? e.message : 'That didn’t work.' })
    } finally {
      setBusy(null)
    }
  }
  // The reviewer's demo and the no-sign-up demo only read: nothing here that would change or disconnect anything.
  const readOnly = isPublicDemo(app)
  const limited = isReviewer(app) || readOnly
  // Moving and disconnecting are an owner's or admin's (the server refuses anyone else).
  const manages = isManager(app)
  const needsReconnect = !limited && (c.status === 'needs_reauth' || !!c.attention?.length)
  // Banks place each account (ConnectionCompany is for single-company sources): a quiet move per account.
  const movable = c.connectorKey === 'plaid' && !limited && manages && (app.ws?.entities ?? []).some((e) => e.kind === 'company')
  return html`<${Drawer} title=${c.name} sub=${html`<span class=${l.tone ?? ''}>${l.text}</span>${c.entityNames.length ? ' · ' + c.entityNames.join(', ') : ''}`} onClose=${onClose} onBack=${onBack}>
    <p style="margin-top:16px">Reads ${c.provides.join(', ')}. Can’t move money.</p>
    ${needsReconnect
      ? html`<div style="margin-top:20px"><p class=${c.status === 'needs_reauth' ? 'sub' : 'sub amber'}>${c.message ?? `${c.name} stopped sharing data. Your data until then is safe.`}</p><div class="formrow" style="margin-top:12px"><${Button} onClick=${reconnect} disabled=${busy !== null}>${c.attention?.includes('new_accounts') && c.status !== 'needs_reauth' ? 'Choose accounts' : 'Reconnect'}</${Button}></div></div>`
      : !limited && c.status === 'error'
        ? // Not syncing for now (the server says why, in a plain sentence); if it keeps happening, reconnect is one click.
          html`<p class="sub amber" style="margin-top:20px">${c.message ?? `${c.name} isn’t syncing right now. Aggregate will try again.`} <${LinkButton} onClick=${busy ? () => {} : reconnect}>${busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}</${LinkButton}></p>`
        : null}
    ${note
      ? html`<p class=${'sub' + (note.tone ? ' ' + note.tone : '')} role="alert" style="margin-top:16px">${note.text}${note.connect ? html` <${LinkButton} onClick=${() => app.push({ kind: 'connect', key: c.connectorKey })}>Connect it again</${LinkButton}>` : null}</p>`
      : null}
    ${limited || !manages ? null : html`<${ConnectionCompany} c=${c} onMoved=${async () => (reload(), await app.reload())} />`}
    ${c.connectorKey === 'xero' && !limited ? html`<${SharedOrgs} id=${c.id} />` : null}
    ${c.unassigned?.length && !limited ? html`<${ChooseCompanies} accounts=${c.unassigned} onSaved=${async () => (reload(), app.reload())} />` : null}
    ${c.storeSales?.map((m) => html`<p class="sub" style="margin-top:16px">Sales reported by the store: ${fmt(m, { cents: true })} this month, not counted as revenue</p>`)}
    ${!c.accounts.length && !needsReconnect
      ? html`<p class="sub" style="margin-top:16px">${c.status === 'syncing'
          ? 'Bringing in your data. The first import can take a few minutes.'
          : c.records
            ? `${c.records.toLocaleString('en-US')} ${c.records === 1 ? 'record' : 'records'} brought in.`
            : c.lastSyncAt && c.connectorKey !== 'plaid'
              ? `Synced ${ago(c.lastSyncAt, now)}.${c.entityNames.length ? ` Its ${c.provides.join(', ')} count toward ${c.entityNames.join(', ')}.` : ''}`
              : 'No data yet. Sync now to check again.'}</p>`
      : null}
    ${c.accounts.length
      ? html`<${Section} compact title="Accounts" sub="Each one belongs to a company, or Personal">
          <${Rows}>${c.accounts.map((a) => html`<${Row} name=${`${a.name}${a.mask ? ' ··' + a.mask : ''}`} line=${movable ? html`${[termsLine(a.terms), balanceAsOf(a.asOf, c.lastSyncAt, now)].filter(Boolean).map((x) => x + ' · ')}<${LinkButton} onClick=${() => setMoving(a.id)}>Move<span class="sr"> ${a.name}</span> to another company</${LinkButton}>` : [termsLine(a.terms), balanceAsOf(a.asOf, c.lastSyncAt, now)].filter(Boolean).join(' · ')} right=${a.balance ? html`<span class="value">${fmt(a.balance)}</span>` : html`<span class="value grey">unknown</span>`} />`)}</${Rows}>
          ${moving && c.accounts.some((a) => a.id === moving) ? html`<${MoveAccount} account=${c.accounts.find((a) => a.id === moving)!} onDone=${async (moved: boolean) => (setMoving(null), moved ? (reload(), await app.reload()) : undefined)} />` : null}
        </${Section}>`
      : null}
    <div class="links" style="margin-top:40px" ref=${linksBox}>
      ${readOnly ? null : html`<${LinkButton} onClick=${async () => (await app.api.syncNow(c.id), reload(), void app.reload(), app.toast({ text: 'Syncing now.' }))}>Sync now</${LinkButton}>`}
      ${c.canRefreshBalance && c.status !== 'needs_reauth' && !limited ? html`<span><${LinkButton} onClick=${busy ? () => {} : refresh}>${busy === 'refresh' ? 'Checking…' : 'Refresh balance'}</${LinkButton}>${checkedAt ? html`<span class="sub"> · checked ${ago(checkedAt, now)}</span>` : null}</span>` : null}
      ${limited || !manages
        ? null
        : confirm === null
        ? html`<${LinkButton} onClick=${() => setConfirm('keep')}>${DISCONNECT_WORDS[c.connectorKey] ?? 'Disconnect'}</${LinkButton}>${c.erasesOnDisconnect ? null : html`<${LinkButton} danger onClick=${() => setConfirm('delete')}>Disconnect and delete its data</${LinkButton}>`}`
        : html`<div class="confirm" role="alert" ref=${confirmBox}>
            <p class="name">${confirm === 'keep' ? `Disconnect ${provider}?` : `Delete ${provider}’s data?`}</p>
            <p class="sub">${confirm === 'keep' ? (c.erasesOnDisconnect === 'always' ? 'Its data will be deleted.' : c.erasesOnDisconnect === 'maybe' ? 'Its data may be deleted when you do.' : 'We stop syncing. What already synced stays.') : `This deletes ${c.accountCount} ${c.accountCount === 1 ? 'account' : 'accounts'} and all their transactions from Aggregate. Your bank isn’t affected.`}</p>
            <div class="formrow"><${Button} danger onClick=${() => disconnect(confirm === 'delete')}>${confirm === 'keep' ? (DISCONNECT_WORDS[c.connectorKey] ?? 'Disconnect') : 'Delete'}</${Button}><${Button} quiet onClick=${() => setConfirm(null)}>Cancel</${Button}></div>
          </div>`}
    </div>
  </${Drawer}>`
}

/** Where the last step happens, when there's one place to send people. */
const PROVIDER_DASHBOARD: Record<string, { href: string; label: string }> = {
  stripe: { href: 'https://dashboard.stripe.com/settings/apps', label: 'Open Stripe' },
}

/** One line before a provider's sign-in, where its page asks something people should know about. */
const SIGN_IN_NOTE: Record<string, string> = {
  // Polar's consent page starts on "all current and future organizations".
  polar: 'Polar asks which organizations to share. It starts on all of them; you can pick just one there.',
  // The providers whose access can't be limited to reading: say so before anyone goes there. Our own code only reads.
  quickbooks: 'QuickBooks only offers one accounting permission, which covers reading and writing. Aggregate only reads.',
  billcom: 'BILL’s sync token can edit records in your BILL account but can’t pay anyone or move money. Aggregate only reads.',
}

/** Their keys can't be limited to reading, so the list under the steps is a statement, not "all read-only". */
const NOT_READ_ONLY = new Set(['lemonsqueezy', 'expensify'])

/** Mercury's partner terms: "Powered by Mercury" plus its not-a-bank disclosure, word for word from the Mercury Partner Media Kit. */
const MERCURY_DISCLOSURE = 'Powered by Mercury. Mercury is a fintech company, not an FDIC-insured bank. Banking services provided through Choice Financial Group and Column N.A., Members FDIC.'

/** Providers whose certification asks for their own wording on our plain buttons (no logo; 60fe3959, Intuit's review). */
const CONNECT_WORDS: Record<string, string> = { xero: 'Connect to Xero', quickbooks: 'Connect to QuickBooks' }
const DISCONNECT_WORDS: Record<string, string> = { xero: 'Disconnect from Xero', quickbooks: 'Disconnect from QuickBooks' }

const GROUPS: Array<{ group: ConnectorGroup; title: string; sub: string }> = [
  { group: 'banks', title: 'Banks and cards', sub: 'Every US bank and card, through Plaid. You sign in with your bank, not with us.' },
  { group: 'payments', title: 'Payments', sub: 'Charges, payouts and fees' },
  { group: 'spend', title: 'Spend platforms', sub: 'Read-only tokens' },
  { group: 'accounting', title: 'Accounting and invoices', sub: 'Invoices, bills and your books' },
  { group: 'payroll', title: 'Payroll and people', sub: 'Payroll runs and contractors' },
  { group: 'equity', title: 'Equity', sub: 'Your cap table' },
  { group: 'files', title: 'Anything else', sub: 'Statements, CSVs and PDFs' },
]

export function ConnectView({ connectorKey, entityId, onClose, onBack }: { connectorKey?: string; entityId?: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: all, error, reload } = useLoad(() => app.api.connectors(), [])
  // Nothing connected yet: the bank is the one to do first, so it's the one dark button.
  const connected = !!app.ws?.connections.length
  if (error) return html`<${LoadFailed} title="Couldn’t load connections" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (connectorKey && all) {
    // Self-hosted with no Plaid keys: a bank is SimpleFIN or a statement first, Plaid with your own account second.
    if (connectorKey === 'plaid-setup' || (connectorKey === 'plaid' && all.some((x) => x.key === 'plaid' && needsSetup(x)))) {
      const plaid = all.find((x) => x.key === 'plaid')
      if (connectorKey === 'plaid-setup' && plaid) return html`<${SetupView} c=${plaid} onClose=${onClose} onBack=${onBack} />`
      return html`<${BankWithoutPlaid} all=${all} onClose=${onClose} onBack=${onBack} />`
    }
    const c = all.find((x) => x.key === connectorKey)
    if (c && needsSetup(c)) return html`<${SetupView} c=${c} onClose=${onClose} onBack=${onBack} />`
    if (c) return html`<${ConnectOne} c=${c} entityId=${entityId} onClose=${onClose} onBack=${onBack} />`
  }
  // A link straight to one connector (back from an emailed check, a shortcut): wait for the list, never flash the menu.
  if (connectorKey && !all) return html`<${Drawer} title="Connect" onClose=${onClose} onBack=${onBack}><p class="sub" aria-busy="true" style="margin-top:12px">One moment…</p></${Drawer}>`
  return html`<${Drawer} title="Add a connection" sub="Most take under a minute. Aggregate only reads." onClose=${onClose} onBack=${onBack}>
    ${GROUPS.map(({ group, title, sub }) => {
      const items = (all ?? []).filter((c) => c.group === group)
      if (!items.length) return null
      return html`<${Section} compact title=${title} sub=${sub}>
        <${Rows}>${[...items.filter((c) => !needsSetup(c)), ...items.filter(needsSetup)].map((c) =>
          needsSetup(c)
            ? html`<${Row} icon=${html`<${SourceTile} connectorKey=${c.key} />`} name=${c.name} line=${needsLine(c)} right=${html`<${Button} quiet onClick=${() => app.push({ kind: 'connect', key: c.key })} label=${'Set up ' + c.name}>Set up</${Button}>`} />`
            : html`<${Row} icon=${html`<${SourceTile} connectorKey=${c.key} plaidMark />`} name=${c.beta ? html`${c.name} <span class="pill">Beta</span>` : c.key === 'plaid' ? 'Bank, card or brokerage' : c.name} line=${c.freshness} right=${html`<${Button} quiet=${!connected && c.key !== 'plaid'} onClick=${() => app.push(c.key === 'files' ? { kind: 'add', what: 'upload' } : { kind: 'connect', key: c.key })} label=${'Connect ' + c.name}>${c.auth === 'file' ? 'Upload' : 'Connect'}</${Button}>`} />`,
        )}</${Rows}>
      </${Section}>`
    })}
    ${all ? html`<p class="meta" style="margin-top:24px">Logos belong to their owners and are shown only to identify services you can connect. No endorsement implied.</p>` : null}
  </${Drawer}>`
}

const needsLine = (c: Connector) => (c.key === 'plaid' ? 'With your own Plaid account' : `Needs your own ${c.name} app`)

/** Self-hosting: this server has no developer app for the provider yet. The steps, the exact redirect URL, where the keys go. */
export function SetupView({ c, onClose, onBack }: { c: Connector; onClose: () => void; onBack: (() => void) | null }) {
  const s = c.setup!
  const who = s.register?.name ?? c.name
  const keys = (s.env ?? []).map((k) => `${k}=…`).join('\n')
  return html`<${Drawer} title=${c.key === 'plaid' ? 'Use your own Plaid account' : `Set up ${c.name}`} sub=${`This server needs its own ${who} app, once. About five minutes.`} onClose=${onClose} onBack=${onBack}>
    <ol class="steps">
      ${s.steps?.length
        ? s.steps.map((t) => html`<li>${t}</li>`)
        : html`<li>Create an app at ${s.register ? html`<a class="link" href=${s.register.url} target="_blank" rel="noopener noreferrer">${who} ↗</a>` : who}.</li>
            ${s.redirectUri ? html`<li>Add this redirect URL to it.</li>` : null}
            ${keys ? html`<li>Put its keys in this server’s environment.</li>` : null}
            <li>Restart the server, then come back and connect.</li>`}
    </ol>
    ${s.redirectUri
      ? html`<p class="sub" style="margin-top:16px">Redirect URL</p><div class="formrow" style="align-items:center;margin-top:6px"><code class="code" style="flex:1">${s.redirectUri}</code><${CopyButton} text=${s.redirectUri} what="redirect URL" /></div>`
      : null}
    ${keys
      ? html`<p class="sub" style="margin-top:16px">Environment</p><div class="formrow" style="align-items:center;margin-top:6px"><code class="code" style="flex:1;white-space:pre-wrap">${keys}</code><${CopyButton} text=${keys} what="variable names" /></div>`
      : null}
    ${s.docsUrl ? html`<div class="links"><a class="link" href=${s.docsUrl} target="_blank" rel="noopener noreferrer">Full guide ↗</a></div>` : null}
  </${Drawer}>`
}

/** A bank on a self-hosted server without Plaid keys: what works now first, Plaid with your own account last. */
function BankWithoutPlaid({ all, onClose, onBack }: { all: Connector[]; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const simplefin = all.find((x) => x.key === 'simplefin' && !needsSetup(x))
  return html`<${Drawer} title="Connect a bank or card" sub="Aggregate only reads. It can’t move money." onClose=${onClose} onBack=${onBack}>
    <${Rows} label="Ways to connect a bank">
      ${simplefin
        ? html`<${Row} icon=${html`<${SourceTile} connectorKey="plaid" />`} name=${simplefin.name} line="Most US banks · paste a setup token" right=${html`<${Button} onClick=${() => app.push({ kind: 'connect', key: 'simplefin' })} label=${'Connect ' + simplefin.name}>Connect</${Button}>`} />`
        : null}
      <${Row} icon=${html`<${SourceTile} connectorKey="files" />`} name="Upload a statement" line="PDF, CSV, OFX, QFX or camt.053" right=${html`<${Button} onClick=${() => app.push({ kind: 'add', what: 'upload' })} label="Upload a statement">Upload</${Button}>`} />
      <${Row} icon=${html`<${SourceTile} connectorKey="plaid" />`} name="Plaid" line="With your own Plaid account" right=${html`<${Button} quiet onClick=${() => app.push({ kind: 'connect', key: 'plaid-setup' })} label="Set up Plaid">Set up</${Button}>`} />
    </${Rows}>
  </${Drawer}>`
}

/** The connect flow for one source. Plaid/OAuth open the provider's own popup; the server finishes the exchange. */
/** Connectors whose data is usually the person's own (an investor's portfolio): the connect drawer starts on Personal. */
const PERSONAL_FIRST = new Set(['wefunder'])

export function ConnectOne({ c, onClose, onBack, entityId, onDone }: { c: ConnectorDescription & { beta?: boolean }; onClose: () => void; onBack: (() => void) | null; entityId?: string; onDone?: () => void }) {
  const app = useApp()
  const [start, setStart] = useState<ConnectStart | null>(null)
  const [accounts, setAccounts] = useState<NewAccount[] | null>(null)
  const [token, setToken] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  /** A limit, not a failure (hosted early access caps banks per workspace): said in grey, with the server's words. */
  const [limit, setLimit] = useState<{ message: string; moreUrl?: string } | null>(null)
  // In a real demo workspace nothing real can connect (the server refuses): offer the way out up front, not a refusal.
  // Except what this server allows in a demo (demoAllowed: the challenge's sandbox Plaid).
  const [demoOnly, setDemoOnly] = useState(() => inDemo(app, isReviewer(app)) && (app.api as { simulated?: boolean }).simulated !== true && !c.demoAllowed)
  /** Back from the provider without finishing ("That took too long. Try again."): said once, above the usual button. */
  const [note, setNote] = useState(() => app.route.params.connect_note ?? '')
  /** "Chase is already connected": point at it instead of adding a second copy. */
  const [duplicateOf, setDuplicateOf] = useState<string | null>(null)
  /** The server refused a second copy: only its sentence (and "Open it") shows, not the check or the button again. */
  const [duplicate, setDuplicate] = useState(false)
  // Which company it's for. Never a silent guess: from "All companies" with more than one company, ask first. Banks
  // ask per account after Plaid instead, so they start with none.
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  // Investor portfolios (Wefunder) are usually the person's own: they start on Personal, changeable right here.
  const personal = (app.ws?.entities ?? []).find((e) => e.kind === 'personal')
  const personalFirst = PERSONAL_FIRST.has(c.key) && !!personal
  const preset = personalFirst ? null : entityId ?? app.scope ?? (companies.length === 1 ? companies[0]!.id : null)
  const askCompany = personalFirst || (!preset && companies.length > 1 && c.key !== 'plaid')
  // In more than one workspace: name the one this connects into, so it never lands in the wrong one unnoticed.
  const spaces = app.me?.workspaces ?? []
  const [picked, setPicked] = useState(personalFirst ? (entityId ?? personal!.id) : '')
  const target = preset ?? (picked || null)
  // Connecting accounts needs a passkey. Without one, say so first, and open the passkey sheet straight from the click
  // (options fetched ahead, so Safari doesn't drop the gesture).
  useEffect(() => closePlaidLink, [])
  // The note is for this one arrival: take it out of the address so no later drawer (or a success) shows it again.
  useEffect(() => {
    const { connect_note: n, ...rest } = app.route.params
    if (n !== undefined) app.go({ params: rest })
  }, [])
  const [needPasskey, setNeedPasskey] = useState(false)
  // The account already has a passkey: a check that timed out, was cancelled or expired asks for that passkey again
  // ("Try again"), never "Add passkey" (the browser refuses a second one for the same account on this device).
  const [retry, setRetry] = useState(false)
  const hasPasskey = useRef<boolean | null>(null)
  const [ceremony, setCeremony] = useState<((name: string) => Promise<boolean>) | null>(null)
  useEffect(() => {
    let live = true
    app.api.preferences().then((p) => {
      hasPasskey.current = p.signIn.passkeys.length > 0
      // Just back from an emailed check (or confirmed with its code, even before a reload): that counts for 10 minutes,
      // so go straight to the provider.
      if (app.route.params.rechecked === '1' || recentlyRechecked()) return
      // Only ever turns the step on: a reply that lands after a press must not undo what that press found.
      if (live && !p.signIn.noRecheck && p.signIn.passkeys.length === 0) setNeedPasskey(true)
    }, () => {})
    return () => void (live = false)
  }, [])
  useEffect(() => {
    if (!needPasskey || retry) return
    let live = true
    app.api.preparePasskey().then((f) => live && setCeremony(() => f), () => {})
    return () => void (live = false)
  }, [needPasskey, retry])
  const [emailSent, setEmailSent] = useState('')
  // Xero's and Intuit's reviews ask for their wording on the connect button (CONNECT_WORDS); it stays our plain button.
  const go = CONNECT_WORDS[c.key] ?? `Continue to ${c.name}`
  // The emailed check, confirmed by its code here: "Continue to …" turns on only then (or after the link brings you back).
  const [confirmed, setConfirmed] = useState(false)
  const companyPicker = askCompany
    ? html`<label class="field" style="margin-top:16px"><span>${personalFirst ? 'Whose investments?' : 'For which company?'}</span>
        <select class="input" value=${picked} onChange=${(e: Event) => (setPicked((e.target as HTMLSelectElement).value), setErr(''))}>
          ${personalFirst ? null : html`<option value="" disabled>Choose a company…</option>`}
          ${(personalFirst ? [personal!, ...companies] : companies).map((x) => html`<option value=${x.id}>${x.kind === 'personal' ? 'Personal (mine)' : x.name}</option>`)}
        </select></label>`
    : null
  const emailInstead = async () => {
    setErr('')
    try {
      setEmailSent((await app.api.recheckByEmail(returnHere())).sentTo)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t send. Try again in a minute.')
    }
  }
  const addPasskey = async () => {
    setErr('')
    const f = ceremony
    if (!f) return setErr('One moment, getting the passkey ready…')
    setCeremony(null)
    let already = false
    const ok = await f(passkeyName()).catch((e: unknown) => ((already = (e as { name?: string } | null)?.name === 'InvalidStateError'), false))
    // This device already holds a passkey for this account: confirm with that one instead.
    if (already) {
      hasPasskey.current = true
      setRetry(true)
      return setErr('You already have a passkey on this device. Confirm it’s you with it.')
    }
    if (!ok) {
      setErr('The passkey wasn’t added. Try again.')
      app.api.preparePasskey().then((g) => setCeremony(() => g), () => {})
      return
    }
    setNeedPasskey(false)
    await begin()
  }

  // Between the provider saying yes and the account list: finishing and the first sync take a few seconds. Say so and
  // take the button away, or it looks like nothing happened and people connect again.
  const [finishing, setFinishing] = useState(false)
  // Starting takes a round trip and (Plaid) a script: say so, and one press opens one thing.
  const [opening, setOpening] = useState(false)
  useEffect(() => {
    // Not for the mock (no Plaid behind it), so tests and the local preview never reach out.
    if (c.key === 'plaid' && (app.api as { simulated?: boolean }).simulated !== true) preloadPlaid()
  }, [])
  // Nothing to assign (BILL, Deel, QuickBooks…: no bank accounts come back): no empty "Which company" step. Finish as
  // AssignAccounts does after saving.
  const arrived = async (list: NewAccount[]) => {
    if (list.length) return setAccounts(list)
    await app.reload().catch(() => undefined)
    app.toast({ text: `${c.key === 'plaid' ? 'Your bank' : c.name} connected. Pulling 24 months of history; about a minute.` })
    onDone ? onDone() : onClose()
  }
  const begin = async () => {
    if (opening) return
    setOpening(true)
    try {
      await start1()
    } finally {
      setOpening(false)
    }
  }
  const start1 = async () => {
    if (finishing) return
    setErr('')
    setNote('')
    if (askCompany && !picked) return setErr('Choose which company this is for.')
    try {
      const back = returnPath(app.route)
      const s = await app.api.startConnect(c.key, target, back)
      // The check passed (the server let it start): leave the email step.
      setNeedPasskey(false)
      setRetry(false)
      setEmailSent('')
      setConfirmed(false)
      setStart(s)
      // The mock has no Plaid or OAuth behind it; a real server's demo workspace refuses connects with a plain message.
      const demo = (app.api as { simulated?: boolean }).simulated === true
      if (s.kind === 'plaid_link') {
        // Plaid's own popup. OAuth banks leave and come back to /connect/plaid/oauth (see PlaidReturnView).
        if (demo) return arrived((await app.api.finishConnect(c.key, { state: s.state, publicToken: 'demo' })).accounts)
        savePending({ mode: 'connect', connectorKey: c.key, linkToken: s.linkToken, state: s.state, returnTo: back, entityId: target })
        let link: Extract<ConnectStart, { kind: 'plaid_link' }> = s
        const ok = await openPlaidLink(s.linkToken, undefined, (e) => void app.api.linkEvent(e), { noAccounts: true }).catch(async (e: unknown) => {
          // A brokerage-only login has nothing for Transactions: once, ask again with investments first (c7's server half).
          if (!(e instanceof PlaidExitError && INVESTMENTS_RETRY.has(e.code ?? ''))) throw e
          setNote('Trying again for investment accounts…')
          const again = await app.api.startConnect(c.key, target, back, { investmentsFirst: true })
          if (again.kind !== 'plaid_link') throw e
          link = again
          setStart(again)
          savePending({ mode: 'connect', connectorKey: c.key, linkToken: again.linkToken, state: again.state, returnTo: back, entityId: target, retried: true })
          return openPlaidLink(again.linkToken, undefined, (x) => void app.api.linkEvent(x), { noAccounts: true })
        })
        if (!ok) return setNote('')
        takePending()
        setFinishing(true)
        await arrived((await app.api.finishConnect(c.key, { state: link.state, ...ok })).accounts)
      } else if (s.kind === 'oauth') {
        // The provider's sign-in page; the server's callback finishes and brings you back here.
        if (demo) return arrived((await app.api.finishConnect(c.key, { state: s.state, code: 'demo' })).accounts)
        location.assign(s.url)
      } else if (s.kind === 'upload') {
        app.push({ kind: 'add', what: 'upload' })
      }
    } catch (e) {
      setFinishing(false)
      if (e instanceof HttpError && e.code === 'passkey_required') return setNeedPasskey(true)
      // "Continue" after the email, but the link wasn't opened and the code wasn't typed: stay on that step and say so,
      // instead of offering "Continue to …" and asking again from the start.
      if (e instanceof HttpError && e.code === 'recheck' && emailSent && !confirmed) return setErr('Not confirmed yet. Open the link in the email, or type its code above.')
      // The check expired (it counts for 10 minutes): back to the passkey / email step, never a dead "Continue to …".
      if (e instanceof HttpError && e.code === 'recheck') {
        forgetRechecked()
        setEmailSent('')
        setConfirmed(false)
        // Not known yet (pressed before preferences came back): ask now, so someone with a passkey never sees "Add passkey".
        hasPasskey.current ??= await app.api.preferences().then((p) => p.signIn.passkeys.length > 0, () => false)
        if (hasPasskey.current) setRetry(true)
        setNeedPasskey(true)
        return setErr('That check expired. Confirm it’s you again.')
      }
      if (e instanceof HttpError && e.code === 'demo') return setDemoOnly(true)
      // Plaid can't reach that bank for us yet, or the bank is down: a plain line above "Choose your bank", not a failure.
      if (e instanceof PlaidExitError && e.kind !== 'other') return setNote(e.message)
      if (e instanceof HttpError && e.code === 'plaid_limit') return setLimit({ message: e.message, ...(typeof e.data.moreUrl === 'string' ? { moreUrl: e.data.moreUrl } : {}) })
      if (e instanceof HttpError && e.code === 'duplicate') {
        setDuplicate(true)
        if (typeof e.data.connectionId === 'string') setDuplicateOf(e.data.connectionId)
      }
      setErr(e instanceof Error ? e.message : 'That didn’t work.')
    }
  }
  const submitToken = async (e: Event) => {
    e.preventDefault()
    if (!start || start.kind !== 'api_key') return
    let body: Record<string, string>
    if (start.fields?.length) {
      const filled = Object.fromEntries(start.fields.map((f) => [f.name, (values[f.name] ?? f.options?.[0] ?? '').trim()]))
      const missing = start.fields.find((f) => !f.optional && !filled[f.name])
      if (missing) return setErr(`${missing.label} is needed.`)
      body = Object.fromEntries(Object.entries(filled).filter(([, v]) => v !== ''))
    } else {
      if (!token.trim()) return setErr('Paste the token first.')
      body = { apiKey: token.trim() }
    }
    if (finishing) return
    setErr('')
    setFinishing(true)
    try {
      const r = await app.api.finishConnect(c.key, { state: start.state, ...body })
      await arrived(r.accounts)
    } catch (x) {
      setFinishing(false)
      if (x instanceof HttpError && x.code === 'duplicate') {
        setDuplicate(true)
        if (typeof x.data.connectionId === 'string') setDuplicateOf(x.data.connectionId)
      }
      setErr(x instanceof Error ? x.message : 'That token didn’t work.')
    }
  }

  if (accounts) return html`<${AssignAccounts} name=${c.key === 'plaid' ? 'Your bank' : c.name} accounts=${accounts} onClose=${onClose} onBack=${onBack} onDone=${onDone} />`

  return html`<${Drawer} title=${c.key === 'plaid' ? 'Connect your bank or card' : `Connect ${c.name}`} sub=${c.key === 'plaid' ? 'You sign in with your bank, not with us.' : 'Aggregate only reads. It can’t move money.'} onClose=${onClose} onBack=${onBack}>
    ${c.beta ? html`<p class="meta" style="margin-top:12px"><span class="pill">Beta</span> Built to ${c.name}’s documentation; not yet tried with a real account. If a number looks off, tell us at <a class="link" href=${`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${c.name} (beta)`)}`}>${SUPPORT_EMAIL}</a>.</p>` : null}
    <p style="margin-top:16px">Aggregate will read ${c.provides.join(', ')}. It ${c.freshness === 'live' ? 'stays live' : /^(updates|syncs|stays)\b/.test(c.freshness) ? c.freshness : `updates ${c.freshness}`}.</p>
    <p class="sub" style="margin-top:8px">${AI_DISCLOSURE.connectText}</p>
    ${note ? html`<p class="sub" role="status" style="margin-top:16px">${note}</p>` : null}
    ${duplicate
      ? null
      : finishing
      ? html`<p class="sub" role="status" aria-busy="true" style="margin-top:16px">Connecting ${c.key === 'plaid' ? 'your bank' : c.name}… Bringing in your accounts, a few seconds.</p>`
      : start?.kind === 'api_key'
      ? html`<form onSubmit=${submitToken}>
          ${start.steps?.length
            ? html`<ol class="steps">${start.steps.map((t, i) => html`<li>${t}${i === 0 && start.helpUrl ? html` <a class="link" href=${start.helpUrl} target="_blank" rel="noopener noreferrer">Open ${c.name} ↗</a>` : null}</li>`)}</ol>`
            : html`<ol class="steps"><li>Open ${c.name} and make read-only credentials.${start.helpUrl ? html` <a class="link" href=${start.helpUrl} target="_blank" rel="noopener noreferrer">Open ${c.name} ↗</a>` : null}</li><li>Paste ${start.fields?.length ? 'them' : 'it'} here.</li></ol>`}
          ${start.permissions?.length
            ? html`<p class="sub" style="margin-top:12px">${NOT_READ_ONLY.has(c.key) ? 'What this key can do:' : 'Only these, all read-only:'}</p><ul class="perms">${start.permissions.map((p) => html`<li>${p}</li>`)}</ul>`
            : null}
          ${start.fields?.length
            ? start.fields.map((f) => {
                const set = (e: Event) => setValues({ ...values, [f.name]: (e.target as HTMLInputElement).value })
                const label = f.label + (f.optional ? ' (optional)' : '')
                if (f.options) return html`<label class="field"><span>${label}</span><select class="input" value=${values[f.name] ?? f.options[0]} onChange=${set}>${f.options.map((o) => html`<option value=${o}>${o}</option>`)}</select></label>`
                if (f.multiline) return html`<label class="field"><span>${label}</span><textarea class="input mono" rows="6" value=${values[f.name] ?? ''} onInput=${set} placeholder=${f.placeholder} autocomplete="off" spellcheck=${false}></textarea></label>`
                return html`<label class="field"><span>${label}</span><input class="input mono" type=${f.secret ? 'password' : 'text'} value=${values[f.name] ?? ''} onInput=${set} placeholder=${f.placeholder} autocomplete="off" spellcheck=${false} /></label>`
              })
            : html`<label class="field"><span>${start.label}</span><input class="input mono" type="password" value=${token} onInput=${(e: Event) => setToken((e.target as HTMLInputElement).value)} placeholder=${start.placeholder} autocomplete="off" spellcheck=${false} /></label>`}
          <div class="formrow"><${Button} type="submit">Connect</${Button}></div>
        </form>`
      : demoOnly
          ? html`<p class="sub" style="margin-top:16px">This is the demo, so real accounts can’t connect here. Leave it to add your own companies, then connect ${c.key === 'plaid' ? 'your bank' : c.name}.</p>
              <div class="formrow"><${Button} onClick=${() => leaveDemo(app)}>Leave the demo and connect for real</${Button}></div>`
      : needPasskey
        ? emailSent
          ? confirmed
            ? html`<p class="sub" role="status" style="margin-top:16px">Confirmed. It’s you.</p>
                ${companyPicker}
                <div class="formrow"><${Button} onClick=${begin} disabled=${opening}>${opening ? 'Opening…' : go}</${Button}></div>`
            : html`<p class="sub" role="status" style="margin-top:16px">Check your email at ${emailSent} for the code. Opening the link on this device brings you straight back.</p>
              <${EmailCode} kind="recheck" onDone=${() => setConfirmed(true)} onResend=${emailInstead} />
              ${companyPicker}
              <div class="formrow"><${Button} disabled>${go}</${Button}></div>
              <p class="meta" style="margin-top:8px"><${LinkButton} onClick=${begin}>${opening ? 'Checking…' : 'I opened the link on another device'}</${LinkButton}></p>`
          : retry
            ? html`<p class="meta" style="margin-top:16px">Connecting accounts needs a quick check that it’s you, with your passkey or by email.</p>
              ${companyPicker}
              <div class="formrow"><${Button} onClick=${begin} disabled=${opening}>${opening ? 'Checking…' : 'Try again'}</${Button}>${isReviewer(app) ? null : html`<${LinkButton} onClick=${emailInstead}>Use email instead</${LinkButton}>`}</div>`
          : html`<p class="meta" style="margin-top:16px">Connecting accounts needs a quick check that it’s you. A passkey makes it one tap with Face ID, a fingerprint or your device PIN.</p>
            <div class="formrow"><${Button} onClick=${addPasskey} disabled=${!ceremony}>Add passkey</${Button}>${isReviewer(app) ? null : html`<${LinkButton} onClick=${emailInstead}>Use email instead</${LinkButton}>`}</div>`
        : limit
          ? html`<p class="sub" role="status" style="margin-top:16px">${limit.message}${limit.moreUrl ? html` <a class="link" href=${limit.moreUrl} target="_blank" rel="noopener noreferrer">More</a>` : null}</p>`
          : html`${spaces.length > 1 ? html`<p class="sub" style="margin-top:16px">Into ${spaces.find((w) => w.id === app.me?.workspaceId)?.name ?? 'this workspace'}</p>` : null}
              ${!askCompany && preset && companies.length > 1 && c.key !== 'plaid'
                ? html`<p class="sub" style="margin-top:16px">For ${companies.find((x) => x.id === preset)?.name ?? 'this company'}</p>`
                : null}
              ${companyPicker}
              ${SIGN_IN_NOTE[c.key] ? html`<p class="sub" style="margin-top:16px">${SIGN_IN_NOTE[c.key]}</p>` : null}
              <div class="formrow"><${Button} onClick=${begin} disabled=${opening}>${opening ? 'Opening…' : c.key === 'plaid' ? 'Choose your bank' : c.key === 'shopify' ? 'Continue to Shopify' : go}</${Button}></div>`}
    ${c.key === 'plaid' && !limit && !demoOnly && !duplicate
      ? html`<p class="meta" style="margin-top:16px">By connecting, you agree to Aggregate’s <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> and Plaid’s <a href="https://plaid.com/legal/#end-user-privacy-policy" target="_blank" rel="noopener noreferrer">End User Privacy Policy</a>.</p>`
      : null}
    ${c.key === 'mercury'
      ? html`<p class="meta" style="margin-top:16px">${MERCURY_DISCLOSURE} <a class="link" href="https://mercury.com" target="_blank" rel="noopener noreferrer">mercury.com ↗</a></p>`
      : null}
    ${err ? html`<p class="err" role="alert">${err}</p>${duplicate ? null : html`<p class="meta" style="margin-top:8px">Still stuck? Email <a class="link" href=${'mailto:' + SUPPORT_EMAIL}>${SUPPORT_EMAIL}</a>.</p>`}` : null}
    ${duplicateOf ? html`<div class="links"><${LinkButton} onClick=${() => app.push({ kind: 'connection', id: duplicateOf })}>Open it</${LinkButton}></div>` : null}
  </${Drawer}>`
}

/** MASTER §4.4: each new account asks once, which company or Personal? Unchecked = never synced, never shown to AI. */
export function AssignAccounts({ name, accounts, onClose, onBack, onDone }: { name: string; accounts: NewAccount[]; onClose: () => void; onBack: (() => void) | null; onDone?: () => void }) {
  const app = useApp()
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(accounts.map((a) => [a.id, a.suggestedEntityId === 'personal' ? 'personal' : (a.suggestedEntityId ?? companies[0]?.id ?? 'personal')])),
  )
  // Saving can take a few seconds (each account's books are refreshed): say so, and say why if it fails. A silent
  // failure here looked like a dead "Done" button (the challenge app, 2026-10-13).
  const [saving, setSaving] = useState(false)
  const [saveErr, setSaveErr] = useState('')
  const save = async () => {
    if (saving) return
    setSaving(true)
    setSaveErr('')
    try {
      await app.api.assignAccounts(accounts.map((a) => ({ accountId: a.id, entityId: map[a.id] ?? 'skip' })))
    } catch (e) {
      setSaving(false)
      return setSaveErr(e instanceof Error && e.message ? e.message : 'That didn’t save. Try again.')
    }
    await app.reload().catch(() => undefined)
    app.toast({ text: `${name} connected. Pulling 24 months of history; about a minute.` })
    onDone ? onDone() : onClose()
  }
  return html`<${Drawer} title=${companies.length ? 'Which company is each account?' : 'Which accounts should sync?'} sub="Asked once. Skipped accounts are never synced or shown to any AI." onClose=${onClose} onBack=${onBack}>
    <${Rows} label="New accounts">
      ${accounts.map(
        (a) => html`<${Row}
          name=${`${a.name}${a.mask ? ' ··' + a.mask : ''}`}
          line=${a.balance ? fmt(a.balance) : 'balance not reported yet'}
          right=${html`<label class="sr" for=${'as-' + a.id}>Company for ${a.name}</label>
            <select id=${'as-' + a.id} class="input" style="height:32px;width:auto" value=${map[a.id]} onChange=${(e: Event) => setMap({ ...map, [a.id]: (e.target as HTMLSelectElement).value })}>
              ${companies.map((co) => html`<option value=${co.id}>${co.name}</option>`)}
              <option value="personal">Personal</option>
              <option value="skip">Don’t sync</option>
            </select>`}
        />`,
      )}
    </${Rows}>
    ${saveErr ? html`<p class="err" role="alert">${saveErr}</p>` : null}
    <div class="formrow"><${Button} onClick=${save} disabled=${saving}>${saving ? 'Saving…' : 'Done'}</${Button}></div>
    <${PlusAction} onClick=${() => app.push({ kind: 'connect', key: 'plaid' })}>Connect another bank</${PlusAction}>
  </${Drawer}>`
}

/** Accounts that arrived without a company: nothing from them shows or syncs until each has one. */
/** Xero won't let you tick an organisation you shared before: offer those here, one Add each, never on its own. */
function SharedOrgs({ id }: { id: string }) {
  const app = useApp()
  const { data: offers, reload } = useLoad(() => app.api.sharedOffers(id).catch(() => []), [id])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  if (!offers?.length) return null
  const add = async (o: { id: string; name: string }) => {
    setErr('')
    setBusy(o.id)
    try {
      await app.api.addShared(id, o.id)
      app.toast({ text: `${o.name} is added. Bringing in its data.` })
      await app.reload()
    } catch (x) {
      setErr(x instanceof HttpError && x.status === 409 ? `${o.name} is no longer shared with Aggregate.` : x instanceof Error ? x.message : 'That didn’t work. Nothing was added.')
    } finally {
      setBusy(null)
      reload()
    }
  }
  return html`<${Section} compact title="Also shared with Aggregate" sub="Xero organisations you shared before. Add any you want here.">
    <${Rows} label="Shared Xero organisations">
      ${offers.map((o) => html`<${Row} name=${o.name} right=${html`<${Button} quiet onClick=${() => add(o)} disabled=${busy !== null} label=${`Add ${o.name}`}>${busy === o.id ? 'Adding…' : 'Add'}</${Button}>`} />`)}
    </${Rows}>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </${Section}>`
}

function ChooseCompanies({ accounts, onSaved }: { accounts: Array<{ id: string; name: string; mask?: string }>; onSaved: () => void }) {
  const app = useApp()
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries(accounts.map((a) => [a.id, companies[0]?.id ?? 'personal'])))
  const [err, setErr] = useState('')
  const save = async () => {
    setErr('')
    try {
      await app.api.assignAccounts(accounts.map((a) => ({ accountId: a.id, entityId: (map[a.id] ?? 'skip') as string })))
      app.toast({ text: accounts.length === 1 ? 'Saved. Its transactions are coming in.' : 'Saved. Their transactions are coming in.' })
      onSaved()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Nothing was changed.')
    }
  }
  return html`<${Section} compact title="Which company is each account?" sub="Its transactions wait until you choose. Skipped accounts are never synced or shown to any AI.">
    <${Rows} label="Accounts without a company">
      ${accounts.map(
        (a) => html`<${Row}
          name=${`${a.name}${a.mask ? ' ··' + a.mask : ''}`}
          right=${html`<label class="sr" for=${'cc-' + a.id}>Company for ${a.name}</label>
            <select id=${'cc-' + a.id} class="input" style="height:32px;width:auto" value=${map[a.id]} onChange=${(e: Event) => setMap({ ...map, [a.id]: (e.target as HTMLSelectElement).value })}>
              ${companies.map((co) => html`<option value=${co.id}>${co.name}</option>`)}
              <option value="personal">Personal</option>
              <option value="skip">Don’t sync</option>
            </select>`}
        />`,
      )}
    </${Rows}>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
    <div class="formrow"><${Button} onClick=${save}>Save</${Button}></div>
  </${Section}>`
}

/** One company for the whole connection. Asked when it has none (e.g. a second Xero organisation from one sign-in);
 *  otherwise a quiet "Move to another company" for single-company sources. Banks place each account instead. */
function ConnectionCompany({ c, onMoved }: { c: ConnectionSummary; onMoved: () => void }) {
  const app = useApp()
  // Personal too: a Carta portfolio or a brokerage can be a person's own (only theirs is listed to them).
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company' || e.kind === 'personal')
  const none = c.entityNames.length === 0
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState('')
  const [err, setErr] = useState('')
  if (c.connectorKey === 'plaid' || !companies.length || (!none && c.entityNames.length > 1)) return null
  const save = async () => {
    if (!choice) return
    setErr('')
    try {
      const r = await app.api.setConnectionCompany(c.id, choice)
      const name = companies.find((x) => x.id === choice)?.name ?? 'that company'
      app.toast({ text: `${c.name} now belongs to ${name}${r.moved ? ` (${r.moved} ${r.moved === 1 ? 'account' : 'accounts'})` : ''}.` })
      setOpen(false)
      onMoved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That didn’t save.')
    }
  }
  if (!none && !open) return html`<div class="links" style="margin-top:12px"><${LinkButton} onClick=${() => setOpen(true)}>Move to another company</${LinkButton}></div>`
  const id = 'conn-company-' + c.id
  return html`<div style="margin-top:16px">
    ${none ? html`<p class="sub amber">Which company is this for? Nothing from it counts until you choose.</p>` : null}
    <div class="formrow" style="margin-top:8px;align-items:center">
      <label class="sr" for=${id}>Company for ${c.name}</label>
      <select id=${id} class="input" style="height:32px;width:auto" value=${choice} onChange=${(e: Event) => setChoice((e.target as HTMLSelectElement).value)}>
        <option value="" disabled>Choose a company…</option>
        ${companies.filter((x) => !c.entityNames.includes(x.name)).map((x) => html`<option value=${x.id}>${x.name}</option>`)}
      </select>
      <${Button} disabled=${!choice} onClick=${save}>${none ? 'Save' : 'Move'}</${Button}>
      ${none ? null : html`<${LinkButton} onClick=${() => (setOpen(false), setErr(''))}>Cancel</${LinkButton}>`}
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </div>`
}

/** One bank account to another company or Personal (the same call as placing new accounts; nothing else moves). */
function MoveAccount({ account, onDone }: { account: { id: string; name: string; mask?: string; entityId?: string }; onDone: (moved: boolean) => void }) {
  const app = useApp()
  const options = (app.ws?.entities ?? []).filter((e) => (e.kind === 'company' || e.kind === 'personal') && e.id !== account.entityId)
  const [choice, setChoice] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const box = useRef<HTMLSelectElement>(null)
  useEffect(() => box.current?.focus(), [account.id])
  const label = `${account.name}${account.mask ? ' ··' + account.mask : ''}`
  const save = async () => {
    if (!choice || saving) return
    setErr('')
    setSaving(true)
    const to = options.find((x) => x.id === choice)
    try {
      await app.api.assignAccounts([{ accountId: account.id, entityId: to?.kind === 'personal' ? 'personal' : choice }])
      app.toast({ text: `${label} now belongs to ${to?.name ?? 'that company'}.` })
      onDone(true)
    } catch (e) {
      setSaving(false)
      setErr(e instanceof Error && e.message ? e.message : 'That didn’t save. Nothing was moved.')
    }
  }
  const id = 'move-' + account.id
  return html`<div style="margin-top:12px">
    <div class="formrow" style="margin-top:8px;align-items:center">
      <label class="sr" for=${id}>Company for ${label}</label>
      <select id=${id} ref=${box} class="input" style="height:32px;width:auto" value=${choice} onChange=${(e: Event) => setChoice((e.target as HTMLSelectElement).value)}>
        <option value="" disabled>Move ${label} to…</option>
        ${options.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
      </select>
      <${Button} disabled=${!choice || saving} onClick=${save}>${saving ? 'Moving…' : 'Move'}</${Button}>
      <${LinkButton} onClick=${() => onDone(false)}>Cancel</${LinkButton}>
    </div>
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </div>`
}

/**
 * An account's time is when its balance was last reported, not when the connection last synced (Stripe can sync now
 * and report a balance from earlier). Say it only when it differs, and call it what it is.
 */
function balanceAsOf(asOf: string, lastSyncAt: string | null, now: number): string | null {
  if (lastSyncAt && Math.abs(Date.parse(asOf) - Date.parse(lastSyncAt)) < 120_000) return null
  return `balance as of ${ago(asOf, now)}`
}
