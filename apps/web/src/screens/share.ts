// Share a card (apps/server/src/share.ts): "Publish this card?" with the image it would publish, amounts and the name
// off unless turned on; then the link, the image to post, and Revoke. Settings → Shared links lists them.
// A badge (apps/server/src/badge.ts) is the same act with its own choices: each figure off until turned on, the embed
// it would publish, and once live the code to paste.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { BadgeField, ShareCard, ShareKind } from '../api/types.ts'
import { isReviewer, useApp, useLoad, type App } from '../app/context.ts'
import { Button, CopyButton, LinkButton, Row, Rows, Section, Toggle } from '../ui/components.ts'
import { Drawer, LoadFailed } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

const KIND: Record<ShareKind, string> = { runway: 'Runway', cash_trend: 'Cash over 12 months', roast: 'Books, roasted', hype: 'Books, hyped', badge: 'Verified badge' }
const FIELDS: Array<{ key: BadgeField; label: string; line: string }> = [
  { key: 'mrr', label: 'Show MRR', line: 'As a range, like $10K–$25K. Never the exact figure.' },
  { key: 'growth', label: 'Show growth', line: 'To the whole percent, over 3 months.' },
  { key: 'runway', label: 'Show runway', line: 'As a range, like 12–24 months.' },
]
const LINES = (k: ShareKind) => k === 'roast' || k === 'hype'
/** Owners and admins of this workspace (the server checks too); never a directory reviewer's demo. */
export function canShare(app: App): boolean {
  if (isReviewer(app)) return false
  const role = app.me?.workspaces?.find((w) => w.id === app.me?.workspaceId)?.role
  return role === 'owner' || role === 'admin'
}

export const LINGER = 'Copies already shared elsewhere may linger briefly.'

/** "Share…" under a runway or cash answer: makes a draft (nothing public yet) and opens it. */
export function ShareLink({ entityId, kind, label = 'Share as a card' }: { entityId: string; kind: ShareKind; label?: string }) {
  const app = useApp()
  const [busy, setBusy] = useState(false)
  return html`<${LinkButton}
    onClick=${async () => {
      if (busy) return
      setBusy(true)
      try {
        const { id } = await app.api.shareDraft(entityId, kind)
        app.push({ kind: 'share', id })
      } catch (e) {
        app.toast({ text: e instanceof Error ? e.message : 'Couldn’t make a card.' })
      } finally {
        setBusy(false)
      }
    }}
  >${label}</${LinkButton}>`
}

