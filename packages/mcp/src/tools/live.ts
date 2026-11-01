// refresh_balance: a live balance check at the bank, on request, with a confirmation step because each check is
// billed. The sync engine enforces the cooldown and daily cap (shared with the person's button); this tool never
// calls without confirm: true, and records every confirmed check in the activity log.

import * as z from 'zod/v4'
import { appendActivity } from '../activity.ts'
import { ToolError } from '../scope.ts'
import { safeLabel } from '../untrusted.ts'
import { company, defineTool, entityIdsOf, inScope, names, w, type ToolDef } from './common.ts'

const refreshBalance = defineTool({
  name: 'refresh_balance',
  title: 'Check balances live at the bank (billed)',
  description:
    'Asks the bank for balances right now, for accounts whose connection supports it (Plaid today). Each live check is billed per bank connection. ' +
    'Without confirm: true nothing is called: the answer lists which connections a check would call and what it costs. With confirm: true the check runs and the fresh balances come back. ' +
    'Daily balances from the regular sync are already in get_metric (cash) and list_accounts at no cost; a live check matters only for "right now" questions. ' +
    'Live checks are limited per connection (a cooldown) and per workspace per day; over a limit nothing is called and the last known balances come back with when a check is allowed again.',
  input: z.object({
    company,
    account: z.string().min(1).max(120).optional().describe('An account id, or part of its name or its last 4 digits. Omit for every account in scope.'),
    confirm: z.boolean().default(false).describe('true runs the billed check. false (default) only says what it would cost.'),
  }),
  kind: 'read',
  hints: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  requires: 'liveBalance',
  dataTypes: ['balances'],
  listWhen: 'grant_and_data',
  rest: { method: 'POST', path: '/v1/balances/refresh' },
  async run(ctx, args) {
    const port = ctx.liveBalance
    if (!port) throw new ToolError('unavailable', 'Live balance checks are not available on this server.')
    // Naming an account finds it in Personal too; without one, "all" refreshes the companies (Personal only when named).
    const ents = await ctx.access.resolve(ctx.principal, args.company, 'view', 'balances', { allowAll: true, allIncludesPersonal: !!args.account?.trim() })
    const set = new Set(entityIdsOf(ents))
    const nm = names(ents)
    const scope = { workspaceId: ctx.principal.workspaceId, entityIds: [...set] }
    const needle = args.account?.trim().toLowerCase()
    const all = inScope(await ctx.reader.accounts(scope, {}), set).filter((a) => !a.closed)
    const accounts = needle ? all.filter((a) => a.id === args.account || a.name.toLowerCase().includes(needle) || (a.mask ?? '').endsWith(needle)) : all
    if (!accounts.length) throw new ToolError('not_found', needle ? `No open account matching "${args.account}".` : 'No open accounts in scope.', 'list_accounts shows the accounts and their ids.')
    const targets = await port.targets(ctx.principal.workspaceId, accounts.map((a) => a.id))
    const label = (id: string) => {
      const a = accounts.find((x) => x.id === id)
      return a ? `${safeLabel(a.name)}${a.mask ? ` ··${a.mask.slice(-4)}` : ''}` : id
    }
    const entityIds = [...new Set(accounts.map((a) => a.entityId))]
    if (!targets.length) {
      return {
        data: { status: 'unsupported', accounts: accounts.map((a) => ({ id: a.id, company: nm.get(a.entityId), name: label(a.id), balance: w(a.balance), last_sync: a.lastSyncAt })) },
        summary: 'None of these accounts’ connections support live checks. The balances shown are from the last sync.',
        entityIds,
      }
    }
    const would = targets.map((t) => ({ connection: safeLabel(t.name), accounts: t.accountIds.map(label) }))
    const limits = `At most one live check per bank connection every ${port.limits.cooldownMinutes} minutes and ${port.limits.dailyCap} per workspace per day.`
    if (!args.confirm) {
      return {
        data: { status: 'needs_confirmation', live_checks: targets.length, would_check: would, cost_note: port.costNote, limits },
        summary: `Nothing was checked yet. A live check would call ${targets.length} bank connection(s): ${would.map((x) => x.connection).join(', ')}. ${port.costNote} ${limits} It runs with confirm: true.`,
        entityIds,
      }
    }

    const checks: Array<Record<string, unknown>> = []
    for (const t of targets) {
      const r = await port.refresh(t.connectionId)
      if (r.status === 'ok') checks.push({ connection: safeLabel(t.name), status: 'checked', at: r.at })
      else if (r.status === 'cached') checks.push({ connection: safeLabel(t.name), status: r.reason === 'cooldown' ? 'checked_recently' : 'daily_limit', last_checked: r.refreshedAt, next_allowed: r.retryAt })
      else checks.push({ connection: safeLabel(t.name), status: 'unsupported' })
    }
    const done = checks.filter((c) => c.status === 'checked').length
    await appendActivity(
      ctx.store.db,
      {
        workspaceId: ctx.principal.workspaceId,
        actorKind: 'agent',
        personId: ctx.principal.personId,
        grantId: ctx.principal.grant.id,
        actorLabel: ctx.principal.label,
        action: 'balance.live_check',
        entityIds,
        status: 'ok',
        detail: `${done} billed live check(s); ${checks.length - done} not run (limit or unsupported)`,
        ip: ctx.principal.ip ?? null,
        userAgent: ctx.principal.userAgent ?? null,
      },
      ctx.clock.now(),
    )
    const fresh = inScope(await ctx.reader.accounts(scope, {}), set).filter((a) => accounts.some((x) => x.id === a.id))
    return {
      data: {
        status: done ? 'checked' : 'not_checked',
        checks,
        limits,
        accounts: fresh.map((a) => ({ id: a.id, company: nm.get(a.entityId), name: label(a.id), balance: w(a.balance), available: w(a.available), last_sync: a.lastSyncAt })),
      },
      summary: (done ? `Checked ${done} connection(s) live. ${fresh.map((a) => `${label(a.id)}: ${w(a.balance)?.amount ?? '?'} ${a.currency}`).join('; ')}.` : 'No live check ran (limit reached or unsupported); these are the last known balances.') + ` ${limits}`,
      rows: fresh.length,
      entityIds,
    }
  },
})

export const LIVE_TOOLS: ToolDef[] = [refreshBalance]
