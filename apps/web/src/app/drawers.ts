// Renders the top of the drawer stack. Back pops one level; Close clears the stack.
import { StakeAddView } from '../screens/stake.ts'
import { InvestmentsView } from '../screens/investments.ts'
import { DEMO_WRITE_VIEWS, isPublicDemo } from '../lib/demo.ts'
import { ReadOnlyDemo } from '../screens/shell.ts'
import { useApp } from './context.ts'
import { html } from '../ui/html.ts'
import { AddCashView, EmailInView, UploadView } from '../screens/add.ts'
import { AiView, ConnectAiView } from '../screens/ai.ts'
import { BucketView } from '../screens/bucket.ts'
import { CompanyView, ExplainView, MrrView, TxnsView } from '../screens/company.ts'
import { ConnectionView, ConnectView, PlaidReturnView } from '../screens/connections.ts'
import { EquityAddView, EquityExitView, EquityRoundView, EquityView } from '../screens/equity.ts'
import { HealthView } from '../screens/workspace.ts'
import { ShareView } from '../screens/share.ts'
import { DeleteMeView, DeleteWorkspaceView, InviteView, NewCompanyView, PersonView } from '../screens/preferences.ts'

export function Drawers() {
  const app = useApp()
  const stack = app.route.stack
  const v = stack[stack.length - 1]
  if (!v) return null
  const p = { onClose: app.close, onBack: stack.length > 1 ? app.back : null }
  if (isPublicDemo(app) && DEMO_WRITE_VIEWS.has(v.kind)) return html`<${ReadOnlyDemo} ...${p} />`
  switch (v.kind) {
    case 'company':
      return html`<${CompanyView} key=${v.id} id=${v.id} ...${p} />`
    case 'explain':
      return html`<${ExplainView} id=${v.id} metric=${v.metric} ...${p} />`
    case 'txns':
      return html`<${TxnsView} id=${v.id} ...${p} />`
    case 'bucket':
      return html`<${BucketView} id=${v.id} ...${p} />`
    case 'ai':
      return html`<${AiView} id=${v.id} ...${p} />`
    case 'connect-ai':
      return html`<${ConnectAiView} ...${p} />`
    case 'connection':
      return html`<${ConnectionView} id=${v.id} ...${p} />`
    case 'connect':
      return html`<${ConnectView} key=${v.key ?? 'all'} connectorKey=${v.key} entityId=${v.entity} ...${p} />`
    case 'add':
      return v.what === 'cash' ? html`<${AddCashView} ...${p} />` : v.what === 'upload' ? html`<${UploadView} ...${p} />` : html`<${EmailInView} ...${p} />`
    case 'company-new':
      return html`<${NewCompanyView} ...${p} />`
    case 'invite':
      return html`<${InviteView} ...${p} />`
    case 'person':
      return html`<${PersonView} id=${v.id} ...${p} />`
    case 'equity':
      return html`<${EquityView} key=${v.id} id=${v.id} ...${p} />`
    case 'equity-add':
      return html`<${EquityAddView} id=${v.id} ...${p} />`
    case 'equity-round':
      return html`<${EquityRoundView} id=${v.id} ...${p} />`
    case 'equity-exit':
      return html`<${EquityExitView} id=${v.id} ...${p} />`
    case 'delete-me':
      return html`<${DeleteMeView} ...${p} />`
    case 'delete-workspace':
      return html`<${DeleteWorkspaceView} ...${p} />`
    case 'health':
      return html`<${HealthView} ...${p} />`
    case 'share':
      return html`<${ShareView} key=${v.id} id=${v.id} ...${p} />`
    case 'mrr':
      return html`<${MrrView} id=${v.id} ...${p} />`
    case 'stake-add':
      return html`<${StakeAddView} id=${v.id} ...${p} />`
    case 'investments':
      return html`<${InvestmentsView} id=${v.id} ...${p} />`
    case 'plaid-return':
      return html`<${PlaidReturnView} onClose=${app.close} />`
  }
}
