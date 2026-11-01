// Preferences: sign-in, companies, AI review mode, notifications, appearance, people & roles, export, recovery code.
import { EmailCode } from '../ui/email-code.ts'
import { canShare, SharedLinks } from './share.ts'
import type { DataType } from '@agfn/contracts'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { PersonRow, Preferences, RolePreset } from '../api/types.ts'
import { gridFor } from '../lib/roles.ts'
import { useApp, useLoad, isManager, isReviewer } from '../app/context.ts'
import { DATA_TYPES } from '../lib/grant.ts'
import { returnHere } from '../lib/recheck.ts'
import { shortDate } from '../lib/time.ts'
import { Button, Field, LinkButton, PlusAction, Row, Rows, Section, Segmented, Toggle } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'
import { applyTheme } from '../app/theme.ts'
import { HttpError, OFFLINE } from '../api/http.ts'
import { cleanEmail } from '../lib/email.ts'
import { PLAN, PLAN_DETAIL } from '../lib/support.ts'

/** A friendly default name for a new passkey, e.g. "Mac" or "iPhone". */
function deviceName(): string {
  const ua = navigator.userAgent
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows PC' : 'This device'
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const ROLES: Array<{ key: RolePreset; name: string; line: string }> = [
  { key: 'owner', name: 'Owner', line: 'Everything' },
  { key: 'admin', name: 'Admin', line: 'Everything except deleting companies or the owner' },
  { key: 'finance', name: 'Finance', line: 'See and add everything; equity view only' },
  { key: 'accountant', name: 'Accountant', line: 'See the books; add documents; no payroll or equity' },
  { key: 'investor', name: 'Investor or board', line: 'Balances, reports and equity, summary only' },
  { key: 'employee', name: 'Employee', line: 'Add their own receipts' },
]
const roleName = (r: RolePreset) => ROLES.find((x) => x.key === r)?.name ?? r

export function PreferencesPage() {
  const app = useApp()
  // Again after any change the app reloads for (a person removed or invited, a company renamed).
  const { data: p, error, reload } = useLoad(() => app.api.preferences(), [app.ws])
  if (!p && error)
    return html`<div class="column"><p class="sub" role="alert">${error === OFFLINE ? 'Can’t reach Aggregate. Check your connection.' : error} <button type="button" class="link" onClick=${reload}>Try again</button></p></div>`
  if (!p) return html`<div class="column" aria-busy="true"></div>`
  const isOwner = p.people.find((x) => x.id === app.me?.personId)?.role === 'owner'
  const limited = isReviewer(app)
  const save = async (patch: Partial<Preferences>) => {
    await app.api.updatePreferences(patch)
    if (patch.theme) applyTheme(patch.theme)
    reload()
    app.reload()
  }
  const entities = app.ws?.entities ?? []
  const where = (ids: PersonRow['entityIds']) => (ids === 'all' ? 'all companies' : ids.map((id) => entities.find((e) => e.id === id)?.name).filter(Boolean).join(', '))

  // Free time, one quiet line: the server's free-grant line covers the creator perk too, so never both.
  const freeLine = app.me?.freeGrant?.label ?? app.me?.perk?.label
  return html`<div class="column">
    <${Section} title="Sign-in" sub="How you get into Aggregate">
      <${Rows}>
        ${p.signIn.passkeys.map(
          (k) => html`<${Row} name=${k.name} line=${`Passkey · added ${shortDate(k.addedAt, true)}`} right=${!limited && (p.signIn.passkeys.length > 1 || p.signIn.email) ? html`<${LinkButton} onClick=${async () => (await app.api.removePasskey(k.id), reload(), app.toast({ text: `Removed ${k.name}.` }))}>Remove</${LinkButton}>` : null} />`,
        )}
        <${Row} name="Email link" line=${p.signIn.email} />
        ${p.signIn.apple || app.me?.signInMethods?.includes('apple') ? html`<${Row} name="Sign in with Apple" right=${html`<span class="grey">${p.signIn.apple ? 'on' : 'off'}</span>`} />` : null}
        ${p.signIn.google || app.me?.signInMethods?.includes('google') ? html`<${Row} name="Sign in with Google" right=${html`<span class="grey">${p.signIn.google ? 'on' : 'off'}</span>`} />` : null}
      </${Rows}>
      ${limited ? null : html`<${PlusAction} onClick=${async () => {
        const ok = await app.api.addPasskey(deviceName()).catch(() => false)
        if (ok) reload()
        app.toast({ text: ok ? 'Passkey added. Next time, sign in with Face ID or Touch ID.' : 'No passkey was added.' })
      }}>Add a passkey</${PlusAction}>`}
    </${Section}>

    <${Section} title="Plan" sub=${PLAN}>
      <p class="meta">${PLAN_DETAIL}</p>
      ${freeLine ? html`<p class="meta" style="margin-top:8px">${freeLine}</p>` : null}
    </${Section}>

    <${Section} title="Companies" sub="Name, currency and when the year starts">
      <${Rows}>
        ${p.companies.map(
          (c) => html`<${Row} name=${c.name} line=${`${c.currency} · year starts in ${MONTHS[c.fiscalYearStartMonth - 1]}`} onClick=${() => app.open({ kind: 'company', id: c.id })} />`,
        )}
      </${Rows}>
      ${limited || !isManager(app) ? null : html`<${PlusAction} onClick=${() => app.open({ kind: 'company-new' })}>Add a company</${PlusAction}>`}
      ${p.timeZone
        ? html`<div class="formrow" style="margin-top:16px;align-items:center"><label class="sub" for="tz">Time zone</label>
            <select id="tz" class="input" style="height:32px;width:auto" value=${p.timeZone} onChange=${(e: Event) => save({ timeZone: (e.target as HTMLSelectElement).value })}>
              ${timeZones(p.timeZone).map((z) => html`<option value=${z}>${z.replace(/_/g, ' ')}</option>`)}
            </select></div>`
        : null}
    </${Section}>

    <${Section} title="AI changes" sub="What happens when an AI adds something">
      <${Toggle} label="AI changes wait for my review" line="Off: changes apply right away, labeled and undoable for 30 days. Each AI can also be set on its own." checked=${p.aiReviewMode} onChange=${(v: boolean) => save({ aiReviewMode: v })} />
      ${limited ? null : html`<div class="links" style="margin-top:0"><${LinkButton} onClick=${async () => (await app.api.pauseAll(!app.ws?.aiPaused), app.reload())}>${app.ws?.aiPaused ? 'Resume all AI' : 'Pause all AI'}</${LinkButton}></div>`}
    </${Section}>

    <${Section} title="Notifications" sub="Quiet by default">
      <${Toggle} label="Monday email" line="Cash, runway, what’s overdue and what changed" checked=${p.notifications.mondayEmail} onChange=${(v: boolean) => save({ notifications: { ...p.notifications, mondayEmail: v } })} />
      <${Toggle} label="When an AI asks for something it can’t see" checked=${p.notifications.blockedAsk} onChange=${(v: boolean) => save({ notifications: { ...p.notifications, blockedAsk: v } })} />
    </${Section}>

    <${Section} title="Appearance">
      <div style="margin-top:12px"><${Segmented} label="Theme" value=${p.theme} onChange=${(v: Preferences['theme']) => save({ theme: v })} options=${[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'Match device' }]} /></div>
    </${Section}>

    <${Section} title="People" sub="Their AIs never see more than they do">
      <${Rows}>
        ${p.people.map((x) => html`<${Row} name=${x.name} line=${`${roleName(x.role)} · ${where(x.entityIds)}${x.pending ? ' · invited' : ''}`} onClick=${limited || !isManager(app) || x.id === app.me?.personId || (x.role === 'owner' && !isOwner) ? undefined : () => app.open({ kind: 'person', id: x.id })} />`)}
      </${Rows}>
      ${limited || !isManager(app) ? null : html`<${PlusAction} onClick=${() => app.open({ kind: 'invite' })}>Invite someone</${PlusAction}>`}
      ${p.canLeave && !limited && !app.ws?.me.demo ? html`<${LeaveWorkspace} />` : null}
    </${Section}>

    ${canShare(app) ? html`<${SharedLinks} />` : null}

    <${Section} title="Your data" sub="It’s yours. Take all of it, any time.">
      <div class="links"><${LinkButton} onClick=${async () => { const r = await app.api.exportAll(); location.assign(r.url) }}>Export everything</${LinkButton}><${LinkButton} onClick=${async () => { const r = await app.api.exportAll('beancount'); location.assign(r.url) }}>Beancount</${LinkButton}><${LinkButton} onClick=${async () => { const r = await app.api.exportAll('hledger'); location.assign(r.url) }}>hledger</${LinkButton}><a class="link" href="/security">Security</a><a class="link" href="/privacy">Privacy</a><a class="link" href="/terms">Terms</a>${isOwner && !app.ws?.me.demo ? html`<${LinkButton} danger onClick=${() => app.open({ kind: 'delete-workspace' })}>Delete workspace</${LinkButton}>` : null}${!isReviewer(app) ? html`<${LinkButton} danger onClick=${() => app.open({ kind: 'delete-me' })}>Delete my account</${LinkButton}>` : null}</div>
    </${Section}>

    ${p.recovery.applicable
      ? html`<${Section} title="Recovery code" sub="Your server encrypts bank tokens. Without this code, a lost key means reconnecting everything.">
          <p class="sub" style="margin-top:12px">${p.recovery.savedAt ? `Saved ${shortDate(p.recovery.savedAt, true)}.` : 'Not saved yet.'}</p>
          <${PlusAction} onClick=${() => app.toast({ text: 'Your recovery code downloads once. Keep it offline.' })}>Download recovery code</${PlusAction}>
        </${Section}>`
      : null}
  </div>`
}

export function InviteView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const companies = (app.ws?.entities ?? []).filter((e) => e.kind === 'company')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<RolePreset>('accountant')
  const [ids, setIds] = useState<string[]>(companies.map((c) => c.id))
  const [err, setErr] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    const to = cleanEmail(email)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return setErr('That doesn’t look like an email address.')
    if (!ids.length) return setErr('Pick at least one company.')
    await app.api.invite(to, role, ids.length === companies.length ? 'all' : ids)
    app.toast({ text: `Invite sent to ${to}.` })
    onClose()
  }
  return html`<${Drawer} title="Invite someone" sub="They sign in with their own passkey or email." onClose=${onClose} onBack=${onBack}>
    <form onSubmit=${submit} novalidate>
      <${Field} label="Email"><input class="input" type="email" value=${email} onInput=${(e: Event) => setEmail((e.target as HTMLInputElement).value)} placeholder="name@company.com" /></${Field}>
      <fieldset class="field" style="border:0;padding:0;margin-top:24px"><legend class="sub" style="margin-bottom:6px">Role</legend>
        <${Rows}>
          ${ROLES.filter((r) => r.key !== 'owner').map(
            (r) => html`<li><label class="row" style="cursor:pointer"><input type="radio" name="role" checked=${role === r.key} onChange=${() => setRole(r.key)} /><span><span class="name">${r.name}</span><span class="line">${r.line}</span></span><span></span></label></li>`,
          )}
        </${Rows}>
      </fieldset>
      <fieldset class="field" style="border:0;padding:0;margin-top:24px"><legend class="sub" style="margin-bottom:6px">Companies</legend>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${companies.map((c) => html`<label style="display:inline-flex;gap:6px;align-items:center"><input type="checkbox" checked=${ids.includes(c.id)} onChange=${() => setIds(ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id])} />${c.name}</label>`)}
        </div>
      </fieldset>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit">Send invite</${Button}></div>
      <p class="meta" style="margin-top:16px">Personal stays private. Nobody else can see it unless you share it.</p>
    </form>
  </${Drawer}>`
}

