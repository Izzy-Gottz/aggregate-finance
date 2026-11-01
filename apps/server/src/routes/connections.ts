// Keeping an existing connection healthy (MASTER §2 Banks): reconnect on the SAME provider login (Plaid Link update
// mode, never a second Item: that would be billed and counted twice), live balance refresh on request, and the Link
// session log Plaid support asks for. Mounted under /api after session auth.

import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import type { Kysely } from 'kysely'
import { isConnectorError } from '@agfn/connector-sdk'
import { clearAttention, type ConnectorTables } from '@agfn/connector-sdk/db'
import { findDuplicatePlaidItem } from '@agfn/connector-registry'
import { nowIso, type CoreTables } from '@agfn/db'
import { fail, type RequestPerson } from '../app.ts'
import type { Services } from '../services.ts'

type Env = { Variables: { person: RequestPerson } }
const STATE_TTL_MS = 30 * 60_000

export function connectionRoutes(s: Services) {
  const app = new Hono<Env>()
  const { db } = s
  const attentionDb = db as unknown as Kysely<CoreTables & ConnectorTables>

  const requireWs = (c: Context<Env>): string => {
    const id = c.get('person').workspaceId
    if (!id) fail(409, 'Create your first company to get started.', { error: 'onboarding' })
    return id
  }
  const ownConnection = async (ws: string, id: string) => {
    const conn = await db.selectFrom('connections').select(['id', 'connector_key', 'display_name', 'status']).where('id', '=', id).where('workspace_id', '=', ws).executeTakeFirst()
    if (!conn || conn.status === 'disconnected') fail(404, 'That connection no longer exists.')
    return conn
  }

  // Start a reconnect. For Plaid: an update-mode Link token for the same Item. Other providers answer {kind:'connect'}
  // and the app runs their normal connect flow.
  app.post('/connections/:id/reconnect', async (c) => {
    const ws = requireWs(c)
    const personId = c.get('person').personId
    if (!(await s.permissions.canManageWorkspace(ws, personId))) fail(403, 'Only an owner or admin can reconnect.')
    const conn = await ownConnection(ws, c.req.param('id'))
    const { accountSelection } = await c.req.json<{ accountSelection?: boolean }>().catch(() => ({ accountSelection: undefined }))
    const state = randomBytes(24).toString('base64url')
    // Not Plaid: the app runs the provider's normal connect. Remember which connection it's for (the start reads it), so
    // the new sign-in goes into this one instead of a second copy, even for providers that name no company.
    const connectAgain = async () => {
      const key = `reconnect_target:${conn.connector_key}:${personId}`
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', key).execute()
      await db.insertInto('settings').values({ workspace_id: ws, key, value_json: JSON.stringify(conn.id), updated_at: nowIso() }).execute()
      return c.json({ kind: 'connect', connectorKey: conn.connector_key })
    }
    let begin
    try {
      begin = await s.sync.beginReconnect(conn.id, {
        workspaceId: ws,
        redirectUri: `${s.config.baseUrl}/api/connectors/${conn.connector_key}/callback`,
        state,
        userRef: personId,
        ...(accountSelection ? { accountSelection: true } : {}),
      })
    } catch (err) {
      if (isConnectorError(err) && err.code === 'ITEM_NOT_FOUND') {
        // Removed at the bank or at Plaid: the old login can't come back. Forget it and start fresh.
        await s.sync.disconnect(conn.id)
        fail(409, `${conn.display_name} was removed at the bank. Connect it again from Connections.`, { error: 'gone' })
      }
      if (err instanceof Error && err.message === 'this connection has no reconnect flow') return connectAgain()
      throw err
    }
    if (begin.kind !== 'link_widget') return connectAgain()
    await db
      .insertInto('settings')
      .values({ workspace_id: ws, key: `reconnect_state:${state}`, value_json: JSON.stringify({ connectionId: conn.id, personId, at: Date.now() }), updated_at: nowIso() })
      .execute()
    return c.json({ kind: 'plaid_link', linkToken: begin.token, state, connectionId: conn.id })
  })

  // Link update mode succeeded. Nothing to exchange: the existing access token keeps working. Clear the prompts, sync.
  app.post('/connections/:id/reconnect/finish', async (c) => {
    const ws = requireWs(c)
    const conn = await ownConnection(ws, c.req.param('id'))
    const body = await c.req.json<{ state?: string; linkSessionId?: string }>().catch(() => ({}) as { state?: string; linkSessionId?: string })
    const key = `reconnect_state:${body.state ?? ''}`
    const st = body.state ? await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst() : undefined
    await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', key).execute()
    const parsed = st ? (JSON.parse(st.value_json) as { connectionId: string; personId: string; at: number }) : null
    if (!parsed || parsed.connectionId !== conn.id || parsed.personId !== c.get('person').personId || Date.now() - parsed.at > STATE_TTL_MS) {
      fail(400, 'This reconnect attempt expired. Start again.')
    }
    if (body.linkSessionId) console.warn('[agfn] plaid link', { event: 'reconnect_success', connectionId: conn.id, linkSessionId: String(body.linkSessionId).slice(0, 80) })
    await db.updateTable('connections').set({ status: 'active', last_error: null }).where('id', '=', conn.id).execute()
    await clearAttention(attentionDb, conn.id)
    await s.sync.request(ws, conn.id)
    return c.json({ ok: true })
  })

  // Live balances, on request only ($0.10 a check at Plaid). Capped in the sync engine (15 min per connection, a daily
  // cap per workspace); over a cap the cached balances stand and the answer says how old they are.
  app.post('/connections/:id/refresh-balance', async (c) => {
    const ws = requireWs(c)
    if (!(await s.permissions.canManageWorkspace(ws, c.get('person').personId))) fail(403, 'Only an owner or admin can refresh balances live.')
    const conn = await ownConnection(ws, c.req.param('id'))
    try {
      const r = await s.sync.refreshBalances(conn.id)
      if (r.status === 'unsupported') fail(409, `${conn.display_name} can’t check balances live. They update with each sync.`, { error: 'unsupported' })
      if (r.status === 'cached') {
        const ago = r.refreshedAt ? Math.max(1, Math.round((Date.now() - Date.parse(r.refreshedAt)) / 60_000)) : null
        const message =
          r.reason === 'daily_cap'
            ? `That’s the limit of live checks for today${ago ? `; last refreshed ${ago} min ago` : ''}. Balances still update with each sync.`
            : `Refreshed ${ago ?? 0} min ago. You can check live again ${new Date(r.retryAt).toISOString().slice(11, 16)} UTC.`
        return c.json({ ok: true, live: false, reason: r.reason, refreshedAt: r.refreshedAt, retryAt: r.retryAt, message })
      }
      return c.json({ ok: true, live: true, at: r.at, snapshots: r.snapshots })
    } catch (err) {
      if (isConnectorError(err)) {
        console.warn('[agfn] live balance failed', { connectionId: conn.id, code: err.code, requestId: err.requestId })
        if (err.kind === 'auth') fail(409, `${conn.display_name} needs you to reconnect first.`, { error: 'needs_reauth' })
        if (err.kind === 'rate_limited') fail(409, 'The bank is limiting live checks right now. Try again later.', { error: 'rate_limited' })
        fail(503, 'The bank didn’t answer in time. Your last known balances are still shown.')
      }
      throw err
    }
  })

  // Link funnel events from the browser (open, exit with error, success): kept in the server log with the Link session
  // id, the handle Plaid support investigates with. Never tokens.
  app.post('/connectors/plaid/link-event', async (c) => {
    requireWs(c)
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    const pick = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, 120) : undefined)
    console.warn('[agfn] plaid link', {
      event: pick('event'),
      linkSessionId: pick('linkSessionId'),
      institutionId: pick('institutionId'),
      errorType: pick('errorType'),
      errorCode: pick('errorCode'),
      requestId: pick('requestId'),
    })
    return c.json({ ok: true })
  })

  return app
}

