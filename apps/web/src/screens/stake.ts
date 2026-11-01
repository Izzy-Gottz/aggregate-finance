// A stake in someone else's company (angels, LPs, friends-and-family): a Personal bucket with the four facts that
// matter. Linking it to that company's cap table comes later.
import { useState } from 'preact/hooks'
import type { BucketField } from '../api/types.ts'
import { useApp } from '../app/context.ts'
import { exponent, parseAmount } from '../lib/money.ts'
import { Button, Field, Segmented } from '../ui/components.ts'
import { Drawer } from '../ui/drawer.ts'
import { html } from '../ui/html.ts'

type Kind = 'SAFE' | 'Shares' | 'Note'
const KINDS: Array<{ value: Kind; label: string }> = [
  { value: 'SAFE', label: 'SAFE' },
  { value: 'Shares', label: 'Shares' },
  { value: 'Note', label: 'Note' },
]

export function StakeAddView({ id, onClose, onBack }: { id: string; onClose: () => void; onBack: (() => void) | null }) {
  const app = useApp()
  const currency = app.ws?.entities.find((e) => e.id === id)?.currency ?? 'USD'
  const [company, setCompany] = useState('')
  const [kind, setKind] = useState<Kind>('SAFE')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async (e: Event) => {
    e.preventDefault()
    if (!company.trim()) return setErr('Which company?')
    const money = parseAmount(amount, currency)
    if (!money || money.minor <= 0) return setErr('How much did you put in?')
    if (!date) return setErr('When?')
    const fields: BucketField[] = [
      { key: 'company', label: 'Company', type: 'text', value: company.trim() },
      { key: 'kind', label: 'Kind', type: 'text', value: kind },
      // "25000.00 USD": the server reads it as money in that currency, never a display string it has to guess at.
      { key: 'amount', label: 'Amount', type: 'money', value: `${(money.minor / 10 ** exponent(money.currency)).toFixed(exponent(money.currency))} ${money.currency}` },
      { key: 'date', label: 'Date', type: 'date', value: date },
    ]
    setBusy(true)
    try {
      await app.api.createBucket(id, { name: `Stake in ${company.trim()}`, fields })
      await app.reload()
      app.toast({ text: `Stake in ${company.trim()} added.` })
      onBack ? onBack() : onClose()
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'That didn’t work. Try again.')
      setBusy(false)
    }
  }
  return html`<${Drawer} title="Add a stake" sub="A company you put money into. Only you see it." onClose=${onClose} onBack=${onBack}>
    <form onSubmit=${save} novalidate style="margin-top:16px">
      <${Field} label="Company"><input class="input" value=${company} onInput=${(e: Event) => setCompany((e.target as HTMLInputElement).value)} placeholder="Lumen Health" /></${Field}>
      <div class="field"><span aria-hidden="true">As</span><${Segmented} label="As" value=${kind} onChange=${setKind} options=${KINDS} /></div>
      <${Field} label="Amount"><input class="input" inputmode="decimal" value=${amount} onInput=${(e: Event) => setAmount((e.target as HTMLInputElement).value)} placeholder="$25,000" /></${Field}>
      <${Field} label="Date"><input class="input" type="date" value=${date} onInput=${(e: Event) => setDate((e.target as HTMLInputElement).value)} /></${Field}>
      ${err ? html`<p class="err" role="alert">${err}</p>` : null}
      <div class="formrow"><${Button} type="submit" disabled=${busy}>Add stake</${Button}></div>
    </form>
  </${Drawer}>`
}