/**
 * A danger link that asks first, inline: the question with its action and Cancel. While it asks, focus is on Cancel;
 * after Cancel, back on the link (the link itself is gone meanwhile, so focus would otherwise fall to the page).
 */
function AskFirst({ label, question, action, run }: { label: string; question: string; action: string; run: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const box = useRef<HTMLDivElement>(null)
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
      await run()
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : 'That didn’t work. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return html`<div ref=${box}>
    ${asking
      ? html`<span class="sub" role="alert">${question} <${LinkButton} danger onClick=${go}>${busy ? 'One moment…' : action}</${LinkButton}> · <${LinkButton} onClick=${() => (setAsking(false), setErr(''))}>Cancel</${LinkButton}></span>`
      : html`<${LinkButton} danger onClick=${() => setAsking(true)}>${label}</${LinkButton}>`}
    ${err ? html`<p class="err" role="alert">${err}</p>` : null}
  </div>`
}

/** Anyone but the workspace's only owner. Afterwards: the next workspace they're in, or setup when none is left. */
function LeaveWorkspace() {
  const app = useApp()
  const name = app.me?.workspaces?.find((w) => w.id === app.me?.workspaceId)?.name ?? 'this workspace'
  return html`<div class="links" style="margin-top:16px"><${AskFirst}
    label="Leave workspace"
    question=${`Leave ${name}? You lose access to its companies, and your AI access and Personal connections in it are removed.`}
    action="Leave"
    run=${async () => {
      await app.api.leaveWorkspace()
      app.toast({ text: `You left ${name}.` })
      await app.reload()
      app.go({ page: 'workspace', step: 0, stack: [] })
    }}
  /></div>`
}

/** A person's role preset, with the full grid one tap down. */
export function PersonView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const { data: p, error, reload } = useLoad(() => app.api.preferences(), [id])
  const [grid, setGrid] = useState(false)
  const person = p?.people.find((x) => x.id === id)
  if (error) return html`<${LoadFailed} title="Couldn’t open this person" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (p && !person) return html`<${Drawer} title="This person isn’t here anymore" sub="They may have been removed from the workspace." onClose=${onClose} onBack=${onBack} />`
  if (!person) return html`<${Drawer} title="Loading…" onClose=${onClose} onBack=${onBack} />`
  const iAmOwner = p?.people.find((x) => x.id === app.me?.personId)?.role === 'owner'
  const update = async (patch: Partial<Pick<PersonRow, 'role' | 'grid'>>) => {
    try {
      await app.api.updatePerson(id, patch)
    } catch (e) {
      // The server's sentence (the last owner can't be changed, a re-check): the row stays as it was.
      app.toast({ text: e instanceof Error && e.message ? e.message : 'That didn’t save. Try again.' })
      return reload()
    }
    reload()
    // Owner changes who can do what everywhere (and the server's last-owner rule): the whole app reloads.
    if (patch.role === 'owner' || person?.role === 'owner') await app.reload()
  }
  const gone = async (text: string) => {
    app.toast({ text })
    onClose()
    await app.reload()
  }
  const cycle = (k: DataType) => {
    const order = ['none', 'view', 'add'] as const
    const next = order[(order.indexOf(person.grid[k]) + 1) % order.length]!
    update({ grid: { ...person.grid, [k]: next } })
  }
  return html`<${Drawer} title=${person.name} sub=${person.email + (person.pending ? ' · invited' : '')} onClose=${onClose} onBack=${onBack}>
    <${Section} compact title="Role" sub="A preset; change any square below">
      <${Rows}>
        ${ROLES.filter((r) => r.key !== 'owner' || iAmOwner || person.role === 'owner').map(
          (r) => html`<li><label class="row" style="cursor:pointer"><input type="radio" name="prole" checked=${person.role === r.key} onChange=${() => update({ role: r.key, grid: gridFor(r.key) })} /><span><span class="name">${r.name}</span><span class="line">${r.line}</span></span><span></span></label></li>`,
        )}
      </${Rows}>
      <${PlusAction} onClick=${() => setGrid(!grid)}>${grid ? 'Hide the full grid' : 'Show the full grid'}</${PlusAction}>
      ${grid
        ? html`<${Rows} label="Access by data type">${DATA_TYPES.map((d) => html`<${Row} name=${d.label[0]!.toUpperCase() + d.label.slice(1)} right=${html`<button type="button" class="btn quiet" onClick=${() => cycle(d.key)} aria-label=${`${d.label}: ${person.grid[d.key]}. Change`}>${{ none: 'No access', view: 'Can see', add: 'Can add' }[person.grid[d.key]]}</button>`} />`)}</${Rows}>`
        : null}
    </${Section}>
    ${person.pending
      ? html`<div class="links" style="margin-top:32px">
          <${LinkButton} onClick=${async () => {
            try {
              const r = await app.api.resendInvite(id)
              app.toast({ text: `A new invite is on its way to ${r.sentTo}.` })
            } catch (e) {
              app.toast({ text: e instanceof Error && e.message ? e.message : 'That didn’t send. Try again.' })
            }
          }}>Resend invite</${LinkButton}>
          <${AskFirst} label="Cancel invite" question=${`Cancel the invite to ${person.email}? The link in it stops working.`} action="Cancel invite" run=${async () => (await app.api.removePerson(id), await gone(`The invite to ${person.email} is cancelled.`))} />
        </div>`
      : html`<div class="links" style="margin-top:32px"><${AskFirst}
          label="Remove from workspace"
          question=${`Remove ${person.name}? They lose access to this workspace, and their AI access and Personal connections in it are removed.`}
          action="Remove"
          run=${async () => (await app.api.removePerson(id), await gone(`${person.name} is removed.`))}
        /></div>`}
  </${Drawer}>`
}

export function NewCompanyView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [err, setErr] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!name.trim()) return setErr('What’s it called?')
    const c = await app.api.createCompany(name.trim(), currency)
    await app.reload()
    app.open({ kind: 'company', id: c.id })
  }
  return html`<${Drawer} title="Add a company" sub="Each company has its own accounts, books and AI access." onClose=${onClose} onBack=${onBack}>
    <form onSubmit=${submit} novalidate>
      <${Field} label="Name"><input class="input" value=${name} onInput=${(e: Event) => setName((e.target as HTMLInputElement).value)} placeholder="Acme Inc" autofocus /></${Field}>
      <${Field} label="Currency">
        <select class="input" value=${currency} onChange=${(e: Event) => setCurrency((e.target as HTMLSelectElement).value)}>
          ${['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'ILS', 'JPY', 'CHF'].map((c) => html`<option value=${c}>${c}</option>`)}
        </select>
      </${Field}>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit">Add company</${Button}></div>
    </form>
  </${Drawer}>`
}

