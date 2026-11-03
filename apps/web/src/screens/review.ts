// Review: a plain question for everything waiting on you, the most important first (the server's order). Same-kind items
// are one line with Confirm all; what Aggregate filed by itself sits behind +, with undo. Keys Y / N / E on the focused row.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { OFFLINE } from '../api/http.ts'
import type { ReviewItem, ReviewKind } from '../api/types.ts'
import { useApp, useLoad } from '../app/context.ts'
import { fmt } from '../lib/money.ts'
import { ago, shortDate } from '../lib/time.ts'
import { Button, LinkButton, PlusAction, Row, Rows, Section, Tile } from '../ui/components.ts'
import { html } from '../ui/html.ts'
import type { IconName } from '../ui/icons.ts'

const KIND: Record<ReviewKind, { icon: IconName; word: string }> = {
  ai_write: { icon: 'spark', word: 'Added by your AI' },
  match: { icon: 'check', word: 'Possible match' },
  duplicate: { icon: 'alert', word: 'Possible duplicate' },
  rule: { icon: 'bucket', word: 'Suggested rule' },
  whose_money: { icon: 'person', word: 'Needs your answer' },
  document: { icon: 'file', word: 'Unread document' },
  set_aside_short: { icon: 'alert', word: 'Set-aside is short' },
}
// Nothing to answer: it clears itself when the balance or the set-aside changes.
const answerable = (i: ReviewItem) => i.kind !== 'set_aside_short'