/**
 * Plaid duplicate-Item guard, before the public token is exchanged: same institution and a same account mask as a
 * live connection in this workspace means it's already connected. Returns a sentence for the person, or undefined.
 */
export async function plaidDuplicateMessage(db: Kysely<CoreTables>, workspaceId: string, input: Record<string, unknown>): Promise<{ message: string; connectionId: string } | undefined> {
  const inst = (input.institution && typeof input.institution === 'object' ? input.institution : {}) as { institution_id?: unknown; name?: unknown }
  const institutionId = typeof inst.institution_id === 'string' ? inst.institution_id : undefined
  const accounts = Array.isArray(input.accounts) ? (input.accounts as Array<{ mask?: unknown }>).map((a) => ({ mask: typeof a.mask === 'string' ? a.mask : null })) : []
  if (!institutionId || !accounts.length) return undefined
  const conns = await db.selectFrom('connections').select(['id', 'config_json', 'display_name']).where('workspace_id', '=', workspaceId).where('connector_key', '=', 'plaid').where('status', '!=', 'disconnected').execute()
  const existing = []
  for (const conn of conns) {
    const cfg = JSON.parse(conn.config_json) as { institutionId?: string }
    if (cfg.institutionId !== institutionId) continue
    const masks = await db.selectFrom('accounts').select('mask').where('connection_id', '=', conn.id).where('closed_at', 'is', null).execute()
    existing.push({ connectionId: conn.id, institutionId, accounts: masks.map((m) => ({ mask: m.mask })) })
  }
  const dup = findDuplicatePlaidItem({ institutionId, accounts }, existing)
  if (!dup) return undefined
  const name = typeof inst.name === 'string' && inst.name ? inst.name : 'This bank'
  return { connectionId: dup, message: `${name} is already connected. Use Reconnect on it instead of adding it again.` }
}
