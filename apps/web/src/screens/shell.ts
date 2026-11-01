// The frame: plain-text left nav (Instinct), company switcher, and on phones a top bar with a menu.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { isFilling, isManager, isReviewer, useApp } from '../app/context.ts'
import { html } from '../ui/html.ts'
import { Icon } from '../ui/icons.ts'
import { emailSupport, openGuide } from '../lib/support.ts'
import { inDemo, isPublicDemo, leaveDemo, signUpFromDemo } from '../lib/demo.ts'
import { Drawer } from '../ui/drawer.ts'
import { Button } from '../ui/components.ts'
import { Opt, Popover } from '../ui/popover.ts'

function Switcher() {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const ents = app.ws?.entities ?? []
  const current = ents.find((e) => e.id === app.scope)
  // More than one workspace (your own, and one you were invited to): pick which one, below the companies.
  const spaces = app.me?.workspaces ?? []
  const switchTo = (id: string) => {
    setOpen(false)
    if (id === app.me?.workspaceId) return
    app.api.setWorkspace(id)
    app.setScope(null)
    app.go({ page: 'workspace', step: 0, stack: [] })
    void app.reload()
  }
  return html`<span class="popwrap" style="display:block">
    <button type="button" class="switcher" aria-haspopup="true" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>
      ${current?.name ?? 'All companies'} <${Icon} name="down" size=${14} />
    </button>
    <${Popover} open=${open} onClose=${() => setOpen(false)} label="Switch company">
      <${Opt} role="menuitemradio" checked=${!app.scope} onClick=${() => (app.setScope(null), setOpen(false))}>All companies</${Opt}>
      ${ents.map((e) => html`<${Opt} role="menuitemradio" checked=${app.scope === e.id} onClick=${() => (app.setScope(e.id), setOpen(false))}>${e.name}</${Opt}>`)}
      ${isReviewer(app) || !isManager(app) ? null : html`<div class="popfoot"><button type="button" class="plus" onClick=${() => (setOpen(false), app.open({ kind: 'company-new' }))}><span class="p" aria-hidden="true">+</span>Add a company</button></div>`}
      ${spaces.length > 1
        ? html`<div class="popfoot" role="group" aria-label="Workspaces">
            ${spaces.map((w) => html`<${Opt} role="menuitemradio" checked=${w.id === app.me?.workspaceId} onClick=${() => switchTo(w.id)}>${w.name}</${Opt}>`)}
          </div>`
        : null}
    </${Popover}>
  </span>`
}

/** Help: the setup guide, or email a person. */
function Help({ onPick }: { onPick: () => void }) {
  const [open, setOpen] = useState(false)
  const pick = (f: () => void) => () => (setOpen(false), onPick(), f())
  return html`<span class="popwrap" style="display:block">
    <button type="button" class="navbtn" aria-haspopup="true" aria-expanded=${open ? 'true' : 'false'} onClick=${() => setOpen(!open)}>Help</button>
    <${Popover} open=${open} onClose=${() => setOpen(false)} label="Help">
      <${Opt} role="menuitem" onClick=${pick(openGuide)}>Setup guide ↗</${Opt}>
      <${Opt} role="menuitem" onClick=${pick(emailSupport)}>Email support</${Opt}>
    </${Popover}>
  </span>`
}

/** The routes live in the hash, so "#main" would leave this page: move focus to the content instead. */
const skipToMain = (e: Event) => {
  e.preventDefault()
  document.getElementById('main')?.focus()
}