export function ReviewPage() {
  const app = useApp()
  const { data, error, reload } = useLoad(() => app.api.review(), [])
  // Not everyone can see this (and it's only a count): without it the page reads the same, minus that part.
  const { data: filed, reload: reloadFiled } = useLoad(() => app.api.reviewFiled().catch(() => null), [])
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The key handler is registered once and reads the latest items and actions through this ref.
  const latest = useRef({ data, decide: (_i: ReviewItem, _a: 'confirm' | 'reject', _v?: Record<string, string>, _l?: string) => {}, setEditing })

  const decide = async (item: ReviewItem, action: 'confirm' | 'reject', values?: Record<string, string>, answer?: string) => {
    const idx = (data ?? []).findIndex((x) => x.id === item.id)
    const done = await app.api.resolve(item.id, values ? { action: 'edit', values } : { action }).catch((e: unknown) => {
      app.toast({ text: `${e instanceof Error ? e.message : 'That didn’t save.'} ${item.title} is still waiting.` })
      return 'failed' as const
    })
    if (done === 'failed') return reload()
    setEditing(null)
    reload()
    await app.reload()
    // The writer's own words when it gives them ("Linked: pays invoice 1012 ($274.50)"), and Undo when it made a record.
    const recordId = done?.recordId
    app.toast({
      text: done?.summary ?? (answer ? `${answer}: ${item.title}` : `${action === 'confirm' || values ? item.confirmLabel ?? 'Confirmed' : item.rejectLabel ?? 'Rejected'}: ${item.title}`),
      ...(recordId ? { undo: async () => (await app.api.undo(recordId), app.toast({ text: 'Undone.' }), reload(), app.reload()) } : {}),
    })
    // Keep the keyboard flow going: focus the next row.
    requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>('[data-review]')[Math.max(0, idx)]?.focus())
  }

  latest.current = { data, decide, setEditing }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.drawer')) return
      const t = e.target
      if (!(t instanceof Element) || t.closest('input,textarea,select')) return
      const row = t.closest<HTMLElement>('[data-review]')
      const { data, decide, setEditing } = latest.current
      const item = data?.find((x) => x.id === row?.dataset.review)
      if (!item || !answerable(item)) return
      const k = e.key.toLowerCase()
      // Items with answers take a number (1, 2, 3…) instead of Y / N.
      const answer = item.answers?.[Number(k) - 1]
      if (item.answers?.length) { if (answer) (e.preventDefault(), decide(item, 'confirm', answer.values, answer.label)) }
      else if (k === 'y') (e.preventDefault(), decide(item, 'confirm'))
      else if (k === 'n') (e.preventDefault(), decide(item, 'reject'))
      else if (k === 'e' && item.editable) (e.preventDefault(), setEditing(item.id))
      else if (k === 'j' || e.key === 'ArrowDown' || k === 'k' || e.key === 'ArrowUp') {
        const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-review]') ?? [])]
        const i = rows.indexOf(row!)
        rows[i + (k === 'j' || e.key === 'ArrowDown' ? 1 : -1)]?.focus()
        e.preventDefault()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const items = data ?? []
  // Several accounts from one connection that look the same way (9 personal accounts on a company's bank login): one
  // tap answers them all; each can still be changed after, in its connection.
  const batches = [...items.reduce((m, it) => (it.batch ? m.set(it.batch.key, [...(m.get(it.batch.key) ?? []), it]) : m), new Map<string, ReviewItem[]>()).values()].filter((g) => g.length > 1)
  const answerAll = async (group: ReviewItem[]) => {
    const b = group[0]!.batch!
    for (const it of group) await app.api.resolve(it.id, { action: 'edit', values: b.values })
    reload()
    await app.reload()
    app.toast({ text: `${group.length} accounts put in ${b.label}. Change any one in its connection.` })
  }
  // Same-kind items are one line, where the first of them would be. A lone one is just its question.
  const members = (key: string) => items.filter((x) => x.group?.key === key)
  const confirmAll = async (group: ReviewItem[]) => {
    const r = await app.api.confirmGroup(group[0]!.group!.key, group.map((x) => x.id)).catch((e: unknown) => {
      app.toast({ text: e instanceof Error ? e.message : 'That didn’t save.' })
      return null
    })
    reload()
    if (!r) return
    await app.reload()
    app.toast({ text: r.count === group.length ? `Confirmed ${r.count}.` : `Confirmed ${r.count} of ${group.length}. The others had already changed.` })
  }
  const undoFiled = async (id: string) => {
    await app.api.undoFiled(id).catch(() => undefined)
    reload()
    reloadFiled()
    await app.reload()
    app.toast({ text: 'Undone. It’s back in Review if it needs an answer.' })
  }
  const row = (it: ReviewItem) => (editing === it.id ? html`<${EditRow} item=${it} onSave=${(v: Record<string, string>) => decide(it, 'confirm', v)} onCancel=${() => setEditing(null)} />` : html`<${ReviewRow} item=${it} onDecide=${decide} onEdit=${() => setEditing(it.id)} now=${app.now()} highlight=${it.id === target?.id} />`)
  // Arrived from an AI's approval link (#/review?w=<write id>): go to that item, or say it was already decided.
  const wanted = app.route.params.w
  const target = wanted ? items.find((x) => x.id === `write:${wanted}` || x.id === wanted) : undefined
  useEffect(() => {
    if (!target) return
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-review]') ?? [])].find((x) => x.dataset.review === target.id)
    el?.scrollIntoView({ block: 'center' })
    el?.focus()
  }, [target?.id])
  return html`<div class="column">
    ${wanted && data && !target ? html`<p class="sub" role="status" style="margin-bottom:16px">That change was already decided, or it’s no longer waiting.</p>` : null}
    <${Section} title="Review" pageTitle sub=${items.length || filed?.count ? html`${topLine(items.filter(answerable).length, filed?.count ?? 0, items.length)}<span class="keyshint"> Keys: <span class="kbd">Y</span> confirm · <span class="kbd">N</span> reject${items.some((i) => i.editable?.length) ? html` · <span class="kbd">E</span> edit` : null}${items.some((i) => i.answers?.length) ? html` · <span class="kbd">1</span> <span class="kbd">2</span> … answer` : null}</span>` : data ? 'Nothing waiting.' : error ? html`<span role="alert">${error === OFFLINE ? 'Can’t reach Aggregate. Check your connection.' : error}</span> <button type="button" class="link" onClick=${reload}>Try again</button>` : html`<span aria-busy="true">Loading…</span>`}>
      ${batches.map((g) => html`<div class="row batchrow"><span class="txt"><span class="name">These ${g.length} accounts look ${g[0]!.batch!.label === 'Personal' ? 'personal' : `like ${g[0]!.batch!.label}`}</span><span class="line">${namesLine(g.map((x) => x.title.replace(/^Which company is (.*)\?$/, '$1')))}</span></span><span class="right"><${Button} onClick=${() => answerAll(g)}>Put all in ${g[0]!.batch!.label}</${Button}></span></div>`)}
      <ul class="rows" ref=${listRef} aria-label="Waiting for review">
        ${items.map((it, i) => {
          const g = it.group ? members(it.group.key) : []
          if (g.length < 2) return row(it)
          return g[0] === it ? html`<${GroupRow} key=${it.group!.key} label=${it.group!.label} onConfirm=${() => confirmAll(g)}>${g.map(row)}</${GroupRow}>` : null
        })}
      </ul>
      ${data && !items.length ? html`<p class="empty">When your AI adds something while review is on, or Aggregate spots a possible match or duplicate, it waits here.</p>` : null}
      ${items.length ? html`<p class="meta" style="margin-top:16px">Or ask your AI to go through these.</p>` : null}
      ${filed?.items.length ? html`<${FiledList} items=${filed.items} onUndo=${undoFiled} />` : null}
    </${Section}>
  </div>`
}

/** "2026-09-30 Northwind Labs" → "Sep 30, 2026 Northwind Labs": dates read the same as everywhere else. */
const plainDates = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => { const d = new Date(m + 'T12:00:00Z'); return isNaN(+d) ? m : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) })

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "3 questions · 12 filed for you". */
export function topLine(questions: number, filed: number, notices = 0): string {
  return [questions ? plural(questions, 'question') : notices ? 'Nothing to answer' : 'Nothing waiting', filed ? `${filed} filed for you` : null].filter(Boolean).join(' · ')
}

