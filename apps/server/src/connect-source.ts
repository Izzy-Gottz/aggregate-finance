// Connect a financial source from the AI chat (behind AGFN_CONNECT_FROM_CHAT). The AI calls connect_source and all it
// gets back is a secure link — never a secret. A workspace owner/admin opens that link in Aggregate, signs in, and
// approves; only then does the normal connect flow run, via the SPA's connect deep link (#/?d=connect:<provider>),
// which reuses every existing path (provider OAuth, Plaid Link, our key form, a token/upload page).
//
// The link is a single-use, 15-minute, hashed token bound to one workspace + provider + the minting person. The raw
// token lives only in the URL; we store and log only its sha256 (and only a short prefix of that). Every mint, every
// confirm-page outcome, and every completed connect is logged for shadow watching before this is ever public.

import { createHash, randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { newId, ownerOf, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { appendActivity, ConnectMintError, type ConnectOption, type ConnectPort } from '@agfn/mcp'
import { notForWorkspace, type ServerConfig } from './config.ts'
import { isReviewerEmail } from './reviewer.ts'
import type { Services } from './services.ts'

export const CONNECT_LINK_MINUTES = 15
/** Unconfirmed links a single connection, or a single workspace, may mint per hour. Beyond it, mint quietly refuses. */
export const CONNECT_MINT_PER_HOUR = 10
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

type ConnectDeps = Pick<Services, 'db' | 'registry' | 'permissions'>
type ConnectConfig = Pick<ServerConfig, 'baseUrl' | 'unlisted' | 'hidden' | 'onlyWorkspaces'>

/** Connectors that never make sense to connect from chat even when installed. */
const NEVER = new Set(['demo'])

/** A short, non-reversible tag for a link in logs: enough to find the row, nothing that could reconstruct the token. */
const tag = (tokenHash: string) => tokenHash.slice(0, 12)

function shadowLog(ev: Record<string, string | undefined>): void {
  console.info('[agfn] connect_from_chat', Object.entries(ev).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' '))
}

/** The connectors a chat-minted link could reach on this deployment, mirroring /api/connectors' own filtering. */
/** No workspace given (the tool's list): a connector offered only to named workspaces is left out. */
function offeredOptions(deps: ConnectDeps, config: ConnectConfig, email: string, workspaceId?: string): ConnectOption[] {
  const unlisted = new Set([...(config.unlisted ?? []), ...(config.hidden ?? []), ...notForWorkspace(config, workspaceId)])
  return deps.registry
    .list()
    .filter((d) => !NEVER.has(d.key) && !unlisted.has(d.key))
    .map((d) => ({ key: d.key, name: d.name, group: d.group, auth: d.auth, provides: d.provides }))
}

async function emailOf(db: Kysely<CoreTables>, personId: string): Promise<string> {
  // people is scoped by membership (RLS); before/aside from a workspace this is a narrow named bypass, like recheck.ts.
  const row = await withBypass('connect:person', () => db.selectFrom('people').select('email').where('id', '=', personId).executeTakeFirst())
  return row?.email ?? ''
}

async function mintedLastHour(db: Kysely<CoreTables>, column: 'grant_id' | 'workspace_id', value: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 3_600_000).toISOString()
  const row = await ownerOf(db)
    .selectFrom('connect_links')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where(column, '=', value)
    .where('created_at', '>', since)
    .executeTakeFirst()
  return Number(row?.n ?? 0)
}

/** The host's connect-from-chat implementation, wired into the MCP service when AGFN_CONNECT_FROM_CHAT=1. */
export function makeConnectPort(deps: ConnectDeps, config: ConnectConfig): ConnectPort {
  const base = config.baseUrl.replace(/\/+$/, '')
  return {
    async options({ personId }) {
      const email = await emailOf(deps.db, personId)
      // The reviewer demo never connects real sources: hand back nothing, so the tool says none are available.
      if (isReviewerEmail(email)) return []
      return offeredOptions(deps, config, email)
    },
    async mint({ workspaceId, personId, grantId, provider, entityId }) {
      const now = new Date()
      const email = await emailOf(deps.db, personId)
      if (isReviewerEmail(email)) throw new ConnectMintError('Connecting a source isn’t available in the reviewer demo.')
      // Re-check the role at mint time (the tool checked it too): only an owner/admin may connect a source.
      if (!(await deps.permissions.canManageWorkspace(workspaceId, personId))) {
        throw new ConnectMintError('Only a workspace owner or admin can connect a new source.')
      }
      if (!offeredOptions(deps, config, email, workspaceId).some((o) => o.key === provider)) {
        throw new ConnectMintError('That source isn’t available to connect here.')
      }
      // Quiet per-connection and per-workspace rate limit, so a runaway or abused AI can't mint link after link.
      if ((await mintedLastHour(deps.db, 'grant_id', grantId, now)) >= CONNECT_MINT_PER_HOUR || (await mintedLastHour(deps.db, 'workspace_id', workspaceId, now)) >= CONNECT_MINT_PER_HOUR) {
        throw new ConnectMintError('Too many connect links were just created. Wait a few minutes and try again.')
      }
      const token = randomBytes(32).toString('base64url')
      const token_hash = hashOf(token)
      const id = newId()
      const expiresAt = new Date(now.getTime() + CONNECT_LINK_MINUTES * 60_000).toISOString()
      // The row carries workspace_id, so the workspace RLS policy covers it; the mint already runs in this workspace.
      await ownerOf(deps.db)
        .insertInto('connect_links')
        .values({ id, token_hash, workspace_id: workspaceId, person_id: personId, grant_id: grantId, provider, entity_id: entityId ?? null, created_at: now.toISOString(), expires_at: expiresAt, used_at: null })
        .execute()
      await withWorkspace(workspaceId, () =>
        appendActivity(deps.db as never, { workspaceId, actorKind: 'agent', grantId, personId, actorLabel: 'AI', action: 'connect_from_chat.mint', status: 'ok', targetType: 'connector', targetId: provider, detail: `Minted a connect link for ${provider}`, ...(entityId ? { entityIds: [entityId] } : {}) }, now),
      ).catch(() => undefined)
      shadowLog({ event: 'mint', link: tag(token_hash), workspace: workspaceId, provider, grant: grantId })
      return { id, url: `${base}/connect/${token}`, expiresAt }
    },
  }
}