export function ShareView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const [amounts, setAmounts] = useState(false)
  const [name, setName] = useState(false)
  const [vendors, setVendors] = useState(false)
  const [fields, setFields] = useState<BadgeField[]>([])
  const [live, setLive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: cards, error, reload } = useLoad(() => app.api.shareCards(), [id])
  const preview = useLoad(() => app.api.sharePreview(id, { amounts, name, vendors, fields }), [id, amounts, name, vendors, fields.join()])
  const card = cards?.find((c) => c.id === id)
  // A card drafted here and closed without publishing is discarded, so drafts don't pile up. An AI's draft stays
  // (it waits in Settings → Shared links for the person to decide).
  const keep = useRef<{ draftFromApp: boolean; done: boolean }>({ draftFromApp: false, done: false })
  keep.current.draftFromApp = card?.status === 'draft' && card.source === 'app'
  useEffect(() => () => void (keep.current.draftFromApp && !keep.current.done && app.api.shareRevoke(id).catch(() => {})), [id])
  if (error) return html`<${LoadFailed} title="Couldn’t open this card" error=${error} reload=${reload} onClose=${onClose} onBack=${onBack} />`
  if (!cards) return html`<${Drawer} title="Share" onClose=${onClose} onBack=${onBack}><p class="sub" aria-busy="true" style="margin-top:12px">Loading…</p></${Drawer}>`
  if (!card) return html`<${Drawer} title="This card is gone" sub="It was published elsewhere, revoked, or discarded." onClose=${onClose} onBack=${onBack} />`
  const url = live ?? card.url
  const revoke = async () => {
    keep.current.done = true
    await app.api.shareRevoke(id)
    app.toast({ text: url ? `Link turned off. ${LINGER}` : 'Card discarded.' })
    onClose()
  }

  if (card.kind === 'badge') return badgeView()
  if (url)
    return html`<${Drawer} title="Card is live" sub=${`${KIND[card.kind]} · ${card.company}`} onClose=${onClose} onBack=${onBack}>
      <img class="sharecard" src=${`${url}/og.png`} alt="The published card" width="1200" height="630" />
      ${canNativeShare() ? html`<div class="formrow" style="margin-top:16px"><${Button} onClick=${() => nativeShare(url, KIND[card.kind])}>Share</${Button}></div>` : null}
      <${Rows}><${Row} name="Link" line=${url} right=${html`<${CopyButton} text=${url} what="Link" />`} /></${Rows}>
      <div class="links">
        <a class="link" href=${`${url}/card.png?download=1`} download>Download square image</a>
        <a class="link" href=${url} target="_blank" rel="noopener">Open</a>
        <${LinkButton} danger onClick=${revoke}>Revoke</${LinkButton}>
      </div>
      <p class="meta" style="margin-top:16px">Anyone with the link can see this card. Revoke turns it off at once. ${LINGER}</p>
    </${Drawer}>`

  function badgeView() {
    const how = `${location.origin}/how-we-verify`
    if (url) {
      const embed = `<a href="${url}"><img src="${url}.svg" alt="Verified by Aggregate"></a>`
      const md = `[![Verified by Aggregate](${url}.svg)](${url})`
      return html`<${Drawer} title="Badge is live" sub=${`${KIND.badge} · ${card!.company}`} onClose=${onClose} onBack=${onBack}>
        <img class="sharebadge" src=${`${url}.svg`} alt="The published badge" />
        <${Rows}>
          <${Row} name="Link" line=${url} right=${html`<${CopyButton} text=${url} what="Link" />`} />
          <${Row} name="HTML" line="For a website" right=${html`<${CopyButton} text=${embed} what="HTML" />`} />
          <${Row} name="Markdown" line="For a README" right=${html`<${CopyButton} text=${md} what="Markdown" />`} />
        </${Rows}>
        <div class="links">
          <a class="link" href=${url} target="_blank" rel="noopener">Open</a>
          <a class="link" href=${how} target="_blank" rel="noopener">How we verify</a>
          <${LinkButton} danger onClick=${revoke}>Revoke</${LinkButton}>
        </div>
        <p class="meta" style="margin-top:16px">Checked again every day. If Aggregate can’t vouch for the books that day, it turns grey and says Not current. Revoke turns it off at once. ${LINGER}</p>
      </${Drawer}>`
    }
    const ready = fields.length > 0 && !preview.error && !!preview.data
    const q = `name=${name ? 1 : 0}&fields=${fields.join(',')}`
    const flip = (k: BadgeField) => (on: boolean) => setFields((f) => (on ? [...f, k] : f.filter((x) => x !== k)))
    return html`<${Drawer} title="Publish this badge?" sub=${`${KIND.badge} · ${card!.company}${card!.source !== 'app' ? ` · drafted by ${card!.source}` : ''}`} onClose=${onClose} onBack=${onBack}>
      ${ready ? html`<img class="sharebadge" src=${app.api.badgePreviewUrl(id, q)} alt="What the badge will show" />` : null}
      ${fields.length && preview.error ? html`<p class="sub" role="status" style="margin-top:16px">${preview.error}</p>` : null}
      <${Section} compact title="What it shows" sub="Each figure is off until you turn it on. Never exact amounts.">
        ${FIELDS.map((f) => html`<${Toggle} label=${f.label} line=${f.line} checked=${fields.includes(f.key)} onChange=${flip(f.key)} />`)}
        <${Toggle} label="Show company name" line=${`Off: “A company” instead of ${card!.company}.`} checked=${name} onChange=${setName} />
      </${Section}>
      <div class="formrow" style="margin-top:20px">
        <${Button}
          disabled=${busy || !ready}
          onClick=${async () => {
            setBusy(true)
            try {
              const r = await app.api.sharePublish(id, { amounts: false, name, fields })
              keep.current.done = true
              setLive(r.url)
            } catch (e) {
              app.toast({ text: e instanceof Error ? e.message : 'Couldn’t publish.' })
            } finally {
              setBusy(false)
            }
          }}
        >Publish</${Button}>
        <${Button} quiet onClick=${revoke}>Discard</${Button}>
      </div>
      <p class="meta" style="margin-top:16px">Anyone with the link can see the badge. Aggregate checks it again every day. <a class="link" href=${how} target="_blank" rel="noopener">How we verify</a></p>
    </${Drawer}>`
  }

  const lines = LINES(card.kind)
  const q = `amounts=${amounts && !lines ? 1 : 0}&name=${name ? 1 : 0}&vendors=${vendors && lines ? 1 : 0}`
  // The plain reason a card can't be made (not reconciled, not enough history, under six months for a roast).
  if (preview.error) return html`<${Drawer} title=${KIND[card.kind]} sub=${card.company} onClose=${onClose} onBack=${onBack}>
    <p class="sub" role="status" style="margin-top:16px">${preview.error}</p>
    <div class="formrow" style="margin-top:20px"><${Button} quiet onClick=${revoke}>Discard</${Button}></div>
  </${Drawer}>`
  return html`<${Drawer} title="Publish this card?" sub=${`${KIND[card.kind]} · ${card.company}${card.source !== 'app' ? ` · drafted by ${card.source}` : ''}`} onClose=${onClose} onBack=${onBack}>
    <img class="sharecard" src=${app.api.sharePreviewUrl(id, q)} alt="What the card will show" width="1200" height="630" />
    <${Section} compact title="What it shows" sub=${lines ? 'Percentages only, from your books. Never dollar figures.' : 'Ratios only, unless you turn these on'}>
      ${lines
        ? html`<${Toggle} label="Show vendor names" line="Off: “one software tool” instead of the name." checked=${vendors} onChange=${setVendors} />`
        : html`<${Toggle} label="Show amounts" line="Off: no dollar figures, only months and percentages." checked=${amounts} onChange=${setAmounts} />`}
      <${Toggle} label="Show company name" line=${`Off: “A company” instead of ${card.company}.`} checked=${name} onChange=${setName} />
    </${Section}>
    <div class="formrow" style="margin-top:20px">
      <${Button}
        disabled=${busy}
        onClick=${async () => {
          setBusy(true)
          try {
            const r = await app.api.sharePublish(id, { amounts: amounts && !lines, name, vendors: vendors && lines })
            keep.current.done = true
            setLive(r.url)
          } catch (e) {
            app.toast({ text: e instanceof Error ? e.message : 'Couldn’t publish.' })
          } finally {
            setBusy(false)
          }
        }}
      >Publish</${Button}>
      <${Button} quiet onClick=${revoke}>Discard</${Button}>
    </div>
    <p class="meta" style="margin-top:16px">The figures are frozen when you publish. Anyone with the link can see the card until you revoke it.</p>
  </${Drawer}>`
}