/** "5 moves between your own accounts · Confirm all", each one behind +. */
function GroupRow({ label, onConfirm, children }: { label: string; onConfirm: () => void; children: ComponentChildren }) {
  const [open, setOpen] = useState(false)
  return html`<li>
    <div class="row noicon"><span class="txt"><span class="name" style="white-space:normal">${label}</span></span><span class="right"><${Button} onClick=${onConfirm}>Confirm all</${Button}></span></div>
    ${open ? html`<ul class="rows">${children}</ul>` : html`<${PlusAction} onClick=${() => setOpen(true)}>See each one</${PlusAction}>`}
  </li>`
}

/** What Aggregate filed by itself: quiet until asked for, and each can be undone. */
function FiledList({ items, onUndo }: { items: Array<{ id: string; text: string; filedAt: string }>; onUndo: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!open) return html`<${PlusAction} onClick=${() => setOpen(true)}>See what was filed</${PlusAction}>`
  return html`<${Rows} wrap label="Filed for you">${items.map((f) => html`<${Row} name=${f.text} line=${shortDate(f.filedAt, true)} right=${html`<${LinkButton} onClick=${() => onUndo(f.id)}>Undo<span class="sr"> ${f.text}</span></${LinkButton}>`} />`)}</${Rows}>`
}

function ReviewRow({ item, onDecide, onEdit, now, highlight }: { item: ReviewItem; onDecide: (i: ReviewItem, a: 'confirm' | 'reject', v?: Record<string, string>, l?: string) => void; onEdit: () => void; now: number; highlight?: boolean }) {
  const app = useApp()
  const k = KIND[item.kind]
  const [others, setOthers] = useState(false)
  const notice = !answerable(item)
  // A plain question says it all: no icon, no kind, and the amount is already in it.
  const plain = !!item.question
  return html`<li class=${highlight ? 'linked' : undefined}>
    <div class=${plain ? 'row noicon' : 'row'} tabindex="0" data-review=${item.id} aria-label=${plain ? `${item.question} ${item.detail}` : `${k.word}: ${item.title}. ${item.detail}`} style="align-items:start;padding-top:12px;padding-bottom:12px">
      ${plain ? null : html`<${Tile} icon=${k.icon} />`}
      <span class="txt">
        <span class="name" style="white-space:normal">${item.question ?? item.title}</span>
        ${item.detail ? html`<span class="line" style="white-space:normal">${plainDates(item.detail)}</span>` : null}
        ${plain ? null : html`<span class="line">${k.word} · ${item.entityName} · ${ago(item.createdAt, now)}</span>`}
        <span style="display:flex;gap:16px;align-items:center;margin-top:10px;flex-wrap:wrap">
          ${notice
            ? item.entityId ? html`<${LinkButton} onClick=${() => app.open({ kind: 'company', id: item.entityId! })}>Open ${item.entityName}</${LinkButton}>` : null
            : item.answers?.length
              ? item.answers.map((a) => html`<${Button} quiet onClick=${() => onDecide(item, 'confirm', a.values, a.label)}>${a.label}</${Button}>`)
              : html`<${Button} onClick=${() => onDecide(item, 'confirm')}>${item.confirmLabel ?? 'Confirm'}</${Button}>
                <${LinkButton} onClick=${() => onDecide(item, 'reject')}>${item.rejectLabel ?? 'Reject'}</${LinkButton}>`}
          ${item.editable ? html`<${LinkButton} onClick=${onEdit}>Edit</${LinkButton}>` : null}
        </span>
        ${item.alternatives?.length
          ? others
            ? item.alternatives.map((a) => html`<span class="line" style="white-space:normal;margin-top:10px">${a.question}${a.detail ? ` ${plainDates(a.detail)}` : ''} <${LinkButton} onClick=${() => onDecide({ ...item, id: a.id, title: a.question }, 'confirm')}>Yes</${LinkButton}></span>`)
            : html`<${PlusAction} onClick=${() => setOthers(true)}>${plural(item.alternatives.length, 'other possible match').replace('matchs', 'matches')}</${PlusAction}>`
          : null}
      </span>
      ${plain || notice ? null : html`<span class="right"><span class="value">${item.amount ? fmt(item.amount) : ''}</span></span>`}
    </div>
  </li>`
}

function EditRow({ item, onSave, onCancel }: { item: ReviewItem; onSave: (v: Record<string, string>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries((item.editable ?? []).map((f) => [f.key, f.value])))
  return html`<li>
    <form class="row noicon" style="display:block;padding:12px 8px" onSubmit=${(e: Event) => (e.preventDefault(), onSave(values))}>
      <span class="name">${item.title}</span>
      ${(item.editable ?? []).map((f, i) => html`<label class="field"><span>${f.label}</span><input class="input" value=${values[f.key]} autofocus=${i === 0} onInput=${(e: Event) => setValues({ ...values, [f.key]: (e.target as HTMLInputElement).value })} /></label>`)}
      <div class="formrow"><${Button} type="submit">Save</${Button}><${LinkButton} onClick=${onCancel}>Cancel</${LinkButton}></div>
    </form>
  </li>`
}

/** "A, B and 7 more": two names, then a count, so the row never runs off the page. */
export function namesLine(names: string[]): string {
  if (names.length <= 3) return names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]}` : names.join(' and ')
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}