// ---------- The confirm page's data layer (apps/server/src/app.ts serves the pages) ----------

export interface ConnectLink {
  id: string
  workspaceId: string
  personId: string
  grantId: string
  provider: string
  entityId: string | null
  tokenHash: string
}

export type LinkLookup = { ok: true; link: ConnectLink } | { ok: false; reason: 'unknown' | 'used' | 'expired' }

/** Find a link by its token, before a workspace is known (so under a named bypass, like recheck_links). */
export async function lookupConnectLink(db: Kysely<CoreTables>, token: string, now: Date = new Date()): Promise<LinkLookup> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: 'unknown' }
  const row = await ownerOf(db).selectFrom('connect_links').selectAll().where('token_hash', '=', hashOf(token)).executeTakeFirst()
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.used_at) return { ok: false, reason: 'used' }
  if (row.expires_at <= now.toISOString()) return { ok: false, reason: 'expired' }
  return { ok: true, link: { id: row.id, workspaceId: row.workspace_id, personId: row.person_id, grantId: row.grant_id, provider: row.provider, entityId: row.entity_id, tokenHash: row.token_hash } }
}

/**
 * May this signed-in person approve this link — i.e. are they an owner/admin of the link's workspace? The /connect/*
 * confirm pages live OUTSIDE the /api/* session middleware, so there is no ambient workspace here. `canManageWorkspace`
 * reads the row-level-security-scoped `memberships` table, so without a workspace set the app role sees zero rows and
 * every owner is wrongly refused (43's staging blocker). Set the link's workspace for this one check. A bypass would
 * also work but would read across tenants; withWorkspace is the least-privilege fit and matches how mint runs (inside
 * the MCP request's workspace).
 */
export async function mayApproveConnect(
  permissions: { canManageWorkspace(workspaceId: string, personId: string): Promise<boolean> },
  link: Pick<ConnectLink, 'workspaceId'>,
  personId: string,
): Promise<boolean> {
  return withWorkspace(link.workspaceId, () => permissions.canManageWorkspace(link.workspaceId, personId))
}

/** Claim a link: one time. A second confirm racing this one finds used_at set and loses. */
export async function claimConnectLink(db: Kysely<CoreTables>, link: ConnectLink, now: Date = new Date()): Promise<boolean> {
  const claimed = await ownerOf(db).updateTable('connect_links').set({ used_at: now.toISOString() }).where('id', '=', link.id).where('used_at', 'is', null).executeTakeFirst()
  return Number(claimed.numUpdatedRows ?? 0) === 1
}

export type ConnectOutcome = 'confirmed' | 'refused_wrong_person' | 'refused_wrong_workspace' | 'expired' | 'used' | 'unknown'

/** Shadow logging for the confirm page and the completed connect — link id + hash prefix only, never the token. */
export async function logConnectOutcome(
  db: Kysely<CoreTables>,
  ev: { link?: ConnectLink; outcome: ConnectOutcome | 'connected'; personId?: string; actorLabel?: string },
  now: Date = new Date(),
): Promise<void> {
  shadowLog({ event: ev.outcome, link: ev.link ? tag(ev.link.tokenHash) : undefined, workspace: ev.link?.workspaceId, provider: ev.link?.provider, grant: ev.link?.grantId, person: ev.personId })
  if (!ev.link) return
  const link = ev.link
  await withWorkspace(link.workspaceId, () =>
    appendActivity(
      db as never,
      {
        workspaceId: link.workspaceId,
        actorKind: 'person',
        personId: ev.personId ?? link.personId,
        grantId: link.grantId,
        actorLabel: ev.actorLabel || 'someone',
        action: `connect_from_chat.${ev.outcome}`,
        targetType: 'connector',
        targetId: link.provider,
        status: ev.outcome === 'confirmed' || ev.outcome === 'connected' ? 'ok' : 'denied',
        detail: `Connect link for ${link.provider}: ${ev.outcome}`,
        ...(link.entityId ? { entityIds: [link.entityId] } : {}),
      },
      now,
    ),
  ).catch(() => undefined)
}