/** Settings → Shared links: live links and drafts waiting to be published. Owners and admins only. */
export function SharedLinks() {
  const app = useApp()
  const { data, reload } = useLoad(() => app.api.shareCards().catch(() => [] as ShareCard[]), [])
  if (!data?.length) return null
  return html`<${Section} title="Shared links" sub=${`Cards anyone with the link can see. ${LINGER}`}>
    <${Rows}>
      ${data.map(
        (c) => html`<${Row}
          name=${`${KIND[c.kind]} · ${c.company}`}
          line=${c.status === 'live' ? `Live · published ${new Date(c.publishedAt ?? c.createdAt).toLocaleDateString()}` : `Draft${c.source !== 'app' ? ` by ${c.source}` : ''} · not public`}
          right=${html`<span class="links" style="margin-top:0"><${LinkButton} onClick=${() => app.open({ kind: 'share', id: c.id })}>Open</${LinkButton}><${LinkButton} danger onClick=${async () => (await app.api.shareRevoke(c.id), reload(), app.toast({ text: c.status === 'live' ? `Link turned off. ${LINGER}` : 'Draft discarded.' }))}>${c.status === 'live' ? 'Revoke' : 'Discard'}</${LinkButton}></span>`}
        />`,
      )}
    </${Rows}>
  </${Section}>`
}

/** Phones (and some desktops) have a share sheet: one tap to post the card to Messages, WhatsApp, X… */
const canNativeShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/** The square image when the sheet takes files (most phones), else the link alone. Cancelling the sheet is fine. */
async function nativeShare(url: string, title: string): Promise<void> {
  try {
    const blob = await fetch(`${url}/card.png`).then((r) => (r.ok ? r.blob() : null)).catch(() => null)
    const file = blob ? new File([blob], 'aggregate-card.png', { type: 'image/png' }) : null
    const withFile = file && navigator.canShare?.({ files: [file] }) ? { files: [file] } : {}
    await navigator.share({ title, url, ...withFile })
  } catch {
    // Dismissed, or the browser refused: the link, image and Open stay right below.
  }
}

