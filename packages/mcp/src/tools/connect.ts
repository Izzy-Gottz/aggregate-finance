// connect_source: the AI starts connecting a financial source (bank, Stripe, Shopify, …) from chat. It never touches a
// credential — all it does is mint a secure link. A workspace owner or admin opens that link in Aggregate, signs in,
// and approves; only then does the real connect flow run (provider OAuth, Plaid Link, our key form, or a token/upload
// page), exactly as if they'd pressed Connect in the app. Off unless the host wires a ConnectPort
// (AGFN_CONNECT_FROM_CHAT=1), so the tool set stays frozen while the directory reviews are open.

import * as z from 'zod/v4'
import { ConnectMintError, type ConnectOption } from '../ports.ts'
import { ToolError } from '../scope.ts'
import { closest } from '../scope.ts'
import { company, defineTool, type ToolDef } from './common.ts'

/** Resolve the connector the AI asked for: exact key, exact name, then a near-miss suggestion. */
function matchProvider(options: ConnectOption[], asked: string): ConnectOption | undefined {
  const q = asked.trim().toLowerCase()
  return (
    options.find((o) => o.key.toLowerCase() === q) ??
    options.find((o) => o.name.toLowerCase() === q) ??
    options.find((o) => o.name.toLowerCase().replace(/[^a-z0-9]/g, '') === q.replace(/[^a-z0-9]/g, ''))
  )
}

const howItConnects: Record<ConnectOption['auth'], string> = {
  oauth: 'they sign in at the provider',
  link_widget: 'they pick their bank in a secure widget',
  api_key: 'they paste a read-only key on an Aggregate page',
  file: 'they upload a statement or export',
  none: 'they confirm it on an Aggregate page',
}

const connectSource = defineTool({
  name: 'connect_source',
  title: 'Connect a financial source',
  description:
    'Start connecting a financial source — a bank, card, or a service like Stripe, Shopify, QuickBooks or PayPal — when get_coverage shows one is missing, or the user asks to add one. ' +
    'This returns a secure link, nothing more: a workspace owner or admin opens it in Aggregate, signs in, and approves, and only then does the connection happen there (provider sign-in, bank picker, a key page, or an upload). ' +
    'NEVER ask the user for a password, API key, token, or account number in chat, and never accept one — the link handles all of that safely on Aggregate. Give the user the link and tell them an owner/admin has to open it. ' +
    'It expires in 15 minutes and works once. After they say it is connected, call get_coverage again to see the new data.',
  input: z.object({
    provider: z.string().min(1).max(60).describe('The source to connect, by name or key: e.g. "Stripe", "plaid" (banks), "QuickBooks", "Shopify". If unsure which key, use the name; the answer lists what is available.'),
    company,
  }),
  kind: 'read',
  hints: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  requires: 'connect',
  // A management action, not tied to the grant's data scope: it lists for any connection, and the run checks the role.
  dataTypes: [],
  listWhen: 'always',
  rest: { method: 'POST', path: '/v1/connect' },
  async run(ctx, args) {
    const port = ctx.connect
    if (!port) throw new ToolError('unavailable', 'Connecting a source from chat isn’t available on this server.')
    // Only a workspace owner or admin may connect a source — checked live, so a role change applies at once. The host's
    // mint re-checks this (and refuses reviewer-demo and rate-limited callers) as defense in depth.
    if (!(await ctx.access.canManageWorkspace(ctx.principal))) {
      throw new ToolError(
        'forbidden',
        'Only a workspace owner or admin can connect a new source.',
        'Tell the user to ask an owner or admin to connect it, or to open Aggregate and connect it themselves under Connect.',
      )
    }
    const options = await port.options({ workspaceId: ctx.principal.workspaceId, personId: ctx.principal.personId })
    if (!options.length) throw new ToolError('unavailable', 'No sources can be connected from chat on this server right now.')
    const match = matchProvider(options, args.provider)
    if (!match) {
      const names = options.map((o) => o.name)
      const guess = closest(args.provider, names)
      const sample = names.slice(0, 12).join(', ')
      throw new ToolError(
        'invalid',
        `“${args.provider.slice(0, 60)}” isn’t a source you can connect here yet.${guess ? ` Did you mean ${guess}?` : ''}`,
        `Available to connect now: ${sample}${names.length > 12 ? `, and ${names.length - 12} more` : ''}. Use one of these names.`,
      )
    }
    // Bind the company only when the AI named one it can see; otherwise the owner picks it when they approve.
    let entityId: string | null = null
    let companyName: string | undefined
    if (args.company && args.company.trim() && args.company.trim().toLowerCase() !== 'all') {
      const ents = await ctx.access.resolve(ctx.principal, args.company, 'view', 'balances', { allowAll: false })
      if (ents.length === 1) {
        entityId = ents[0]!.id
        companyName = ents[0]!.kind === 'personal' ? 'Personal' : ents[0]!.name
      }
    }
    try {
      const link = await port.mint({ workspaceId: ctx.principal.workspaceId, personId: ctx.principal.personId, grantId: ctx.principal.grant.id, provider: match.key, entityId })
      const to = companyName ? ` to ${companyName}` : ''
      return {
        data: {
          provider: match.key,
          provider_name: match.name,
          connect_url: link.url,
          expires_at: link.expiresAt,
          ...(companyName ? { company: companyName } : {}),
        },
        summary:
          `To connect ${match.name}${to}, give the user this link and tell them a workspace owner or admin has to open it in Aggregate to approve it (${howItConnects[match.auth]}): ${link.url} ` +
          `It expires in 15 minutes and works once. Don’t ask for any password, key, token or account number in chat — the link handles sign-in safely. After they connect it, call get_coverage again.`,
        ...(entityId ? { entityIds: [entityId] } : {}),
      }
    } catch (err) {
      if (err instanceof ConnectMintError) throw new ToolError('invalid', err.message)
      throw err
    }
  },
})

export const CONNECT_TOOLS: readonly ToolDef[] = [connectSource]