/** "It also disconnects the Personal accounts of Ana Ortiz (1 connection) and Ben Ito (2 connections). We'll email them first." */
export function alsoLine(people: Array<{ name: string; email: string; personalConnections: number }>): string {
  const each = people.map((x) => `${x.name || x.email} (${x.personalConnections} ${x.personalConnections === 1 ? 'connection' : 'connections'})`)
  const list = each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each[0]!
  return `It also disconnects the Personal accounts of ${list}. We’ll email ${people.length === 1 ? 'them' : 'each of them'} first.`
}

/** Owner only. Type DELETE; the server asks for a passkey re-check first. Afterwards onboarding starts fresh. */
export function DeleteWorkspaceView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  // Say which one: with more than one workspace, "Delete workspace" alone is a guess.
  const name = app.me?.workspaces?.find((w) => w.id === app.me?.workspaceId)?.name
  // Other members' Personal connections go too: say whose, and how many (not which: Personal stays private).
  const { data: preview } = useLoad(() => app.api.deleteWorkspacePreview().catch(() => null), [])
  const also = preview?.affected.length ? alsoLine(preview.affected) : null
  return html`<${TypeToDelete}
    title=${name ? `Delete ${name}` : 'Delete workspace'}
    also=${also}
    sub=${`Every company, connection, document and AI link in ${name ?? 'it'} goes, for everyone in it. This can’t be undone.`}
    note="Export everything first if you want a copy."
    onClose=${onClose}
    onBack=${onBack}
    run=${(confirm: string) => app.api.deleteWorkspace(confirm)}
    after=${async () => {
      // Still in another workspace: open that one. Onboarding only when none is left (the app routes there itself).
      await app.reload()
      app.go({ page: 'workspace', step: 0, stack: [] })
      app.toast({ text: `${name ?? 'The workspace'} and everything in it is deleted. Your banks aren’t affected.` })
    }}
  />`
}