export function Shell({ children, onSearch }: { children: ComponentChildren; onSearch: () => void }) {
  const app = useApp()
  const [menu, setMenu] = useState(false)
  // Leaving a full demo takes a few seconds on the server: say so, and one press is enough.
  const [leaving, setLeaving] = useState(false)
  const leave = async () => {
    if (leaving) return
    setLeaving(true)
    try {
      await leaveDemo(app)
    } finally {
      setLeaving(false)
    }
  }
  const menuBtn = useRef<HTMLButtonElement>(null)
  const navRef = useRef<HTMLElement>(null)
  // Phone menu by keyboard: focus moves in when it opens; Escape or "Close menu" returns it to the Menu button, and
  // Tabbing out of it closes it.
  const closeMenu = (refocus = true) => {
    setMenu(false)
    if (refocus) menuBtn.current?.focus()
  }
  useEffect(() => {
    if (!menu) return
    navRef.current?.querySelector<HTMLElement>('[aria-label="Close menu"]')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.pop')) return
      e.preventDefault()
      e.stopPropagation()
      closeMenu()
    }
    const nav = navRef.current
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null
      if (to && !nav?.contains(to) && to !== menuBtn.current) closeMenu(false)
    }
    document.addEventListener('keydown', onKey, true)
    nav?.addEventListener('focusout', onOut)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      nav?.removeEventListener('focusout', onOut)
    }
  }, [menu])
  const ws = app.ws
  const page = app.route.page
  const demo = inDemo(app, isReviewer(app))
  const pub = isPublicDemo(app)
  const showReview = !!ws && (ws.reviewCount > 0 || ws.reviewModeOn || page === 'review')
  const nav = (p: 'workspace' | 'review' | 'preferences') => (e: Event) => {
    e.preventDefault()
    setMenu(false)
    app.go({ page: p, stack: [] })
  }
  const signOut = async () => {
    await app.api.signOut()
    // Chosen, not expired: the sign-in page says so, not "You were signed out".
    app.leave('You’re signed out.')
  }
  return html`<div class="shell">
    <a href="#main" class="sr" onClick=${skipToMain} onFocus=${(e: Event) => (e.target as HTMLElement).classList.remove('sr')} onBlur=${(e: Event) => (e.target as HTMLElement).classList.add('sr')}>Skip to content</a>
    <header class="topbar">
      <span class="wordmark">Aggregate</span>
      <${Switcher} />
      <button type="button" class="iconbtn" ref=${menuBtn} aria-label="Menu" aria-expanded=${menu ? 'true' : 'false'} aria-controls="nav" onClick=${() => setMenu(!menu)}><${Icon} name="menu" /></button>
    </header>
    <nav id="nav" ref=${navRef} class=${'nav' + (menu ? ' open' : '')} aria-label="Main">
      ${menu ? html`<div style="display:flex;justify-content:flex-end"><button type="button" class="iconbtn" aria-label="Close menu" onClick=${() => closeMenu()}><${Icon} name="close" /></button></div>` : null}
      <span class="wordmark">Aggregate</span>
      <${Switcher} />
      <a href="#/" aria-current=${page === 'workspace' ? 'page' : undefined} onClick=${nav('workspace')}>Workspace</a>
      ${showReview ? html`<a href="#/review" aria-current=${page === 'review' ? 'page' : undefined} onClick=${nav('review')}>Review ${ws && ws.reviewCount && !isFilling(ws) ? html`<span class="count" aria-label=${`${ws.reviewCount} waiting`}>${ws.reviewCount}</span>` : null}</a>` : null}
      ${pub ? null : html`<a href="#/preferences" aria-current=${page === 'preferences' ? 'page' : undefined} onClick=${nav('preferences')}>Preferences</a>`}
      <button type="button" class="navbtn" onClick=${() => (setMenu(false), onSearch())}>Search <span class="kbd kbdhint" aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</span></button>
      <div class="gap"></div>
      ${isReviewer(app) || pub || !isManager(app) ? null : html`<button type="button" class="navbtn" onClick=${() => (setMenu(false), app.open({ kind: 'invite' }))}>Invite someone</button>`}
      ${demo ? html`<button type="button" class="navbtn" disabled=${leaving} onClick=${() => (setMenu(false), void leave())}>${leaving ? 'Leaving the demo…' : 'Leave the demo'}</button>` : null}
      <${Help} onPick=${() => setMenu(false)} />
      ${pub ? html`<button type="button" class="navbtn" onClick=${() => signUpFromDemo(app)}>Sign up</button>` : html`<button type="button" class="navbtn" onClick=${signOut}>Log out</button>`}
      <div class="grow"></div>
      ${ws && !pub ? html`<p class="who">${ws.me.name}</p><p class="who">${ws.me.email}</p>` : null}
    </nav>
    <main class="main" id="main" tabindex="-1">
      ${isReviewer(app) ? html`<p class="sub reviewer-note" role="note">Reviewer demo · made-up companies · resets nightly</p>` : null}
      ${pub ? html`<p class="demo-bar" role="note"><span>Demo company · read-only · made-up numbers</span> <button type="button" class="link" onClick=${() => signUpFromDemo(app)}>Sign up →</button></p>` : null}
      ${demo ? html`<p class="demo-bar" role="note"><span>You’re looking at a demo with made-up companies.</span> <button type="button" class="link" disabled=${leaving} aria-busy=${leaving ? 'true' : undefined} onClick=${() => void leave()}>${leaving ? 'Leaving the demo…' : 'Start with your own companies →'}</button></p>` : null}
      ${children}
    </main>
  </div>`
}

/** In the public demo, anything that would change something opens this instead. The server refuses writes anyway. */
export function ReadOnlyDemo({ onClose, onBack }: { onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  return html`<${Drawer} title="This is a read-only demo" sub="Sign up to connect your own accounts and ask your AI about them. It can never move money." onClose=${onClose} onBack=${onBack}>
    <div class="formrow" style="margin-top:20px"><${Button} onClick=${() => signUpFromDemo(app)}>Sign up</${Button}></div>
  </${Drawer}>`
}
