// share_answer: an AI drafts a shareable answer card (runway, or the 12-month cash trend) for one company. Only a draft:
// the card goes public when someone who manages the workspace publishes it in Aggregate, choosing whether amounts and
// the company name show. Off unless the host wires a SharePort (AGFN_MCP_SHARE=1), so the tool set stays fixed while a
// directory review is open.

import * as z from 'zod/v4'
import { ToolError } from '../scope.ts'
import { safeLabel } from '../untrusted.ts'
import { companyRequired, defineTool, type ToolDef } from './common.ts'

const shareAnswer = defineTool({
  name: 'share_answer',
  title: 'Draft a shareable card (runway, cash trend, roast or hype)',
  description:
    'Drafts a card someone can share: the company’s runway, its cash over the last 12 months as a shape, a roast of its spending, or a hype card. Nothing is public: the answer has a review_url where an owner or admin previews it and decides whether to publish, and whether amounts and the company name show (both hidden by default). ' +
    'Roast and hype cards are written by Aggregate from fixed lines, never by the AI: the answer’s lines are exactly what the card says, to show as they are. They roast the spending, never the person; carry no advice and no amounts; name vendors only when vendors is true (only when the user asked). A roast is refused when the books aren’t reconciled or runway is under six months, and the answer says why. ' +
    'Use when the user asks to share or post how a company is doing. Give the user the review_url. One company per card; at most 20 cards per workspace per day.',
  input: z.object({
    company: companyRequired,
    card: z.enum(['runway', 'cash_trend', 'roast', 'hype']).describe('runway: months of runway. cash_trend: the 12-month cash shape. roast: a joke about the spending. hype: a celebration.'),
    vendors: z.boolean().default(false).describe('roast/hype only: name vendors. Only when the user asked for names.'),
  }),
  kind: 'read',
  hints: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  requires: 'share',
  dataTypes: ['balances'],
  listWhen: 'grant_and_data',
  rest: { method: 'POST', path: '/v1/share' },
  async run(ctx, args) {
    const port = ctx.share
    if (!port) throw new ToolError('unavailable', 'Sharing cards is not available on this server.')
    const ents = await ctx.access.resolve(ctx.principal, args.company, 'view', 'balances', { allowAll: false })
    const e = ents.length === 1 ? ents[0]! : null
    if (!e) throw new ToolError('invalid', 'Say which one company the card is for.')
    if (e.kind === 'personal') throw new ToolError('invalid', 'Cards are for companies, not Personal.')
    try {
      const d = await port.draft({ workspaceId: ctx.principal.workspaceId, personId: ctx.principal.personId, entityId: e.id, kind: args.card, source: ctx.principal.grant.clientName || 'AI', ...(args.vendors ? { vendors: true } : {}) })
      // Template lines, but vendor names inside them come from other people's text: cleaned like any label.
      const lines = d.lines?.flatMap((l) => safeLabel(l, 'counterparty_name') ?? [])
      const label = { runway: 'runway', cash_trend: 'cash trend', roast: 'roast', hype: 'hype' }[args.card]
      return {
        data: { status: 'draft', card: args.card, company: e.name, review_url: d.reviewUrl, ...(lines ? { lines } : {}) },
        summary: `Drafted a ${label} card for ${e.name}.${lines?.length ? ` It says: ${lines.join(' / ')}` : ''} Nothing is public yet: an owner or admin reviews and publishes it at ${d.reviewUrl}.`,
        entityIds: [e.id],
      }
    } catch (err) {
      const status = (err as { status?: number }).status
      const message = err instanceof Error ? err.message : 'That card couldn’t be drafted.'
      if (status === 404) throw new ToolError('not_found', message)
      if (status === 422 || status === 409) throw new ToolError('invalid', message)
      if (status === 429) throw new ToolError('rate_limited', message)
      throw err
    }
  },
})

export const SHARE_TOOLS: readonly ToolDef[] = [shareAnswer]