/** Anyone. The session ends with it, so afterwards it's the sign-in page. */
export function DeleteMeView({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  return html`<${TypeToDelete}
    title="Delete my account"
    sub="This deletes your sign-in and removes you from every workspace. Workspaces where you’re the only member, including the demo, are deleted with all their data. Workspaces you share stay with their other owners. AI access you set up is revoked and banks in your Personal space are disconnected."
    note="This can’t be undone. Export everything first if you want a copy."
    onClose=${onClose}
    onBack=${onBack}
    run=${(confirm: string) => app.api.deleteMe(confirm)}
    after=${async () => app.leave('Your account and its data are deleted.')}
  />`
}

/** Type DELETE, then the irreversible thing. The server asks for a passkey re-check first (the client retries). */
function TypeToDelete(p: { title: string; sub: string; note: string; also?: string | null; onClose: () => void; onBack: (() => void) | null; run: (confirm: string) => Promise<unknown>; after: () => Promise<void> }) {
  const app = useApp()
  // Back from the emailed check: DELETE was already typed, so it isn't asked twice.
  const [text, setText] = useState(() => (app.route.params.typed === '1' ? 'DELETE' : ''))
  const [err, setErr] = useState('')
  const [soleOwner, setSoleOwner] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The passkey check didn't happen (none, cancelled, or not on this device): confirm with an emailed link instead. */
  const [emailCheck, setEmailCheck] = useState<{ step: 'ask' } | { step: 'sent'; to: string } | null>(null)
  const sendLink = async () => {
    setErr('')
    try {
      const r = await app.api.recheckByEmail(returnHere(text.trim() === 'DELETE' ? { typed: '1' } : {}))
      setEmailCheck({ step: 'sent', to: r.sentTo })
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t send. Try again in a minute.')
    }
  }
  const submit = async (e: Event) => {
    e.preventDefault()
    if (text.trim() !== 'DELETE') return setErr('Type DELETE to confirm.')
    setBusy(true)
    setSoleOwner(false)
    try {
      await p.run(text.trim())
      p.onClose()
      await p.after()
    } catch (x) {
      if (x instanceof HttpError && x.code === 'recheck') {
        setEmailCheck({ step: 'ask' })
        return
      }
      setErr(x instanceof Error ? x.message : 'That didn’t work. Nothing was deleted.')
      setSoleOwner(x instanceof HttpError && x.code === 'sole_owner')
    } finally {
      setBusy(false)
    }
  }
  return html`<${Drawer} title=${p.title} sub=${p.sub} onClose=${p.onClose} onBack=${p.onBack}>
    ${p.also ? html`<p style="margin-top:16px">${p.also}</p>` : null}
    <p style="margin-top:16px">${p.note}</p>
    <form onSubmit=${submit} novalidate style="margin-top:16px">
      <label for="confirm-delete" class="sub">Type DELETE to confirm</label>
      <input id="confirm-delete" class="input" autocomplete="off" value=${text} onInput=${(e: Event) => setText((e.target as HTMLInputElement).value)} />
      ${emailCheck?.step === 'ask'
        ? html`<p class="sub" role="status" style="margin-top:12px">First, confirm it’s you. We’ll email you a link.</p><div class="formrow" style="margin-top:8px"><${Button} quiet onClick=${sendLink}>Email me a link</${Button}></div>`
        : emailCheck?.step === 'sent'
          ? html`<p class="sub" role="status" style="margin-top:12px">Check your email at ${emailCheck.to}. Open the link on any device, then press ${p.title} again.</p>
              <${EmailCode} kind="recheck" onDone=${() => (setEmailCheck(null), setErr(''), app.toast({ text: `Confirmed. Press ${p.title} to finish.` }))} onResend=${sendLink} />`
          : null}
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      ${soleOwner
        ? html`<div class="links"><${LinkButton} onClick=${() => p.onClose()}>People</${LinkButton}><${LinkButton} danger onClick=${() => app.open({ kind: 'delete-workspace' })}>Delete workspace</${LinkButton}></div>`
        : null}
      <div class="formrow" style="margin-top:12px"><${Button} danger type="submit" disabled=${busy}>${p.title}</${Button}></div>
    </form>
  </${Drawer}>`
}

/** Every IANA zone the browser knows (the current one first if it's unusual). */
function timeZones(current: string): string[] {
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    /* old browser */
  }
  return all.includes(current) ? all : [current, ...all]
}
